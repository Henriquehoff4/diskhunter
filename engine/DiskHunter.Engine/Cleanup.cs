namespace DiskHunter.Engine;

public sealed class CleanupOptions
{
    public int DownloadsDays = 180;
    public int InstallerDays = 30;
    public int StaleProjectDays = 90;
    public int LogDays = 30;
    public long NowUnix = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
    public int MaxItems = 500;
}

public sealed class Recommendation
{
    public required string Id;
    public required string Group;
    public required string Title;
    public required string Why;
    public required string Risk;
    public required string Action;
    public long Bytes;
    public long Count;
    public string? Note;
    public List<int> Items = new();
    public List<(int id, long bytes)> Pool = new();
}

public static class Cleanup
{
    private enum Mode { Contents, Folder, Info }

    private sealed record Rule(string Id, string Pattern, Mode Mode, int StaleDays = 0)
    {
        public readonly string[] Segments = Pattern.Split('/');
        public string Leaf => Segments[^1];
    }

    private sealed record Meta(string Group, string Title, string Why, string Risk, string? Note = null);

    private static readonly Dictionary<string, Meta> Metas = new()
    {
        ["temp"] = new("Temporários", "Arquivos temporários do usuário", "Programas deixam estes arquivos para trás. Os que estiverem em uso são ignorados.", "low"),
        ["win-temp"] = new("Temporários", "Temporários do Windows", "Sobras de instalações e serviços do Windows.", "low", "Pode exigir abrir o DiskHunter como administrador."),
        ["browser"] = new("Caches", "Cache de navegadores", "Páginas e imagens guardadas. O navegador baixa de novo quando precisar; feche-o antes para liberar mais.", "low"),
        ["apps"] = new("Caches", "Cache de aplicativos", "Dados descartáveis de apps como Discord, Slack e VS Code. Feche os apps antes.", "low"),
        ["shader"] = new("Caches", "Cache de sombreadores", "O Windows e o driver de vídeo recriam estes arquivos; o primeiro carregamento de jogos pode ficar mais lento.", "low"),
        ["crash"] = new("Temporários", "Relatórios de falhas", "Só servem para diagnosticar travamentos passados.", "low", "Pode exigir abrir o DiskHunter como administrador."),
        ["update"] = new("Temporários", "Downloads do Windows Update", "Instaladores já baixados. O Windows baixa de novo se precisar.", "review", "Exige administrador. Em dúvida, use a Limpeza de Disco do Windows."),
        ["devcache"] = new("Desenvolvimento", "Caches de desenvolvimento", "npm, pip, NuGet, Gradle e similares. Serão baixados de novo no próximo build, o que exige internet e tempo.", "review"),
        ["node_modules"] = new("Desenvolvimento", "node_modules de projetos parados", "Sem alteração há mais de 90 dias. Dá para recriar com npm install se o projeto tiver lockfile.", "review", "A data vem da própria pasta e nem sempre reflete o último uso do projeto."),
        ["pycache"] = new("Desenvolvimento", "Caches do Python", "Bytecode recriado automaticamente pelo Python.", "low"),
        ["installers"] = new("Downloads", "Instaladores esquecidos", "Instaladores e imagens de disco com mais de 30 dias em Downloads, Desktop ou Documentos. Confira se ainda precisa deles.", "review"),
        ["downloads"] = new("Downloads", "Downloads antigos", "Itens em Downloads sem alteração há mais de 180 dias. Confira um a um: podem ser arquivos únicos.", "caution"),
        ["dumps"] = new("Temporários", "Despejos de memória", "Arquivos .dmp grandes, usados só para depuração.", "review"),
        ["logs"] = new("Temporários", "Logs grandes e antigos", "Arquivos de log com mais de 50 MB e 30 dias.", "review"),
        ["recycle"] = new("Sistema", "Lixeira", "Itens já enviados à Lixeira ainda ocupam espaço até ela ser esvaziada.", "low", "Esvazie pela própria Lixeira do Windows."),
        ["windows-old"] = new("Sistema", "Instalação anterior do Windows", "Permite voltar à versão anterior. Remova pela Limpeza de Disco do Windows, não manualmente.", "caution"),
        ["hibernate"] = new("Sistema", "Hibernação e arquivo de paginação", "Gerenciados pelo Windows. Não devem ser apagados à mão; a hibernação pode ser desligada com powercfg /h off.", "caution"),
        ["delivery"] = new("Sistema", "Otimização de Entrega", "Cache de atualizações compartilhadas. Limpe pela Limpeza de Disco do Windows.", "low"),
    };

    private static readonly Rule[] DirRules =
    {
        new("temp", "AppData/Local/Temp", Mode.Contents),
        new("win-temp", "^/Windows/Temp", Mode.Contents),
        new("browser", "User Data/*/Cache", Mode.Contents),
        new("browser", "User Data/*/Code Cache", Mode.Contents),
        new("browser", "User Data/*/GPUCache", Mode.Contents),
        new("browser", "User Data/*/DawnCache", Mode.Contents),
        new("browser", "User Data/*/DawnGraphiteCache", Mode.Contents),
        new("browser", "User Data/*/DawnWebGPUCache", Mode.Contents),
        new("browser", "User Data/*/Service Worker/CacheStorage", Mode.Contents),
        new("browser", "User Data/ShaderCache", Mode.Contents),
        new("browser", "User Data/GrShaderCache", Mode.Contents),
        new("browser", "Firefox/Profiles/*/cache2", Mode.Contents),
        new("apps", "AppData/Roaming/*/Cache", Mode.Contents),
        new("apps", "AppData/Roaming/*/Code Cache", Mode.Contents),
        new("apps", "AppData/Roaming/*/GPUCache", Mode.Contents),
        new("apps", "AppData/Roaming/Code/CachedData", Mode.Contents),
        new("apps", "AppData/Roaming/Code/CachedExtensionVSIXs", Mode.Contents),
        new("shader", "AppData/Local/D3DSCache", Mode.Contents),
        new("shader", "AppData/Local/NVIDIA/DXCache", Mode.Contents),
        new("shader", "AppData/Local/NVIDIA/GLCache", Mode.Contents),
        new("shader", "AppData/Local/AMD/DxCache", Mode.Contents),
        new("crash", "AppData/Local/CrashDumps", Mode.Contents),
        new("crash", "^/Windows/Minidump", Mode.Contents),
        new("crash", "^/ProgramData/Microsoft/Windows/WER/ReportArchive", Mode.Contents),
        new("crash", "^/ProgramData/Microsoft/Windows/WER/ReportQueue", Mode.Contents),
        new("update", "^/Windows/SoftwareDistribution/Download", Mode.Contents),
        new("devcache", "AppData/Local/npm-cache", Mode.Contents),
        new("devcache", "AppData/Local/pip/cache", Mode.Contents),
        new("devcache", "AppData/Local/Yarn/Cache", Mode.Contents),
        new("devcache", "AppData/Local/pnpm-cache", Mode.Contents),
        new("devcache", "AppData/Local/go-build", Mode.Contents),
        new("devcache", "AppData/Local/ms-playwright", Mode.Contents),
        new("devcache", "AppData/Local/electron/Cache", Mode.Contents),
        new("devcache", "AppData/Local/electron-builder/Cache", Mode.Contents),
        new("devcache", ".nuget/packages", Mode.Contents),
        new("devcache", ".gradle/caches", Mode.Contents),
        new("devcache", ".m2/repository", Mode.Contents),
        new("devcache", ".cargo/registry/cache", Mode.Contents),
        new("devcache", ".cache/puppeteer", Mode.Contents),
        new("node_modules", "node_modules", Mode.Folder, 90),
        new("pycache", "__pycache__", Mode.Folder),
        new("recycle", "^/$Recycle.Bin", Mode.Info),
        new("windows-old", "^/Windows.old", Mode.Info),
        new("delivery", "^/Windows/ServiceProfiles/NetworkService/AppData/Local/Microsoft/Windows/DeliveryOptimization", Mode.Info),
    };

    private static readonly string[][] DownloadPatterns =
    {
        "Users/*/Downloads".Split('/'),
        "Users/*/OneDrive/Downloads".Split('/'),
    };

    private static readonly string[][] UserPatterns =
    {
        "Users/*/Desktop".Split('/'),
        "Users/*/Documents".Split('/'),
        "Users/*/OneDrive/Desktop".Split('/'),
        "Users/*/OneDrive/Documents".Split('/'),
    };

    private static readonly HashSet<string> InstallerExts = new(StringComparer.Ordinal) { "exe", "msi", "msix", "msixbundle", "appx", "appxbundle", "iso", "img" };
    private static readonly HashSet<string> GenericRules = new(StringComparer.Ordinal) { "node_modules", "pycache" };
    private static readonly HashSet<string> RootSystemFiles = new(StringComparer.OrdinalIgnoreCase) { "hiberfil.sys", "pagefile.sys", "swapfile.sys" };

    public static List<Recommendation> Evaluate(NodeStore store, CleanupOptions options, CancellationToken token)
    {
        var rulesByLeaf = new Dictionary<string, List<Rule>>(StringComparer.OrdinalIgnoreCase);
        foreach (var rule in DirRules)
        {
            if (!rulesByLeaf.TryGetValue(rule.Leaf, out var list)) rulesByLeaf[rule.Leaf] = list = new List<Rule>();
            list.Add(rule);
        }
        var rootSegments = store.RootPath.TrimEnd('\\').Split('\\', StringSplitOptions.RemoveEmptyEntries);
        var results = new Dictionary<string, Recommendation>();
        Recommendation Get(string id)
        {
            if (results.TryGetValue(id, out var rec)) return rec;
            var meta = Metas[id];
            rec = new Recommendation
            {
                Id = id,
                Group = meta.Group,
                Title = meta.Title,
                Why = id == "installers" ? meta.Why.Replace("30 dias", $"{options.InstallerDays} dias") : id == "downloads" ? meta.Why.Replace("180 dias", $"{options.DownloadsDays} dias") : meta.Why,
                Risk = meta.Risk,
                Action = id is "recycle" or "windows-old" or "hibernate" or "delivery" ? "info" : "trash",
                Note = meta.Note,
            };
            results[id] = rec;
            return rec;
        }
        void AddItem(Recommendation rec, int id)
        {
            var bytes = store.EffectiveAlloc(id);
            rec.Bytes += bytes;
            rec.Count++;
            rec.Pool.Add((id, bytes));
        }

        var count = store.Count;
        var covered = new bool[count];
        var userArea = new bool[count];
        var downloadRoots = new HashSet<int>();
        var system = Duplicates.SystemMap(store);
        var installerCutoff = options.NowUnix - options.InstallerDays * 86400L;
        var downloadCutoff = options.NowUnix - options.DownloadsDays * 86400L;
        var logCutoff = options.NowUnix - options.LogDays * 86400L;
        var rootLeaf = rootSegments.Length > 0 ? rootSegments[^1] : "";
        const long mib = 1024 * 1024;

        for (var i = 0; i < count; i++)
        {
            if ((i & 0xFFFF) == 0) token.ThrowIfCancellationRequested();
            ref var node = ref store[i];
            if ((node.Flags & NodeFlags.Deleted) != 0) continue;
            if (i > 0)
            {
                covered[i] = covered[node.Parent];
                userArea[i] = userArea[node.Parent];
            }
            if (covered[i]) continue;
            var inDownloads = i > 0 && downloadRoots.Contains(node.Parent);

            if ((node.Flags & NodeFlags.Dir) != 0)
            {
                if ((node.Flags & NodeFlags.Link) != 0) continue;
                var name = i == 0 ? rootLeaf : store.Name(i).ToString();
                var index = i;
                if (name.Equals("Downloads", StringComparison.OrdinalIgnoreCase) && DownloadPatterns.Any(p => MatchPattern(store, index, p, rootSegments)))
                {
                    downloadRoots.Add(i);
                    userArea[i] = true;
                }
                else if ((name.Equals("Desktop", StringComparison.OrdinalIgnoreCase) || name.Equals("Documents", StringComparison.OrdinalIgnoreCase)) && UserPatterns.Any(p => MatchPattern(store, index, p, rootSegments)))
                {
                    userArea[i] = true;
                }
                if (rulesByLeaf.TryGetValue(name, out var candidates))
                {
                    foreach (var rule in candidates)
                    {
                        if (!MatchPattern(store, i, rule.Segments, rootSegments)) continue;
                        if (GenericRules.Contains(rule.Id) && system != null && system[i]) break;
                        covered[i] = true;
                        if (rule.StaleDays > 0 && node.MTime > options.NowUnix - rule.StaleDays * 86400L) break;
                        if (node.Alloc <= 0) break;
                        var rec = Get(rule.Id);
                        if (rule.Mode == Mode.Contents)
                        {
                            for (var c = node.First; c < node.First + node.Count; c++)
                            {
                                if ((store[c].Flags & NodeFlags.Deleted) == 0 && store.EffectiveAlloc(c) > 0) AddItem(rec, c);
                            }
                        }
                        else
                        {
                            AddItem(rec, i);
                        }
                        break;
                    }
                }
                if (!covered[i] && inDownloads && node.MTime < downloadCutoff && node.Alloc > 0)
                {
                    covered[i] = true;
                    AddItem(Get("downloads"), i);
                }
                continue;
            }

            var alloc = store.EffectiveAlloc(i);
            if (node.Parent == 0 && IsDriveRoot(store) && RootSystemFiles.Contains(store.Name(i).ToString()))
            {
                AddItem(Get("hibernate"), i);
                continue;
            }
            if (alloc <= 0 || (system != null && system[i])) continue;
            var ext = store.Ext(i);
            if (userArea[i] && alloc >= mib && node.MTime < installerCutoff && InstallerExts.Contains(ext))
            {
                AddItem(Get("installers"), i);
            }
            else if (ext == "dmp" && alloc >= 10 * mib)
            {
                AddItem(Get("dumps"), i);
            }
            else if (ext == "log" && alloc >= 50 * mib && node.MTime < logCutoff)
            {
                AddItem(Get("logs"), i);
            }
            else if (inDownloads && node.MTime < downloadCutoff)
            {
                AddItem(Get("downloads"), i);
            }
        }

        foreach (var rec in results.Values)
        {
            rec.Pool.Sort((a, b) => b.bytes.CompareTo(a.bytes));
            rec.Items = rec.Pool.Take(options.MaxItems).Select(p => p.id).ToList();
            rec.Pool = new List<(int, long)>();
        }
        return results.Values.Where(r => r.Bytes > 0).OrderBy(r => r.Action == "info" ? 1 : 0).ThenByDescending(r => r.Bytes).ToList();
    }

    private static bool IsDriveRoot(NodeStore store) => store.RootPath.TrimEnd('\\').Length == 2;

    internal static bool MatchPattern(NodeStore store, int node, string[] pattern, string[] rootSegments)
    {
        var anchored = pattern[0] == "^";
        var first = anchored ? 1 : 0;
        var current = node;
        var rootPos = rootSegments.Length - 1;
        for (var p = pattern.Length - 1; p >= first; p--)
        {
            ReadOnlySpan<char> name;
            if (current > 0)
            {
                name = store.Name(current);
                current = store[current].Parent;
            }
            else
            {
                if (rootPos < 0) return false;
                name = rootSegments[rootPos--];
            }
            if (pattern[p] != "*" && !name.Equals(pattern[p], StringComparison.OrdinalIgnoreCase)) return false;
        }
        return !anchored || (current == 0 && rootPos == 0 && rootSegments[0].EndsWith(':'));
    }
}
