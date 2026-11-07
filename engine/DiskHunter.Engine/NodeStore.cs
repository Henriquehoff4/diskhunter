using System.Runtime.InteropServices;

namespace DiskHunter.Engine;

[StructLayout(LayoutKind.Sequential, Pack = 4)]
public struct Node
{
    public long Size;
    public long Alloc;
    public int Parent;
    public int NameOff;
    public int First;
    public int Count;
    public int Files;
    public uint MTime;
    public ushort NameLen;
    public ushort Ext;
    public ushort Flags;
    public ushort Reserved;
}

public static class NodeFlags
{
    public const ushort Dir = 1;
    public const ushort Link = 2;
    public const ushort Hidden = 4;
    public const ushort System = 8;
    public const ushort ReadOnly = 16;
    public const ushort Cloud = 32;
    public const ushort HardlinkDup = 64;
    public const ushort Denied = 128;
    public const ushort Deleted = 256;
    public const ushort Excluded = 512;
    public const ushort Partial = 1024;
    public const ushort Incomplete = 2048;
}

public struct PendingEntry
{
    public long Size;
    public long Alloc;
    public ulong FileId;
    public uint MTime;
    public int NameStart;
    public ushort NameLen;
    public ushort Ext;
    public ushort Flags;
}

public sealed class NodeStore
{
    private const int NodeShift = 16;
    private const int NodeChunk = 1 << NodeShift;
    private const int NodeMask = NodeChunk - 1;
    private const int NameShift = 20;
    private const int NameChunk = 1 << NameShift;
    private const int NameMask = NameChunk - 1;

    private readonly Node[]?[] _nodes = new Node[32768][];
    private ulong[]?[]? _ids = new ulong[32768][];
    private readonly char[]?[] _names = new char[2048][];
    private readonly object _gate = new();
    private readonly Dictionary<ulong, ushort> _extByKey = new();
    private readonly List<string> _exts = new() { "" };
    private readonly List<byte> _extCats = new() { 0 };
    private int _count;
    private int _nameTop;

    public readonly ReaderWriterLockSlim Lock = new(LockRecursionPolicy.SupportsRecursion);
    public string RootPath { get; }
    public int Version;
    public int Count => Volatile.Read(ref _count);
    public long RemovedAlloc;

    public NodeStore(string rootPath)
    {
        RootPath = rootPath;
        var root = new Node { Parent = -1, Flags = NodeFlags.Dir };
        WriteName(ref root, rootPath);
        Ensure(1);
        this[0] = root;
        _count = 1;
    }

    public ref Node this[int index] => ref _nodes[index >> NodeShift]![index & NodeMask];

    public ReadOnlySpan<char> Name(int index)
    {
        ref var node = ref this[index];
        return new ReadOnlySpan<char>(_names[node.NameOff >> NameShift]!, node.NameOff & NameMask, node.NameLen);
    }

    public string Ext(int index) => _exts[this[index].Ext];
    public string ExtName(ushort ext) => _exts[ext];
    public int ExtCount => _exts.Count;
    public byte Category(int index) => (this[index].Flags & NodeFlags.Dir) != 0 ? (byte)0 : _extCats[this[index].Ext];
    public byte CategoryOfExt(ushort ext) => _extCats[ext];

    public ushort InternExt(ReadOnlySpan<char> ext)
    {
        if (ext.IsEmpty || ext.Length > 16) return 0;
        var key = 14695981039346656037UL;
        foreach (var c in ext)
        {
            var lower = c < 128 ? (char)(c >= 'A' && c <= 'Z' ? c + 32 : c) : char.ToLowerInvariant(c);
            key = (key ^ lower) * 1099511628211UL;
        }
        lock (_extByKey)
        {
            if (_extByKey.TryGetValue(key, out var existing)) return existing;
            if (_exts.Count >= ushort.MaxValue) return 0;
            var value = (ushort)_exts.Count;
            var name = ext.ToString().ToLowerInvariant();
            _exts.Add(name);
            _extCats.Add(Categories.Of(name));
            _extByKey[key] = value;
            return value;
        }
    }

    private void Ensure(int top)
    {
        if (top <= 0) return;
        var last = (top - 1) >> NodeShift;
        for (var i = 0; i <= last; i++)
        {
            if (_nodes[i] != null) continue;
            _nodes[i] = new Node[NodeChunk];
            if (_ids != null) _ids[i] = new ulong[NodeChunk];
        }
    }

    private void WriteName(ref Node node, ReadOnlySpan<char> name)
    {
        var length = Math.Min(name.Length, ushort.MaxValue);
        var chunk = _nameTop >> NameShift;
        var offset = _nameTop & NameMask;
        if (offset + length > NameChunk)
        {
            chunk++;
            offset = 0;
            _nameTop = chunk << NameShift;
        }
        var target = _names[chunk] ??= new char[NameChunk];
        name[..length].CopyTo(target.AsSpan(offset));
        node.NameOff = _nameTop;
        node.NameLen = (ushort)length;
        _nameTop += length;
    }

    public int AddChildren(int parent, ReadOnlySpan<PendingEntry> entries, ReadOnlySpan<char> names)
    {
        lock (_gate)
        {
            var start = _count;
            Ensure(start + entries.Length);
            for (var i = 0; i < entries.Length; i++)
            {
                ref readonly var e = ref entries[i];
                var node = new Node
                {
                    Size = e.Size,
                    Alloc = e.Alloc,
                    Parent = parent,
                    MTime = e.MTime,
                    Ext = e.Ext,
                    Flags = e.Flags,
                };
                WriteName(ref node, names.Slice(e.NameStart, e.NameLen));
                var index = start + i;
                this[index] = node;
                if (_ids != null) _ids[index >> NodeShift]![index & NodeMask] = e.FileId;
            }
            this[parent].First = start;
            this[parent].Count = entries.Length;
            Volatile.Write(ref _count, start + entries.Length);
            return start;
        }
    }

    public int ResolveHardlinks()
    {
        var ids = _ids;
        if (ids == null) return 0;
        var count = Count;
        var filled = 0;
        for (var i = 1; i < count; i++)
        {
            if ((this[i].Flags & (NodeFlags.Dir | NodeFlags.Link)) != 0) continue;
            if (ids[i >> NodeShift]![i & NodeMask] != 0) filled++;
        }
        var keys = new ulong[filled];
        var indices = new int[filled];
        filled = 0;
        for (var i = 1; i < count; i++)
        {
            if ((this[i].Flags & (NodeFlags.Dir | NodeFlags.Link)) != 0) continue;
            var id = ids[i >> NodeShift]![i & NodeMask];
            if (id == 0) continue;
            keys[filled] = id;
            indices[filled] = i;
            filled++;
        }
        Array.Sort(keys, indices);
        var marks = 0;
        for (var i = 1; i < filled; i++)
        {
            if (keys[i] != keys[i - 1]) continue;
            this[indices[i]].Flags |= NodeFlags.HardlinkDup;
            marks++;
        }
        return marks;
    }

    public void ReleaseIds() => _ids = null;

    public void Rollup()
    {
        var count = Count;
        for (var i = 0; i < count; i++)
        {
            ref var node = ref this[i];
            if ((node.Flags & NodeFlags.Dir) == 0) continue;
            node.Size = 0;
            node.Alloc = 0;
            node.Files = 0;
        }
        for (var i = count - 1; i > 0; i--)
        {
            ref var node = ref this[i];
            ref var parent = ref this[node.Parent];
            if ((node.Flags & NodeFlags.Dir) != 0)
            {
                parent.Size += node.Size;
                parent.Alloc += node.Alloc;
                parent.Files += node.Files;
                if ((node.Flags & (NodeFlags.Denied | NodeFlags.Partial | NodeFlags.Excluded | NodeFlags.Incomplete)) != 0) parent.Flags |= NodeFlags.Incomplete;
            }
            else
            {
                if ((node.Flags & (NodeFlags.HardlinkDup | NodeFlags.Link)) == 0)
                {
                    parent.Size += node.Size;
                    parent.Alloc += node.Alloc;
                }
                parent.Files++;
            }
        }
    }

    public long EffectiveAlloc(int index)
    {
        ref var node = ref this[index];
        if ((node.Flags & NodeFlags.Dir) != 0) return node.Alloc;
        return (node.Flags & (NodeFlags.HardlinkDup | NodeFlags.Link)) != 0 ? 0 : node.Alloc;
    }

    public long EffectiveSize(int index)
    {
        ref var node = ref this[index];
        if ((node.Flags & NodeFlags.Dir) != 0) return node.Size;
        return (node.Flags & (NodeFlags.HardlinkDup | NodeFlags.Link)) != 0 ? 0 : node.Size;
    }

    public long Metric(int index, bool logical) => logical ? EffectiveSize(index) : EffectiveAlloc(index);

    public string Path(int index)
    {
        if (index == 0) return RootPath;
        var chain = new List<int>(32);
        var total = 0;
        var current = index;
        while (current > 0)
        {
            chain.Add(current);
            total += this[current].NameLen + 1;
            current = this[current].Parent;
        }
        var root = RootPath.AsSpan();
        var hasSlash = root.Length > 0 && root[^1] == '\\';
        var buffer = new char[root.Length + total - (hasSlash ? 1 : 0)];
        root.CopyTo(buffer);
        var at = root.Length - (hasSlash ? 1 : 0);
        for (var i = chain.Count - 1; i >= 0; i--)
        {
            buffer[at++] = '\\';
            var name = Name(chain[i]);
            name.CopyTo(buffer.AsSpan(at));
            at += name.Length;
        }
        return new string(buffer);
    }

    public int Depth(int index)
    {
        var depth = 0;
        while (index > 0)
        {
            index = this[index].Parent;
            depth++;
        }
        return depth;
    }

    public int Find(string path)
    {
        var full = path.TrimEnd('\\');
        var root = RootPath.TrimEnd('\\');
        if (!full.StartsWith(root, StringComparison.OrdinalIgnoreCase)) return -1;
        if (full.Length == root.Length) return 0;
        if (full[root.Length] != '\\') return -1;
        var current = 0;
        foreach (var part in full[(root.Length + 1)..].Split('\\', StringSplitOptions.RemoveEmptyEntries))
        {
            ref var node = ref this[current];
            var found = -1;
            for (var c = node.First; c < node.First + node.Count; c++)
            {
                if ((this[c].Flags & NodeFlags.Deleted) != 0) continue;
                if (Name(c).Equals(part, StringComparison.OrdinalIgnoreCase))
                {
                    found = c;
                    break;
                }
            }
            if (found < 0) return -1;
            current = found;
        }
        return current;
    }

    public bool Remove(int index)
    {
        if (index <= 0 || index >= Count) return false;
        ref var node = ref this[index];
        if ((node.Flags & NodeFlags.Deleted) != 0) return false;
        var size = EffectiveSize(index);
        var alloc = EffectiveAlloc(index);
        var files = (node.Flags & NodeFlags.Dir) != 0 ? node.Files : 1;
        MarkDeleted(index);
        var parent = node.Parent;
        while (parent >= 0)
        {
            ref var ancestor = ref this[parent];
            ancestor.Size -= size;
            ancestor.Alloc -= alloc;
            ancestor.Files -= files;
            parent = ancestor.Parent;
        }
        RemovedAlloc += alloc;
        Interlocked.Increment(ref Version);
        return true;
    }

    private void MarkDeleted(int index)
    {
        var stack = new Stack<int>();
        stack.Push(index);
        while (stack.Count > 0)
        {
            var current = stack.Pop();
            ref var node = ref this[current];
            node.Flags |= NodeFlags.Deleted;
            if ((node.Flags & NodeFlags.Dir) == 0) continue;
            for (var c = node.First; c < node.First + node.Count; c++) stack.Push(c);
        }
    }

    public long ApproximateMemory()
    {
        long total = 0;
        foreach (var chunk in _nodes) if (chunk != null) total += chunk.Length * 48L;
        foreach (var chunk in _names) if (chunk != null) total += chunk.Length * 2L;
        return total;
    }
}
