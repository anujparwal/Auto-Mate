// Auto-Mate Windows Portable Application Launcher
// Built with Microsoft .NET Framework 4.0+ Visual C# Compiler (csc.exe)
// Target: Windows 11 x64 (Build 22000+)

using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

[assembly: AssemblyTitle("Auto-Mate")]
[assembly: AssemblyDescription("Auto-Mate Windows Portable Application Launcher")]
[assembly: AssemblyConfiguration("Release")]
[assembly: AssemblyCompany("Auto-Mate")]
[assembly: AssemblyProduct("Auto-Mate")]
[assembly: AssemblyCopyright("Copyright (c) 2026 Auto-Mate Contributors")]
[assembly: AssemblyTrademark("")]
[assembly: AssemblyCulture("")]
[assembly: ComVisible(false)]
[assembly: AssemblyVersion("0.1.0.1")]
[assembly: AssemblyFileVersion("0.1.0.1")]
[assembly: AssemblyInformationalVersion("0.1.0-preview.1")]

namespace AutoMate.Platforms.Windows.Launcher {
    /// <summary>
    /// Encapsulates an owned Windows Job Object configured with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE.
    /// Ensures all child processes (Bun, Playwright Chromium, PowerShell helpers) are cleanly terminated
    /// by the Windows kernel when the launcher process exits or is terminated.
    /// </summary>
    internal sealed class JobObjectGuard : IDisposable {
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetInformationJobObject(IntPtr hJob, int JobObjectInfoClass, IntPtr lpJobObjectInfo, uint cbJobObjectInfoLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr hObject);

        private const int JobObjectExtendedLimitInformation = 9;
        private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;

        [StructLayout(LayoutKind.Sequential)]
        private struct IO_COUNTERS {
            public ulong ReadOperationCount;
            public ulong WriteOperationCount;
            public ulong OtherOperationCount;
            public ulong ReadTransferCount;
            public ulong WriteTransferCount;
            public ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
            public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
            public IO_COUNTERS IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryLimit;
            public UIntPtr PeakJobMemoryLimit;
        }

        private IntPtr hJob;
        private bool disposed;

        public JobObjectGuard() {
            hJob = CreateJobObject(IntPtr.Zero, null);
            if (hJob == IntPtr.Zero) {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Failed to create Windows Job Object.");
            }

            JOBOBJECT_EXTENDED_LIMIT_INFORMATION info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

            int length = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
            IntPtr infoPtr = Marshal.AllocHGlobal(length);
            try {
                Marshal.StructureToPtr(info, infoPtr, false);
                if (!SetInformationJobObject(hJob, JobObjectExtendedLimitInformation, infoPtr, (uint)length)) {
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "Failed to configure Job Object limits.");
                }
            } finally {
                Marshal.FreeHGlobal(infoPtr);
            }
        }

        public void AssignProcess(IntPtr hProcess) {
            if (!AssignProcessToJobObject(hJob, hProcess)) {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Failed to assign process to Job Object.");
            }
        }

        public void Dispose() {
            if (!disposed) {
                if (hJob != IntPtr.Zero) {
                    CloseHandle(hJob);
                    hJob = IntPtr.Zero;
                }
                disposed = true;
            }
        }
    }

    public static class Program {
        private const string VersionString = "0.1.0-preview.1";
        private const string AppTitle = "Auto-Mate";

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint GetConsoleProcessList(uint[] processList, uint processCount);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern bool CreateProcess(
            string lpApplicationName,
            string lpCommandLine,
            IntPtr lpProcessAttributes,
            IntPtr lpThreadAttributes,
            bool bInheritHandles,
            uint dwCreationFlags,
            IntPtr lpEnvironment,
            string lpCurrentDirectory,
            ref STARTUPINFO lpStartupInfo,
            out PROCESS_INFORMATION lpProcessInformation
        );

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint ResumeThread(IntPtr hThread);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool TerminateProcess(IntPtr hProcess, uint uExitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr GetStdHandle(int nStdHandle);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr hObject);

        private const int STD_INPUT_HANDLE = -10;
        private const int STD_OUTPUT_HANDLE = -11;
        private const int STD_ERROR_HANDLE = -12;
        private const int STARTF_USESTDHANDLES = 0x00000100;
        private const uint CREATE_SUSPENDED = 0x00000004;
        private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
        private const uint INFINITE = 0xFFFFFFFF;

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct STARTUPINFO {
            public int cb;
            public string lpReserved;
            public string lpDesktop;
            public string lpTitle;
            public int dwX;
            public int dwY;
            public int dwXSize;
            public int dwYSize;
            public int dwXCountChars;
            public int dwYCountChars;
            public int dwFillAttribute;
            public int dwFlags;
            public short wShowWindow;
            public short cbReserved2;
            public IntPtr lpReserved2;
            public IntPtr hStdInput;
            public IntPtr hStdOutput;
            public IntPtr hStdError;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct PROCESS_INFORMATION {
            public IntPtr hProcess;
            public IntPtr hThread;
            public int dwProcessId;
            public int dwThreadId;
        }

        /// <summary>
        /// Determines whether the current process owns its console window (e.g., launched from Windows Explorer)
        /// or was invoked from an existing interactive terminal (cmd.exe or powershell.exe).
        /// </summary>
        private static bool IsOwnedConsole() {
            try {
                uint[] pids = new uint[2];
                return GetConsoleProcessList(pids, 2) <= 1;
            } catch {
                return false;
            }
        }

        /// <summary>
        /// Determines whether error messages should present interactive UI prompts (MessageBox/ReadLine).
        /// Returns false for --check, redirected streams, or non-interactive automation environments.
        /// </summary>
        private static bool ShouldPresentInteractiveError(bool isCheck) {
            if (isCheck) {
                return false;
            }
            try {
                if (Console.IsOutputRedirected || Console.IsErrorRedirected || Console.IsInputRedirected) {
                    return false;
                }
            } catch {
                return false;
            }
            return IsOwnedConsole();
        }

        private static void ShowHelp() {
            Console.WriteLine("Auto-Mate v" + VersionString + " (Windows x64 Portable)");
            Console.WriteLine("Unsigned Developer Preview. Test data and verified local workstations only.");
            Console.WriteLine();
            Console.WriteLine("Usage:");
            Console.WriteLine("  Auto-Mate.exe [options]");
            Console.WriteLine();
            Console.WriteLine("Options:");
            Console.WriteLine("  (no arguments)       Launch Auto-Mate Owner Autofill application in Chromium");
            Console.WriteLine("  --check              Run offline verification smoke test (headless Chromium + DPAPI)");
            Console.WriteLine("  --version            Display version and runtime details");
            Console.WriteLine("  --help               Display this help message");
            Console.WriteLine();
            Console.WriteLine("Runtime Architecture:");
            Console.WriteLine("  - Runtime dependencies are bundled; external website browsing still requires network access.");
            Console.WriteLine("  - Bundled Bun 1.4.4 x64 runtime located in bin\\bun.exe.");
            Console.WriteLine("  - Bundled Playwright Chromium resources located in browsers\\.");
            Console.WriteLine("  - Session audit journal stored per-user at %LOCALAPPDATA%\\AutoMate\\audit.");
            Console.WriteLine("  - Protected vaults stored per-user under Windows DPAPI CurrentUser encryption.");
            Console.WriteLine("  - Child process tree managed by an owned Windows Job Object with kill-on-close limits.");
        }

        private static void ShowVersion() {
            Console.WriteLine("Auto-Mate v" + VersionString + " (windows-x64 portable)");
            Console.WriteLine("Runtime: Bundled Bun 1.4.4 (Windows x64)");
            Console.WriteLine("Browser Engine: Playwright Chromium revision 1248 (Chrome for Testing 156.0.8078.4)");
            Console.WriteLine("Classification: Unsigned Developer Preview (Private Release)");
            Console.WriteLine("Hardware Authentication: Windows Hello biometric / PIN verification required for normal vaults");
        }

        private static void ReportError(string title, string message, bool isCheck) {
            Console.Error.WriteLine("[" + AppTitle + " Error] " + message);
            if (ShouldPresentInteractiveError(isCheck)) {
                try {
                    MessageBox.Show(message, AppTitle + " - " + title, MessageBoxButtons.OK, MessageBoxIcon.Error);
                } catch {
                    // Ignore GUI failure if message box cannot be presented.
                }
            }
        }

        public static int Main(string[] args) {
            // Process basic informational switches
            if (args.Length == 1) {
                string arg = args[0].Trim();
                if (arg == "--help") {
                    ShowHelp();
                    return 0;
                }
                if (arg == "--version") {
                    ShowVersion();
                    return 0;
                }
            }

            // Determine execution mode
            bool isCheck = false;
            if (args.Length == 0) {
                isCheck = false;
            } else if (args.Length == 1 && args[0] == "--check") {
                isCheck = true;
            } else {
                Console.Error.WriteLine("Unrecognized arguments. Use Auto-Mate.exe --help for usage details.");
                return 1;
            }

            string baseDir = AppDomain.CurrentDomain.BaseDirectory;
            string bunExe = Path.Combine(baseDir, @"bin\bun.exe");
            string browsersDir = Path.Combine(baseDir, @"browsers");

            // Verify bundled Bun executable exists
            if (!File.Exists(bunExe)) {
                ReportError("Runtime Missing",
                    "The bundled Bun runtime was not found at:\n" + bunExe +
                    "\n\nPlease ensure the portable ZIP package was extracted completely.", isCheck);
                return 1;
            }

            // Verify bundled Playwright browsers directory exists
            if (!Directory.Exists(browsersDir)) {
                ReportError("Browser Engine Missing",
                    "The bundled Playwright browser directory was not found at:\n" + browsersDir +
                    "\n\nPlease ensure the portable ZIP package was extracted completely.", isCheck);
                return 1;
            }

            // Determine entrypoint script: run-app.ts for normal app, smoke.ts for --check
            string scriptRelPath = isCheck ? @"tools\smoke.ts" : @"tools\run-app.ts";
            string targetScript = Path.Combine(baseDir, scriptRelPath);

            if (!File.Exists(targetScript)) {
                ReportError("Application Script Missing",
                    "The application entrypoint was not found at:\n" + targetScript +
                    "\n\nPlease verify your installation.", isCheck);
                return 1;
            }

            // Configure environment variables in the parent process so child inherits them via lpEnvironment = IntPtr.Zero
            Environment.SetEnvironmentVariable("PLAYWRIGHT_BROWSERS_PATH", browsersDir);

            string existingPath = Environment.GetEnvironmentVariable("PATH");
            if (existingPath == null) {
                existingPath = "";
            }
            string binDir = Path.Combine(baseDir, "bin");
            Environment.SetEnvironmentVariable("PATH", binDir + ";" + existingPath);
            Environment.SetEnvironmentVariable("AUTOMATE_PORTABLE_ROOT", baseDir);

            // Compose command line: "C:\path\to\bun.exe" run "C:\path\to\target.ts"
            string commandLine = "\"" + bunExe + "\" run \"" + targetScript + "\"";

            STARTUPINFO si = new STARTUPINFO();
            si.cb = Marshal.SizeOf(typeof(STARTUPINFO));

            IntPtr hIn = GetStdHandle(STD_INPUT_HANDLE);
            IntPtr hOut = GetStdHandle(STD_OUTPUT_HANDLE);
            IntPtr hErr = GetStdHandle(STD_ERROR_HANDLE);
            IntPtr invalidHandle = new IntPtr(-1);

            if (hIn != IntPtr.Zero && hIn != invalidHandle &&
                hOut != IntPtr.Zero && hOut != invalidHandle &&
                hErr != IntPtr.Zero && hErr != invalidHandle) {
                si.dwFlags = STARTF_USESTDHANDLES;
                si.hStdInput = hIn;
                si.hStdOutput = hOut;
                si.hStdError = hErr;
            }

            PROCESS_INFORMATION pi = new PROCESS_INFORMATION();
            uint creationFlags = CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT;

            IntPtr processHandle = IntPtr.Zero;
            int exitCode = 1;

            try {
                // Initialize Job Object guard with KILL_ON_JOB_CLOSE before spawning
                using (JobObjectGuard jobGuard = new JobObjectGuard()) {
                    // Create child process SUSPENDED to prevent execution escape before job assignment
                    bool created = CreateProcess(
                        bunExe,
                        commandLine,
                        IntPtr.Zero,
                        IntPtr.Zero,
                        true, // bInheritHandles
                        creationFlags,
                        IntPtr.Zero, // lpEnvironment: inherits parent environment
                        baseDir,
                        ref si,
                        out pi
                    );

                    if (!created) {
                        throw new Win32Exception(Marshal.GetLastWin32Error(), "Failed to create Bun process.");
                    }

                    processHandle = pi.hProcess;
                    IntPtr threadHandle = pi.hThread;

                    // 1. Assign process to Job Object while still suspended
                    try {
                        jobGuard.AssignProcess(processHandle);
                    } catch {
                        // Terminate suspended process immediately on job assignment failure.
                        // It has never executed a single user instruction.
                        try { TerminateProcess(processHandle, 1); } catch { }
                        CloseHandle(processHandle);
                        CloseHandle(threadHandle);
                        processHandle = IntPtr.Zero;
                        throw;
                    }

                    // 2. Resume thread ONLY after verified job assignment
                    uint resumeResult = ResumeThread(threadHandle);
                    CloseHandle(threadHandle);
                    if (resumeResult == 0xFFFFFFFF) {
                        try { TerminateProcess(processHandle, 1); } catch { }
                        CloseHandle(processHandle);
                        processHandle = IntPtr.Zero;
                        throw new Win32Exception(Marshal.GetLastWin32Error(), "Failed to resume Bun main thread.");
                    }

                    // 3. Wait for process exit
                    WaitForSingleObject(processHandle, INFINITE);

                    uint rawExitCode;
                    if (!GetExitCodeProcess(processHandle, out rawExitCode)) {
                        rawExitCode = 1;
                    }
                    exitCode = (int)rawExitCode;

                    CloseHandle(processHandle);
                    processHandle = IntPtr.Zero;
                }
            } catch (Win32Exception ex) {
                ReportError("Execution Error",
                    "Failed to launch Auto-Mate runtime process: " + ex.Message + " (Error code: " + ex.NativeErrorCode + ")", isCheck);
                return 1;
            } catch (Exception ex) {
                ReportError("Execution Error",
                    "An unexpected error occurred during execution: " + ex.Message, isCheck);
                return 1;
            } finally {
                if (processHandle != IntPtr.Zero) {
                    try { TerminateProcess(processHandle, 1); } catch { }
                    CloseHandle(processHandle);
                }
            }

            // If launched interactively by double-clicking in Explorer and an error occurred, pause so user can read message
            if (exitCode != 0 && ShouldPresentInteractiveError(isCheck)) {
                Console.WriteLine();
                Console.WriteLine("[Auto-Mate] Application process exited with error code {0}.", exitCode);
                Console.WriteLine("Press Enter to close this window...");
                try {
                    Console.ReadLine();
                } catch {
                    // Ignore stream closure
                }
            }

            return exitCode;
        }
    }
}
