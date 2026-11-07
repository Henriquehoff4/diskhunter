using System.Diagnostics;
using System.Text;
using DiskHunter.Engine;
using Xunit;

namespace DiskHunter.Engine.Tests;

internal sealed class TempTree : IDisposable
{
    public string Root { get; } = Path.Combine(Path.GetTempPath(), "dh-test-" + Guid.NewGuid().ToString("N"));
    public TempTree() => Directory.CreateDirectory(Root);

    public string File(string relative, byte[] content)
    {
        var path = Path.Combine(Root, relative);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        System.IO.File.WriteAllBytes(path, content);
        return path;
    }

    public string File(string relative, int length, byte seed = 7)
    {
        var data = new byte[length];
        new Random(seed).NextBytes(data);
        return File(relative, data);
    }

    public void Dispose()
    {
        try
        {
            Directory.Delete(Root, true);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
        }
    }
}

internal static class Helpers
{
    public static ScanResult Scan(string root, string[]? excludes = null) =>
        new Scanner(new NtDirectorySource(), new ScanOptions { Threads = 4, Excludes = excludes ?? Array.Empty<string>() }).Run(root, null, CancellationToken.None);

    public static bool RunCmd(string args)
    {
        using var process = Process.Start(new ProcessStartInfo("cmd.exe", "/c " + args) { CreateNoWindow = true, UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true })!;
        process.WaitForExit(10000);
        return process.ExitCode == 0;
    }

    public sealed class FakeTree : IDirectorySource
    {
        public readonly Dictionary<string, List<(string name, long size, uint attrs, uint tag, long unix, ulong id)>> Dirs = new(StringComparer.OrdinalIgnoreCase);
        public readonly Dictionary<string, int> Errors = new(StringComparer.OrdinalIgnoreCase);

        public void Add(string dir, string name, long size = 0, uint attrs = 0x20, uint tag = 0, long unix = 1_700_000_000, ulong id = 0, long? alloc = null)
        {
            dir = dir.TrimEnd('\\');
            if (!Dirs.TryGetValue(dir, out var list)) Dirs[dir] = list = new();
            list.Add((name, size, attrs, tag, unix, id));
        }

        public int Read(string path, bool isRoot, IEntrySink sink, byte[] buffer)
        {
            if (Errors.TryGetValue(path.TrimEnd('\\'), out var error)) return error;
            if (Dirs.TryGetValue(path.TrimEnd('\\'), out var list))
            {
                foreach (var e in list) sink.Add(e.name, e.size, e.size, e.attrs, e.tag, e.unix * 10_000_000L + 116444736000000000L, e.id);
            }
            return 0;
        }

        public ScanResult Scan(string root) => new Scanner(this, new ScanOptions { Threads = 2 }).Run(root, null, CancellationToken.None);
    }
}

public class ScannerTests
{
    [Fact(Timeout = 30000)]
    public async Task Totals_match_the_files_on_disk()
    {
        await Task.Yield();
        using var tree = new TempTree();
        tree.File(@"a\one.bin", 5000);
        tree.File(@"a\b\two.txt", 7000);
        tree.File(@"c\three.png", 100);
        var result = Helpers.Scan(tree.Root);
        var store = result.Store;
        Assert.Equal(12100, store[0].Size);
        Assert.Equal(3, store[0].Files);
        Assert.True(store[0].Alloc >= 8192);
        Assert.Equal(0, result.Errors);
        var found = store.Find(Path.Combine(tree.Root, @"a\b\two.txt"));
        Assert.True(found > 0);
        Assert.Equal(Path.Combine(tree.Root, @"a\b\two.txt"), store.Path(found), ignoreCase: true);
        Assert.Equal("txt", store.Ext(found));
    }

    [Fact(Timeout = 30000)]
    public async Task Junction_loop_is_not_followed()
    {
        await Task.Yield();
        using var tree = new TempTree();
        tree.File(@"real\data.bin", 4096);
        Assert.True(Helpers.RunCmd($"mklink /J \"{Path.Combine(tree.Root, @"real\voltar")}\" \"{tree.Root}\""));
        var result = Helpers.Scan(tree.Root);
        Assert.Equal(4096, result.Store[0].Size);
        Assert.Equal(1, result.Links);
        var link = result.Store.Find(Path.Combine(tree.Root, @"real\voltar"));
        Assert.True((result.Store[link].Flags & NodeFlags.Link) != 0);
        Assert.Equal(0, result.Store[link].Count);
        Directory.Delete(Path.Combine(tree.Root, @"real\voltar"));
    }

    [Fact(Timeout = 30000)]
    public async Task Hard_links_count_once()
    {
        await Task.Yield();
        using var tree = new TempTree();
        var file = tree.File(@"a\origem.bin", 100_000);
        Directory.CreateDirectory(Path.Combine(tree.Root, "b"));
        Assert.True(Helpers.RunCmd($"mklink /H \"{Path.Combine(tree.Root, @"b\copia.bin")}\" \"{file}\""));
        var result = Helpers.Scan(tree.Root);
        Assert.Equal(1, result.Hardlinks);
        Assert.Equal(100_000, result.Store[0].Size);
        Assert.Equal(2, result.Store[0].Files);
    }

    [Fact(Timeout = 30000)]
    public async Task Long_paths_and_unicode_are_read()
    {
        await Task.Yield();
        using var tree = new TempTree();
        var deep = string.Join('\\', Enumerable.Range(0, 30).Select(i => $"pasta-comprida-{i:00}-ç"));
        Assert.True(deep.Length > 300);
        var full = Path.Combine(tree.Root, deep);
        Directory.CreateDirectory(@"\\?\" + full);
        File.WriteAllBytes(@"\\?\" + Path.Combine(full, "fim 🦊.txt"), new byte[123]);
        var result = Helpers.Scan(tree.Root);
        Assert.Equal(123, result.Store[0].Size);
        Assert.Equal(0, result.Errors);
        Directory.Delete(@"\\?\" + Path.Combine(tree.Root, "pasta-comprida-00-ç"), true);
    }

    [Fact(Timeout = 30000)]
    public async Task Denied_folder_is_reported_and_scan_continues()
    {
        await Task.Yield();
        var fake = new Helpers.FakeTree();
        fake.Add(@"X:\r", "ok", attrs: 0x10);
        fake.Add(@"X:\r", "negado", attrs: 0x10);
        fake.Add(@"X:\r\ok", "f.bin", 10);
        fake.Errors[@"X:\r\negado"] = 5;
        var result = fake.Scan(@"X:\r");
        Assert.Equal(1, result.Errors);
        Assert.Equal(5, result.ErrorList[0].Code);
        Assert.Equal(10, result.Store[0].Size);
        Assert.True((result.Store[result.Store.Find(@"X:\r\negado")].Flags & NodeFlags.Denied) != 0);
    }

    [Fact(Timeout = 30000)]
    public async Task Cloud_folder_is_followed_and_symlink_folder_is_not()
    {
        await Task.Yield();
        var fake = new Helpers.FakeTree();
        fake.Add(@"X:\r", "OneDrive", attrs: 0x10 | 0x400, tag: 0x9000701A);
        fake.Add(@"X:\r", "atalho", attrs: 0x10 | 0x400, tag: 0xA000000C);
        fake.Add(@"X:\r\OneDrive", "nuvem.mp4", 5000, attrs: 0x20 | 0x400 | 0x400000, tag: 0x9000601A);
        fake.Add(@"X:\r\atalho", "nao-deve-aparecer.bin", 999);
        var result = fake.Scan(@"X:\r");
        Assert.Equal(5000, result.Store[0].Size);
        var cloud = result.Store.Find(@"X:\r\OneDrive\nuvem.mp4");
        Assert.True((result.Store[cloud].Flags & NodeFlags.Cloud) != 0);
        Assert.Equal(-1, result.Store.Find(@"X:\r\atalho\nao-deve-aparecer.bin"));
    }

    [Fact(Timeout = 30000)]
    public async Task Cancel_stops_early_and_flags_result()
    {
        await Task.Yield();
        using var cts = new CancellationTokenSource();
        cts.Cancel();
        var result = new Scanner(new SyntheticSource(@"Z:\", 100000), new ScanOptions { Threads = 2 }).Run(@"Z:\", null, cts.Token);
        Assert.True(result.Cancelled);
        Assert.True(result.Store.Count < 100000);
    }

    [Fact(Timeout = 30000)]
    public async Task Excluded_folder_is_not_descended()
    {
        await Task.Yield();
        var fake = new Helpers.FakeTree();
        fake.Add(@"X:\r", "skip", attrs: 0x10);
        fake.Add(@"X:\r\skip", "a.bin", 100);
        var result = new Scanner(fake, new ScanOptions { Threads = 1, Excludes = new[] { @"X:\r\skip" } }).Run(@"X:\r", null, CancellationToken.None);
        Assert.Equal(0, result.Store[0].Size);
    }
}

public class ScaleTests
{
    [Fact(Timeout = 30000)]
    public async Task Two_million_synthetic_nodes_scan_and_query_quickly()
    {
        await Task.Yield();
        var watch = Stopwatch.StartNew();
        var result = new Scanner(new SyntheticSource(@"Z:\", 2_000_000), new ScanOptions { Threads = 8 }).Run(@"Z:\", null, CancellationToken.None);
        var store = result.Store;
        Assert.True(store.Count > 1_000_000, $"nodes {store.Count}");
        long sum = 0;
        for (var c = store[0].First; c < store[0].First + store[0].Count; c++) sum += store.EffectiveAlloc(c);
        Assert.Equal(store[0].Alloc, sum);

        watch.Restart();
        var query = Query.Run(store, new QueryFilter { Kind = "file", Text = "viagem" }, CancellationToken.None);
        Assert.True(watch.ElapsedMilliseconds < 5000, $"query took {watch.ElapsedMilliseconds}ms");
        Assert.True(query.Total > 0);
        for (var i = 1; i < query.Items.Length; i++)
        {
            Assert.True(store.EffectiveAlloc(query.Items[i - 1]) >= store.EffectiveAlloc(query.Items[i]));
        }

        var map = TreemapBuilder.Build(store, 0, 6000, false, 0.00002);
        Assert.InRange(map.Count, 100, 6200);
        var memory = store.ApproximateMemory();
        Assert.True(memory / store.Count < 160, $"bytes per node {memory / store.Count}");
    }

    [Fact(Timeout = 30000)]
    public async Task Removing_a_node_updates_every_ancestor()
    {
        await Task.Yield();
        var fake = new Helpers.FakeTree();
        fake.Add(@"X:\r", "a", attrs: 0x10);
        fake.Add(@"X:\r\a", "b", attrs: 0x10);
        fake.Add(@"X:\r\a\b", "x.bin", 100);
        fake.Add(@"X:\r\a\b", "y.bin", 50);
        var store = fake.Scan(@"X:\r").Store;
        Assert.Equal(150, store[0].Size);
        var id = store.Find(@"X:\r\a\b\x.bin");
        Assert.True(store.Remove(id));
        Assert.False(store.Remove(id));
        Assert.Equal(50, store[0].Size);
        Assert.Equal(1, store[0].Files);
        var dir = store.Find(@"X:\r\a");
        store.Remove(dir);
        Assert.Equal(0, store[0].Size);
        Assert.Equal(0, store[0].Files);
        Assert.Equal(0, Query.Run(store, new QueryFilter(), CancellationToken.None).Total);
    }
}

public class QueryTests
{
    private static NodeStore Build()
    {
        var fake = new Helpers.FakeTree();
        fake.Add(@"X:\r", "docs", attrs: 0x10);
        fake.Add(@"X:\r", "media", attrs: 0x10);
        fake.Add(@"X:\r\docs", "contrato.pdf", 1000, unix: 1_600_000_000);
        fake.Add(@"X:\r\docs", "notas.txt", 10, unix: 1_700_000_000);
        fake.Add(@"X:\r\media", "ferias.mp4", 90000, unix: 1_650_000_000);
        fake.Add(@"X:\r\media", "contrato-scan.png", 5000, unix: 1_710_000_000);
        return fake.Scan(@"X:\r").Store;
    }

    private static string[] Names(NodeStore store, QueryResult result) => result.Items.Select(i => store.Name(i).ToString()).ToArray();

    [Fact(Timeout = 30000)]
    public async Task Filters_combine()
    {
        await Task.Yield();
        var store = Build();
        Assert.Equal(new[] { "ferias.mp4", "contrato-scan.png", "contrato.pdf", "notas.txt" }, Names(store, Query.Run(store, new QueryFilter(), default)));
        Assert.Equal(new[] { "contrato-scan.png", "contrato.pdf" }, Names(store, Query.Run(store, new QueryFilter { Text = "CONTRATO" }, default)));
        Assert.Equal(new[] { "contrato.pdf" }, Names(store, Query.Run(store, new QueryFilter { Exts = new() { "pdf" } }, default)));
        Assert.Equal(new[] { "ferias.mp4" }, Names(store, Query.Run(store, new QueryFilter { Cats = new() { Categories.Video } }, default)));
        Assert.Equal(new[] { "contrato-scan.png", "contrato.pdf" }, Names(store, Query.Run(store, new QueryFilter { MinSize = 1000, MaxSize = 5000 }, default)));
        Assert.Equal(new[] { "contrato-scan.png", "notas.txt" }, Names(store, Query.Run(store, new QueryFilter { ModifiedAfter = 1_680_000_000 }, default)));
        Assert.Equal(new[] { "contrato-scan.png", "ferias.mp4" }, Names(store, Query.Run(store, new QueryFilter { Within = store.Find(@"X:\r\media"), Sort = "name", Ascending = true }, default)));
        Assert.Equal(new[] { "ferias.mp4" }, Names(store, Query.Run(store, new QueryFilter { Text = "*.mp4" }, default)));
        Assert.Equal(new[] { "docs", "media" }, Names(store, Query.Run(store, new QueryFilter { Kind = "dir", Sort = "name", Ascending = true }, default)));
    }

    [Fact(Timeout = 30000)]
    public async Task Query_can_be_cancelled()
    {
        await Task.Yield();
        var store = Build();
        using var cts = new CancellationTokenSource();
        cts.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => Task.Run(() => Query.Run(store, new QueryFilter(), cts.Token)));
    }

    [Fact(Timeout = 30000)]
    public async Task Treemap_aggregates_small_children()
    {
        await Task.Yield();
        var fake = new Helpers.FakeTree();
        fake.Add(@"X:\r", "big.bin", 1_000_000_000);
        for (var i = 0; i < 100; i++) fake.Add(@"X:\r", $"tiny{i}.bin", 10);
        var store = fake.Scan(@"X:\r").Store;
        var map = TreemapBuilder.Build(store, 0, 1000, false, 0.00002);
        var rest = Assert.Single(map, e => e.Kind == TreemapBuilder.KindRest);
        Assert.Equal(100, rest.Hidden);
        Assert.Equal(1000, rest.Size);
        Assert.Equal(store[0].Size, map.Where(e => e.Parent == 0).Sum(e => e.Size));
    }

    [Fact(Timeout = 30000)]
    public async Task Invalid_unicode_names_do_not_break_json()
    {
        await Task.Yield();
        var bad = "ruim\uD83D.txt";
        Assert.True(Text.IsLossy(bad));
        Assert.False(Text.IsLossy("bom 🦊.txt"));
        Assert.Equal("ruim\uFFFD.txt", Text.Clean(bad));
    }
}

public class DuplicateTests
{
    [Fact(Timeout = 30000)]
    public async Task Same_size_different_content_is_not_a_duplicate()
    {
        await Task.Yield();
        using var tree = new TempTree();
        var a = new byte[200_000];
        new Random(1).NextBytes(a);
        tree.File(@"x\copia1.bin", a);
        tree.File(@"y\copia2.bin", a);
        var almost = (byte[])a.Clone();
        almost[100_000] ^= 0xFF;
        tree.File(@"z\quase.bin", almost);
        tree.File(@"z\outro-tamanho.bin", new byte[199_999]);
        var store = Helpers.Scan(tree.Root).Store;
        var result = Duplicates.Run(store, new DupOptions { MinSize = 1 }, null, default);
        var group = Assert.Single(result.Groups);
        Assert.Equal(2, group.Files.Length);
        Assert.Equal(200_000, group.Wasted);
        Assert.Equal(64, group.Hash.Length);
        var names = group.Files.Select(f => store.Name(f).ToString()).OrderBy(n => n).ToArray();
        Assert.Equal(new[] { "copia1.bin", "copia2.bin" }, names);
    }

    [Fact(Timeout = 30000)]
    public async Task Hard_links_are_not_duplicates()
    {
        await Task.Yield();
        using var tree = new TempTree();
        var file = tree.File(@"a\o.bin", 50_000);
        Assert.True(Helpers.RunCmd($"mklink /H \"{Path.Combine(tree.Root, @"a\l.bin")}\" \"{file}\""));
        var store = Helpers.Scan(tree.Root).Store;
        Assert.Empty(Duplicates.Run(store, new DupOptions { MinSize = 1 }, null, default).Groups);
    }

    [Fact(Timeout = 30000)]
    public async Task Cloud_placeholders_are_never_opened()
    {
        await Task.Yield();
        var fake = new Helpers.FakeTree();
        fake.Add(@"X:\r", "a.bin", 5000, attrs: 0x20 | 0x400000);
        fake.Add(@"X:\r", "b.bin", 5000, attrs: 0x20 | 0x400000);
        var store = fake.Scan(@"X:\r").Store;
        var result = Duplicates.Run(store, new DupOptions { MinSize = 1 }, null, default);
        Assert.Equal(0, result.Scanned);
        Assert.Equal(0, result.Skipped);
    }

    [Fact(Timeout = 30000)]
    public async Task File_changed_after_scan_is_not_reported()
    {
        await Task.Yield();
        using var tree = new TempTree();
        var a = new byte[10_000];
        tree.File(@"a.bin", a);
        var other = tree.File(@"b.bin", a);
        var store = Helpers.Scan(tree.Root).Store;
        File.SetLastWriteTimeUtc(other, DateTime.UtcNow.AddHours(-5));
        var result = Duplicates.Run(store, new DupOptions { MinSize = 1 }, null, default);
        Assert.Empty(result.Groups);
    }

    [Fact(Timeout = 30000)]
    public async Task Cancel_returns_partial_flag()
    {
        await Task.Yield();
        using var tree = new TempTree();
        tree.File("a.bin", 5000);
        tree.File("b.bin", 5000);
        var store = Helpers.Scan(tree.Root).Store;
        using var cts = new CancellationTokenSource();
        cts.Cancel();
        Assert.True(Duplicates.Run(store, new DupOptions { MinSize = 1 }, null, cts.Token).Cancelled);
    }

    [Fact(Timeout = 30000)]
    public async Task SameContent_detects_last_byte_difference()
    {
        await Task.Yield();
        using var tree = new TempTree();
        var a = new byte[3_000_000];
        var b = (byte[])a.Clone();
        b[^1] = 1;
        var left = tree.File("l.bin", a);
        var right = tree.File("r.bin", b);
        var same = tree.File("s.bin", a);
        Assert.False(Duplicates.SameContent(left, right, default));
        Assert.True(Duplicates.SameContent(left, same, default));
    }
}

public class CleanupTests
{
    private const long Now = 1_800_000_000;
    private const long Old = Now - 400 * 86400;
    private const long Recent = Now - 5 * 86400;

    private static List<Recommendation> Evaluate(NodeStore store) => Cleanup.Evaluate(store, new CleanupOptions { NowUnix = Now }, default);

    [Fact(Timeout = 30000)]
    public async Task Rules_find_caches_downloads_and_installers_without_double_counting()
    {
        await Task.Yield();
        var fake = new Helpers.FakeTree();
        fake.Add(@"C:\", "Users", attrs: 0x10);
        fake.Add(@"C:\", "Windows", attrs: 0x10);
        fake.Add(@"C:\Users", "Ana", attrs: 0x10);
        fake.Add(@"C:\Users\Ana", "AppData", attrs: 0x10);
        fake.Add(@"C:\Users\Ana", "Downloads", attrs: 0x10);
        fake.Add(@"C:\Users\Ana", "Documents", attrs: 0x10);
        fake.Add(@"C:\Users\Ana\AppData", "Local", attrs: 0x10);
        fake.Add(@"C:\Users\Ana\AppData\Local", "Temp", attrs: 0x10);
        fake.Add(@"C:\Users\Ana\AppData\Local\Temp", "lixo.tmp", 2_000_000);
        fake.Add(@"C:\Users\Ana\Downloads", "setup.exe", 50_000_000, unix: Old);
        fake.Add(@"C:\Users\Ana\Downloads", "setup-novo.exe", 50_000_000, unix: Recent);
        fake.Add(@"C:\Users\Ana\Downloads", "foto-velha.jpg", 3_000_000, unix: Old);
        fake.Add(@"C:\Users\Ana\Downloads", "foto-nova.jpg", 3_000_000, unix: Recent);
        fake.Add(@"C:\Users\Ana\Documents", "contrato.pdf", 9_000_000, unix: Old);
        fake.Add(@"C:\Windows", "Temp", attrs: 0x10);
        fake.Add(@"C:\Windows", "System32", attrs: 0x10);
        fake.Add(@"C:\Windows\Temp", "w.tmp", 1_000_000);
        fake.Add(@"C:\Windows\System32", "ntoskrnl.exe", 11_000_000, unix: Old);
        var list = Evaluate(fake.Scan(@"C:\").Store);
        var map = list.ToDictionary(r => r.Id);
        Assert.Equal(2_000_000, map["temp"].Bytes);
        Assert.Equal(1_000_000, map["win-temp"].Bytes);
        Assert.Equal(50_000_000, map["installers"].Bytes);
        Assert.Equal(1, map["installers"].Count);
        Assert.Equal(3_000_000, map["downloads"].Bytes);
        Assert.False(map.ContainsKey("logs"));
        Assert.Equal(4, list.Count);
    }

    [Fact(Timeout = 30000)]
    public async Task Fake_Windows_Temp_outside_drive_root_is_not_treated_as_system_temp()
    {
        await Task.Yield();
        var fake = new Helpers.FakeTree();
        fake.Add(@"D:\", "projeto", attrs: 0x10);
        fake.Add(@"D:\projeto", "Windows", attrs: 0x10);
        fake.Add(@"D:\projeto\Windows", "Temp", attrs: 0x10);
        fake.Add(@"D:\projeto\Windows\Temp", "importante.dat", 5000);
        Assert.Empty(Evaluate(fake.Scan(@"D:\").Store));
    }

    [Fact(Timeout = 30000)]
    public async Task Stale_node_modules_only_and_never_inside_system_folders()
    {
        await Task.Yield();
        var fake = new Helpers.FakeTree();
        fake.Add(@"C:\", "dev", attrs: 0x10);
        fake.Add(@"C:\", "Program Files", attrs: 0x10);
        fake.Add(@"C:\dev", "velho", attrs: 0x10);
        fake.Add(@"C:\dev", "novo", attrs: 0x10);
        fake.Add(@"C:\dev\velho", "node_modules", attrs: 0x10, unix: Old);
        fake.Add(@"C:\dev\novo", "node_modules", attrs: 0x10, unix: Recent);
        fake.Add(@"C:\dev\velho\node_modules", "a.js", 1000);
        fake.Add(@"C:\dev\novo\node_modules", "b.js", 2000);
        fake.Add(@"C:\Program Files", "App", attrs: 0x10);
        fake.Add(@"C:\Program Files\App", "node_modules", attrs: 0x10, unix: Old);
        fake.Add(@"C:\Program Files\App\node_modules", "c.js", 4000);
        var list = Evaluate(fake.Scan(@"C:\").Store);
        var rec = Assert.Single(list);
        Assert.Equal("node_modules", rec.Id);
        Assert.Equal(1000, rec.Bytes);
    }

    [Fact(Timeout = 30000)]
    public async Task System_items_are_information_only()
    {
        await Task.Yield();
        var fake = new Helpers.FakeTree();
        fake.Add(@"C:\", "hiberfil.sys", 8_000_000_000);
        fake.Add(@"C:\", "Windows.old", attrs: 0x10);
        fake.Add(@"C:\Windows.old", "a.dll", 7_000_000);
        var list = Evaluate(fake.Scan(@"C:\").Store);
        Assert.All(list, r => Assert.Equal("info", r.Action));
        Assert.Equal(2, list.Count);
    }

    [Fact(Timeout = 30000)]
    public async Task Rules_work_when_scan_starts_inside_the_target()
    {
        await Task.Yield();
        var fake = new Helpers.FakeTree();
        fake.Add(@"C:\Users\Ana\AppData\Local\Temp", "lixo.tmp", 2000);
        var list = Evaluate(fake.Scan(@"C:\Users\Ana\AppData\Local\Temp").Store);
        var rec = Assert.Single(list);
        Assert.Equal("temp", rec.Id);
    }
}

public class ModelTests
{
    private static byte[] Gguf(string name, string arch, uint fileType)
    {
        using var ms = new MemoryStream();
        using var w = new BinaryWriter(ms);
        w.Write("GGUF"u8.ToArray());
        w.Write(3u);
        w.Write(42L);
        w.Write(4L);
        void Str(string s)
        {
            var b = Encoding.UTF8.GetBytes(s);
            w.Write((long)b.Length);
            w.Write(b);
        }
        Str("general.architecture");
        w.Write(8u);
        Str(arch);
        Str("some.array");
        w.Write(9u);
        w.Write(5u);
        w.Write(3L);
        w.Write(new byte[12]);
        Str("general.name");
        w.Write(8u);
        Str(name);
        Str("general.file_type");
        w.Write(4u);
        w.Write(fileType);
        return ms.ToArray();
    }

    private static byte[] SafeTensors(string json, int padding = 16)
    {
        var body = Encoding.UTF8.GetBytes(json);
        using var ms = new MemoryStream();
        using var w = new BinaryWriter(ms);
        w.Write((ulong)body.Length);
        w.Write(body);
        w.Write(new byte[padding]);
        return ms.ToArray();
    }

    [Fact(Timeout = 30000)]
    public async Task Gguf_metadata_is_read()
    {
        await Task.Yield();
        var data = Gguf("Llama 3 8B", "llama", 15);
        var info = AiModels.ParseHeader(data, "GGUF", data.Length);
        Assert.True(info.Verified);
        Assert.Equal("Llama 3 8B", info.Name);
        Assert.Equal("llama", info.Arch);
        Assert.Equal("Q4_K_M", info.Quant);
        Assert.Equal(42, info.Tensors);
    }

    [Fact(Timeout = 30000)]
    public async Task Malformed_headers_never_throw()
    {
        await Task.Yield();
        var random = new Random(3);
        var valid = Gguf("nome", "arch", 1);
        for (var i = 0; i < 2000; i++)
        {
            var copy = (byte[])valid.Clone();
            for (var k = 0; k < 4; k++) copy[random.Next(copy.Length)] = (byte)random.Next(256);
            var n = random.Next(copy.Length);
            AiModels.ParseHeader(copy.AsSpan(0, n), "GGUF", n);
            AiModels.ParseHeader(copy.AsSpan(0, n), "SafeTensors", n);
        }
        var fake = "isto nao e um modelo"u8.ToArray();
        Assert.True(AiModels.ParseHeader(fake, "GGUF", fake.Length).Rejected);
        Assert.True(AiModels.ParseHeader(fake, "SafeTensors", fake.Length).Rejected);
    }

    [Fact(Timeout = 30000)]
    public async Task SafeTensors_counts_tensors_and_ignores_metadata()
    {
        await Task.Yield();
        var data = SafeTensors("{\"__metadata__\":{\"modelspec.title\":\"Flux\"},\"a\":{},\"b\":{}}");
        var info = AiModels.ParseHeader(data, "SafeTensors", data.Length);
        Assert.True(info.Verified);
        Assert.Equal(2, info.Tensors);
        Assert.Equal("Flux", info.Name);
    }

    [Fact(Timeout = 30000)]
    public async Task Finder_verifies_signatures_merges_shards_and_rejects_impostors()
    {
        await Task.Yield();
        using var tree = new TempTree();
        var pad = new byte[1024 * 1024 + 10];
        byte[] Padded(byte[] head)
        {
            var result = (byte[])pad.Clone();
            head.CopyTo(result, 0);
            return result;
        }
        tree.File(@"a\modelo.gguf", Padded(Gguf("Mistral", "mistral", 7)));
        tree.File(@"a\falso.gguf", new byte[pad.Length]);
        tree.File(@"b\model-00001-of-00002.safetensors", SafeTensors("{\"x\":{}}", pad.Length));
        tree.File(@"b\model-00002-of-00002.safetensors", SafeTensors("{\"y\":{}}", pad.Length));
        tree.File(@".cache\huggingface\hub\models--org--nome\blobs\abc123", Padded(Gguf("x", "y", 1)));
        var store = Helpers.Scan(tree.Root).Store;
        var models = AiModels.Find(store, default);
        Assert.Equal(3, models.Count);
        Assert.DoesNotContain(models, m => m.Path.EndsWith("falso.gguf"));
        var shard = Assert.Single(models, m => m.Parts == 2);
        Assert.Equal("SafeTensors", shard.Format);
        Assert.Equal(2, shard.Tensors);
        var hub = Assert.Single(models, m => m.Name == "org/nome");
        Assert.Equal("Hugging Face", hub.Runner);
        Assert.Equal("GGUF", hub.Format);
    }
}

public class SnapshotTests
{
    [Fact(Timeout = 30000)]
    public async Task Compare_reports_growth_and_folds_parent_chains()
    {
        await Task.Yield();
        using var tree = new TempTree();
        var repo = new SnapshotRepository(tree.Root);
        const long mb = 1024 * 1024;

        var first = new Helpers.FakeTree();
        first.Add(@"X:\r", "a", attrs: 0x10);
        first.Add(@"X:\r", "sumiu", attrs: 0x10);
        first.Add(@"X:\r\a", "b", attrs: 0x10);
        first.Add(@"X:\r\a\b", "f.bin", 10 * mb);
        first.Add(@"X:\r\sumiu", "g.bin", 7 * mb);
        var baseHeader = repo.Save(first.Scan(@"X:\r").Store, 100, 50, 1000);

        var second = new Helpers.FakeTree();
        second.Add(@"X:\r", "a", attrs: 0x10);
        second.Add(@"X:\r", "novo", attrs: 0x10);
        second.Add(@"X:\r\a", "b", attrs: 0x10);
        second.Add(@"X:\r\a\b", "f.bin", 110 * mb);
        second.Add(@"X:\r\novo", "h.bin", 20 * mb);
        var targetHeader = repo.Save(second.Scan(@"X:\r").Store, 100, 40, 2000);

        var list = repo.List(@"X:\r");
        Assert.Equal(2, list.Count);
        Assert.Equal(targetHeader.Id, list[0].Id);

        var result = repo.Compare(@"X:\r", baseHeader.Id, targetHeader.Id);
        var top = result.Items[0];
        Assert.Equal(@"X:\r\a\b", top.Path);
        Assert.Equal(100 * mb, top.Delta);
        Assert.DoesNotContain(result.Items, i => i.Path == @"X:\r\a");
        Assert.Contains(result.Items, i => i.Path == @"X:\r\novo" && i.Status == "new" && i.Delta == 20 * mb);
        Assert.Contains(result.Items, i => i.Path == @"X:\r\sumiu" && i.Status == "removed" && i.Delta == -7 * mb);
    }

    [Fact(Timeout = 30000)]
    public async Task Bad_snapshot_ids_are_refused()
    {
        await Task.Yield();
        using var tree = new TempTree();
        var repo = new SnapshotRepository(tree.Root);
        Assert.Throws<ArgumentException>(() => repo.Compare(@"X:\r", @"..\..\segredo", "1"));
    }
}

public class ProtocolTests
{
    [Fact(Timeout = 30000)]
    public async Task Requests_and_events_flow_end_to_end()
    {
        using var tree = new TempTree();
        tree.File(@"dados\a.bin", 5000);
        var data = Path.Combine(tree.Root, "appdata");
        var input = new BlockingPipe();
        var output = new CapturingStream();
        var server = new Server(data, false, output);
        var run = Task.Run(() => server.Run(input));

        void Send(string line) => input.Feed(Encoding.UTF8.GetBytes(line + "\n"));
        Send("{\"id\":1,\"cmd\":\"ping\"}");
        var pathJson = System.Text.Json.JsonSerializer.Serialize(Path.Combine(tree.Root, "dados"));
        Send("{\"id\":2,\"cmd\":\"scan.start\",\"args\":{\"path\":" + pathJson + "}}");
        await output.WaitFor("\"event\":\"scan.done\"", TimeSpan.FromSeconds(15));
        Send("{\"id\":3,\"cmd\":\"query\",\"args\":{\"filter\":{\"kind\":\"file\"}}}");
        await output.WaitFor("\"id\":3", TimeSpan.FromSeconds(10));
        Send("{\"id\":4,\"cmd\":\"does.not.exist\"}");
        await output.WaitFor("unknown-command", TimeSpan.FromSeconds(10));
        Send("not json at all");
        Send("{\"id\":5,\"cmd\":\"node.info\",\"args\":{\"ids\":[999999]}}");
        await output.WaitFor("\"gone\":true", TimeSpan.FromSeconds(10));
        var text = output.Text;
        Assert.Contains("a.bin", text);
        Assert.Contains("scan.progress", text);
        input.Close();
        await run.WaitAsync(TimeSpan.FromSeconds(10));
    }

    private sealed class BlockingPipe : Stream
    {
        private readonly System.Collections.Concurrent.BlockingCollection<byte[]> _chunks = new();
        private byte[] _current = Array.Empty<byte>();
        private int _pos;
        public void Feed(byte[] data) => _chunks.Add(data);
        public new void Close() => _chunks.CompleteAdding();

        public override int Read(byte[] buffer, int offset, int count)
        {
            if (_pos >= _current.Length)
            {
                if (!_chunks.TryTake(out _current!, Timeout.Infinite)) return 0;
                _pos = 0;
            }
            var length = Math.Min(count, _current.Length - _pos);
            Array.Copy(_current, _pos, buffer, offset, length);
            _pos += length;
            return length;
        }

        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => 0;
        public override long Position { get; set; }
        public override void Flush() { }
        public override long Seek(long offset, SeekOrigin origin) => 0;
        public override void SetLength(long value) { }
        public override void Write(byte[] buffer, int offset, int count) { }
    }

    private sealed class CapturingStream : Stream
    {
        private readonly StringBuilder _builder = new();
        public string Text
        {
            get
            {
                lock (_builder) return _builder.ToString();
            }
        }

        public async Task WaitFor(string needle, TimeSpan timeout)
        {
            var until = DateTime.UtcNow + timeout;
            while (DateTime.UtcNow < until)
            {
                if (Text.Contains(needle)) return;
                await Task.Delay(20);
            }
            throw new TimeoutException(needle + "\n" + Text);
        }

        public override void Write(byte[] buffer, int offset, int count)
        {
            lock (_builder) _builder.Append(Encoding.UTF8.GetString(buffer, offset, count));
        }

        public override bool CanRead => false;
        public override bool CanSeek => false;
        public override bool CanWrite => true;
        public override long Length => 0;
        public override long Position { get; set; }
        public override void Flush() { }
        public override int Read(byte[] buffer, int offset, int count) => 0;
        public override long Seek(long offset, SeekOrigin origin) => 0;
        public override void SetLength(long value) { }
    }
}
