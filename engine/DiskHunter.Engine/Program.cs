using System.Buffers;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Threading.Channels;

namespace DiskHunter.Engine;

public static class Program
{
    public static async Task<int> Main(string[] args)
    {
        var dataDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "DiskHunter");
        for (var i = 0; i < args.Length - 1; i++)
        {
            if (args[i] == "--data") dataDir = args[i + 1];
        }
        var allowSynthetic = Environment.GetEnvironmentVariable("DISKHUNTER_TEST") == "1";
        using var input = Console.OpenStandardInput();
        using var output = Console.OpenStandardOutput();
        var server = new Server(dataDir, allowSynthetic, output);
        await server.Run(input);
        return 0;
    }
}

public sealed class Server
{
    private readonly string _dataDir;
    private readonly bool _allowSynthetic;
    private readonly Channel<byte[]> _outgoing = Channel.CreateUnbounded<byte[]>(new UnboundedChannelOptions { SingleReader = true });
    private readonly Stream _output;
    private readonly SnapshotRepository _snapshots;
    private readonly object _gate = new();
    private readonly Dictionary<long, CancellationTokenSource> _requests = new();
    private static readonly JsonWriterOptions WriterOptions = new() { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping, SkipValidation = true };

    private NodeStore? _store;
    private ScanResult? _scan;
    private CancellationTokenSource? _scanCts;
    private Task? _scanTask;
    private CancellationTokenSource? _dupCts;
    private Task? _dupTask;
    private DupResult? _dups;
    private string _lastKey = "";
    private int _lastVersion = -1;
    private QueryResult? _lastResult;
    private SnapshotHeader? _lastSnapshot;
    private long _volumeTotal;
    private long _volumeFree;

    public Server(string dataDir, bool allowSynthetic, Stream output)
    {
        _dataDir = dataDir;
        _allowSynthetic = allowSynthetic;
        _output = output;
        _snapshots = new SnapshotRepository(dataDir);
    }

    public async Task Run(Stream input)
    {
        var writer = Task.Run(WriteLoop);
        using var reader = new StreamReader(input, new UTF8Encoding(false));
        while (true)
        {
            var line = await reader.ReadLineAsync();
            if (line == null) break;
            if (line.Length == 0) continue;
            _ = Task.Run(() => Dispatch(line));
        }
        _scanCts?.Cancel();
        _dupCts?.Cancel();
        _outgoing.Writer.TryComplete();
        await writer;
    }

    private async Task WriteLoop()
    {
        await foreach (var data in _outgoing.Reader.ReadAllAsync())
        {
            await _output.WriteAsync(data);
            await _output.FlushAsync();
        }
    }

    private void Emit(Action<Utf8JsonWriter> body)
    {
        var buffer = new ArrayBufferWriter<byte>(512);
        using (var json = new Utf8JsonWriter(buffer, WriterOptions)) body(json);
        buffer.Write("\n"u8);
        _outgoing.Writer.TryWrite(buffer.WrittenSpan.ToArray());
    }

    private void Event(string name, Action<Utf8JsonWriter> payload) => Emit(w =>
    {
        w.WriteStartObject();
        w.WriteString("event", name);
        w.WritePropertyName("data");
        w.WriteStartObject();
        payload(w);
        w.WriteEndObject();
        w.WriteEndObject();
    });

    private void Dispatch(string line)
    {
        long id = -1;
        CancellationTokenSource? cts = null;
        try
        {
            using var doc = JsonDocument.Parse(line);
            var root = doc.RootElement;
            id = root.GetProperty("id").GetInt64();
            var command = root.GetProperty("cmd").GetString() ?? "";
            var args = root.TryGetProperty("args", out var a) ? a : default;
            cts = new CancellationTokenSource();
            lock (_gate) _requests[id] = cts;
            var token = cts.Token;
            Emit(w =>
            {
                w.WriteStartObject();
                w.WriteNumber("id", id);
                w.WriteBoolean("ok", true);
                w.WritePropertyName("data");
                Handle(command, args, w, token);
                w.WriteEndObject();
            });
        }
        catch (Exception e)
        {
            var code = e is OperationCanceledException ? "cancelled" : e is EngineError known ? known.Code : "internal";
            var message = e.Message;
            var requestId = id;
            Emit(w =>
            {
                w.WriteStartObject();
                w.WriteNumber("id", requestId);
                w.WriteBoolean("ok", false);
                w.WriteStartObject("error");
                w.WriteString("code", code);
                Text.Write(w, "message", message);
                w.WriteEndObject();
                w.WriteEndObject();
            });
        }
        finally
        {
            lock (_gate) _requests.Remove(id);
            cts?.Dispose();
        }
    }

    private void Handle(string command, JsonElement args, Utf8JsonWriter w, CancellationToken token)
    {
        switch (command)
        {
            case "ping": w.WriteStartObject(); w.WriteString("version", "1.0.0"); w.WriteEndObject(); break;
            case "cancel": CancelRequest(args, w); break;
            case "drives.list": DrivesList(w); break;
            case "scan.start": ScanStart(args, w); break;
            case "scan.cancel": _scanCts?.Cancel(); w.WriteNullValue(); break;
            case "scan.errors": ScanErrors(args, w); break;
            case "scan.summary": WriteSummary(w); break;
            case "node.children": NodeChildren(args, w, token); break;
            case "node.info": NodeInfo(args, w); break;
            case "node.find": NodeFind(args, w); break;
            case "node.chain": NodeChain(args, w); break;
            case "node.remove": NodeRemove(args, w); break;
            case "treemap": Treemap(args, w); break;
            case "query": QueryCommand(args, w, token); break;
            case "stats": Stats(args, w, token); break;
            case "cleanup": CleanupCommand(args, w, token); break;
            case "dups.start": DupsStart(args, w); break;
            case "dups.cancel": _dupCts?.Cancel(); w.WriteNullValue(); break;
            case "dups.page": DupsPage(args, w); break;
            case "dups.verify": DupsVerify(args, w, token); break;
            case "models": Models(w, token); break;
            case "snapshots.list": SnapshotsList(args, w); break;
            case "snapshots.compare": SnapshotsCompare(args, w); break;
            default: throw new EngineError("unknown-command", command);
        }
    }

    private NodeStore Require() => _store ?? throw new EngineError("no-scan", "Nenhuma análise carregada.");

    private void CancelRequest(JsonElement args, Utf8JsonWriter w)
    {
        var target = args.GetProperty("target").GetInt64();
        lock (_gate)
        {
            if (_requests.TryGetValue(target, out var cts)) cts.Cancel();
        }
        w.WriteNullValue();
    }

    private static void DrivesList(Utf8JsonWriter w)
    {
        w.WriteStartArray();
        foreach (var drive in DriveInfo.GetDrives())
        {
            w.WriteStartObject();
            Text.Write(w, "path", drive.Name);
            w.WriteString("type", drive.DriveType.ToString());
            var ready = false;
            try
            {
                ready = drive.IsReady;
                if (ready)
                {
                    Text.Write(w, "label", drive.VolumeLabel);
                    w.WriteString("format", drive.DriveFormat);
                    w.WriteNumber("total", drive.TotalSize);
                    w.WriteNumber("free", drive.TotalFreeSpace);
                    w.WriteBoolean("hdd", Native.HasSeekPenalty(drive.Name));
                }
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                ready = false;
            }
            w.WriteBoolean("ready", ready);
            w.WriteEndObject();
        }
        w.WriteEndArray();
    }

    private void ScanStart(JsonElement args, Utf8JsonWriter w)
    {
        if (_scanTask is { IsCompleted: false }) throw new EngineError("busy", "Já existe uma análise em andamento.");
        _dupCts?.Cancel();
        var requested = args.GetProperty("path").GetString() ?? "";
        var excludes = args.TryGetProperty("excludes", out var ex) && ex.ValueKind == JsonValueKind.Array ? ex.EnumerateArray().Select(e => e.GetString() ?? "").Where(e => e.Length > 0).ToArray() : Array.Empty<string>();
        IDirectorySource source;
        long expected = 0;
        string path;
        long total = 0, free = 0;
        var threads = args.TryGetProperty("threads", out var t) && t.ValueKind == JsonValueKind.Number ? t.GetInt32() : 0;

        if (_allowSynthetic && args.TryGetProperty("synthetic", out var synthetic))
        {
            path = requested;
            var files = synthetic.GetProperty("files").GetInt64();
            var growth = synthetic.TryGetProperty("growth", out var g) ? g.GetDouble() : 0;
            source = new SyntheticSource(path, files, growth);
            total = synthetic.TryGetProperty("total", out var st) ? st.GetInt64() : 1_000_000_000_000;
            free = synthetic.TryGetProperty("free", out var sf) ? sf.GetInt64() : 200_000_000_000;
        }
        else
        {
            path = Path.GetFullPath(requested);
            if (!Directory.Exists(Native.LongPath(path))) throw new EngineError("not-found", "Esta pasta não existe ou não está acessível.");
            source = new NtDirectorySource();
            var isDrive = path.TrimEnd('\\').Length == 2;
            if (path.Length >= 2 && path[1] == ':')
            {
                try
                {
                    var drive = new DriveInfo(path[..1]);
                    total = drive.TotalSize;
                    free = drive.TotalFreeSpace;
                    if (isDrive) expected = total - free;
                }
                catch (Exception e) when (e is IOException or UnauthorizedAccessException or ArgumentException)
                {
                }
            }
            if (threads <= 0 && Native.HasSeekPenalty(path)) threads = 2;
        }

        _volumeTotal = total;
        _volumeFree = free;
        _scanCts = new CancellationTokenSource();
        var token = _scanCts.Token;
        var options = new ScanOptions { Threads = threads, Excludes = excludes };
        var saveSnapshot = !(args.TryGetProperty("snapshot", out var snap) && snap.ValueKind == JsonValueKind.False);
        var clock = args.TryGetProperty("clock", out var c) && _allowSynthetic ? c.GetInt64() : (long?)null;

        _scanTask = Task.Run(() =>
        {
            try
            {
                var result = new Scanner(source, options).Run(path, p =>
                {
                    Event("scan.progress", e =>
                    {
                        e.WriteNumber("files", p.Files);
                        e.WriteNumber("dirs", p.Dirs);
                        e.WriteNumber("bytes", p.Bytes);
                        e.WriteNumber("alloc", p.Alloc);
                        e.WriteNumber("errors", p.Errors);
                        e.WriteNumber("elapsed", p.Elapsed);
                        e.WriteNumber("expected", expected);
                        e.WriteString("phase", p.Phase);
                        Text.Write(e, "current", p.Current);
                    });
                }, token);

                var store = result.Store;
                store.Lock.EnterWriteLock();
                try
                {
                    _store = store;
                    _scan = result;
                    _dups = null;
                    _lastResult = null;
                    _lastSnapshot = null;
                }
                finally
                {
                    store.Lock.ExitWriteLock();
                }
                if (!result.Cancelled && saveSnapshot)
                {
                    try
                    {
                        _lastSnapshot = _snapshots.Save(store, total, free, clock);
                    }
                    catch (Exception)
                    {
                        _lastSnapshot = null;
                    }
                }
                GC.Collect(2, GCCollectionMode.Optimized, false);
                Event("scan.done", WriteSummaryFields);
            }
            catch (Exception e)
            {
                Event("scan.failed", p => Text.Write(p, "message", e.Message));
            }
        });

        w.WriteStartObject();
        Text.Write(w, "path", path);
        w.WriteEndObject();
    }

    private void WriteSummary(Utf8JsonWriter w)
    {
        if (_store == null)
        {
            w.WriteNullValue();
            return;
        }
        w.WriteStartObject();
        WriteSummaryFields(w);
        w.WriteEndObject();
    }

    private void WriteSummaryFields(Utf8JsonWriter e)
    {
        var store = Require();
        var scan = _scan!;
        store.Lock.EnterReadLock();
        try
        {
            ref var root = ref store[0];
            Text.Write(e, "path", store.RootPath);
            e.WriteNumber("alloc", root.Alloc);
            e.WriteNumber("size", root.Size);
            e.WriteNumber("files", root.Files);
            e.WriteNumber("nodes", store.Count);
            e.WriteNumber("elapsed", scan.Elapsed);
            e.WriteBoolean("cancelled", scan.Cancelled);
            e.WriteNumber("errors", scan.Errors);
            e.WriteNumber("hardlinks", scan.Hardlinks);
            e.WriteNumber("links", scan.Links);
            e.WriteNumber("threads", scan.Threads);
            e.WriteNumber("volumeTotal", _volumeTotal);
            e.WriteNumber("volumeFree", _volumeFree);
            e.WriteNumber("removed", store.RemovedAlloc);
            e.WriteNumber("memory", store.ApproximateMemory());
            e.WriteBoolean("isDrive", store.RootPath.TrimEnd('\\').Length == 2);
            if (_lastSnapshot != null) e.WriteString("snapshot", _lastSnapshot.Id);
            else e.WriteNull("snapshot");
        }
        finally
        {
            store.Lock.ExitReadLock();
        }
    }

    private void ScanErrors(JsonElement args, Utf8JsonWriter w)
    {
        var scan = _scan;
        w.WriteStartObject();
        w.WriteNumber("total", scan?.Errors ?? 0);
        w.WriteStartArray("items");
        if (scan != null)
        {
            var offset = GetInt(args, "offset", 0);
            var limit = GetInt(args, "limit", 200);
            lock (scan.ErrorList)
            {
                foreach (var error in scan.ErrorList.Skip(offset).Take(limit))
                {
                    w.WriteStartObject();
                    Text.Write(w, "path", error.Path);
                    w.WriteNumber("code", error.Code);
                    w.WriteEndObject();
                }
            }
        }
        w.WriteEndArray();
        w.WriteEndObject();
    }

    private static int GetInt(JsonElement args, string name, int fallback) => args.ValueKind == JsonValueKind.Object && args.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetInt32() : fallback;
    private static long? GetLong(JsonElement args, string name) => args.ValueKind == JsonValueKind.Object && args.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetInt64() : null;
    private static string? GetString(JsonElement args, string name) => args.ValueKind == JsonValueKind.Object && args.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
    private static bool GetBool(JsonElement args, string name) => args.ValueKind == JsonValueKind.Object && args.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.True;

    private static int ValidId(NodeStore store, int id)
    {
        if (id < 0 || id >= store.Count || (store[id].Flags & NodeFlags.Deleted) != 0) throw new EngineError("gone", "Este item não está mais na análise.");
        return id;
    }

    private static void WriteItem(Utf8JsonWriter w, NodeStore store, int id, bool withPath, Dictionary<int, string>? parents = null)
    {
        ref var node = ref store[id];
        w.WriteStartObject();
        w.WriteNumber("id", id);
        Text.Write(w, "name", id == 0 ? store.RootPath.AsSpan() : store.Name(id));
        w.WriteNumber("size", store.EffectiveSize(id));
        w.WriteNumber("alloc", store.EffectiveAlloc(id));
        w.WriteNumber("rawSize", node.Size);
        w.WriteNumber("mtime", node.MTime);
        w.WriteNumber("flags", node.Flags);
        w.WriteNumber("cat", store.Category(id));
        w.WriteString("ext", store.Ext(id));
        w.WriteNumber("files", node.Files);
        w.WriteNumber("children", node.Count);
        if (withPath && id > 0)
        {
            var parent = node.Parent;
            string? parentPath = null;
            if (parents != null && !parents.TryGetValue(parent, out parentPath))
            {
                parentPath = store.Path(parent);
                parents[parent] = parentPath;
            }
            Text.Write(w, "dir", parentPath ?? store.Path(parent));
            w.WriteNumber("parent", parent);
        }
        w.WriteEndObject();
    }

    private void NodeChildren(JsonElement args, Utf8JsonWriter w, CancellationToken token)
    {
        var store = Require();
        store.Lock.EnterReadLock();
        try
        {
            var id = ValidId(store, GetInt(args, "id", 0));
            var items = Query.Children(store, id, GetString(args, "sort") ?? "size", GetBool(args, "asc"), GetBool(args, "logical"));
            var offset = Math.Max(0, GetInt(args, "offset", 0));
            var limit = Math.Clamp(GetInt(args, "limit", 200), 1, 5000);
            w.WriteStartObject();
            w.WriteNumber("total", items.Length);
            w.WriteStartArray("items");
            for (var i = offset; i < Math.Min(items.Length, offset + limit); i++) WriteItem(w, store, items[i], false);
            w.WriteEndArray();
            w.WriteEndObject();
        }
        finally
        {
            store.Lock.ExitReadLock();
        }
    }

    private void NodeInfo(JsonElement args, Utf8JsonWriter w)
    {
        var store = Require();
        store.Lock.EnterReadLock();
        try
        {
            w.WriteStartArray();
            foreach (var value in args.GetProperty("ids").EnumerateArray())
            {
                var id = value.GetInt32();
                if (id < 0 || id >= store.Count || (store[id].Flags & NodeFlags.Deleted) != 0)
                {
                    w.WriteStartObject();
                    w.WriteNumber("id", id);
                    w.WriteBoolean("gone", true);
                    w.WriteEndObject();
                    continue;
                }
                w.WriteStartObject();
                w.WriteNumber("id", id);
                Text.Write(w, "path", store.Path(id));
                Text.Write(w, "name", id == 0 ? store.RootPath.AsSpan() : store.Name(id));
                w.WriteBoolean("lossy", Text.IsLossy(store.Path(id)));
                w.WriteNumber("size", store.EffectiveSize(id));
                w.WriteNumber("alloc", store.EffectiveAlloc(id));
                w.WriteNumber("rawSize", store[id].Size);
                w.WriteNumber("mtime", store[id].MTime);
                w.WriteNumber("flags", store[id].Flags);
                w.WriteNumber("cat", store.Category(id));
                w.WriteString("ext", store.Ext(id));
                w.WriteNumber("files", store[id].Files);
                w.WriteNumber("children", store[id].Count);
                var isDir = (store[id].Flags & NodeFlags.Dir) != 0;
                var unread = (store[id].Flags & (NodeFlags.Denied | NodeFlags.Partial | NodeFlags.Excluded | NodeFlags.Incomplete)) != 0;
                w.WriteBoolean("incomplete", isDir && (unread || _scan?.Cancelled == true));
                w.WriteEndObject();
            }
            w.WriteEndArray();
        }
        finally
        {
            store.Lock.ExitReadLock();
        }
    }

    private void NodeFind(JsonElement args, Utf8JsonWriter w)
    {
        var store = Require();
        store.Lock.EnterReadLock();
        try
        {
            var found = store.Find(args.GetProperty("path").GetString() ?? "");
            if (found < 0) w.WriteNullValue();
            else w.WriteNumberValue(found);
        }
        finally
        {
            store.Lock.ExitReadLock();
        }
    }

    private void NodeChain(JsonElement args, Utf8JsonWriter w)
    {
        var store = Require();
        store.Lock.EnterReadLock();
        try
        {
            var chain = new List<int>();
            var id = ValidId(store, GetInt(args, "id", 0));
            while (id >= 0)
            {
                chain.Add(id);
                id = store[id].Parent;
            }
            chain.Reverse();
            w.WriteStartArray();
            foreach (var item in chain) WriteItem(w, store, item, false);
            w.WriteEndArray();
        }
        finally
        {
            store.Lock.ExitReadLock();
        }
    }

    private void NodeRemove(JsonElement args, Utf8JsonWriter w)
    {
        var store = Require();
        store.Lock.EnterWriteLock();
        try
        {
            var removed = 0;
            foreach (var value in args.GetProperty("ids").EnumerateArray())
            {
                if (store.Remove(value.GetInt32())) removed++;
            }
            _lastResult = null;
            w.WriteNumberValue(removed);
        }
        finally
        {
            store.Lock.ExitWriteLock();
        }
    }

    private void Treemap(JsonElement args, Utf8JsonWriter w)
    {
        var store = Require();
        store.Lock.EnterReadLock();
        try
        {
            var id = ValidId(store, GetInt(args, "id", 0));
            var budget = Math.Clamp(GetInt(args, "budget", 6000), 16, 40000);
            var logical = GetBool(args, "logical");
            var entries = TreemapBuilder.Build(store, id, budget, logical, 0.00002);
            w.WriteStartObject();
            w.WriteNumber("id", id);
            w.WriteStartArray("nodes");
            foreach (var entry in entries)
            {
                w.WriteStartArray();
                w.WriteNumberValue(entry.Id);
                w.WriteNumberValue(entry.Parent);
                Text.WriteValue(w, entry.Name);
                w.WriteNumberValue(entry.Size);
                w.WriteNumberValue(entry.Cat);
                w.WriteNumberValue(entry.Kind);
                w.WriteNumberValue(entry.Hidden);
                w.WriteEndArray();
            }
            w.WriteEndArray();
            w.WriteEndObject();
        }
        finally
        {
            store.Lock.ExitReadLock();
        }
    }

    private static QueryFilter ParseFilter(JsonElement args)
    {
        var filter = new QueryFilter
        {
            Kind = GetString(args, "kind") ?? "file",
            Text = GetString(args, "text"),
            MinSize = GetLong(args, "minSize"),
            MaxSize = GetLong(args, "maxSize"),
            Logical = GetBool(args, "logical"),
            Sort = GetString(args, "sort") ?? "size",
            Ascending = GetBool(args, "asc"),
        };
        var after = GetLong(args, "after");
        var before = GetLong(args, "before");
        if (after != null) filter.ModifiedAfter = (uint)Math.Clamp(after.Value, 0, uint.MaxValue);
        if (before != null) filter.ModifiedBefore = (uint)Math.Clamp(before.Value, 0, uint.MaxValue);
        var within = GetLong(args, "within");
        if (within != null) filter.Within = (int)within.Value;
        if (args.ValueKind == JsonValueKind.Object && args.TryGetProperty("exts", out var exts) && exts.ValueKind == JsonValueKind.Array && exts.GetArrayLength() > 0)
        {
            filter.Exts = new HashSet<string>(exts.EnumerateArray().Select(e => (e.GetString() ?? "").TrimStart('.').ToLowerInvariant()), StringComparer.Ordinal);
        }
        if (args.ValueKind == JsonValueKind.Object && args.TryGetProperty("cats", out var cats) && cats.ValueKind == JsonValueKind.Array && cats.GetArrayLength() > 0)
        {
            filter.Cats = new HashSet<byte>(cats.EnumerateArray().Select(c => (byte)c.GetInt32()));
        }
        return filter;
    }

    private void QueryCommand(JsonElement args, Utf8JsonWriter w, CancellationToken token)
    {
        var store = Require();
        store.Lock.EnterReadLock();
        try
        {
            var filterArgs = args.TryGetProperty("filter", out var f) ? f : default;
            var key = filterArgs.ValueKind == JsonValueKind.Undefined ? "" : filterArgs.GetRawText();
            QueryResult result;
            lock (_gate)
            {
                result = key == _lastKey && _lastVersion == store.Version && _lastResult != null ? _lastResult : null!;
            }
            if (result == null)
            {
                var filter = ParseFilter(filterArgs);
                if (filter.Within is { } within) ValidId(store, within);
                result = Query.Run(store, filter, token);
                lock (_gate)
                {
                    _lastKey = key;
                    _lastVersion = store.Version;
                    _lastResult = result;
                }
            }
            var offset = Math.Max(0, GetInt(args, "offset", 0));
            var limit = Math.Clamp(GetInt(args, "limit", 100), 1, 2000);
            var parents = new Dictionary<int, string>();
            w.WriteStartObject();
            w.WriteNumber("total", result.Total);
            w.WriteNumber("totalBytes", result.TotalBytes);
            w.WriteBoolean("capped", result.Capped);
            w.WriteNumber("window", result.Items.Length);
            w.WriteStartArray("items");
            for (var i = offset; i < Math.Min(result.Items.Length, offset + limit); i++)
            {
                if ((store[result.Items[i]].Flags & NodeFlags.Deleted) != 0) continue;
                WriteItem(w, store, result.Items[i], true, parents);
            }
            w.WriteEndArray();
            w.WriteEndObject();
        }
        finally
        {
            store.Lock.ExitReadLock();
        }
    }

    private void Stats(JsonElement args, Utf8JsonWriter w, CancellationToken token)
    {
        var store = Require();
        store.Lock.EnterReadLock();
        try
        {
            var logical = GetBool(args, "logical");
            var cats = new long[Categories.Total];
            var catCounts = new long[Categories.Total];
            var extBytes = new long[store.ExtCount];
            var extCounts = new long[store.ExtCount];
            var ages = new long[5];
            var ageCounts = new long[5];
            var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
            long hidden = 0, cloud = 0, cloudCount = 0, largestSize = 0;
            var count = store.Count;
            for (var i = 1; i < count; i++)
            {
                if ((i & 0xFFFF) == 0) token.ThrowIfCancellationRequested();
                ref var node = ref store[i];
                if ((node.Flags & (NodeFlags.Dir | NodeFlags.Deleted)) != 0) continue;
                var value = store.Metric(i, logical);
                var cat = store.CategoryOfExt(node.Ext);
                cats[cat] += value;
                catCounts[cat]++;
                extBytes[node.Ext] += value;
                extCounts[node.Ext]++;
                var days = (now - node.MTime) / 86400;
                var bucket = days <= 30 ? 0 : days <= 90 ? 1 : days <= 365 ? 2 : days <= 1095 ? 3 : 4;
                ages[bucket] += value;
                ageCounts[bucket]++;
                if ((node.Flags & NodeFlags.Hidden) != 0) hidden += value;
                if ((node.Flags & NodeFlags.Cloud) != 0)
                {
                    cloud += node.Size;
                    cloudCount++;
                }
                if (value > largestSize) largestSize = value;
            }
            w.WriteStartObject();
            w.WriteStartArray("categories");
            for (var c = 0; c < cats.Length; c++)
            {
                w.WriteStartObject();
                w.WriteNumber("cat", c);
                w.WriteNumber("bytes", cats[c]);
                w.WriteNumber("count", catCounts[c]);
                w.WriteEndObject();
            }
            w.WriteEndArray();
            w.WriteStartArray("exts");
            foreach (var e in Enumerable.Range(0, extBytes.Length).OrderByDescending(x => extBytes[x]).Take(60))
            {
                if (extCounts[e] == 0) continue;
                w.WriteStartObject();
                w.WriteString("ext", store.ExtName((ushort)e));
                w.WriteNumber("bytes", extBytes[e]);
                w.WriteNumber("count", extCounts[e]);
                w.WriteNumber("cat", store.CategoryOfExt((ushort)e));
                w.WriteEndObject();
            }
            w.WriteEndArray();
            w.WriteStartArray("ages");
            for (var a = 0; a < ages.Length; a++)
            {
                w.WriteStartObject();
                w.WriteNumber("bucket", a);
                w.WriteNumber("bytes", ages[a]);
                w.WriteNumber("count", ageCounts[a]);
                w.WriteEndObject();
            }
            w.WriteEndArray();
            w.WriteNumber("hidden", hidden);
            w.WriteNumber("cloud", cloud);
            w.WriteNumber("cloudCount", cloudCount);
            w.WriteEndObject();
        }
        finally
        {
            store.Lock.ExitReadLock();
        }
    }

    private void CleanupCommand(JsonElement args, Utf8JsonWriter w, CancellationToken token)
    {
        var store = Require();
        store.Lock.EnterReadLock();
        try
        {
            var options = new CleanupOptions
            {
                DownloadsDays = Math.Clamp(GetInt(args, "downloadsDays", 180), 1, 3650),
                InstallerDays = Math.Clamp(GetInt(args, "installerDays", 30), 1, 3650),
            };
            var list = Cleanup.Evaluate(store, options, token);
            var parents = new Dictionary<int, string>();
            w.WriteStartObject();
            w.WriteNumber("recoverable", list.Where(r => r.Action == "trash").Sum(r => r.Bytes));
            w.WriteStartArray("items");
            foreach (var rec in list)
            {
                w.WriteStartObject();
                w.WriteString("id", rec.Id);
                w.WriteString("group", rec.Group);
                w.WriteString("title", rec.Title);
                w.WriteString("why", rec.Why);
                w.WriteString("risk", rec.Risk);
                w.WriteString("action", rec.Action);
                if (rec.Note != null) w.WriteString("note", rec.Note);
                w.WriteNumber("bytes", rec.Bytes);
                w.WriteNumber("count", rec.Count);
                w.WriteStartArray("items");
                foreach (var id in rec.Items) WriteItem(w, store, id, true, parents);
                w.WriteEndArray();
                w.WriteEndObject();
            }
            w.WriteEndArray();
            w.WriteEndObject();
        }
        finally
        {
            store.Lock.ExitReadLock();
        }
    }

    private void DupsStart(JsonElement args, Utf8JsonWriter w)
    {
        var store = Require();
        if (_dupTask is { IsCompleted: false }) throw new EngineError("busy", "A busca de duplicatas já está em andamento.");
        var hdd = Native.HasSeekPenalty(store.RootPath);
        var options = new DupOptions
        {
            MinSize = Math.Max(1, GetLong(args, "minSize") ?? 1024 * 1024),
            IncludeSystem = GetBool(args, "includeSystem"),
            Threads = hdd ? 1 : Math.Clamp(Environment.ProcessorCount / 2, 2, 6),
        };
        _dupCts = new CancellationTokenSource();
        var token = _dupCts.Token;
        _dups = null;
        _dupTask = Task.Run(() =>
        {
            try
            {
                var last = 0L;
                var result = Duplicates.Run(store, options, p =>
                {
                    var now = Environment.TickCount64;
                    var previous = Interlocked.Read(ref last);
                    if (now - previous < 100 || Interlocked.CompareExchange(ref last, now, previous) != previous) return;
                    Event("dups.progress", e =>
                    {
                        e.WriteString("stage", p.Stage);
                        e.WriteNumber("bytesDone", Volatile.Read(ref p.BytesDone));
                        e.WriteNumber("bytesTotal", p.BytesTotal);
                        e.WriteNumber("candidates", p.Candidates);
                        e.WriteNumber("groups", Volatile.Read(ref p.Groups));
                    });
                }, token);
                _dups = result;
                Event("dups.done", e => WriteDupSummary(e, result));
            }
            catch (Exception e)
            {
                Event("dups.failed", p => Text.Write(p, "message", e.Message));
            }
        });
        w.WriteNullValue();
    }

    private static void WriteDupSummary(Utf8JsonWriter e, DupResult result)
    {
        e.WriteNumber("groups", result.Groups.Count);
        e.WriteNumber("wasted", result.Wasted);
        e.WriteNumber("skipped", result.Skipped);
        e.WriteNumber("scanned", result.Scanned);
        e.WriteNumber("elapsed", result.Elapsed);
        e.WriteBoolean("cancelled", result.Cancelled);
    }

    private void DupsPage(JsonElement args, Utf8JsonWriter w)
    {
        var store = Require();
        var result = _dups;
        if (result == null)
        {
            w.WriteNullValue();
            return;
        }
        store.Lock.EnterReadLock();
        try
        {
            var offset = Math.Max(0, GetInt(args, "offset", 0));
            var limit = Math.Clamp(GetInt(args, "limit", 100), 1, 1000);
            var parents = new Dictionary<int, string>();
            w.WriteStartObject();
            WriteDupSummary(w, result);
            w.WriteStartArray("skippedPaths");
            foreach (var path in result.SkippedPaths.Take(100)) Text.WriteValue(w, path);
            w.WriteEndArray();
            w.WriteStartArray("items");
            foreach (var group in result.Groups.Skip(offset).Take(limit))
            {
                var alive = group.Files.Where(id => (store[id].Flags & NodeFlags.Deleted) == 0).ToArray();
                w.WriteStartObject();
                w.WriteString("hash", group.Hash);
                w.WriteNumber("size", group.Size);
                w.WriteNumber("wasted", Math.Max(0, alive.Length - 1) * group.Size);
                w.WriteStartArray("files");
                foreach (var id in alive) WriteItem(w, store, id, true, parents);
                w.WriteEndArray();
                w.WriteEndObject();
            }
            w.WriteEndArray();
            w.WriteEndObject();
        }
        finally
        {
            store.Lock.ExitReadLock();
        }
    }

    private void DupsVerify(JsonElement args, Utf8JsonWriter w, CancellationToken token)
    {
        var store = Require();
        string left, right;
        store.Lock.EnterReadLock();
        try
        {
            left = store.Path(ValidId(store, GetInt(args, "keep", -1)));
            right = store.Path(ValidId(store, GetInt(args, "other", -1)));
        }
        finally
        {
            store.Lock.ExitReadLock();
        }
        var same = false;
        try
        {
            same = !left.Equals(right, StringComparison.OrdinalIgnoreCase) && Duplicates.SameContent(left, right, token);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            same = false;
        }
        w.WriteBooleanValue(same);
    }

    private void Models(Utf8JsonWriter w, CancellationToken token)
    {
        var store = Require();
        var list = AiModels.Find(store, token);
        w.WriteStartObject();
        w.WriteNumber("bytes", list.Sum(m => m.Size));
        w.WriteStartArray("items");
        foreach (var model in list)
        {
            w.WriteStartObject();
            w.WriteNumber("id", model.Id);
            Text.Write(w, "path", model.Path);
            Text.Write(w, "name", model.Name);
            w.WriteString("format", model.Format);
            w.WriteNumber("size", model.Size);
            w.WriteNumber("parts", model.Parts);
            w.WriteString("confidence", model.Confidence);
            if (model.Arch != null) Text.Write(w, "arch", model.Arch);
            if (model.Quant != null) w.WriteString("quant", model.Quant);
            if (model.Tensors != null) w.WriteNumber("tensors", model.Tensors.Value);
            if (model.Runner != null) w.WriteString("runner", model.Runner);
            w.WriteNumber("mtime", model.MTime);
            w.WriteStartArray("partIds");
            foreach (var id in model.PartIds) w.WriteNumberValue(id);
            w.WriteEndArray();
            w.WriteEndObject();
        }
        w.WriteEndArray();
        w.WriteEndObject();
    }

    private void SnapshotsList(JsonElement args, Utf8JsonWriter w)
    {
        var list = _snapshots.List(GetString(args, "path"));
        w.WriteStartArray();
        foreach (var item in list) WriteSnapshot(w, item);
        w.WriteEndArray();
    }

    private static void WriteSnapshot(Utf8JsonWriter w, SnapshotHeader h)
    {
        w.WriteStartObject();
        w.WriteString("id", h.Id);
        Text.Write(w, "root", h.Root);
        w.WriteNumber("time", h.Time);
        w.WriteNumber("alloc", h.Alloc);
        w.WriteNumber("size", h.Size);
        w.WriteNumber("files", h.Files);
        w.WriteNumber("dirs", h.Dirs);
        w.WriteNumber("volumeTotal", h.VolumeTotal);
        w.WriteNumber("volumeFree", h.VolumeFree);
        w.WriteEndObject();
    }

    private void SnapshotsCompare(JsonElement args, Utf8JsonWriter w)
    {
        var path = GetString(args, "path") ?? throw new EngineError("bad-args", "path");
        var result = _snapshots.Compare(path, GetString(args, "base") ?? "", GetString(args, "target") ?? "");
        w.WriteStartObject();
        w.WritePropertyName("base");
        WriteSnapshot(w, result.Base);
        w.WritePropertyName("target");
        WriteSnapshot(w, result.Target);
        w.WriteNumber("grown", result.Grown);
        w.WriteNumber("shrunk", result.Shrunk);
        w.WriteStartArray("items");
        foreach (var item in result.Items)
        {
            w.WriteStartObject();
            Text.Write(w, "path", item.Path);
            w.WriteNumber("before", item.Before);
            w.WriteNumber("after", item.After);
            w.WriteNumber("delta", item.Delta);
            w.WriteNumber("filesDelta", item.FilesDelta);
            w.WriteString("status", item.Status);
            w.WriteEndObject();
        }
        w.WriteEndArray();
        w.WriteEndObject();
    }
}

public sealed class EngineError : Exception
{
    public string Code { get; }
    public EngineError(string code, string message) : base(message) => Code = code;
}

public static class Text
{
    public static bool IsLossy(ReadOnlySpan<char> value)
    {
        for (var i = 0; i < value.Length; i++)
        {
            var c = value[i];
            if (!char.IsSurrogate(c)) continue;
            if (char.IsHighSurrogate(c) && i + 1 < value.Length && char.IsLowSurrogate(value[i + 1]))
            {
                i++;
                continue;
            }
            return true;
        }
        return false;
    }

    public static string Clean(ReadOnlySpan<char> value)
    {
        if (!IsLossy(value)) return value.ToString();
        var builder = new StringBuilder(value.Length);
        for (var i = 0; i < value.Length; i++)
        {
            var c = value[i];
            if (char.IsHighSurrogate(c) && i + 1 < value.Length && char.IsLowSurrogate(value[i + 1]))
            {
                builder.Append(c).Append(value[++i]);
            }
            else
            {
                builder.Append(char.IsSurrogate(c) ? '�' : c);
            }
        }
        return builder.ToString();
    }

    public static void Write(Utf8JsonWriter w, string name, ReadOnlySpan<char> value)
    {
        if (IsLossy(value)) w.WriteString(name, Clean(value));
        else w.WriteString(name, value);
    }

    public static void Write(Utf8JsonWriter w, string name, string value) => Write(w, name, value.AsSpan());

    public static void WriteValue(Utf8JsonWriter w, string value)
    {
        if (IsLossy(value)) w.WriteStringValue(Clean(value));
        else w.WriteStringValue(value);
    }
}
