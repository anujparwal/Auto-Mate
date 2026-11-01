# Trusted lifecycle helper. No vault contents, URLs, or account identifiers enter this process.
$ErrorActionPreference = 'Stop'
try {
    Add-Type -ReferencedAssemblies System.Windows.Forms -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;
public sealed class AutoMateSessionWindow : Form {
    [DllImport("wtsapi32.dll", SetLastError=true)] static extern bool WTSRegisterSessionNotification(IntPtr hwnd, uint flags);
    [DllImport("wtsapi32.dll")] static extern bool WTSUnRegisterSessionNotification(IntPtr hwnd);
    [DllImport("wtsapi32.dll", EntryPoint="WTSQuerySessionInformationW", SetLastError=true)] static extern bool WTSQuerySessionInformation(IntPtr server, int session, int info, out IntPtr buffer, out int bytes);
    [DllImport("wtsapi32.dll")] static extern void WTSFreeMemory(IntPtr buffer);
    [DllImport("user32.dll", SetLastError=true)] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll", SetLastError=true)] static extern bool SwitchDesktop(IntPtr desktop);
    [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
    readonly Timer timer = new Timer();
    bool registered;
    public static bool IsInteractive() {
        IntPtr buffer; int bytes;
        if (!WTSQuerySessionInformation(IntPtr.Zero, -1, 8, out buffer, out bytes)) return false;
        try { if (bytes < 4 || Marshal.ReadInt32(buffer) != 0) return false; }
        finally { WTSFreeMemory(buffer); }
        IntPtr desktop = OpenInputDesktop(0, false, 0x0100);
        if (desktop == IntPtr.Zero) return false;
        try { return Environment.UserInteractive && SwitchDesktop(desktop); }
        finally { CloseDesktop(desktop); }
    }
    public AutoMateSessionWindow() {
        ShowInTaskbar = false; FormBorderStyle = FormBorderStyle.None;
        Width = 0; Height = 0; Opacity = 0;
        timer.Interval = 500;
        timer.Tick += delegate { Publish(IsInteractive()); };
    }
    protected override void SetVisibleCore(bool value) { base.SetVisibleCore(false); }
    protected override void OnHandleCreated(EventArgs args) {
        base.OnHandleCreated(args);
        registered = WTSRegisterSessionNotification(Handle, 0);
        if (!registered) throw new InvalidOperationException();
        Publish(IsInteractive());
        timer.Start();
    }
    void Publish(bool active) {
        Console.WriteLine(active ? "active" : "inactive");
        Console.Out.Flush();
    }
    protected override void WndProc(ref Message message) {
        if (message.Msg == 0x02B1) {
            int reason = message.WParam.ToInt32();
            // Any session transition removes existing authority before checking for a new active session.
            Publish(false);
            if (reason == 8 || reason == 1 || reason == 5) Publish(IsInteractive());
        }
        base.WndProc(ref message);
    }
    protected override void Dispose(bool disposing) {
        timer.Stop();
        if (registered) WTSUnRegisterSessionNotification(Handle);
        if (disposing) timer.Dispose();
        base.Dispose(disposing);
    }
    [STAThread] public static void Run() {
        using (var window = new AutoMateSessionWindow()) {
            IntPtr handle = window.Handle;
            Application.Run();
        }
    }
}
'@
    [AutoMateSessionWindow]::Run()
} catch {
    [Console]::Out.WriteLine('unavailable')
    [Console]::Out.Flush()
    exit 1
}
