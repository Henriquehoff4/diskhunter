using System.Buffers;
using System.Collections.Concurrent;
using System.IO.Hashing;
using System.Security.Cryptography;

namespace DiskHunter.Engine;

public sealed class DupOptions
{
    public long MinSize = 1024 * 1024;
    public bool IncludeSystem;
    public int Threads = 4;
}

public sealed class DupProgress
{
    public string Stage = "group";
    public long BytesDone;
    public long BytesTotal;
    public int Candidates;
    public int Groups;
}

public sealed class DupGroup
{
    public required long Size;
    public required string Hash;
    public required int[] Files;
    public long Wasted => Size * (Files.Length - 1);
}

public sealed class DupResult
{
    public required List<DupGroup> Groups;
    public required long Wasted;
    public required int Skipped;
    public required List<string> SkippedPaths;
    public required bool Cancelled;
    public required int Scanned;
    public required double Elapsed;
}

public static class Duplicates
{
    private const int PartialBlock = 64 * 1024;
    private const int ChunkSize = 1024 * 1024;
    private static readonly string[] SystemRoots = { "Windows", "Program Files", "Program Files (x86)", "ProgramData", "$Recycle.Bin", "System Volume Information", "Recovery", "$WinREAgent", "Windows.old" };

    private sealed class Candidate
    {
        public required int Id;
        public required string Path;
        public required long Size;
        public required uint MTime;
        public string Hash = "";
    }

    public static bool[]? SystemMap(NodeStore store)
    {
        var root = store.RootPath;
        if (root.Length < 2 || root[1] != ':') return null;
        var drive = root[..2] + "\\";
        var map = new bool[store.Count];
        var any = false;
        foreach (var name in SystemRoots)
        {
            var path = drive + name;
            if (root.TrimEnd('\\').Equals(path, StringComparison.OrdinalIgnoreCase) || root.StartsWith(path + "\\", StringComparison.OrdinalIgnoreCase)) continue;
            var id = store.Find(path);
            if (id <= 0) continue;
            map[id] = true;
            any = true;
        }
        if (!any) return null;
        for (var i = 1; i < map.Length; i++)
        {
            var parent = store[i].Parent;
            if (parent >= 0 && map[parent]) map[i] = true;
        }
        return map;
    }

    public static DupResult Run(NodeStore store, DupOptions options, Action<DupProgress>? progress, CancellationToken token)
    {
        var watch = System.Diagnostics.Stopwatch.StartNew();
        var report = new DupProgress();
        var skipped = new ConcurrentBag<string>();
        var bySize = Gather(store, options);
        var scanned = bySize.Sum(g => g.Count);
        report.Candidates = scanned;
        progress?.Invoke(report);
        var parallel = new ParallelOptions { CancellationToken = token, MaxDegreeOfParallelism = Math.Clamp(options.Threads, 1, 16) };
        var cancelled = false;
        var finalGroups = new ConcurrentBag<DupGroup>();

        try
        {
            report.Stage = "partial";
            report.BytesTotal = bySize.Sum(g => g.Sum(c => Math.Min(c.Size, PartialBlock * 3L)));
            report.BytesDone = 0;
            var partialGroups = HashStage(bySize, parallel, skipped, report, progress, PartialKey, c => Math.Min(c.Size, PartialBlock * 3L));

            report.Stage = "hash";
            report.BytesTotal = partialGroups.Sum(g => g.Sum(c => c.Size));
            report.BytesDone = 0;
            var hashGroups = HashStage(partialGroups, parallel, skipped, report, progress, FullKey, c => c.Size);

            report.Stage = "verify";
            report.BytesTotal = hashGroups.Sum(g => g.Skip(1).Sum(c => c.Size));
            report.BytesDone = 0;
            progress?.Invoke(report);
            Parallel.ForEach(hashGroups, parallel, group =>
            {
                foreach (var verified in VerifyGroup(group, skipped, report, progress, token))
                {
                    finalGroups.Add(new DupGroup
                    {
                        Size = verified[0].Size,
                        Hash = verified[0].Hash,
                        Files = verified.Select(c => c.Id).ToArray(),
                    });
                    Interlocked.Increment(ref report.Groups);
                }
            });
        }
        catch (OperationCanceledException)
        {
            cancelled = true;
        }
        catch (AggregateException e) when (e.Flatten().InnerExceptions.All(x => x is OperationCanceledException))
        {
            cancelled = true;
        }

        var list = finalGroups.OrderByDescending(g => g.Wasted).ToList();
        var skippedList = skipped.Take(500).ToList();
        return new DupResult
        {
            Groups = list,
            Wasted = list.Sum(g => g.Wasted),
            Skipped = skipped.Count,
            SkippedPaths = skippedList,
            Cancelled = cancelled,
            Scanned = scanned,
            Elapsed = watch.Elapsed.TotalSeconds,
        };
    }

    private static List<List<Candidate>> Gather(NodeStore store, DupOptions options)
    {
        store.Lock.EnterReadLock();
        try
        {
            var system = options.IncludeSystem ? null : SystemMap(store);
            var items = new List<(long size, int id)>();
            var count = store.Count;
            const ushort skip = NodeFlags.Dir | NodeFlags.Link | NodeFlags.HardlinkDup | NodeFlags.Cloud | NodeFlags.Deleted;
            for (var i = 1; i < count; i++)
            {
                ref var node = ref store[i];
                if ((node.Flags & skip) != 0 || node.Size < options.MinSize || node.Size == 0) continue;
                if (system != null && system[i]) continue;
                items.Add((node.Size, i));
            }
            items.Sort((a, b) => a.size.CompareTo(b.size));
            var groups = new List<List<Candidate>>();
            for (var start = 0; start < items.Count;)
            {
                var end = start + 1;
                while (end < items.Count && items[end].size == items[start].size) end++;
                if (end - start > 1)
                {
                    var group = new List<Candidate>(end - start);
                    for (var i = start; i < end; i++) group.Add(new Candidate { Id = items[i].id, Path = store.Path(items[i].id), Size = items[i].size, MTime = store[items[i].id].MTime });
                    groups.Add(group);
                }
                start = end;
            }
            return groups;
        }
        finally
        {
            store.Lock.ExitReadLock();
        }
    }

    private static FileStream Open(string path) => new(Native.LongPath(path), new FileStreamOptions
    {
        Mode = FileMode.Open,
        Access = FileAccess.Read,
        Share = FileShare.ReadWrite | FileShare.Delete,
        Options = FileOptions.SequentialScan,
        BufferSize = 0,
    });

    private static List<List<Candidate>> HashStage(List<List<Candidate>> groups, ParallelOptions parallel, ConcurrentBag<string> skipped, DupProgress report, Action<DupProgress>? progress, Func<Candidate, CancellationToken, string> key, Func<Candidate, long> cost)
    {
        var token = parallel.CancellationToken;
        var buckets = new ConcurrentDictionary<(long, string), ConcurrentBag<Candidate>>();
        var last = Environment.TickCount64;
        var flat = groups.SelectMany(g => g);
        Parallel.ForEach(flat, parallel, candidate =>
        {
            try
            {
                var hash = key(candidate, token);
                buckets.GetOrAdd((candidate.Size, hash), _ => new ConcurrentBag<Candidate>()).Add(candidate);
                candidate.Hash = hash;
            }
            catch (OperationCanceledException)
            {
                throw;
            }
            catch (Exception)
            {
                skipped.Add(candidate.Path);
            }
            Interlocked.Add(ref report.BytesDone, cost(candidate));
            var now = Environment.TickCount64;
            var previous = Interlocked.Read(ref last);
            if (now - previous > 120 && Interlocked.CompareExchange(ref last, now, previous) == previous) progress?.Invoke(report);
        });
        progress?.Invoke(report);
        return buckets.Values.Where(b => b.Count > 1).Select(b => b.OrderBy(c => c.Id).ToList()).ToList();
    }

    private static string PartialKey(Candidate candidate, CancellationToken token)
    {
        token.ThrowIfCancellationRequested();
        using var stream = Open(candidate.Path);
        var hasher = new XxHash128();
        var buffer = ArrayPool<byte>.Shared.Rent(PartialBlock);
        try
        {
            var size = candidate.Size;
            if (size <= PartialBlock * 3L)
            {
                int read;
                while ((read = stream.Read(buffer, 0, PartialBlock)) > 0) hasher.Append(buffer.AsSpan(0, read));
            }
            else
            {
                foreach (var offset in new[] { 0L, size / 2 - PartialBlock / 2, size - PartialBlock })
                {
                    stream.Seek(offset, SeekOrigin.Begin);
                    var read = stream.ReadAtLeast(buffer.AsSpan(0, PartialBlock), PartialBlock, false);
                    hasher.Append(buffer.AsSpan(0, read));
                }
            }
            return Convert.ToHexString(hasher.GetCurrentHash());
        }
        finally
        {
            ArrayPool<byte>.Shared.Return(buffer);
        }
    }

    private static string FullKey(Candidate candidate, CancellationToken token)
    {
        using var stream = Open(candidate.Path);
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        var buffer = ArrayPool<byte>.Shared.Rent(ChunkSize);
        try
        {
            int read;
            while ((read = stream.Read(buffer, 0, ChunkSize)) > 0)
            {
                token.ThrowIfCancellationRequested();
                hash.AppendData(buffer, 0, read);
            }
            return Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant();
        }
        finally
        {
            ArrayPool<byte>.Shared.Return(buffer);
        }
    }

    private static List<List<Candidate>> VerifyGroup(List<Candidate> group, ConcurrentBag<string> skipped, DupProgress report, Action<DupProgress>? progress, CancellationToken token)
    {
        var classes = new List<List<Candidate>>();
        for (var index = 0; index < group.Count; index++)
        {
            var candidate = group[index];
            var placed = false;
            var failed = false;
            foreach (var cls in classes)
            {
                try
                {
                    if (!SameContent(cls[0].Path, candidate.Path, token)) continue;
                    if (StillSame(candidate) && StillSame(cls[0])) cls.Add(candidate);
                    else failed = true;
                    placed = true;
                    break;
                }
                catch (OperationCanceledException)
                {
                    throw;
                }
                catch (Exception)
                {
                    failed = true;
                    break;
                }
            }
            if (failed)
            {
                skipped.Add(candidate.Path);
            }
            else if (!placed)
            {
                classes.Add(new List<Candidate> { candidate });
            }
            if (index > 0) Interlocked.Add(ref report.BytesDone, candidate.Size);
            progress?.Invoke(report);
        }
        return classes.Where(c => c.Count > 1).ToList();
    }

    private static bool StillSame(Candidate candidate)
    {
        var info = new FileInfo(Native.LongPath(candidate.Path));
        if (!info.Exists || info.Length != candidate.Size) return false;
        var seconds = new DateTimeOffset(info.LastWriteTimeUtc).ToUnixTimeSeconds();
        return Math.Abs(seconds - candidate.MTime) <= 1;
    }

    public static bool SameContent(string left, string right, CancellationToken token)
    {
        using var a = Open(left);
        using var b = Open(right);
        if (a.Length != b.Length) return false;
        var bufferA = ArrayPool<byte>.Shared.Rent(ChunkSize);
        var bufferB = ArrayPool<byte>.Shared.Rent(ChunkSize);
        try
        {
            while (true)
            {
                token.ThrowIfCancellationRequested();
                var readA = a.ReadAtLeast(bufferA.AsSpan(0, ChunkSize), ChunkSize, false);
                var readB = b.ReadAtLeast(bufferB.AsSpan(0, ChunkSize), ChunkSize, false);
                if (readA != readB) return false;
                if (readA == 0) return true;
                if (!bufferA.AsSpan(0, readA).SequenceEqual(bufferB.AsSpan(0, readB))) return false;
            }
        }
        finally
        {
            ArrayPool<byte>.Shared.Return(bufferA);
            ArrayPool<byte>.Shared.Return(bufferB);
        }
    }
}
