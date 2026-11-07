using System.IO.Enumeration;

namespace DiskHunter.Engine;

public sealed class QueryFilter
{
    public string Kind = "file";
    public string? Text;
    public HashSet<string>? Exts;
    public HashSet<byte>? Cats;
    public long? MinSize;
    public long? MaxSize;
    public uint? ModifiedAfter;
    public uint? ModifiedBefore;
    public int? Within;
    public bool Logical;
    public string Sort = "size";
    public bool Ascending;
}

public sealed class QueryResult
{
    public required int[] Items;
    public required long Total;
    public required long TotalBytes;
    public required bool Capped;
}

public static class Query
{
    public const int WindowLimit = 20000;

    public static QueryResult Run(NodeStore store, QueryFilter filter, CancellationToken token)
    {
        var within = filter.Within is > 0 ? BuildWithin(store, filter.Within.Value) : null;
        var exts = BuildExtMask(store, filter);
        var terms = ParseTerms(filter.Text);
        var count = store.Count;
        var slices = Math.Clamp(Environment.ProcessorCount, 1, 8);
        var heaps = new TopK[slices];
        var totals = new long[slices];
        var bytes = new long[slices];
        var compare = Comparer(store, filter);
        var options = new ParallelOptions { CancellationToken = token, MaxDegreeOfParallelism = slices };
        Parallel.For(0, slices, options, slice =>
        {
            var heap = new TopK(WindowLimit, compare);
            var from = (int)((long)count * slice / slices);
            var to = (int)((long)count * (slice + 1) / slices);
            long hits = 0, sum = 0;
            for (var i = Math.Max(from, 1); i < to; i++)
            {
                if ((i & 0xFFFF) == 0 && token.IsCancellationRequested) return;
                if (!Matches(store, i, filter, exts, terms, within)) continue;
                hits++;
                sum += store.Metric(i, filter.Logical);
                heap.Add(i);
            }
            heaps[slice] = heap;
            totals[slice] = hits;
            bytes[slice] = sum;
        });

        token.ThrowIfCancellationRequested();
        var merged = new List<int>();
        foreach (var heap in heaps) merged.AddRange(heap.Items);
        merged.Sort(compare);
        if (merged.Count > WindowLimit) merged.RemoveRange(WindowLimit, merged.Count - WindowLimit);
        var total = totals.Sum();
        return new QueryResult { Items = merged.ToArray(), Total = total, TotalBytes = bytes.Sum(), Capped = total > merged.Count };
    }

    private static Comparison<int> Comparer(NodeStore store, QueryFilter filter)
    {
        var direction = filter.Ascending ? 1 : -1;
        var logical = filter.Logical;
        Comparison<int> primary = filter.Sort switch
        {
            "name" => (a, b) => store.Name(a).CompareTo(store.Name(b), StringComparison.OrdinalIgnoreCase),
            "mtime" => (a, b) => store[a].MTime.CompareTo(store[b].MTime),
            "ext" => (a, b) => string.CompareOrdinal(store.Ext(a), store.Ext(b)),
            _ => (a, b) => store.Metric(a, logical).CompareTo(store.Metric(b, logical)),
        };
        return (a, b) =>
        {
            var result = primary(a, b) * direction;
            return result != 0 ? result : a.CompareTo(b);
        };
    }

    public static bool[]? BuildExtMask(NodeStore store, QueryFilter filter)
    {
        if (filter.Exts == null && filter.Cats == null) return null;
        var mask = new bool[store.ExtCount];
        for (var i = 0; i < mask.Length; i++)
        {
            var name = store.ExtName((ushort)i);
            var byExt = filter.Exts?.Contains(name) ?? true;
            var byCat = filter.Cats?.Contains(store.CategoryOfExt((ushort)i)) ?? true;
            mask[i] = byExt && byCat;
        }
        return mask;
    }

    public static bool[] BuildWithin(NodeStore store, int root)
    {
        var count = store.Count;
        var map = new bool[count];
        map[root] = true;
        for (var i = root + 1; i < count; i++)
        {
            var parent = store[i].Parent;
            if (parent >= 0 && map[parent]) map[i] = true;
        }
        map[root] = false;
        return map;
    }

    public sealed record Term(string Text, bool Glob);

    public static Term[] ParseTerms(string? text)
    {
        if (string.IsNullOrWhiteSpace(text)) return Array.Empty<Term>();
        return text.Split(' ', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(t => new Term(t, t.Contains('*') || t.Contains('?')))
            .ToArray();
    }

    public static bool NameMatches(ReadOnlySpan<char> name, Term[] terms)
    {
        foreach (var term in terms)
        {
            if (term.Glob)
            {
                if (!FileSystemName.MatchesSimpleExpression(term.Text, name, ignoreCase: true)) return false;
            }
            else if (name.IndexOf(term.Text, StringComparison.OrdinalIgnoreCase) < 0)
            {
                return false;
            }
        }
        return true;
    }

    private static bool Matches(NodeStore store, int i, QueryFilter filter, bool[]? exts, Term[] terms, bool[]? within)
    {
        ref var node = ref store[i];
        if ((node.Flags & NodeFlags.Deleted) != 0) return false;
        var isDir = (node.Flags & NodeFlags.Dir) != 0;
        if (filter.Kind == "file" && isDir) return false;
        if (filter.Kind == "dir" && !isDir) return false;
        if (exts != null && (isDir || !exts[node.Ext])) return false;
        if (within != null && !within[i]) return false;
        if (filter.MinSize != null || filter.MaxSize != null)
        {
            var size = store.Metric(i, filter.Logical);
            if (size < filter.MinSize || size > filter.MaxSize) return false;
        }
        if (node.MTime < filter.ModifiedAfter || node.MTime > filter.ModifiedBefore) return false;
        return terms.Length == 0 || NameMatches(store.Name(i), terms);
    }

    public static int[] Children(NodeStore store, int id, string sort, bool ascending, bool logical)
    {
        ref var node = ref store[id];
        var list = new List<int>(node.Count);
        for (var c = node.First; c < node.First + node.Count; c++)
        {
            if ((store[c].Flags & NodeFlags.Deleted) == 0) list.Add(c);
        }
        var filter = new QueryFilter { Sort = sort, Ascending = ascending, Logical = logical };
        list.Sort(Comparer(store, filter));
        return list.ToArray();
    }

    private sealed class TopK
    {
        private readonly int _limit;
        private readonly Comparison<int> _compare;
        private readonly PriorityQueue<int, int> _queue;

        public TopK(int limit, Comparison<int> compare)
        {
            _limit = limit;
            _compare = compare;
            _queue = new PriorityQueue<int, int>(Comparer<int>.Create((a, b) => compare(b, a)));
        }

        public void Add(int item)
        {
            if (_queue.Count < _limit)
            {
                _queue.Enqueue(item, item);
                return;
            }
            var worst = _queue.Peek();
            if (_compare(item, worst) >= 0) return;
            _queue.DequeueEnqueue(item, item);
        }

        public IEnumerable<int> Items => _queue.UnorderedItems.Select(x => x.Element);
    }
}

public sealed class TreemapBuilder
{
    public sealed record Entry(int Id, int Parent, string Name, long Size, byte Cat, byte Kind, int Hidden, int ChildCount);

    public const byte KindFile = 0;
    public const byte KindDir = 1;
    public const byte KindRest = 2;

    public static List<Entry> Build(NodeStore store, int root, int budget, bool logical, double minShare)
    {
        var rootSize = Math.Max(1, store.Metric(root, logical));
        var cutoff = (long)(rootSize * minShare);
        var entries = new List<Entry>(Math.Min(budget + 32, 64000));
        var open = new PriorityQueue<(int node, int entry), long>(Comparer<long>.Create((a, b) => b.CompareTo(a)));
        entries.Add(new Entry(root, -1, store.Name(root).ToString(), store.Metric(root, logical), 0, KindDir, 0, store[root].Count));
        open.Enqueue((root, 0), rootSize);

        while (open.Count > 0 && entries.Count < budget)
        {
            var (node, entryIndex) = open.Dequeue();
            ref var parent = ref store[node];
            var children = new List<(int id, long size)>(parent.Count);
            for (var c = parent.First; c < parent.First + parent.Count; c++)
            {
                if ((store[c].Flags & NodeFlags.Deleted) != 0) continue;
                var size = store.Metric(c, logical);
                if (size > 0) children.Add((c, size));
            }
            children.Sort((a, b) => b.size.CompareTo(a.size));

            var room = Math.Max(1, budget - entries.Count);
            long restSize = 0;
            var restCount = 0;
            var shown = 0;
            foreach (var (id, size) in children)
            {
                if (size < cutoff || shown >= room)
                {
                    restSize += size;
                    restCount++;
                    continue;
                }
                ref var child = ref store[id];
                var isDir = (child.Flags & NodeFlags.Dir) != 0;
                entries.Add(new Entry(id, entryIndex, store.Name(id).ToString(), size, store.Category(id), isDir ? KindDir : KindFile, 0, isDir ? child.Count : 0));
                if (isDir && child.Count > 0) open.Enqueue((id, entries.Count - 1), size);
                shown++;
            }
            if (restCount > 0) entries.Add(new Entry(-1, entryIndex, "", restSize, 0, KindRest, restCount, 0));
        }
        return entries;
    }
}
