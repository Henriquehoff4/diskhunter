using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace DiskHunter.Engine;

public sealed class ModelInfo
{
    public required int Id;
    public required string Path;
    public required string Name;
    public required string Format;
    public long Size;
    public int Parts = 1;
    public string Confidence = "likely";
    public string? Arch;
    public string? Quant;
    public long? Tensors;
    public string? Runner;
    public uint MTime;
    public List<int> PartIds = new();
}

public sealed class HeaderInfo
{
    public string Format = "";
    public bool Verified;
    public bool Rejected;
    public string? Name;
    public string? Arch;
    public string? Quant;
    public long? Tensors;
}

public static partial class AiModels
{
    private const long MinSize = 1024 * 1024;
    private const long MinBinSize = 50 * 1024 * 1024;
    private const int HeaderBytes = 2 * 1024 * 1024;

    private static readonly Dictionary<string, string> Formats = new(StringComparer.Ordinal)
    {
        ["gguf"] = "GGUF",
        ["ggml"] = "GGML",
        ["safetensors"] = "SafeTensors",
        ["ckpt"] = "Checkpoint",
        ["pth"] = "PyTorch",
        ["pt"] = "PyTorch",
        ["bin"] = "PyTorch",
        ["onnx"] = "ONNX",
        ["tflite"] = "TensorFlow Lite",
        ["h5"] = "Keras/HDF5",
        ["keras"] = "Keras",
        ["mlmodel"] = "Core ML",
        ["nemo"] = "NeMo",
        ["pte"] = "ExecuTorch",
    };

    private static readonly Dictionary<string, string> Runners = new(StringComparer.OrdinalIgnoreCase)
    {
        [".ollama"] = "Ollama",
        [".lmstudio"] = "LM Studio",
        ["LM Studio"] = "LM Studio",
        ["huggingface"] = "Hugging Face",
        ["ComfyUI"] = "ComfyUI",
        ["stable-diffusion-webui"] = "Stable Diffusion WebUI",
        ["InvokeAI"] = "InvokeAI",
        ["GPT4All"] = "GPT4All",
        ["jan"] = "Jan",
        ["koboldcpp"] = "KoboldCpp",
        ["text-generation-webui"] = "text-generation-webui",
    };

    private static readonly string[] QuantNames =
    {
        "F32", "F16", "Q4_0", "Q4_1", "Q4_1_F16", "Q8_0_OLD", "Q5_0_OLD", "Q8_0", "Q5_0", "Q5_1", "Q2_K", "Q3_K_S", "Q3_K_M", "Q3_K_L", "Q4_K_S", "Q4_K_M", "Q5_K_S", "Q5_K_M", "Q6_K", "IQ2_XS", "IQ3_XS",
    };

    [GeneratedRegex(@"-(\d{3,5})-of-(\d{3,5})", RegexOptions.CultureInvariant)]
    private static partial Regex ShardPattern();

    public static List<ModelInfo> Find(NodeStore store, CancellationToken token)
    {
        var candidates = new List<(int id, string path, string fmt, string? runner, string? repo, uint mtime, long size, bool cloud, string name)>();
        store.Lock.EnterReadLock();
        try
        {
            var count = store.Count;
            var runner = new byte[count];
            var inBlobs = new bool[count];
            var runnerNames = new List<string?> { null };
            var modelsDir = new bool[count];
            for (var i = 0; i < count; i++)
            {
                if ((i & 0xFFFF) == 0) token.ThrowIfCancellationRequested();
                ref var node = ref store[i];
                if ((node.Flags & NodeFlags.Deleted) != 0) continue;
                if (i > 0)
                {
                    runner[i] = runner[node.Parent];
                    inBlobs[i] = inBlobs[node.Parent];
                    modelsDir[i] = modelsDir[node.Parent];
                }
                if ((node.Flags & NodeFlags.Dir) != 0)
                {
                    if ((node.Flags & NodeFlags.Link) != 0) continue;
                    var dirName = store.Name(i).ToString();
                    if (Runners.TryGetValue(dirName, out var match))
                    {
                        var at = runnerNames.IndexOf(match);
                        if (at < 0)
                        {
                            runnerNames.Add(match);
                            at = runnerNames.Count - 1;
                        }
                        runner[i] = (byte)at;
                    }
                    if (dirName.Equals("models", StringComparison.OrdinalIgnoreCase) || dirName.Equals("checkpoints", StringComparison.OrdinalIgnoreCase)) modelsDir[i] = true;
                    if (dirName.Equals("blobs", StringComparison.OrdinalIgnoreCase) && i > 0 && (runner[i] != 0 || store.Name(node.Parent).StartsWith("models--", StringComparison.OrdinalIgnoreCase))) inBlobs[i] = true;
                    continue;
                }
                if ((node.Flags & (NodeFlags.Link | NodeFlags.HardlinkDup)) != 0 || node.Size < MinSize) continue;
                var ext = store.Ext(i);
                var known = Formats.TryGetValue(ext, out var format);
                var isBlob = inBlobs[i] && ext.Length == 0;
                if (!known && !isBlob) continue;
                if (ext == "bin" && node.Size < MinBinSize && !modelsDir[i] && runner[i] == 0) continue;
                candidates.Add((i, store.Path(i), format ?? "Blob", runnerNames[runner[i]], RepoName(store, i), node.MTime, node.Size, (node.Flags & NodeFlags.Cloud) != 0, store.Name(i).ToString()));
            }
        }
        finally
        {
            store.Lock.ExitReadLock();
        }

        var results = new System.Collections.Concurrent.ConcurrentBag<ModelInfo>();
        Parallel.ForEach(candidates, new ParallelOptions { CancellationToken = token, MaxDegreeOfParallelism = 4 }, c =>
        {
            var header = new HeaderInfo { Format = c.fmt };
            if (!c.cloud)
            {
                try
                {
                    header = ReadHeader(c.path, c.fmt);
                }
                catch (Exception)
                {
                    header.Verified = false;
                }
            }
            if (header.Rejected) return;
            if (c.fmt == "Blob" && !header.Verified) return;
            if (ExtOf(c.name) == "bin" && !header.Verified) return;
            results.Add(new ModelInfo
            {
                Id = c.id,
                Path = c.path,
                Name = c.repo ?? header.Name ?? c.name,
                Format = header.Format,
                Size = c.size,
                Confidence = header.Verified ? "verified" : "likely",
                Arch = header.Arch,
                Quant = header.Quant,
                Tensors = header.Tensors,
                Runner = c.runner,
                MTime = c.mtime,
                PartIds = new List<int> { c.id },
            });
        });
        return MergeShards(results);
    }

    private static string ExtOf(string name)
    {
        var dot = name.LastIndexOf('.');
        return dot <= 0 ? "" : name[(dot + 1)..].ToLowerInvariant();
    }

    private static string? RepoName(NodeStore store, int node)
    {
        var current = store[node].Parent;
        while (current > 0)
        {
            var name = store.Name(current);
            if (name.StartsWith("models--", StringComparison.OrdinalIgnoreCase))
            {
                var parts = name[8..].ToString().Split("--");
                return string.Join('/', parts);
            }
            current = store[current].Parent;
        }
        return null;
    }

    private static List<ModelInfo> MergeShards(IEnumerable<ModelInfo> models)
    {
        var merged = new Dictionary<string, ModelInfo>(StringComparer.OrdinalIgnoreCase);
        var list = new List<ModelInfo>();
        foreach (var model in models.OrderBy(m => m.Path, StringComparer.OrdinalIgnoreCase))
        {
            var fileName = System.IO.Path.GetFileName(model.Path);
            if (!ShardPattern().IsMatch(fileName))
            {
                list.Add(model);
                continue;
            }
            var key = System.IO.Path.GetDirectoryName(model.Path) + "|" + ShardPattern().Replace(fileName, "");
            if (merged.TryGetValue(key, out var existing))
            {
                existing.Size += model.Size;
                existing.Parts++;
                existing.PartIds.Add(model.Id);
                existing.Tensors = existing.Tensors == null || model.Tensors == null ? existing.Tensors ?? model.Tensors : existing.Tensors + model.Tensors;
                if (model.Confidence != "verified") existing.Confidence = model.Confidence;
            }
            else
            {
                merged[key] = model;
                list.Add(model);
            }
        }
        list.Sort((a, b) => b.Size.CompareTo(a.Size));
        return list;
    }

    public static HeaderInfo ReadHeader(string path, string declared)
    {
        using var stream = new FileStream(Native.LongPath(path), new FileStreamOptions { Mode = FileMode.Open, Access = FileAccess.Read, Share = FileShare.ReadWrite | FileShare.Delete, BufferSize = 0 });
        var buffer = new byte[Math.Min(HeaderBytes, stream.Length)];
        var read = stream.ReadAtLeast(buffer, buffer.Length, false);
        return ParseHeader(buffer.AsSpan(0, read), declared, stream.Length);
    }

    public static HeaderInfo ParseHeader(ReadOnlySpan<byte> data, string declared, long fileLength)
    {
        var info = new HeaderInfo { Format = declared == "Blob" ? "Blob" : declared };
        if (data.Length >= 4 && data[..4].SequenceEqual("GGUF"u8))
        {
            info.Format = "GGUF";
            info.Verified = true;
            ParseGguf(data, info);
            return info;
        }
        if (declared == "GGUF")
        {
            info.Rejected = true;
            return info;
        }
        if (declared == "GGML")
        {
            info.Verified = data.Length >= 4 && (data[..4].SequenceEqual("lmgg"u8) || data[..4].SequenceEqual("ggml"u8) || data[..4].SequenceEqual("tjgg"u8));
            return info;
        }
        if (declared == "SafeTensors")
        {
            if (!ParseSafeTensors(data, fileLength, info)) info.Rejected = true;
            return info;
        }
        if (declared is "PyTorch" or "Checkpoint")
        {
            var zip = data.Length >= 4 && data[0] == (byte)'P' && data[1] == (byte)'K' && data[2] == 3 && data[3] == 4;
            var pickle = data.Length >= 2 && data[0] == 0x80 && data[1] is >= 2 and <= 5;
            info.Verified = zip || pickle;
            if (!info.Verified && declared == "Checkpoint") info.Rejected = true;
            return info;
        }
        if (declared == "ONNX")
        {
            info.Verified = data.Length > 1 && data[0] == 0x08;
            if (!info.Verified) info.Rejected = true;
            return info;
        }
        if (declared == "TensorFlow Lite")
        {
            info.Verified = data.Length >= 8 && data.Slice(4, 4).SequenceEqual("TFL3"u8);
            if (!info.Verified) info.Rejected = true;
            return info;
        }
        if (declared == "Keras/HDF5")
        {
            info.Verified = data.Length >= 8 && data[..8].SequenceEqual(new byte[] { 0x89, 0x48, 0x44, 0x46, 0x0D, 0x0A, 0x1A, 0x0A });
            if (!info.Verified) info.Rejected = true;
            return info;
        }
        if (declared is "Keras" or "NeMo")
        {
            info.Verified = data.Length >= 2 && ((data[0] == (byte)'P' && data[1] == (byte)'K') || data[0] == 0x1F);
            return info;
        }
        return info;
    }

    private static bool ParseSafeTensors(ReadOnlySpan<byte> data, long fileLength, HeaderInfo info)
    {
        if (data.Length < 10) return false;
        var length = BitConverter.ToUInt64(data[..8]);
        if (length < 2 || length > 200_000_000UL || (long)length + 8 > fileLength) return false;
        if (data[8] != (byte)'{') return false;
        info.Verified = true;
        if ((long)length + 8 > data.Length) return true;
        try
        {
            using var json = JsonDocument.Parse(data.Slice(8, (int)length).ToArray());
            long tensors = 0;
            foreach (var property in json.RootElement.EnumerateObject())
            {
                if (property.Name == "__metadata__")
                {
                    if (property.Value.ValueKind != JsonValueKind.Object) continue;
                    if (property.Value.TryGetProperty("modelspec.title", out var title) && title.ValueKind == JsonValueKind.String) info.Name = title.GetString();
                    if (property.Value.TryGetProperty("modelspec.architecture", out var arch) && arch.ValueKind == JsonValueKind.String) info.Arch = arch.GetString();
                }
                else
                {
                    tensors++;
                }
            }
            info.Tensors = tensors;
        }
        catch (JsonException)
        {
            info.Verified = false;
            return false;
        }
        return true;
    }

    private static void ParseGguf(ReadOnlySpan<byte> data, HeaderInfo info)
    {
        if (data.Length < 24) return;
        var version = BitConverter.ToUInt32(data.Slice(4, 4));
        if (version is < 2 or > 16) return;
        var tensors = BitConverter.ToInt64(data.Slice(8, 8));
        var pairs = BitConverter.ToInt64(data.Slice(16, 8));
        if (tensors >= 0 && tensors < 10_000_000) info.Tensors = tensors;
        var at = 24;
        for (long i = 0; i < pairs && i < 256; i++)
        {
            if (!ReadString(data, ref at, out var key)) return;
            if (at + 4 > data.Length) return;
            var type = BitConverter.ToUInt32(data.Slice(at, 4));
            at += 4;
            if (type == 8)
            {
                if (!ReadString(data, ref at, out var value)) return;
                if (key == "general.name") info.Name = value;
                else if (key == "general.architecture") info.Arch = value;
            }
            else
            {
                if (key == "general.file_type" && type == 4 && at + 4 <= data.Length)
                {
                    var fileType = BitConverter.ToUInt32(data.Slice(at, 4));
                    if (fileType < QuantNames.Length) info.Quant = QuantNames[fileType];
                }
                if (!Skip(data, ref at, type)) return;
            }
            if (info.Name != null && info.Arch != null && info.Quant != null) return;
        }
    }

    private static bool ReadString(ReadOnlySpan<byte> data, ref int at, out string value)
    {
        value = "";
        if (at + 8 > data.Length) return false;
        var length = BitConverter.ToInt64(data.Slice(at, 8));
        if (length < 0 || length > 65536 || at + 8 + length > data.Length) return false;
        value = Encoding.UTF8.GetString(data.Slice(at + 8, (int)length));
        at += 8 + (int)length;
        return true;
    }

    private static bool Skip(ReadOnlySpan<byte> data, ref int at, uint type)
    {
        var width = WidthOf(type);
        if (width > 0)
        {
            if (at + width > data.Length) return false;
            at += width;
            return true;
        }
        if (type == 8)
        {
            return ReadString(data, ref at, out _);
        }
        if (type != 9 || at + 12 > data.Length) return false;
        var inner = BitConverter.ToUInt32(data.Slice(at, 4));
        var count = BitConverter.ToInt64(data.Slice(at + 4, 8));
        at += 12;
        if (count < 0 || count > data.Length) return false;
        var innerWidth = WidthOf(inner);
        if (innerWidth > 0)
        {
            var bytes = count * innerWidth;
            if (bytes > data.Length - at) return false;
            at += (int)bytes;
            return true;
        }
        if (inner != 8) return false;
        for (long i = 0; i < count; i++)
        {
            if (!ReadString(data, ref at, out _)) return false;
        }
        return true;
    }

    private static int WidthOf(uint type) => type switch
    {
        0 or 1 or 7 => 1,
        2 or 3 => 2,
        4 or 5 or 6 => 4,
        10 or 11 or 12 => 8,
        _ => 0,
    };
}
