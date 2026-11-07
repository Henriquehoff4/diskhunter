using System.Runtime.InteropServices;

namespace DiskHunter.Engine;

public interface IEntrySink
{
    void Add(ReadOnlySpan<char> name, long size, long alloc, uint attributes, uint reparseTag, long lastWrite, ulong fileId);
}

public interface IDirectorySource
{
    int Read(string path, bool isRoot, IEntrySink sink, byte[] buffer);
}

public static class Attr
{
    public const uint ReadOnly = 0x1;
    public const uint Hidden = 0x2;
    public const uint System = 0x4;
    public const uint Directory = 0x10;
    public const uint ReparsePoint = 0x400;
    public const uint Offline = 0x1000;
    public const uint RecallOnOpen = 0x40000;
    public const uint RecallOnDataAccess = 0x400000;

    public static bool IsNameSurrogate(uint tag) => (tag & 0x20000000) != 0;
    public static bool IsCloud(uint attributes) => (attributes & (Offline | RecallOnOpen | RecallOnDataAccess)) != 0;
}

public sealed class NtDirectorySource : IDirectorySource
{
    private volatile bool _idClassUnsupported;

    public unsafe int Read(string path, bool isRoot, IEntrySink sink, byte[] buffer)
    {
        var flags = Native.FlagBackupSemantics | (isRoot ? 0 : Native.FlagOpenReparsePoint);
        using var handle = Native.CreateFileW(Native.LongPath(path), Native.FileListDirectory | Native.Synchronize, Native.ShareAll, IntPtr.Zero, Native.OpenExisting, flags, IntPtr.Zero);
        if (handle.IsInvalid) return Marshal.GetLastWin32Error();

        var infoClass = _idClassUnsupported ? Native.ClassFileFull : Native.ClassFileIdFull;
        fixed (byte* start = buffer)
        {
            byte restart = 1;
            while (true)
            {
                var status = Native.NtQueryDirectoryFile(handle, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, out _, start, (uint)buffer.Length, infoClass, 0, IntPtr.Zero, restart);
                restart = 0;
                if (status == Native.StatusNoMoreFiles || status == Native.StatusNoSuchFile) return 0;
                if (infoClass == Native.ClassFileIdFull && (status == Native.StatusInvalidInfoClass || status == Native.StatusNotImplemented || status == Native.StatusNotSupported || status == Native.StatusInvalidParameter))
                {
                    _idClassUnsupported = true;
                    infoClass = Native.ClassFileFull;
                    restart = 1;
                    continue;
                }
                if (status < 0) return Native.RtlNtStatusToDosError(status);

                var nameOffset = infoClass == Native.ClassFileIdFull ? 80 : 68;
                var entry = start;
                while (true)
                {
                    var next = *(uint*)entry;
                    var lastWrite = *(long*)(entry + 24);
                    var size = *(long*)(entry + 40);
                    var alloc = *(long*)(entry + 48);
                    var attributes = *(uint*)(entry + 56);
                    var nameBytes = *(uint*)(entry + 60);
                    var tag = (attributes & Attr.ReparsePoint) != 0 ? *(uint*)(entry + 64) : 0u;
                    var fileId = infoClass == Native.ClassFileIdFull ? *(ulong*)(entry + 72) : 0ul;
                    var name = new ReadOnlySpan<char>(entry + nameOffset, (int)(nameBytes / 2));
                    var isDots = name.Length <= 2 && name.Length > 0 && name[0] == '.' && (name.Length == 1 || name[1] == '.');
                    if (!isDots) sink.Add(name, size, alloc, attributes, tag, lastWrite, fileId);
                    if (next == 0) break;
                    entry += next;
                }
            }
        }
    }
}
