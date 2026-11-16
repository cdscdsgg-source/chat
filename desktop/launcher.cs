// 유튜브자막.exe — 포터블 프로그램의 실행 파일.
// runtime\node.exe 로 app\server.js 를 창 없이 띄우고, 트레이 아이콘(열기/종료)을 보여준다.
// 빌드: build.ps1 이 Windows 기본 C# 컴파일러(csc.exe)로 만든다.
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Threading;
using System.Windows.Forms;

static class Launcher
{
    static Process server;
    static NotifyIcon tray;
    static StreamWriter log;
    static string root = AppDomain.CurrentDomain.BaseDirectory;
    static string dataDir = Path.Combine(root, "data");
    static bool quitting;

    [STAThread]
    static void Main()
    {
        bool first;
        using (var mutex = new Mutex(true, "YouTubeSubtitlePortableApp", out first))
        {
            if (!first)
            {
                // 이미 실행 중이면 화면만 다시 연다
                OpenBrowser();
                return;
            }
            Application.EnableVisualStyles();
            if (!StartServer()) return;
            ShowTray();
            Application.Run();
        }
    }

    static bool StartServer()
    {
        string node = Path.Combine(root, @"runtime\node.exe");
        string script = Path.Combine(root, @"app\server.js");
        if (!File.Exists(node) || !File.Exists(script))
        {
            MessageBox.Show("프로그램 파일이 없어요. 압축을 모두 푼 폴더에서 실행해 주세요.\n\n" + node,
                "유튜브 자막", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return false;
        }
        Directory.CreateDirectory(dataDir);
        log = new StreamWriter(Path.Combine(dataDir, "log.txt"), false) { AutoFlush = true };

        var psi = new ProcessStartInfo(node, "\"" + script + "\"")
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true, // 이 런처가 끝나면 stdin이 닫히고 서버도 같이 끝난다
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            WorkingDirectory = Path.Combine(root, "app"),
        };
        server = new Process { StartInfo = psi, EnableRaisingEvents = true };
        server.OutputDataReceived += (s, e) => { if (e.Data != null) lock (log) log.WriteLine(e.Data); };
        server.ErrorDataReceived += (s, e) => { if (e.Data != null) lock (log) log.WriteLine(e.Data); };
        server.Exited += (s, e) =>
        {
            if (quitting) return;
            MessageBox.Show("프로그램이 예기치 않게 종료됐어요.\n자세한 내용: " + Path.Combine(dataDir, "log.txt"),
                "유튜브 자막", MessageBoxButtons.OK, MessageBoxIcon.Error);
            Quit();
        };
        server.Start();
        server.BeginOutputReadLine();
        server.BeginErrorReadLine();
        return true;
    }

    static void ShowTray()
    {
        var menu = new ContextMenuStrip();
        menu.Items.Add("열기", null, (s, e) => OpenBrowser());
        menu.Items.Add("자막 저장 폴더", null, (s, e) => OpenFolder(Path.Combine(dataDir, "subs-cache")));
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("종료", null, (s, e) => Quit());

        tray = new NotifyIcon
        {
            Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath) ?? SystemIcons.Application,
            Text = "유튜브 자막",
            ContextMenuStrip = menu,
            Visible = true,
        };
        tray.DoubleClick += (s, e) => OpenBrowser();
        tray.ShowBalloonTip(4000, "유튜브 자막", "브라우저에서 열려요. 끄려면 이 아이콘을 오른쪽 클릭 → 종료", ToolTipIcon.Info);
    }

    static void OpenBrowser()
    {
        string port = "5180";
        try { port = File.ReadAllText(Path.Combine(dataDir, "port.txt")).Trim(); } catch { }
        try { Process.Start("http://127.0.0.1:" + port + "/"); } catch { }
    }

    static void OpenFolder(string dir)
    {
        Directory.CreateDirectory(dir);
        Process.Start("explorer.exe", "\"" + dir + "\"");
    }

    static void Quit()
    {
        quitting = true;
        if (tray != null) tray.Visible = false;
        try
        {
            if (server != null && !server.HasExited)
            {
                server.StandardInput.Close(); // 서버가 음성 인식 프로세스까지 정리하고 끝난다
                if (!server.WaitForExit(5000)) server.Kill();
            }
        }
        catch { }
        Application.Exit();
        Environment.Exit(0);
    }
}
