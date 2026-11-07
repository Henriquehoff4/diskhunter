using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;

namespace DiskHunter.Engine;

public sealed class SnapshotHeader
{
    public required string Id;
    public required string Root;
    public required long Time;
    public required long Alloc;
    public required long Size;
    public required long Files;
    public required long Dirs;
    public long VolumeTotal;
    public long VolumeFree;
}

public sealed record SnapshotEntry(long Alloc, int Files);

public sealed class GrowthItem
{
    public required string Path;
    public required long Before;
    public required long After;
    public required long Delta;
    public required int FilesDelta;
    public required string Status;
}

public sealed class GrowthResult
{
    public required SnapshotHeader Base;
    public required SnapshotHeader Target;
    public required List<GrowthItem> Items;
    public required long Grown;
    public required long Shrunk;
}

public sealed class SnapshotRepository
{
    private const uint Magic = 0x31534844;
    private const long MinTrackedAlloc = 1024 * 1024;
    private const int KeepPerRoot = 30;
    private readonly string _dir;

    public SnapshotRepository(string dataDir) => _dir = System.IO.Path.Combine(dataDir, "snapshots");

    private string RootDir(string root)
    {
        var key = SHA1.HashData(Encoding.UTF8.GetBytes(root.TrimEnd('\\').ToLowerInvariant()));
        return System.IO.Path.Combine(_dir, Convert.ToHexString(key)[..16].ToLowerInvariant());
    }

    public SnapshotHeader Save(NodeStore store, long volumeTotal, long volumeFree, long? nowUnix = null)
    {
        var dir = RootDir(store.RootPath);
        Directory.CreateDirectory(dir);
        var time = nowUnix ?? DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        var id = time.ToString();
        var path = System.IO.Path.Combine(dir, id + ".dhsnap");
        for (var n = 1; File.Exists(path); n++)
        {
            id = $"{time}-{n}";
            path = System.IO.Path.Combine(dir, id + ".dhsnap");
        }
        var tmp = path + ".tmp";

        var entries = new List<int>();
        long dirs = 0;
        for (var i = 0; i < store.Count; i++)
        {
            ref var node = ref store[i];
            if ((node.Flags & NodeFlags.Dir) == 0 || (node.Flags & (NodeFlags.Deleted | NodeFlags.Link)) != 0) continue;
            dirs++;
            if (node.Alloc >= MinTrackedAlloc || i == 0 || store.Depth(i) <= 2) entries.Add(i);
        }

        var header = new SnapshotHeader
        {
            Id = id,
            Root = store.RootPath,
            Time = time,
            Alloc = store[0].Alloc,
            Size = store[0].Size,
            Files = store[0].Files,
            Dirs = dirs,
            VolumeTotal = volumeTotal,
            VolumeFree = volumeFree,
        };
        var rootLength = store.RootPath.TrimEnd('\\').Length;
        using (var file = File.Create(tmp))
        using (var gzip = new GZipStream(file, CompressionLevel.Fastest))
        using (var writer = new BinaryWriter(gzip, Encoding.Unicode))
        {
            writer.Write(Magic);
            WriteHeader(writer, header);
            writer.Write(entries.Count);
            foreach (var i in entries)
            {
                var full = store.Path(i);
                var relative = i == 0 ? "" : full[rootLength..].TrimStart('\\');
                writer.Write(relative);
                writer.Write(store[i].Alloc);
                writer.Write(store[i].Files);
            }
        }
        File.Move(tmp, path, true);
        Prune(dir);
        return header;
    }

    private static void Prune(string dir)
    {
        var files = new DirectoryInfo(dir).GetFiles("*.dhsnap").OrderByDescending(f => f.LastWriteTimeUtc).Skip(KeepPerRoot);
        foreach (var file in files)
        {
            try
            {
                file.Delete();
            }
            catch (IOException)
            {
            }
        }
    }

    private static void WriteHeader(BinaryWriter writer, SnapshotHeader h)
    {
        writer.Write(h.Root);
        writer.Write(h.Time);
        writer.Write(h.Alloc);
        writer.Write(h.Size);
        writer.Write(h.Files);
        writer.Write(h.Dirs);
        writer.Write(h.VolumeTotal);
        writer.Write(h.VolumeFree);
    }

    private static SnapshotHeader ReadHeader(BinaryReader reader, string id)
    {
        if (reader.ReadUInt32() != Magic) throw new InvalidDataException("snapshot");
        return new SnapshotHeader
        {
            Id = id,
            Root = reader.ReadString(),
            Time = reader.ReadInt64(),
            Alloc = reader.ReadInt64(),
            Size = reader.ReadInt64(),
            Files = reader.ReadInt64(),
            Dirs = reader.ReadInt64(),
            VolumeTotal = reader.ReadInt64(),
            VolumeFree = reader.ReadInt64(),
        };
    }

    public List<SnapshotHeader> List(string? root)
    {
        var list = new List<SnapshotHeader>();
        if (!Directory.Exists(_dir)) return list;
        var folders = root != null ? new[] { RootDir(root) } : Directory.GetDirectories(_dir);
        foreach (var folder in folders)
        {
            if (!Directory.Exists(folder)) continue;
            foreach (var file in Directory.GetFiles(folder, "*.dhsnap"))
            {
                try
                {
                    using var stream = File.OpenRead(file);
                    using var gzip = new GZipStream(stream, CompressionMode.Decompress);
                    using var reader = new BinaryReader(gzip, Encoding.Unicode);
                    list.Add(ReadHeader(reader, System.IO.Path.GetFileNameWithoutExtension(file)));
                }
                catch (Exception e) when (e is IOException or InvalidDataException)
                {
                }
            }
        }
        list.Sort((a, b) => b.Time.CompareTo(a.Time));
        return list;
    }

    private (SnapshotHeader header, Dictionary<string, SnapshotEntry> entries) Load(string root, string id)
    {
        if (id.Any(c => !char.IsAsciiDigit(c) && c != '-')) throw new ArgumentException("snapshot id");
        var path = System.IO.Path.Combine(RootDir(root), id + ".dhsnap");
        using var stream = File.OpenRead(path);
        using var gzip = new GZipStream(stream, CompressionMode.Decompress);
        using var reader = new BinaryReader(gzip, Encoding.Unicode);
        var header = ReadHeader(reader, id);
        var count = reader.ReadInt32();
        var map = new Dictionary<string, SnapshotEntry>(count, StringComparer.OrdinalIgnoreCase);
        for (var i = 0; i < count; i++)
        {
            var relative = reader.ReadString();
            map[relative] = new SnapshotEntry(reader.ReadInt64(), reader.ReadInt32());
        }
        return (header, map);
    }

    public GrowthResult Compare(string root, string baseId, string targetId, long threshold = 1024 * 1024, int limit = 1000)
    {
        var (baseHeader, before) = Load(root, baseId);
        var (targetHeader, after) = Load(root, targetId);
        var items = new List<GrowthItem>();
        var strongestChild = new Dictionary<string, long>(StringComparer.OrdinalIgnoreCase);
        var rootPath = root.TrimEnd('\\');

        void Consider(string relative, long oldAlloc, long newAlloc, int oldFiles, int newFiles, string status)
        {
            var delta = newAlloc - oldAlloc;
            if (relative.Length == 0 || Math.Abs(delta) < threshold) return;
            items.Add(new GrowthItem
            {
                Path = rootPath + "\\" + relative,
                Before = oldAlloc,
                After = newAlloc,
                Delta = delta,
                FilesDelta = newFiles - oldFiles,
                Status = status,
            });
            var slash = relative.LastIndexOf('\\');
            var parent = slash < 0 ? "" : relative[..slash];
            var key = parent + (delta > 0 ? "|+" : "|-");
            if (!strongestChild.TryGetValue(key, out var best) || Math.Abs(delta) > Math.Abs(best)) strongestChild[key] = delta;
        }

        foreach (var (relative, entry) in after)
        {
            if (before.TryGetValue(relative, out var old)) Consider(relative, old.Alloc, entry.Alloc, old.Files, entry.Files, "changed");
            else Consider(relative, 0, entry.Alloc, 0, entry.Files, "new");
        }
        foreach (var (relative, entry) in before)
        {
            if (!after.ContainsKey(relative)) Consider(relative, entry.Alloc, 0, entry.Files, 0, "removed");
        }

        var topLevel = items.Where(i => i.Path.IndexOf('\\', rootPath.Length + 1) < 0).ToList();
        var filtered = items.Where(item =>
        {
            var relative = item.Path[(rootPath.Length + 1)..];
            var key = relative + (item.Delta > 0 ? "|+" : "|-");
            return !(strongestChild.TryGetValue(key, out var child) && Math.Abs(child) >= Math.Abs(item.Delta) * 0.9);
        }).OrderByDescending(i => Math.Abs(i.Delta)).Take(limit).ToList();

        return new GrowthResult
        {
            Base = baseHeader,
            Target = targetHeader,
            Items = filtered,
            Grown = topLevel.Where(i => i.Delta > 0).Sum(i => i.Delta),
            Shrunk = topLevel.Where(i => i.Delta < 0).Sum(i => -i.Delta),
        };
    }
}
