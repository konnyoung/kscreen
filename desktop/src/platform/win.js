'use strict';
// Windows: kscreen-audio.exe (native/kscreen-audio.cs) does the platform work:
//  - PC audio through process loopback, minus kScreen and the apps the user excluded;
//  - fullscreen game windows are captured through their monitor (DXGI, GPU) instead of GDI.
const { app, screen } = require('electron');
const { spawn, execFile } = require('node:child_process');
const path = require('node:path');

function helperPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'kscreen-audio.exe')
    : path.join(__dirname, '..', '..', 'native', 'kscreen-audio.exe');
}

function run(args, timeout = 5000) {
  return new Promise((resolve) => {
    execFile(helperPath(), args, { timeout, windowsHide: true }, (err, stdout) => resolve(err ? null : stdout));
  });
}

// Wraps a helper process as { stdout, stop(), onExit(cb) }.
function handleOf(child) {
  child.on('error', () => {});
  return {
    stdout: child.stdout,
    stop() {
      try { child.stdin.end(); } catch { /* gone */ }
      setTimeout(() => { if (child.exitCode === null) child.kill(); }, 1000);
    },
    onExit(cb) { child.on('exit', cb); }
  };
}

let probe = null;

// Windows' per-app GPU choice (Settings > System > Display > Graphics), the same registry value
// that page writes: "GpuPreference=1;" = power saving, "=2;" = high performance.
const GPU_KEY = 'HKCU\\Software\\Microsoft\\DirectX\\UserGpuPreferences';
function reg(args) {
  return new Promise((resolve) => {
    execFile('reg.exe', args, { timeout: 5000, windowsHide: true }, (err, stdout) => resolve(err ? null : String(stdout)));
  });
}

module.exports = {
  name: 'win',

  capture: {
    // Electron enumerates screens and windows itself: our own picker with thumbnails works.
    systemPicker: false
  },

  audio: {
    supported() {
      probe ??= run(['--probe'], 6000).then(out => out !== null);
      return probe;
    },
    // Before Windows 10 2004 there is no process loopback: Electron's own 'loopback'
    // (which also captures the room's voices) is the only option.
    fallbackLoopback: true,

    async listApps(selfPid) {
      try {
        return JSON.parse(await run(['--list', String(selfPid)]) || '[]');
      } catch {
        return [];
      }
    },

    start({ selfPid, exclude }) {
      const args = [String(selfPid), ...(exclude.length ? ['--exclude', exclude.join(',')] : [])];
      const child = spawn(helperPath(), args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      child.stderr.on('data', d => console.warn('[kscreen-audio]', String(d).trim()));
      return handleOf(child);
    }
  },

  gpu: {
    // High GPU scheduling priority for these processes (kScreen's GPU process: capture + encoder).
    async boost(pids) {
      const out = await run(['--gpu-priority', ...pids.map(String)]);
      return Number(out) > 0;
    },
    // REALTIME GPU priority for all kScreen processes, through the SYSTEM task the installer
    // registered (kscreen-audio.cs, InstallGpuTask). Only the installed app has it.
    realtime() {
      return new Promise((resolve) => {
        execFile('schtasks.exe', ['/run', '/tn', 'kScreen GPU'], { timeout: 5000, windowsHide: true }, (err) => resolve(!err));
      });
    },
    // null = no choice saved for this exe (Windows decides)
    async get(exe) {
      const out = await reg(['query', GPU_KEY, '/v', exe]);
      const m = out && /GpuPreference=(\d)/.exec(out);
      return m ? Number(m[1]) : null;
    },
    async set(exe, preference) {
      return (await reg(['add', GPU_KEY, '/v', exe, '/t', 'REG_SZ', '/d', `GpuPreference=${preference};`, '/f'])) !== null;
    },
    async clear(exe) {
      return (await reg(['delete', GPU_KEY, '/v', exe, '/f'])) !== null;
    }
  },

  game: {
    // Chromium captures single windows through GDI (CPU copies; WGC is only a Windows 11
    // fallback). A game that fills its monitor looks exactly like that monitor, which is
    // captured through DXGI on the GPU.
    async fullscreenDisplayOf(sourceId) {
      const hwnd = sourceId.split(':')[1];
      if (!/^\d+$/.test(hwnd)) return null;
      let rect = null;
      try { rect = JSON.parse(await run(['--window-rect', hwnd], 3000) || 'null'); } catch { /* none */ }
      if (!rect || rect.minimized) return null;
      const near = (a, b) => Math.abs(a - b) <= 2;
      return screen.getAllDisplays().find((d) => {
        const px = screen.dipToScreenRect(null, d.bounds);
        return near(rect.x, px.x) && near(rect.y, px.y) && near(rect.width, px.width) && near(rect.height, px.height);
      }) || null;
    },

    // Calls onChange(visible) whenever the game window is restored/minimized.
    watch(sourceId, onChange) {
      const child = spawn(helperPath(), ['--watch', sourceId.split(':')[1]], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
      let buffer = '';
      child.stdout.on('data', (chunk) => {
        buffer += chunk;
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop();
        const last = lines.filter(Boolean).pop();
        if (last) onChange(last.trim() === '1');
      });
      return handleOf(child);
    }
  }
};
