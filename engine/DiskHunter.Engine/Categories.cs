namespace DiskHunter.Engine;

public static class Categories
{
    public const byte Other = 0;
    public const byte Video = 1;
    public const byte Image = 2;
    public const byte Audio = 3;
    public const byte Document = 4;
    public const byte Archive = 5;
    public const byte Code = 6;
    public const byte Program = 7;
    public const byte AiModel = 8;
    public const int Total = 9;

    private static readonly Dictionary<string, byte> Map = Build();

    private static Dictionary<string, byte> Build()
    {
        var map = new Dictionary<string, byte>(StringComparer.Ordinal);
        void Add(byte cat, string list)
        {
            foreach (var ext in list.Split(' ')) map[ext] = cat;
        }
        Add(Code, "js mjs cjs tsx jsx json py java cs cpp c h hpp go rs rb php html css scss xml yml yaml toml map pyc class o obj lock sql sh ps1 bat cmd vue svelte ipynb wasm");
        Add(Video, "mp4 mkv mov avi wmv webm m4v mpg mpeg ts m2ts vob flv 3gp mts");
        Add(Image, "jpg jpeg png gif webp bmp tif tiff heic heif avif raw cr2 cr3 nef arw dng psd xcf svg ico exr tga");
        Add(Audio, "mp3 flac wav ogg opus m4a aac wma aiff alac mid midi");
        Add(Document, "pdf doc docx xls xlsx ppt pptx odt ods odp txt rtf md epub mobi csv tex one pages numbers key");
        Add(Archive, "zip rar 7z tar gz bz2 xz zst iso img vhd vhdx vmdk wim esd cab tgz dmg");
        Add(Program, "exe dll sys msi msix msixbundle appx appxbundle ocx drv mui pak so dylib lib a pdb bin dat cat");
        Add(AiModel, "gguf ggml safetensors ckpt pth pt onnx tflite h5 keras mlmodel nemo pte");
        return map;
    }

    public static byte Of(string ext) => Map.TryGetValue(ext, out var cat) ? cat : Other;
}
