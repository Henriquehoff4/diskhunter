using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace DiskHunter.Engine;

internal static unsafe class Native
{
    public const uint FileListDirectory = 0x1;
    public const uint Synchronize = 0x100000;
    public const uint ShareAll = 0x7;
    public const uint OpenExisting = 3;
    public const uint FlagBackupSemantics = 0x02000000;
    public const uint FlagOpenReparsePoint = 0x00200000;
    public const int StatusNoMoreFiles = unchecked((int)0x80000006);
    public const int StatusNoSuchFile = unchecked((int)0xC000000F);
    public const int StatusInvalidInfoClass = unchecked((int)0xC0000003);
    public const int StatusNotImplemented = unchecked((int)0xC0000002);
    public const int StatusNotSupported = unchecked((int)0xC00000BB);
    public const int StatusInvalidParameter = unchecked((int)0xC000000D);
    public const int ClassFileFull = 2;
    public const int ClassFileIdFull = 38;

    [StructLayout(LayoutKind.Sequential)]
    public struct IoStatusBlock
    {
        public IntPtr Status;
        public IntPtr Information;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
    public static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);

    [DllImport("ntdll.dll", ExactSpelling = true)]
    public static extern int NtQueryDirectoryFile(SafeFileHandle handle, IntPtr evt, IntPtr apc, IntPtr ctx, out IoStatusBlock iosb, void* buffer, uint length, int infoClass, byte single, IntPtr name, byte restart);

    [DllImport("ntdll.dll", ExactSpelling = true)]
    public static extern int RtlNtStatusToDosError(int status);

    [DllImport("kernel32.dll", SetLastError = true, ExactSpelling = true)]
    public static extern bool DeviceIoControl(SafeFileHandle handle, uint code, void* input, int inputSize, void* output, int outputSize, out int returned, IntPtr overlapped);

    public static string LongPath(string path)
    {
        if (path.StartsWith(@"\\?\", StringComparison.Ordinal)) return path;
        if (path.StartsWith(@"\\", StringComparison.Ordinal)) return @"\\?\UNC\" + path[2..];
        return @"\\?\" + path;
    }

    public static bool HasSeekPenalty(string root)
    {
        try
        {
            if (root.Length < 2 || root[1] != ':') return false;
            using var volume = CreateFileW(@"\\.\" + root[..2], 0, ShareAll, IntPtr.Zero, OpenExisting, 0, IntPtr.Zero);
            if (volume.IsInvalid) return false;
            var query = stackalloc uint[3];
            query[0] = 7;
            query[1] = 0;
            query[2] = 0;
            var output = stackalloc uint[3];
            const uint ioctlStorageQueryProperty = 0x2D1400;
            if (!DeviceIoControl(volume, ioctlStorageQueryProperty, query, 12, output, 12, out var returned, IntPtr.Zero) || returned < 9) return false;
            return ((byte*)output)[8] != 0;
        }
        catch
        {
            return false;
        }
    }
}
