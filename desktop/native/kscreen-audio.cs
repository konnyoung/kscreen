// kscreen-audio: captures what the PC is playing without the kScreen app itself (so friends never
// hear their own voices back) and, optionally, without other apps chosen by the user (Discord...).
//
// Windows' process-loopback API (VAD\Process_Loopback) can exclude only ONE process tree:
//  - no extra exclusions: one capture of everything EXCEPT the kScreen tree;
//  - with exclusions: one INCLUDE capture per app that has an audio session, minus kScreen and
//    the excluded apps, mixed here (sessions are re-scanned every second for new apps).
//
//   kscreen-audio.exe <pid> [--exclude discord,spotify]   PCM s16le 48 kHz stereo on stdout
//                                                         until stdin closes
//   kscreen-audio.exe --list <pid>    JSON: apps with an audio session (outside <pid>'s tree)
//   kscreen-audio.exe --probe         exit code 0 if the API works on this Windows
//   kscreen-audio.exe --window-rect <hwnd>   JSON: window bounds in physical pixels
//   kscreen-audio.exe --watch <hwnd>  prints 1 / 0 whenever that window is restored / minimized,
//                                     until stdin closes
//
// Built with the C# compiler that ships with Windows (.NET Framework 4): scripts/build-audio.js.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

static class Program
{
    const int SampleRate = 48000;
    const int Channels = 2;
    const int BlockAlign = 4;           // s16 stereo
    const int Chunk = 480;              // 10 ms mix step

    static volatile bool running = true;

    [MTAThread]
    static int Main(string[] args)
    {
        try
        {
            if (args.Length == 1 && args[0] == "--probe") return Probe();
            if (args.Length >= 2 && args[0] == "--gpu-priority") return GpuPriority(args);
            if (args.Length == 1 && args[0] == "--boost-app") return BoostApp();
            if (args.Length == 1 && args[0] == "--install-gpu-task") return InstallGpuTask();
            if (args.Length == 1 && args[0] == "--remove-gpu-task") return RemoveGpuTask();
            if (args.Length == 2 && args[0] == "--list") return ListApps(int.Parse(args[1]));
            if (args.Length == 2 && args[0] == "--window-rect") return WindowRect(new IntPtr(long.Parse(args[1])));
            if (args.Length == 2 && args[0] == "--watch") { WatchStdin(); return WatchForeground(new IntPtr(long.Parse(args[1]))); }
            if (args.Length >= 1)
            {
                int self = int.Parse(args[0]);
                var excludes = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                for (int i = 1; i + 1 < args.Length; i += 2)
                    if (args[i] == "--exclude")
                        foreach (string name in args[i + 1].Split(','))
                            if (name.Trim().Length > 0) excludes.Add(CleanExe(name));
                WatchStdin();
                return excludes.Count == 0 ? RunExcludeSelf(self) : RunMix(self, excludes);
            }
        }
        catch (Exception e) { Console.Error.WriteLine("erro: " + e.Message); return 3; }
        Console.Error.WriteLine("uso: kscreen-audio <pid> [--exclude a,b] | --list <pid> | --probe");
        return 2;
    }

    // The parent closes our stdin when the share stops (or the app dies): exit then.
    static AutoResetEvent wake = new AutoResetEvent(false);
    static void WatchStdin()
    {
        var t = new Thread(() => { try { Console.OpenStandardInput().CopyTo(Stream.Null); } catch { } running = false; wake.Set(); });
        t.IsBackground = true;
        t.Start();
    }

    static int Probe()
    {
        Capture c = Capture.Open(Process.GetCurrentProcess().Id, false, false);
        c.Dispose();
        return 0;
    }

    // ---- mode 1: everything except the kScreen tree (event driven, lowest latency) ----------

    static int RunExcludeSelf(int self)
    {
        Capture c = Capture.Open(self, false, true);
        c.Client.SetEventHandle(wake.SafeWaitHandle.DangerousGetHandle());
        c.Client.Start();
        Stream stdout = Console.OpenStandardOutput();
        byte[] bytes = new byte[SampleRate * BlockAlign];
        try
        {
            while (running)
            {
                wake.WaitOne(100);
                int got;
                while (running && (got = c.ReadBytes(bytes)) > 0) stdout.Write(bytes, 0, got);
                stdout.Flush();
            }
        }
        catch (IOException) { }
        finally { c.Dispose(); }
        return 0;
    }

    // ---- mode 2: mix of every app except kScreen and the excluded ones ----------------------

    // GPU scheduling priority (like OBS): a GPU-bound game otherwise keeps the capture copy and the
    // hardware encoder waiting in the GPU queue, and the share drops to a few FPS. HIGH works
    // without admin; REALTIME needs it (what OBS gets when run as admin).
    [DllImport("gdi32.dll")] static extern int D3DKMTSetProcessSchedulingPriorityClass(IntPtr process, int priorityClass);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(int access, bool inherit, int pid);
    const int D3DKMT_PRIORITY_HIGH = 4, D3DKMT_PRIORITY_REALTIME = 5;
    const int PROCESS_SET_INFORMATION = 0x0200, PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

    static int GpuPriority(string[] args)
    {
        int ok = 0, first = 1, priorityClass = D3DKMT_PRIORITY_HIGH;
        // "--gpu-priority realtime <pid...>": only granted to an elevated process (like OBS as admin).
        if (args[1] == "realtime") { priorityClass = D3DKMT_PRIORITY_REALTIME; first = 2; }
        for (int i = first; i < args.Length; i++)
        {
            int pid;
            if (!int.TryParse(args[i], out pid)) continue;
            IntPtr h = OpenProcess(PROCESS_SET_INFORMATION | PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
            if (h == IntPtr.Zero) continue;
            try { if (D3DKMTSetProcessSchedulingPriorityClass(h, priorityClass) == 0) ok++; }
            catch { /* old Windows */ }
            finally { CloseHandle(h); }
        }
        Console.WriteLine(ok);
        return ok > 0 ? 0 : 1;
    }

    // ---- REALTIME GPU priority through an elevated scheduled task ---------------------------
    //
    // Windows only grants REALTIME GPU scheduling to elevated processes (OBS gets it when run as
    // admin). Measured with Minecraft + shaders at 99% GPU: DXGI capture + AMF encode = 10 FPS at
    // normal priority, 31 at HIGH, 58 at REALTIME. The per-machine installer (UAC) registers a
    // SYSTEM task that runs "--boost-app" from Program Files (admin-only writable); the app starts
    // it with "schtasks /run" when a share begins. The task takes no arguments and only touches
    // processes whose image is this installation's kScreen.exe.
    const string GpuTaskName = "kScreen GPU";
    const int D3DKMT_PRIORITY_NORMAL = 2;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool QueryFullProcessImageNameW(IntPtr process, int flags, StringBuilder name, ref int size);

    static string AppExe()
    {
        // <install>\resources\kscreen-audio.exe -> <install>\kScreen.exe
        string resources = Path.GetDirectoryName(Path.GetFullPath(System.Reflection.Assembly.GetEntryAssembly().Location));
        return Path.Combine(Path.GetDirectoryName(resources), "kScreen.exe");
    }

    static int BoostApp()
    {
        string target = AppExe();
        int ok = 0;
        foreach (Process p in Process.GetProcessesByName("kScreen"))
        {
            IntPtr h = OpenProcess(PROCESS_SET_INFORMATION | PROCESS_QUERY_LIMITED_INFORMATION, false, p.Id);
            if (h == IntPtr.Zero) continue;
            try
            {
                var name = new StringBuilder(1024);
                int size = name.Capacity;
                if (!QueryFullProcessImageNameW(h, 0, name, ref size)) continue;
                if (!string.Equals(name.ToString(), target, StringComparison.OrdinalIgnoreCase)) continue;
                if (D3DKMTSetProcessSchedulingPriorityClass(h, D3DKMT_PRIORITY_REALTIME) == 0) ok++;
            }
            catch { /* old Windows */ }
            finally { CloseHandle(h); }
        }
        Console.WriteLine(ok);
        return ok > 0 ? 0 : 1;
    }

    static int InstallGpuTask()
    {
        string helper = Path.GetFullPath(System.Reflection.Assembly.GetEntryAssembly().Location);
        string xml =
            "<?xml version=\"1.0\" encoding=\"UTF-16\"?>" +
            "<Task version=\"1.2\" xmlns=\"http://schemas.microsoft.com/windows/2004/02/mit/task\">" +
            "<RegistrationInfo><Description>kScreen: prioridade de GPU da transmissão de tela.</Description></RegistrationInfo>" +
            "<Principals><Principal id=\"System\"><UserId>S-1-5-18</UserId><RunLevel>HighestAvailable</RunLevel></Principal></Principals>" +
            "<Settings><MultipleInstancesPolicy>Parallel</MultipleInstancesPolicy>" +
            "<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>" +
            "<AllowStartOnDemand>true</AllowStartOnDemand><Enabled>true</Enabled><Hidden>true</Hidden>" +
            "<ExecutionTimeLimit>PT1M</ExecutionTimeLimit><Priority>4</Priority></Settings>" +
            "<Actions Context=\"System\"><Exec><Command>" + System.Security.SecurityElement.Escape(helper) + "</Command>" +
            "<Arguments>--boost-app</Arguments></Exec></Actions></Task>";
        Type t = Type.GetTypeFromProgID("Schedule.Service");
        object service = Activator.CreateInstance(t);
        t.InvokeMember("Connect", System.Reflection.BindingFlags.InvokeMethod, null, service, new object[0]);
        object root = t.InvokeMember("GetFolder", System.Reflection.BindingFlags.InvokeMethod, null, service, new object[] { "\\" });
        // Full control for SYSTEM and admins; read + run for every signed-in user (it only ever
        // boosts kScreen, so letting any user start it is harmless).
        const string sddl = "D:(A;;FA;;;SY)(A;;FA;;;BA)(A;;FRFX;;;AU)";
        // 6 = TASK_CREATE_OR_UPDATE, 5 = TASK_LOGON_SERVICE_ACCOUNT
        root.GetType().InvokeMember("RegisterTask", System.Reflection.BindingFlags.InvokeMethod, null, root,
            new object[] { GpuTaskName, xml, 6, "SYSTEM", null, 5, sddl });
        Console.WriteLine("ok");
        return 0;
    }

    static int RemoveGpuTask()
    {
        try
        {
            Type t = Type.GetTypeFromProgID("Schedule.Service");
            object service = Activator.CreateInstance(t);
            t.InvokeMember("Connect", System.Reflection.BindingFlags.InvokeMethod, null, service, new object[0]);
            object root = t.InvokeMember("GetFolder", System.Reflection.BindingFlags.InvokeMethod, null, service, new object[] { "\\" });
            root.GetType().InvokeMember("DeleteTask", System.Reflection.BindingFlags.InvokeMethod, null, root, new object[] { GpuTaskName, 0 });
        }
        catch { /* not registered */ }
        return 0;
    }

    [DllImport("winmm.dll")] static extern int timeBeginPeriod(int ms);

    static int RunMix(int self, HashSet<string> excludes)
    {
        timeBeginPeriod(1);
        var captures = new Dictionary<int, Capture>();
        Stream stdout = Console.OpenStandardOutput();
        int[] mix = new int[Chunk * Channels];
        byte[] outBytes = new byte[Chunk * BlockAlign];
        short[] tmp = new short[Chunk * Channels];
        var clock = Stopwatch.StartNew();
        long produced = 0;
        long nextScan = 0;

        try
        {
            while (running)
            {
                if (clock.ElapsedMilliseconds >= nextScan)
                {
                    Rescan(self, excludes, captures);
                    nextScan = clock.ElapsedMilliseconds + 1000;
                }
                foreach (var c in new List<Capture>(captures.Values))
                {
                    if (!c.Drain()) { captures.Remove(c.Pid); c.Dispose(); }
                }

                long due = clock.ElapsedTicks * SampleRate / Stopwatch.Frequency;
                if (due - produced > SampleRate / 5) produced = due - Chunk; // fell far behind: skip
                while (due - produced >= Chunk)
                {
                    Array.Clear(mix, 0, mix.Length);
                    foreach (var c in captures.Values)
                        if (c.Take(tmp, Chunk))
                            for (int i = 0; i < tmp.Length; i++) mix[i] += tmp[i];
                    for (int i = 0; i < mix.Length; i++)
                    {
                        int v = mix[i] > short.MaxValue ? short.MaxValue : mix[i] < short.MinValue ? short.MinValue : mix[i];
                        outBytes[i * 2] = (byte)v;
                        outBytes[i * 2 + 1] = (byte)(v >> 8);
                    }
                    stdout.Write(outBytes, 0, outBytes.Length);
                    produced += Chunk;
                }
                stdout.Flush();
                Thread.Sleep(3);
            }
        }
        catch (IOException) { }
        finally { foreach (var c in captures.Values) c.Dispose(); }
        return 0;
    }

    static void Rescan(int self, HashSet<string> excludes, Dictionary<int, Capture> captures)
    {
        Dictionary<int, ProcInfo> procs = Snapshot();
        var forbidden = new HashSet<int> { self };
        foreach (var p in procs.Values) if (excludes.Contains(p.Exe)) forbidden.Add(p.Pid);

        var wanted = new HashSet<int>();
        foreach (int pid in SessionPids())
        {
            ProcInfo info;
            if (pid == 0 || !procs.TryGetValue(pid, out info)) continue;
            if (excludes.Contains(info.Exe) || IsDescendant(pid, self, procs)) continue;
            // An include capture takes the whole tree: never pick a process that is an ancestor
            // of kScreen or of an excluded app (e.g. explorer.exe, which launched both).
            bool ancestorOfForbidden = false;
            foreach (int f in forbidden) if (f != pid && IsDescendant(f, pid, procs)) { ancestorOfForbidden = true; break; }
            if (!ancestorOfForbidden) wanted.Add(pid);
        }
        // Inside an already captured tree: capturing it again would double its sound.
        var final = new HashSet<int>();
        foreach (int pid in wanted)
        {
            bool covered = false;
            foreach (int other in wanted) if (other != pid && IsDescendant(pid, other, procs)) { covered = true; break; }
            if (!covered) final.Add(pid);
        }

        foreach (int pid in new List<int>(captures.Keys))
            if (!final.Contains(pid)) { captures[pid].Dispose(); captures.Remove(pid); }
        foreach (int pid in final)
        {
            if (captures.ContainsKey(pid)) continue;
            try
            {
                Capture c = Capture.Open(pid, true, false);
                c.Client.Start();
                captures[pid] = c;
            }
            catch (Exception e) { Console.Error.WriteLine("captura " + pid + ": " + e.Message); }
        }
    }

    // ---- windows: bounds and foreground (fullscreen games are captured via their monitor) ----

    [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out RECT value, int size);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd, int flags);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hwnd, int cmd);
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);

    static void DpiAware()
    {
        // Per-monitor v2: window rects come back in real pixels, not scaled.
        try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { }
    }

    static int WindowRect(IntPtr hwnd)
    {
        DpiAware();
        if (!IsWindow(hwnd)) { Console.Out.Write("null"); return 1; }
        RECT r;
        // Extended frame bounds = what is actually drawn (no invisible resize borders).
        if (DwmGetWindowAttribute(hwnd, 9, out r, Marshal.SizeOf(typeof(RECT))) != 0) GetWindowRect(hwnd, out r);
        Console.Out.Write("{\"x\":" + r.Left + ",\"y\":" + r.Top + ",\"width\":" + (r.Right - r.Left) + ",\"height\":" + (r.Bottom - r.Top) +
            ",\"minimized\":" + (IsIconic(hwnd) ? "true" : "false") + "}");
        return 0;
    }

    static bool IsInFront(IntPtr hwnd)
    {
        IntPtr fg = GetForegroundWindow();
        if (fg == IntPtr.Zero) return false;
        if (fg == hwnd) return true;
        // The game's own popups/children (launcher dialogs, owned windows) count as the game.
        if (GetAncestor(fg, 3 /* GA_ROOTOWNER */) == hwnd || GetAncestor(fg, 2 /* GA_ROOT */) == hwnd) return true;
        return GetWindow(fg, 4 /* GW_OWNER */) == hwnd;
    }

    static int WatchForeground(IntPtr hwnd)
    {
        int last = -1;
        while (running && IsWindow(hwnd))
        {
            int now = IsIconic(hwnd) ? 0 : 1; // pause only while minimized; covered windows keep streaming
            if (now != last)
            {
                Console.Out.WriteLine(now);
                Console.Out.Flush();
                last = now;
            }
            wake.WaitOne(150);
        }
        return 0;
    }

    // ---- --list ---------------------------------------------------------------------------

    static int ListApps(int self)
    {
        Dictionary<int, ProcInfo> procs = Snapshot();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var sb = new StringBuilder("[");
        foreach (int pid in SessionPids())
        {
            ProcInfo info;
            if (pid == 0 || !procs.TryGetValue(pid, out info)) continue;
            if (IsDescendant(pid, self, procs) || !seen.Add(info.Exe)) continue;
            string name = info.Exe;
            try
            {
                string desc = Process.GetProcessById(pid).MainModule.FileVersionInfo.FileDescription;
                if (!string.IsNullOrEmpty(desc)) name = desc.Trim();
            }
            catch { }
            if (sb.Length > 1) sb.Append(',');
            sb.Append("{\"exe\":").Append(Json(info.Exe)).Append(",\"name\":").Append(Json(name)).Append('}');
        }
        sb.Append(']');
        Console.Out.Write(sb.ToString());
        return 0;
    }

    static string Json(string s)
    {
        var sb = new StringBuilder("\"");
        foreach (char ch in s)
        {
            if (ch == '"' || ch == '\\') sb.Append('\\').Append(ch);
            else if (ch < 0x20) sb.Append("\\u").Append(((int)ch).ToString("x4"));
            else sb.Append(ch);
        }
        return sb.Append('"').ToString();
    }

    // ---- processes and audio sessions -------------------------------------------------------

    class ProcInfo { public int Pid, Parent; public string Exe; }

    static string CleanExe(string exe)
    {
        exe = exe.Trim();
        return exe.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) ? exe.Substring(0, exe.Length - 4) : exe;
    }

    static bool IsDescendant(int pid, int ancestor, Dictionary<int, ProcInfo> procs)
    {
        var guard = new HashSet<int>();
        int cur = pid;
        while (guard.Add(cur))
        {
            if (cur == ancestor) return true;
            ProcInfo p;
            if (!procs.TryGetValue(cur, out p) || p.Parent == 0 || p.Parent == cur) return false;
            cur = p.Parent;
        }
        return false;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct PROCESSENTRY32W
    {
        public int dwSize, cntUsage, th32ProcessID;
        public IntPtr th32DefaultHeapID;
        public int th32ModuleID, cntThreads, th32ParentProcessID, pcPriClassBase, dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
    }
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(int flags, int pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32FirstW(IntPtr snap, ref PROCESSENTRY32W e);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32NextW(IntPtr snap, ref PROCESSENTRY32W e);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);

    static Dictionary<int, ProcInfo> Snapshot()
    {
        var map = new Dictionary<int, ProcInfo>();
        IntPtr snap = CreateToolhelp32Snapshot(2 /* TH32CS_SNAPPROCESS */, 0);
        if (snap == IntPtr.Zero || snap == new IntPtr(-1)) return map;
        try
        {
            var e = new PROCESSENTRY32W();
            e.dwSize = Marshal.SizeOf(typeof(PROCESSENTRY32W));
            if (Process32FirstW(snap, ref e))
                do map[e.th32ProcessID] = new ProcInfo { Pid = e.th32ProcessID, Parent = e.th32ParentProcessID, Exe = CleanExe(e.szExeFile) };
                while (Process32NextW(snap, ref e));
        }
        finally { CloseHandle(snap); }
        return map;
    }

    // Processes with an audio session (playing or idle) on any active output device.
    static List<int> SessionPids()
    {
        var pids = new List<int>();
        var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
        IMMDeviceCollection devices;
        enumerator.EnumAudioEndpoints(0 /* eRender */, 1 /* DEVICE_STATE_ACTIVE */, out devices);
        uint count;
        devices.GetCount(out count);
        for (uint d = 0; d < count; d++)
        {
            try
            {
                IMMDevice device;
                devices.Item(d, out device);
                Guid iid = typeof(IAudioSessionManager2).GUID;
                object o;
                device.Activate(ref iid, 23 /* CLSCTX_ALL */, IntPtr.Zero, out o);
                var manager = (IAudioSessionManager2)o;
                IAudioSessionEnumerator sessions;
                manager.GetSessionEnumerator(out sessions);
                int n;
                sessions.GetCount(out n);
                for (int i = 0; i < n; i++)
                {
                    IAudioSessionControl2 control;
                    sessions.GetSession(i, out control);
                    int state;
                    control.GetState(out state);
                    uint pid;
                    control.GetProcessId(out pid);
                    if (state != 2 /* expired */ && !pids.Contains((int)pid)) pids.Add((int)pid);
                }
            }
            catch { }
        }
        return pids;
    }
}

// One process-loopback capture (include or exclude a process tree), PCM s16 stereo 48 kHz.
class Capture : IDisposable
{
    public readonly int Pid;
    public readonly IAudioClient Client;
    readonly IAudioCaptureClient capture;
    readonly short[] ring = new short[48000 * 2];   // 1 s
    int read, write, frames;
    bool primed;

    Capture(int pid, IAudioClient client, IAudioCaptureClient capture) { Pid = pid; Client = client; this.capture = capture; }

    public static Capture Open(int pid, bool include, bool eventDriven)
    {
        IAudioClient client = Activate(pid, include);
        IntPtr format = Marshal.AllocHGlobal(18);
        Marshal.WriteInt16(format, 0, 1);          // PCM
        Marshal.WriteInt16(format, 2, 2);          // stereo
        Marshal.WriteInt32(format, 4, 48000);
        Marshal.WriteInt32(format, 8, 48000 * 4);
        Marshal.WriteInt16(format, 12, 4);
        Marshal.WriteInt16(format, 14, 16);
        Marshal.WriteInt16(format, 16, 0);
        const uint LOOPBACK = 0x00020000, EVENTCALLBACK = 0x00040000, AUTOCONVERTPCM = 0x80000000, SRC_DEFAULT_QUALITY = 0x08000000;
        uint flags = LOOPBACK | AUTOCONVERTPCM | SRC_DEFAULT_QUALITY | (eventDriven ? EVENTCALLBACK : 0);
        client.Initialize(0, flags, eventDriven ? 200000 : 2000000, 0, format, IntPtr.Zero);
        Marshal.FreeHGlobal(format);
        Guid iid = typeof(IAudioCaptureClient).GUID;
        object svc;
        client.GetService(ref iid, out svc);
        return new Capture(pid, client, (IAudioCaptureClient)svc);
    }

    // Event mode: copy every pending packet straight out as bytes.
    public int ReadBytes(byte[] dest)
    {
        uint next;
        capture.GetNextPacketSize(out next);
        if (next == 0) return 0;
        IntPtr data; uint got, flags; ulong pos, qpc;
        capture.GetBuffer(out data, out got, out flags, out pos, out qpc);
        int bytes = Math.Min((int)got * 4, dest.Length);
        if ((flags & 0x2) != 0) Array.Clear(dest, 0, bytes);
        else Marshal.Copy(data, dest, 0, bytes);
        capture.ReleaseBuffer(got);
        return bytes;
    }

    // Mix mode: move pending packets into the ring. False once the capture is dead.
    public bool Drain()
    {
        try
        {
            uint next;
            capture.GetNextPacketSize(out next);
            while (next > 0)
            {
                IntPtr data; uint got, flags; ulong pos, qpc;
                capture.GetBuffer(out data, out got, out flags, out pos, out qpc);
                int samples = (int)got * 2;
                var tmp = new short[samples];
                if ((flags & 0x2) == 0) Marshal.Copy(data, tmp, 0, samples);
                capture.ReleaseBuffer(got);
                for (int i = 0; i < samples; i++) { ring[write] = tmp[i]; write = (write + 1) % ring.Length; }
                frames = Math.Min(ring.Length / 2, frames + (int)got);
                capture.GetNextPacketSize(out next);
            }
            // Never let latency creep: keep at most ~100 ms queued.
            if (frames > 4800)
            {
                int drop = frames - 1440;
                read = (read + drop * 2) % ring.Length;
                frames -= drop;
            }
            return true;
        }
        catch { return false; }
    }

    // Small cushion (20 ms) before playing, silence on underrun instead of crackle.
    public bool Take(short[] dest, int count)
    {
        if (!primed) { if (frames < 960) return false; primed = true; }
        if (frames < count) { primed = false; return false; }
        for (int i = 0; i < count * 2; i++) { dest[i] = ring[read]; read = (read + 1) % ring.Length; }
        frames -= count;
        return true;
    }

    public void Dispose()
    {
        try { Client.Stop(); } catch { }
        try { Marshal.ReleaseComObject(capture); } catch { }
        try { Marshal.ReleaseComObject(Client); } catch { }
    }

    static IAudioClient Activate(int pid, bool include)
    {
        // AUDIOCLIENT_ACTIVATION_PARAMS { PROCESS_LOOPBACK, { pid, INCLUDE(0) / EXCLUDE(1) tree } }
        IntPtr parameters = Marshal.AllocHGlobal(12);
        Marshal.WriteInt32(parameters, 0, 1);
        Marshal.WriteInt32(parameters, 4, pid);
        Marshal.WriteInt32(parameters, 8, include ? 0 : 1);
        // PROPVARIANT { vt = VT_BLOB, blob = { 12, pBlobData } }
        IntPtr variant = Marshal.AllocHGlobal(24);
        for (int i = 0; i < 24; i += 4) Marshal.WriteInt32(variant, i, 0);
        Marshal.WriteInt16(variant, 0, 65);
        Marshal.WriteInt32(variant, 8, 12);
        Marshal.WriteIntPtr(variant, IntPtr.Size == 8 ? 16 : 12, parameters);
        try
        {
            var handler = new CompletionHandler();
            IActivateAudioInterfaceAsyncOperation op;
            Guid iid = typeof(IAudioClient).GUID;
            ActivateAudioInterfaceAsync("VAD\\Process_Loopback", ref iid, variant, handler, out op);
            if (!handler.Done.WaitOne(5000)) throw new TimeoutException("sem resposta do Windows");
            int hr;
            object unknown;
            op.GetActivateResult(out hr, out unknown);
            if (hr < 0) Marshal.ThrowExceptionForHR(hr);
            return (IAudioClient)unknown;
        }
        finally
        {
            Marshal.FreeHGlobal(variant);
            Marshal.FreeHGlobal(parameters);
        }
    }

    [DllImport("Mmdevapi.dll", ExactSpelling = true, PreserveSig = false)]
    static extern void ActivateAudioInterfaceAsync(
        [MarshalAs(UnmanagedType.LPWStr)] string deviceInterfacePath, ref Guid riid, IntPtr activationParams,
        IActivateAudioInterfaceCompletionHandler completionHandler, out IActivateAudioInterfaceAsyncOperation activationOperation);
}

// The completion handler must be agile (callable from any thread) or activation fails.
[ComVisible(true)]
[ClassInterface(ClassInterfaceType.None)]
class CompletionHandler : IActivateAudioInterfaceCompletionHandler, IAgileObject
{
    public readonly ManualResetEvent Done = new ManualResetEvent(false);
    public void ActivateCompleted(IActivateAudioInterfaceAsyncOperation operation) { Done.Set(); }
}

[ComImport, Guid("94ea2b94-e9cc-49e0-c0ff-ee64ca8f5b90"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAgileObject { }

[ComImport, Guid("41D949AB-9862-444A-80F6-C261334DA5EB"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IActivateAudioInterfaceCompletionHandler
{
    void ActivateCompleted(IActivateAudioInterfaceAsyncOperation activateOperation);
}

[ComImport, Guid("72A22D78-CDE4-431D-B8CC-843A71199B6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IActivateAudioInterfaceAsyncOperation
{
    void GetActivateResult(out int activateResult, [MarshalAs(UnmanagedType.IUnknown)] out object activatedInterface);
}

[ComImport, Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioClient
{
    void Initialize(int shareMode, uint streamFlags, long bufferDuration, long periodicity, IntPtr format, IntPtr audioSessionGuid);
    void GetBufferSize(out uint frames);
    void GetStreamLatency(out long latency);
    void GetCurrentPadding(out uint padding);
    [PreserveSig] int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closestMatch);
    void GetMixFormat(out IntPtr format);
    void GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
    void Start();
    void Stop();
    void Reset();
    void SetEventHandle(IntPtr eventHandle);
    void GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
}

[ComImport, Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioCaptureClient
{
    void GetBuffer(out IntPtr data, out uint frames, out uint flags, out ulong devicePosition, out ulong qpcPosition);
    void ReleaseBuffer(uint frames);
    void GetNextPacketSize(out uint frames);
}

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
class MMDeviceEnumeratorComObject { }

[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator
{
    void EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
    void GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
    void GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
    void RegisterEndpointNotificationCallback(IntPtr client);
    void UnregisterEndpointNotificationCallback(IntPtr client);
}

[ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceCollection
{
    void GetCount(out uint count);
    void Item(uint index, out IMMDevice device);
}

[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice
{
    void Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
    void OpenPropertyStore(int access, out IntPtr properties);
    void GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
    void GetState(out int state);
}

[ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionManager2
{
    void GetAudioSessionControl(IntPtr sessionGuid, int flags, out IntPtr control);
    void GetSimpleAudioVolume(IntPtr sessionGuid, int flags, out IntPtr volume);
    void GetSessionEnumerator(out IAudioSessionEnumerator sessions);
    void RegisterSessionNotification(IntPtr notification);
    void UnregisterSessionNotification(IntPtr notification);
    void RegisterDuckNotification([MarshalAs(UnmanagedType.LPWStr)] string sessionId, IntPtr notification);
    void UnregisterDuckNotification(IntPtr notification);
}

[ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionEnumerator
{
    void GetCount(out int count);
    void GetSession(int index, out IAudioSessionControl2 session);
}

[ComImport, Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionControl2
{
    // IAudioSessionControl
    void GetState(out int state);
    void GetDisplayName(out IntPtr name);
    void SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string name, IntPtr context);
    void GetIconPath(out IntPtr path);
    void SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string path, IntPtr context);
    void GetGroupingParam(out Guid grouping);
    void SetGroupingParam(ref Guid grouping, IntPtr context);
    void RegisterAudioSessionNotification(IntPtr client);
    void UnregisterAudioSessionNotification(IntPtr client);
    // IAudioSessionControl2
    void GetSessionIdentifier(out IntPtr id);
    void GetSessionInstanceIdentifier(out IntPtr id);
    void GetProcessId(out uint pid);
    [PreserveSig] int IsSystemSoundsSession();
    void SetDuckingPreference(bool optOut);
}
