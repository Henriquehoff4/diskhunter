using System.Collections.Concurrent;
using System.Diagnostics;

namespace DiskHunter.Engine;

public sealed class ScanOptions
{
    public int Threads;
    public string[] Excludes = Array.Empty<string>();
    public int MaxDepth = 2048;
}

public sealed class ScanProgress
{
    public long Files;
    public long Dirs;
    public long Bytes;
    public long Alloc;
    public long Errors;
    public int Pending;
    public double Elapsed;
    public string Current = "";
    public string Phase = "scan";
}

public sealed record ScanError(string Path, int Code);

public sealed class ScanResult
{
    public required NodeStore Store;
    public required bool Cancelled;
    public required double Elapsed;
    public required long Errors;
    public required List<ScanError> ErrorList;
    public required int Hardlinks;
    public required long Links;
    public required int Threads;
}

public sealed class Scanner
{
    private readonly record struct Work(int Node, string Path, int Depth);

    private const int MaxErrorList = 5000;
    private readonly IDirectorySource _source;
    private readonly ScanOptions _options;
    private readonly ConcurrentStack<Work> _stack = new();
    private readonly List<ScanError> _errorList = new();
    private readonly HashSet<string> _excludes;
    private long _files, _dirs, _bytes, _alloc, _errors, _links;
    private int _pending;
    private volatile string _current = "";

    public Scanner(IDirectorySource source, ScanOptions options)
    {
        _source = source;
        _options = options;
        _excludes = new HashSet<string>(options.Excludes.Select(e => e.TrimEnd('\\')), StringComparer.OrdinalIgnoreCase);
    }

    public ScanResult Run(string root, Action<ScanProgress>? progress, CancellationToken token)
    {
        var watch = Stopwatch.StartNew();
        var store = new NodeStore(root);
        var threads = Math.Clamp(_options.Threads > 0 ? _options.Threads : Math.Min(Environment.ProcessorCount, 8), 1, 32);
        _pending = 1;
        _stack.Push(new Work(0, root, 0));

        var workers = new Thread[threads];
        for (var i = 0; i < threads; i++)
        {
            workers[i] = new Thread(() => Worker(store, token), 1024 * 1024) { IsBackground = true, Priority = ThreadPriority.BelowNormal, Name = "scan" };
            workers[i].Start();
        }

        while (true)
        {
            var finished = true;
            foreach (var worker in workers)
            {
                if (!worker.Join(finished ? 100 : 0)) finished = false;
            }
            progress?.Invoke(Snapshot(watch));
            if (finished) break;
        }

        var cancelled = token.IsCancellationRequested;
        progress?.Invoke(new ScanProgress { Phase = "finalize", Files = _files, Dirs = _dirs, Bytes = _bytes, Alloc = _alloc, Errors = _errors, Elapsed = watch.Elapsed.TotalSeconds });
        var hardlinks = store.ResolveHardlinks();
        store.ReleaseIds();
        store.Rollup();
        return new ScanResult
        {
            Store = store,
            Cancelled = cancelled,
            Elapsed = watch.Elapsed.TotalSeconds,
            Errors = _errors,
            ErrorList = _errorList,
            Hardlinks = hardlinks,
            Links = _links,
            Threads = threads,
        };
    }

    private ScanProgress Snapshot(Stopwatch watch) => new()
    {
        Files = Interlocked.Read(ref _files),
        Dirs = Interlocked.Read(ref _dirs),
        Bytes = Interlocked.Read(ref _bytes),
        Alloc = Interlocked.Read(ref _alloc),
        Errors = Interlocked.Read(ref _errors),
        Pending = Volatile.Read(ref _pending),
        Elapsed = watch.Elapsed.TotalSeconds,
        Current = _current,
    };

    private void Worker(NodeStore store, CancellationToken token)
    {
        var sink = new Sink(store);
        var buffer = new byte[64 * 1024];
        var spin = new SpinWait();
        while (Volatile.Read(ref _pending) > 0)
        {
            if (token.IsCancellationRequested) return;
            if (!_stack.TryPop(out var work))
            {
                spin.SpinOnce(20);
                continue;
            }
            spin.Reset();
            try
            {
                Process(store, sink, buffer, work);
            }
            catch (Exception)
            {
                AddError(work.Path, -1);
                store[work.Node].Flags |= NodeFlags.Denied;
            }
            finally
            {
                Interlocked.Decrement(ref _pending);
            }
        }
    }

    private void Process(NodeStore store, Sink sink, byte[] buffer, in Work work)
    {
        sink.Reset();
        _current = work.Path;
        var error = _source.Read(work.Path, work.Depth == 0, sink, buffer);
        if (error != 0)
        {
            store[work.Node].Flags |= sink.Count > 0 ? NodeFlags.Partial : NodeFlags.Denied;
            AddError(work.Path, error);
        }
        Interlocked.Increment(ref _dirs);
        if (sink.Count == 0) return;

        var first = store.AddChildren(work.Node, sink.Entries, sink.Names);
        Interlocked.Add(ref _files, sink.FileCount);
        Interlocked.Add(ref _bytes, sink.BytesTotal);
        Interlocked.Add(ref _alloc, sink.AllocTotal);
        if (sink.LinkCount > 0) Interlocked.Add(ref _links, sink.LinkCount);
        if (sink.DirIndices.Count == 0) return;

        var trimmed = work.Path.EndsWith('\\') ? work.Path : work.Path + "\\";
        foreach (var offset in sink.DirIndices)
        {
            var index = first + offset;
            var path = string.Concat(trimmed, store.Name(index));
            if (_excludes.Count > 0 && _excludes.Contains(path))
            {
                store[index].Flags |= NodeFlags.Excluded;
                continue;
            }
            if (work.Depth + 1 > _options.MaxDepth)
            {
                store[index].Flags |= NodeFlags.Partial;
                continue;
            }
            Interlocked.Increment(ref _pending);
            _stack.Push(new Work(index, path, work.Depth + 1));
        }
    }

    private void AddError(string path, int code)
    {
        Interlocked.Increment(ref _errors);
        lock (_errorList)
        {
            if (_errorList.Count < MaxErrorList) _errorList.Add(new ScanError(path, code));
        }
    }

    private sealed class Sink : IEntrySink
    {
        private readonly NodeStore _store;
        private PendingEntry[] _entries = new PendingEntry[256];
        private char[] _names = new char[16 * 1024];
        private int _nameTop;

        public int Count;
        public int FileCount;
        public int LinkCount;
        public long BytesTotal;
        public long AllocTotal;
        public readonly List<int> DirIndices = new();

        public Sink(NodeStore store) => _store = store;
        public ReadOnlySpan<PendingEntry> Entries => _entries.AsSpan(0, Count);
        public ReadOnlySpan<char> Names => _names.AsSpan(0, _nameTop);

        public void Reset()
        {
            Count = 0;
            FileCount = 0;
            LinkCount = 0;
            BytesTotal = 0;
            AllocTotal = 0;
            _nameTop = 0;
            DirIndices.Clear();
        }

        public void Add(ReadOnlySpan<char> name, long size, long alloc, uint attributes, uint reparseTag, long lastWrite, ulong fileId)
        {
            if (Count == _entries.Length) Array.Resize(ref _entries, _entries.Length * 2);
            if (_nameTop + name.Length > _names.Length) Array.Resize(ref _names, Math.Max(_names.Length * 2, _nameTop + name.Length));
            name.CopyTo(_names.AsSpan(_nameTop));

            var isDir = (attributes & Attr.Directory) != 0;
            var isLink = (attributes & Attr.ReparsePoint) != 0 && Attr.IsNameSurrogate(reparseTag);
            ushort flags = 0;
            if (isDir) flags |= NodeFlags.Dir;
            if (isLink) flags |= NodeFlags.Link;
            if ((attributes & Attr.Hidden) != 0) flags |= NodeFlags.Hidden;
            if ((attributes & Attr.System) != 0) flags |= NodeFlags.System;
            if ((attributes & Attr.ReadOnly) != 0) flags |= NodeFlags.ReadOnly;
            if (Attr.IsCloud(attributes)) flags |= NodeFlags.Cloud;

            ref var entry = ref _entries[Count];
            entry = default;
            entry.NameStart = _nameTop;
            entry.NameLen = (ushort)name.Length;
            entry.Flags = flags;
            entry.MTime = ToUnix(lastWrite);
            entry.FileId = isDir || isLink ? 0 : fileId;
            if (!isDir)
            {
                entry.Size = isLink ? 0 : size;
                entry.Alloc = isLink ? 0 : alloc;
                entry.Ext = _store.InternExt(ExtensionOf(name));
                FileCount++;
                BytesTotal += entry.Size;
                AllocTotal += entry.Alloc;
            }
            if (isLink) LinkCount++;
            if (isDir && !isLink) DirIndices.Add(Count);
            _nameTop += name.Length;
            Count++;
        }

        private static ReadOnlySpan<char> ExtensionOf(ReadOnlySpan<char> name)
        {
            var dot = name.LastIndexOf('.');
            return dot <= 0 || dot == name.Length - 1 ? default : name[(dot + 1)..];
        }

        private static uint ToUnix(long fileTime)
        {
            const long epoch = 116444736000000000L;
            if (fileTime <= epoch) return 0;
            var seconds = (fileTime - epoch) / 10_000_000L;
            return seconds > uint.MaxValue ? uint.MaxValue : (uint)seconds;
        }
    }
}
