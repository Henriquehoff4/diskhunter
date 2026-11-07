using System.Collections.Concurrent;

namespace DiskHunter.Engine;

public sealed class SyntheticSource : IDirectorySource
{
    private static readonly string[] DirWords = { "src", "assets", "backup", "cache", "lib", "data", "projects", "fotos", "2021", "2022", "2023", "2024", "2025", "viagem", "clientes", "render", "export", "build", "docs", "tmp", "amostras", "arquivo morto" };
    private static readonly (string ext, double meanLog, double sigma, double weight)[] Mix =
    {
        ("js", 9.0, 1.2, 12), ("json", 8.0, 1.5, 8), ("dll", 12.5, 1.5, 10), ("exe", 13.5, 1.8, 3), ("png", 11.0, 1.4, 12), ("jpg", 13.8, 1.0, 12),
        ("mp4", 19.5, 1.2, 1.4), ("mkv", 21.0, 0.8, 0.3), ("mp3", 15.0, 0.6, 3), ("pdf", 13.0, 1.5, 4), ("docx", 11.5, 1.0, 3), ("zip", 17.0, 1.8, 1.5),
        ("log", 11.0, 2.2, 3), ("dat", 12.0, 2.5, 4), ("tmp", 10.0, 2.0, 3), ("py", 8.5, 1.1, 5), ("cs", 8.8, 1.0, 4), ("sys", 12.5, 1.2, 1), ("iso", 22.0, 0.5, 0.05), ("safetensors", 22.0, 0.8, 0.02), ("gguf", 22.5, 0.7, 0.02),
    };

    private readonly ConcurrentDictionary<string, long> _budget = new(StringComparer.OrdinalIgnoreCase);
    private readonly long _now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
    private readonly double _growth;
    private readonly string _root;
    private readonly double _totalWeight;
    private readonly long _rootBudget;

    public SyntheticSource(string root, long files, double growth = 0)
    {
        _root = root.TrimEnd('\\');
        _growth = growth;
        _rootBudget = files;
        _totalWeight = Mix.Sum(m => m.weight);
    }

    private static ulong Hash(string text)
    {
        var hash = 14695981039346656037UL;
        foreach (var c in text) hash = (hash ^ char.ToLowerInvariant(c)) * 1099511628211UL;
        return hash;
    }

    private static readonly (string rel, double share)[] Skeleton =
    {
        ("Windows", 0.30), ("Program Files", 0.12), ("Program Files (x86)", 0.05), ("ProgramData", 0.04),
        ("Users", 0.01), ("Users\\Ana", 0.01), ("Users\\Ana\\AppData", 0.01), ("Users\\Ana\\AppData\\Local", 0.01),
        ("Users\\Ana\\AppData\\Local\\Temp", 0.03), ("Users\\Ana\\AppData\\Local\\npm-cache", 0.04),
        ("Users\\Ana\\AppData\\Local\\Google", 0.001), ("Users\\Ana\\AppData\\Local\\Google\\Chrome", 0.001), ("Users\\Ana\\AppData\\Local\\Google\\Chrome\\User Data", 0.001), ("Users\\Ana\\AppData\\Local\\Google\\Chrome\\User Data\\Default", 0.001), ("Users\\Ana\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Cache", 0.02),
        ("Users\\Ana\\Downloads", 0.03), ("Users\\Ana\\Documents", 0.05), ("Users\\Ana\\Videos", 0.01), ("Users\\Ana\\Pictures", 0.10), ("Users\\Ana\\projetos", 0.12), ("Users\\Ana\\projetos\\site\\node_modules", 0.08),
        ("Users\\Ana\\.cache", 0.001), ("Users\\Ana\\.cache\\huggingface", 0.001), ("Users\\Ana\\.cache\\huggingface\\hub", 0.002), ("Users\\Ana\\.ollama\\models\\blobs", 0.001), ("Users\\Ana\\modelos", 0.002),
    };

    public int Read(string path, bool isRoot, IEntrySink sink, byte[] buffer)
    {
        var trimmed = path.TrimEnd('\\');
        var relative = trimmed.Length == _root.Length ? "" : trimmed[(_root.Length + 1)..];
        var rootBudget = _rootBudget;
        _budget.TryRemove(trimmed, out var budget);
        var random = new Random((int)(Hash(relative) & 0x7FFFFFFF));

        var skeletonChildren = new List<(string name, long budget)>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var (rel, share) in Skeleton)
        {
            var parent = rel.Contains('\\') ? rel[..rel.LastIndexOf('\\')] : "";
            if (parent.Equals(relative, StringComparison.OrdinalIgnoreCase))
            {
                var name = rel[(parent.Length == 0 ? 0 : parent.Length + 1)..];
                if (seen.Add(name)) skeletonChildren.Add((name, (long)(rootBudget * share)));
                continue;
            }
            if (relative.Length > 0 && rel.StartsWith(relative + "\\", StringComparison.OrdinalIgnoreCase))
            {
                var rest = rel[(relative.Length + 1)..];
                var name = rest.Split('\\')[0];
                if (seen.Add(name)) skeletonChildren.Add((name, Math.Max(1, (long)(rootBudget * 0.0005))));
            }
            else if (relative.Length == 0 && rel.Contains('\\'))
            {
                var name = rel.Split('\\')[0];
                if (seen.Add(name)) skeletonChildren.Add((name, Math.Max(1, (long)(rootBudget * 0.0005))));
            }
        }

        foreach (var (name, childBudget) in skeletonChildren)
        {
            var childPath = trimmed + "\\" + name;
            _budget[childPath] = childBudget;
            sink.Add(name, 0, 0, Attr.Directory, 0, FileTime(_now - random.Next(0, 60 * 86400)), 0);
        }
        if (relative.Length == 0) return 0;

        var remaining = budget;
        var filesHere = (int)Math.Min(remaining, random.Next(4, 60));
        remaining -= filesHere;
        var isDownloads = relative.EndsWith("Downloads", StringComparison.OrdinalIgnoreCase);
        var isHub = relative.EndsWith("huggingface\\hub", StringComparison.OrdinalIgnoreCase) || relative.EndsWith("modelos", StringComparison.OrdinalIgnoreCase);
        for (var i = 0; i < filesHere; i++)
        {
            var kind = PickKind(random);
            var ext = isHub ? (i % 2 == 0 ? "safetensors" : "gguf") : isDownloads && i % 5 == 0 ? (i % 2 == 0 ? "iso" : "msi") : kind.ext;
            var size = (long)Math.Min(Math.Exp(kind.meanLog + kind.sigma * Gaussian(random)), 200L * 1024 * 1024 * 1024);
            if (isHub) size = (long)(random.NextDouble() * 9e9) + 1_000_000_000;
            if (isDownloads && ext is "iso" or "msi" && i % 5 == 0) size = (long)(random.NextDouble() * 4e9) + 40_000_000;
            if (_growth != 0 && (Hash(relative) % 7) == 0) size = (long)(size * (1 + _growth));
            var alloc = (size + 4095) / 4096 * 4096;
            var name = $"{Word(random)}-{random.Next(1000, 99999)}.{ext}";
            sink.Add(name, size, alloc, 0x20, 0, FileTime(_now - (long)(Math.Pow(random.NextDouble(), 2) * 5 * 365 * 86400)), Hash(relative) ^ (ulong)i);
        }

        if (remaining > 0)
        {
            var count = Math.Clamp(random.Next(2, 9), 1, (int)Math.Min(remaining, 9));
            var weights = Enumerable.Range(0, count).Select(_ => random.NextDouble() + 0.05).ToArray();
            var sum = weights.Sum();
            var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            for (var i = 0; i < count; i++)
            {
                var name = DirWords[random.Next(DirWords.Length)];
                while (!names.Add(name) || seen.Contains(name)) name = DirWords[random.Next(DirWords.Length)] + random.Next(10, 999);
                _budget[trimmed + "\\" + name] = (long)(remaining * weights[i] / sum);
                sink.Add(name, 0, 0, Attr.Directory, 0, FileTime(_now - random.Next(0, 700 * 86400)), 0);
            }
        }
        return 0;
    }

    private (string ext, double meanLog, double sigma, double weight) PickKind(Random random)
    {
        var roll = random.NextDouble() * _totalWeight;
        foreach (var item in Mix)
        {
            roll -= item.weight;
            if (roll <= 0) return item;
        }
        return Mix[0];
    }

    private static string Word(Random random) => DirWords[random.Next(DirWords.Length)].Replace(' ', '-');

    private static double Gaussian(Random random)
    {
        var u = 1 - random.NextDouble();
        var v = random.NextDouble();
        return Math.Sqrt(-2 * Math.Log(u)) * Math.Cos(2 * Math.PI * v);
    }

    private static long FileTime(long unix) => unix * 10_000_000L + 116444736000000000L;
}
