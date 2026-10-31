// Auto-Mate Windows Hello Native Interop (.NET Framework 4.8 / Windows 11 Build 22000+)
// Provides desktop user verification via IUserConsentVerifierInterop and WinRT UserConsentVerifier.
// Security invariants:
// 1. Minimum OS requirement: Windows 11 build 22000+. Unmanifested RtlGetVersion check; fails closed.
// 2. Desktop WinRT COM ABI: Uses IUserConsentVerifierInterop::RequestVerificationForWindowAsync with an owned HWND.
// 3. Thread affinity & message pump: Dedicated STA thread hosting an owned dialog with active message pumping.
// 4. Strict verification: Returns true ONLY on OS UserConsentVerificationResult.Verified (0).
//    All other statuses (DeviceNotPresent, NotConfiguredForUser, DisabledByPolicy, Canceled, Timeout, Error) return false.
// 5. Clean resource lifetime: Releases COM interfaces, HSTRINGs, and closes owned window in finally.

using System;
using System.Diagnostics;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

namespace AutoMate.Platforms.Windows
{
    public enum AsyncStatus
    {
        Started = 0,
        Completed = 1,
        Canceled = 2,
        Error = 3
    }

    public enum UserConsentVerificationResult
    {
        Verified = 0,
        DeviceNotPresent = 1,
        NotConfiguredForUser = 2,
        DisabledByPolicy = 3,
        DeviceBusy = 4,
        RetriesExhausted = 5,
        Canceled = 6,
        Timeout = 100,
        UnsupportedOS = 101,
        InteropFailure = 102
    }

    [ComImport]
    [Guid("39E050C3-4E74-441A-8DC0-B81104DF949C")]
    [InterfaceType(ComInterfaceType.InterfaceIsIInspectable)]
    internal interface IUserConsentVerifierInterop
    {
        [return: MarshalAs(UnmanagedType.IUnknown)]
        object RequestVerificationForWindowAsync(
            IntPtr appWindow,
            [MarshalAs(UnmanagedType.HString)] string message,
            [In] ref Guid riid);
    }

    [ComImport]
    [Guid("00000036-0000-0000-C000-000000000046")]
    [InterfaceType(ComInterfaceType.InterfaceIsIInspectable)]
    internal interface IAsyncInfo
    {
        uint Id { get; }
        AsyncStatus Status { get; }
        int ErrorCode { get; }
        void Cancel();
        void Close();
    }

    [ComImport]
    [Guid("FD596FFD-2318-558F-9DBE-D21DF43764A5")]
    [InterfaceType(ComInterfaceType.InterfaceIsIInspectable)]
    internal interface IAsyncOperationConsentResult
    {
        void SetCompleted(IntPtr handler);
        IntPtr GetCompleted();
        int GetResults();
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    internal struct RTL_OSVERSIONINFOEXW
    {
        public uint dwOSVersionInfoSize;
        public uint dwMajorVersion;
        public uint dwMinorVersion;
        public uint dwBuildNumber;
        public uint dwPlatformId;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)]
        public string szCSDVersion;
        public ushort wServicePackMajor;
        public ushort wServicePackMinor;
        public ushort wSuiteMask;
        public byte wProductType;
        public byte wReserved;
    }

    public static class WindowsHello
    {
        private static readonly Guid IID_IUserConsentVerifierInterop = new Guid("39E050C3-4E74-441A-8DC0-B81104DF949C");
        private static readonly Guid IID_IAsyncOperation_ConsentResult = new Guid("FD596FFD-2318-558F-9DBE-D21DF43764A5");
        private const string UserConsentVerifierRuntimeClass = "Windows.Security.Credentials.UI.UserConsentVerifier";

        private const int RO_INIT_SINGLETHREADED = 0;
        private const int S_OK = 0;
        private const int S_FALSE = 1;

        [DllImport("ntdll.dll")]
        private static extern int RtlGetVersion(ref RTL_OSVERSIONINFOEXW versionInfo);

        [DllImport("combase.dll")]
        private static extern int RoInitialize(int initType);

        [DllImport("combase.dll")]
        private static extern void RoUninitialize();

        [DllImport("combase.dll")]
        private static extern int WindowsCreateString([MarshalAs(UnmanagedType.LPWStr)] string sourceString, int length, out IntPtr hstring);

        [DllImport("combase.dll")]
        private static extern int WindowsDeleteString(IntPtr hstring);

        [DllImport("combase.dll")]
        private static extern int RoGetActivationFactory(IntPtr activatableClassId, [In] ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object factory);

        private sealed class SessionState
        {
            public volatile bool TimedOut = false;
            public volatile bool UserCanceled = false;
            public volatile bool OperationCompleted = false;
            public volatile int FinalResult = (int)UserConsentVerificationResult.InteropFailure;
            public string FinalStatus = "Verification failed or timed out.";
            public volatile Form OwnerWindow;
        }

        public static bool IsWindows11OrGreater()
        {
            try
            {
                var info = new RTL_OSVERSIONINFOEXW();
                info.dwOSVersionInfoSize = (uint)Marshal.SizeOf(info);
                int status = RtlGetVersion(ref info);
                if (status != 0) return false;
                return info.dwBuildNumber >= 22000;
            }
            catch
            {
                return false;
            }
        }

        public static uint GetOSBuildNumber()
        {
            try
            {
                var info = new RTL_OSVERSIONINFOEXW();
                info.dwOSVersionInfoSize = (uint)Marshal.SizeOf(info);
                if (RtlGetVersion(ref info) == 0)
                {
                    return info.dwBuildNumber;
                }
            }
            catch { }
            return 0;
        }

        /// <summary>
        /// Prompts user for Windows Hello verification using an owned window.
        /// Returns true ONLY if the OS explicitly reports UserConsentVerificationResult.Verified (0).
        /// </summary>
        public static bool Confirm(string message = "Auto-Mate Security Verification", int timeoutSeconds = 60)
        {
            string status;
            UserConsentVerificationResult result = RequestVerification(message, timeoutSeconds, out status);
            return result == UserConsentVerificationResult.Verified;
        }

        /// <summary>
        /// Requests verification and returns the explicit UserConsentVerificationResult enum and status string.
        /// </summary>
        public static UserConsentVerificationResult RequestVerification(
            string message,
            int timeoutSeconds,
            out string statusMessage)
        {
            statusMessage = "Initialization";

            if (!IsWindows11OrGreater())
            {
                statusMessage = "Unsupported OS: Windows 11 build 22000 or higher is required.";
                return UserConsentVerificationResult.UnsupportedOS;
            }

            if (timeoutSeconds < 1 || timeoutSeconds > 300)
            {
                statusMessage = "Invalid verification deadline.";
                return UserConsentVerificationResult.InteropFailure;
            }

            // Only bounded, non-control text is allowed in the trusted prompt.
            string sanitizedMessage = string.IsNullOrWhiteSpace(message)
                ? "Auto-Mate Security Verification"
                : message.Trim();

            if (sanitizedMessage.Length > 256)
            {
                sanitizedMessage = sanitizedMessage.Substring(0, 256);
            }
            for (int i = 0; i < sanitizedMessage.Length; i++)
            {
                if (char.IsControl(sanitizedMessage[i]))
                {
                    statusMessage = "Unsupported verification message.";
                    return UserConsentVerificationResult.InteropFailure;
                }
            }

            var state = new SessionState();
            long started = Stopwatch.GetTimestamp();
            long timeoutTicks = (long)timeoutSeconds * Stopwatch.Frequency;

            Thread staThread = new Thread(() =>
            {
                bool shouldUninit = false;

                IntPtr hstr = IntPtr.Zero;
                object factoryObj = null;
                object asyncOp = null;
                IAsyncInfo asyncInfo = null;
                Form authWindow = null;

                try
                {
                    int hrInit = RoInitialize(RO_INIT_SINGLETHREADED);
                    if (hrInit != S_OK && hrInit != S_FALSE) return;
                    shouldUninit = true;
                    authWindow = CreateAuthWindow(sanitizedMessage, () =>
                    {
                        if (!state.OperationCompleted)
                        {
                            if (!state.TimedOut) state.UserCanceled = true;
                            if (asyncInfo != null)
                            {
                                try { asyncInfo.Cancel(); } catch { }
                            }
                        }
                    });
                    state.OwnerWindow = authWindow;

                    authWindow.Show();
                    authWindow.Update();
                    IntPtr hwnd = authWindow.Handle;

                    int hrStr = WindowsCreateString(UserConsentVerifierRuntimeClass, UserConsentVerifierRuntimeClass.Length, out hstr);
                    if (hrStr != 0 || hstr == IntPtr.Zero)
                    {
                        state.FinalStatus = "Failed to allocate WinRT class string.";
                        state.FinalResult = (int)UserConsentVerificationResult.InteropFailure;
                        return;
                    }

                    Guid factoryIid = IID_IUserConsentVerifierInterop;
                    int hrFactory = RoGetActivationFactory(hstr, ref factoryIid, out factoryObj);
                    if (hrFactory != 0 || factoryObj == null)
                    {
                        state.FinalStatus = "Failed to acquire IUserConsentVerifierInterop activation factory.";
                        state.FinalResult = (int)UserConsentVerificationResult.InteropFailure;
                        return;
                    }

                    var interop = (IUserConsentVerifierInterop)factoryObj;
                    Guid opIid = IID_IAsyncOperation_ConsentResult;

                    asyncOp = interop.RequestVerificationForWindowAsync(hwnd, sanitizedMessage, ref opIid);
                    if (asyncOp == null)
                    {
                        state.FinalStatus = "RequestVerificationForWindowAsync returned null operation.";
                        state.FinalResult = (int)UserConsentVerificationResult.InteropFailure;
                        return;
                    }

                    asyncInfo = (IAsyncInfo)asyncOp;

                    while (!state.TimedOut && !state.UserCanceled)
                    {
                        Application.DoEvents();
                        if (Stopwatch.GetTimestamp() - started >= timeoutTicks)
                        {
                            state.TimedOut = true;
                            state.FinalResult = (int)UserConsentVerificationResult.Timeout;
                            state.FinalStatus = "Verification timed out.";
                            break;
                        }

                        AsyncStatus status;
                        try
                        {
                            status = asyncInfo.Status;
                        }
                        catch
                        {
                            status = AsyncStatus.Error;
                        }

                        if (status != AsyncStatus.Started)
                        {
                            state.OperationCompleted = true;
                            if (status == AsyncStatus.Completed && !state.TimedOut && !state.UserCanceled)
                            {
                                var consentOp = (IAsyncOperationConsentResult)asyncOp;
                                int rawRes = consentOp.GetResults();
                                if (Stopwatch.GetTimestamp() - started >= timeoutTicks || state.TimedOut)
                                {
                                    state.TimedOut = true;
                                    state.FinalResult = (int)UserConsentVerificationResult.Timeout;
                                    state.FinalStatus = "Verification timed out.";
                                }
                                else
                                {
                                    state.FinalResult = rawRes;
                                    state.FinalStatus = "Verification completed with code " + rawRes;
                                }
                            }
                            else if (status == AsyncStatus.Canceled || state.UserCanceled)
                            {
                                state.FinalResult = (int)UserConsentVerificationResult.Canceled;
                                state.FinalStatus = "Verification canceled by user or system.";
                            }
                            else
                            {
                                state.FinalResult = (int)UserConsentVerificationResult.InteropFailure;
                                state.FinalStatus = "Verification ended with error status: " + status;
                            }
                            break;
                        }


                        Thread.Sleep(25);
                    }
                }
                catch (Exception ex)
                {
                    state.FinalResult = (int)UserConsentVerificationResult.InteropFailure;
                    state.FinalStatus = "Native verification error: " + ex.GetType().Name;
                }
                finally
                {
                    bool cancelPending = !state.OperationCompleted || state.TimedOut || state.UserCanceled;
                    state.OperationCompleted = true;

                    if (asyncInfo != null)
                    {
                        if (cancelPending) { try { asyncInfo.Cancel(); } catch { } }
                        try { asyncInfo.Close(); } catch { }
                        asyncInfo = null;
                    }
                    if (asyncOp != null)
                    {
                        try { Marshal.ReleaseComObject(asyncOp); } catch { }
                        asyncOp = null;
                    }
                    if (factoryObj != null)
                    {
                        try { Marshal.ReleaseComObject(factoryObj); } catch { }
                        factoryObj = null;
                    }
                    if (hstr != IntPtr.Zero)
                    {
                        WindowsDeleteString(hstr);
                        hstr = IntPtr.Zero;
                    }

                    if (authWindow != null)
                    {
                        try
                        {
                            if (!authWindow.IsDisposed)
                            {
                                authWindow.Close();
                                authWindow.Dispose();
                            }
                        }
                        catch { }
                        authWindow = null;
                    }
                    state.OwnerWindow = null;

                    if (shouldUninit)
                    {
                        RoUninitialize();
                    }
                }
            });

            staThread.SetApartmentState(ApartmentState.STA);
            staThread.IsBackground = true;
            staThread.Start();

            // Guard wait: bound total thread wait to timeoutSeconds + 5 seconds margin
            int waitTimeoutMs = (timeoutSeconds + 5) * 1000;
            if (!staThread.Join(waitTimeoutMs))
            {
                state.TimedOut = true;
                state.FinalResult = (int)UserConsentVerificationResult.Timeout;
                state.FinalStatus = "Verification thread wait timed out.";
                // Never abort a thread during COM or resource cleanup. Its owner-thread
                // loop observes TimedOut; closing the HWND also dismisses pending consent.
                Form owner = state.OwnerWindow;
                if (owner != null)
                {
                    try { owner.BeginInvoke(new Action(() => owner.Close())); } catch { }
                }
            }

            statusMessage = state.FinalStatus;
            if (state.TimedOut)
            {
                return UserConsentVerificationResult.Timeout;
            }
            if (state.UserCanceled)
            {
                return UserConsentVerificationResult.Canceled;
            }

            return (UserConsentVerificationResult)state.FinalResult;
        }

        private static Form CreateAuthWindow(string message, Action onCancel)
        {
            Form form = new Form();
            form.Text = "Auto-Mate Security Verification";
            form.FormBorderStyle = FormBorderStyle.FixedDialog;
            form.MaximizeBox = false;
            form.MinimizeBox = false;
            form.ShowInTaskbar = true;
            form.StartPosition = FormStartPosition.CenterScreen;
            form.ClientSize = new Size(420, 180);
            form.BackColor = SystemColors.Window;
            form.ForeColor = SystemColors.WindowText;
            form.Font = SystemFonts.MessageBoxFont ?? new Font("Segoe UI", 9F, FontStyle.Regular);

            TableLayoutPanel layout = new TableLayoutPanel();
            layout.Dock = DockStyle.Fill;
            layout.ColumnCount = 1;
            layout.RowCount = 4;
            layout.Padding = new Padding(20, 16, 20, 12);
            layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100F));
            layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 40F));

            Label titleLabel = new Label();
            titleLabel.Text = "Windows Hello Verification";
            titleLabel.Font = new Font(form.Font.FontFamily, 11F, FontStyle.Bold);
            titleLabel.AutoSize = true;
            titleLabel.Margin = new Padding(0, 0, 0, 8);
            layout.Controls.Add(titleLabel, 0, 0);

            Label messageLabel = new Label();
            messageLabel.Text = message;
            messageLabel.AutoEllipsis = true;
            messageLabel.Dock = DockStyle.Fill;
            messageLabel.ForeColor = SystemColors.WindowText;
            messageLabel.Margin = new Padding(0, 0, 0, 4);
            layout.Controls.Add(messageLabel, 0, 1);

            Label hintLabel = new Label();
            hintLabel.Text = "Please complete the prompt on your screen to proceed.";
            hintLabel.AutoSize = true;
            hintLabel.ForeColor = SystemColors.GrayText;
            hintLabel.Margin = new Padding(0, 0, 0, 8);
            layout.Controls.Add(hintLabel, 0, 2);

            Panel bottomPanel = new Panel();
            bottomPanel.Dock = DockStyle.Fill;
            bottomPanel.Margin = new Padding(0);

            Button cancelButton = new Button();
            cancelButton.Text = "Cancel";
            cancelButton.DialogResult = DialogResult.Cancel;
            cancelButton.Size = new Size(85, 28);
            cancelButton.Anchor = AnchorStyles.Bottom | AnchorStyles.Right;
            cancelButton.Location = new Point(bottomPanel.Width - cancelButton.Width, bottomPanel.Height - cancelButton.Height);
            cancelButton.FlatStyle = FlatStyle.System;
            cancelButton.Click += (s, e) =>
            {
                if (onCancel != null) onCancel();
                form.Close();
            };

            bottomPanel.Controls.Add(cancelButton);
            bottomPanel.Resize += (s, e) =>
            {
                cancelButton.Location = new Point(bottomPanel.Width - cancelButton.Width, bottomPanel.Height - cancelButton.Height);
            };

            layout.Controls.Add(bottomPanel, 0, 3);
            form.Controls.Add(layout);
            form.CancelButton = cancelButton;

            form.FormClosing += (s, e) =>
            {
                if (onCancel != null) onCancel();
            };

            return form;
        }
    }
}
