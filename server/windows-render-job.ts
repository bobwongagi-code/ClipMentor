// The keeper is launched by the supervisor on Windows. Its only inputs are
// an owned child's PID and the supervisor's private pipe. No handle is inherited.
export const windowsRenderJobCommand = Buffer.from(String.raw`
$ErrorActionPreference = 'Stop'
try {
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
using Microsoft.Win32.SafeHandles;

public static class RenderJob {
    [StructLayout(LayoutKind.Sequential)]
    struct BasicLimit {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr MinWorkingSet, MaxWorkingSet;
        public uint ActiveLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct IoCounters {
        public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct ExtendedLimit {
        public BasicLimit Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct Accounting {
        public long UserTime, KernelTime, ThisPeriodUser, ThisPeriodKernel;
        public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
    }

    [DllImport("kernel32.dll", EntryPoint = "CreateJobObjectW", SetLastError = true)]
    static extern SafeFileHandle CreateJobObject(IntPtr attributes, IntPtr name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(SafeFileHandle job, int infoClass, ref ExtendedLimit info, uint length);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern SafeFileHandle OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(SafeFileHandle job, SafeFileHandle process);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateJobObject(SafeFileHandle job, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool QueryInformationJobObject(SafeFileHandle job, int infoClass, out Accounting info, uint length, IntPtr returned);

    static Win32Exception NativeError() { return new Win32Exception(Marshal.GetLastWin32Error()); }

    public static void Hold(int pid) {
        const uint AssignAccess = 0x0101; // PROCESS_SET_QUOTA | PROCESS_TERMINATE
        const uint KillOnClose = 0x2000;
        const int ExtendedLimitInformation = 9;
        const int BasicAccountingInformation = 1;
        var processHandle = OpenProcess(AssignAccess, false, pid);
        if (processHandle.IsInvalid) throw NativeError();
        using (var process = processHandle) {
            Console.WriteLine("opened");
            Console.Out.Flush();
            if (Console.ReadLine() != "attach") return;
            using (var job = CreateJobObject(IntPtr.Zero, IntPtr.Zero)) {
                if (job.IsInvalid) throw NativeError();
                var limits = new ExtendedLimit();
                limits.Basic.Flags = KillOnClose;
                if (!SetInformationJobObject(job, ExtendedLimitInformation, ref limits, (uint)Marshal.SizeOf(limits)))
                    throw NativeError();
                if (!AssignProcessToJobObject(job, process)) throw NativeError();
                Console.WriteLine("owned");
                Console.Out.Flush();
                Console.ReadLine();

                if (!TerminateJobObject(job, 1)) throw NativeError();
                var deadline = Stopwatch.StartNew();
                while (deadline.ElapsedMilliseconds < 5000) {
                    Accounting info;
                    if (!QueryInformationJobObject(job, BasicAccountingInformation, out info,
                        (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero)) throw NativeError();
                    if (info.ActiveProcesses == 0) {
                        Console.WriteLine("drained");
                        Console.Out.Flush();
                        return;
                    }
                    Thread.Sleep(20);
                }
                throw new TimeoutException("Render job still has active processes after termination");
            }
        }
    }
}
'@
[Console]::WriteLine('listening')
[Console]::Out.Flush()
$childPid = [Console]::ReadLine()
if ($null -ne $childPid) { [RenderJob]::Hold([int]$childPid) }
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`, 'utf16le').toString('base64');
