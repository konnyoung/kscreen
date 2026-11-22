'use strict';
// Linux: capture and PC audio through PipeWire.
//
// Video: on Wayland nobody can list windows; the system (xdg-desktop-portal) shows its own
// picker. On X11 Electron lists screens and windows like on Windows.
//
// Audio: a private virtual sink ("kScreen") gets a copy of every app's sound except kScreen
// itself (the room's voices) and the apps the user excluded. PipeWire lets one output feed
// several inputs, so the apps keep playing on the user's speakers as usual. The sink's monitor
// is recorded as PCM s16le 48 kHz stereo, the same format the Windows helper produces.
// Tools: pw-dump + pw-link (pipewire), pactl + parec (pipewire-pulse / pulseaudio-utils).
const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');

const SINK_PREFIX = 'kscreen_share';
const isWayland = () => process.env.XDG_SESSION_TYPE === 'wayland' || !!process.env.WAYLAND_DISPLAY;

// Inside the Flatpak sandbox the PipeWire/Pulse tools live on the host: run them through
// flatpak-spawn --host (needs --talk-name=org.freedesktop.Flatpak in finish-args).
const inFlatpak = !!process.env.FLATPAK_ID || fs.existsSync('/.flatpak-info');
const hostCmd = (cmd, args) => (inFlatpak ? ['flatpak-spawn', ['--host', cmd, ...args]] : [cmd, args]);

function run(cmd, args, timeout = 5000) {
  [cmd, args] = hostCmd(cmd, args);
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : String(stdout)));
  });
}

async function pwDump() {
  try {
    return JSON.parse(await run('pw-dump', []) || '[]');
  } catch {
    return [];
  }
}

// Parent pid from /proc (to recognise our own Chromium audio process).
function parentOf(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // "pid (comm) state ppid ...": comm may contain spaces, so split after the last ')'.
    return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]) || 0;
  } catch {
    return 0;
  }
}

function isDescendant(pid, ancestor) {
  const seen = new Set();
  for (let cur = Number(pid); cur > 1 && !seen.has(cur); cur = parentOf(cur)) {
    if (cur === ancestor) return true;
    seen.add(cur);
  }
  return false;
}

const props = (obj) => obj?.info?.props || {};

// App playback streams (what the user hears from each app).
function playbackStreams(objects) {
  return objects.filter(o => o.type === 'PipeWire:Interface:Node' && props(o)['media.class'] === 'Stream/Output/Audio');
}

function appOf(node) {
  const p = props(node);
  const exe = String(p['application.process.binary'] || p['application.name'] || '').split('/').pop();
  return { exe, name: String(p['application.name'] || exe), pid: Number(p['application.process.id']) || 0 };
}

const sameExe = (a, b) => a.toLowerCase() === b.toLowerCase();

function isOwn(node, selfPid) {
  const { pid, exe } = appOf(node);
  return (pid && isDescendant(pid, selfPid)) || sameExe(exe, 'kscreen');
}

let probe = null;

// Links every allowed app stream into our sink. Returns the number of new links.
async function linkStreams(sinkName, selfPid, exclude) {
  const objects = await pwDump();
  const sink = objects.find(o => o.type === 'PipeWire:Interface:Node' && props(o)['node.name'] === sinkName);
  if (!sink) return 0;
  const ports = objects.filter(o => o.type === 'PipeWire:Interface:Port');
  const portsOf = (nodeId, dir) => ports.filter(p => props(p)['node.id'] === nodeId && props(p)['port.direction'] === dir && !props(p)['port.monitor']);
  const sinkIn = portsOf(sink.id, 'in');
  const inFL = sinkIn.find(p => props(p)['audio.channel'] === 'FL') || sinkIn[0];
  const inFR = sinkIn.find(p => props(p)['audio.channel'] === 'FR') || sinkIn[1] || inFL;
  if (!inFL) return 0;

  const existing = new Set(objects
    .filter(o => o.type === 'PipeWire:Interface:Link')
    .map(o => `${o.info?.['output-port-id']}>${o.info?.['input-port-id']}`));

  const wanted = [];
  for (const node of playbackStreams(objects)) {
    if (isOwn(node, selfPid)) continue;
    const { exe, name } = appOf(node);
    if (exclude.some(e => sameExe(e, exe) || sameExe(e, name))) continue;
    const out = portsOf(node.id, 'out');
    if (!out.length) continue;
    const fl = out.find(p => props(p)['audio.channel'] === 'FL');
    const fr = out.find(p => props(p)['audio.channel'] === 'FR');
    if (fl && fr) {
      wanted.push([fl.id, inFL.id], [fr.id, inFR.id]);
    } else {
      // Mono (or unlabeled) stream: same signal on both sides.
      wanted.push([out[0].id, inFL.id], [out[0].id, inFR.id]);
    }
  }

  let added = 0;
  for (const [outId, inId] of wanted) {
    if (existing.has(`${outId}>${inId}`)) continue;
    if (await run('pw-link', [String(outId), String(inId)], 3000) !== null) added++;
  }
  return added;
}

// Leftovers from a crash: sinks we created and never unloaded. Done once per run: by then a
// sink with our prefix can only be from an earlier run. Later captures (the share's and the
// Instant Replay's can run side by side) must never remove each other's sink.
let staleCleanup = null;
const cleanStaleSinksOnce = () => (staleCleanup ??= unloadStaleSinks().catch(() => {}));
let sinkSeq = 0;

async function unloadStaleSinks() {
  const list = await run('pactl', ['list', 'short', 'modules']) || '';
  for (const line of list.split('\n')) {
    const [id, name, args = ''] = line.split('\t');
    if (name === 'module-null-sink' && args.includes(`sink_name=${SINK_PREFIX}`)) await run('pactl', ['unload-module', id]);
  }
}

// ---- Instant Replay helpers ------------------------------------------------------------------

// The host's /etc/os-release (inside the Flatpak the sandbox's own is the runtime's).
function hostOs() {
  for (const file of ['/run/host/os-release', '/etc/os-release']) {
    try {
      const text = fs.readFileSync(file, 'utf8');
      const get = (k) => (new RegExp(`^${k}="?([^"\n]*)"?`, 'm').exec(text) || [])[1] || '';
      return { id: get('ID'), like: get('ID_LIKE'), name: get('PRETTY_NAME') || get('NAME') };
    } catch { /* next */ }
  }
  return { id: '', like: '', name: '' };
}

// The runtime branch of this Flatpak ("24.08"), from /.flatpak-info.
function flatpakRuntimeBranch() {
  try {
    const m = /^runtime=runtime\/[^/]+\/[^/]+\/(\S+)$/m.exec(fs.readFileSync('/.flatpak-info', 'utf8'));
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

const VENDORS = { 0x1002: 'AMD', 0x8086: 'Intel', 0x10de: 'NVIDIA' };
const SOURCES = {
  rpmfusion: { name: 'RPM Fusion: Multimedia', url: 'https://rpmfusion.org/Howto/Multimedia' },
  rpmfusionSetup: { name: 'RPM Fusion: Configuração', url: 'https://rpmfusion.org/Configuration' },
  arch: { name: 'ArchWiki: Hardware video acceleration', url: 'https://wiki.archlinux.org/title/Hardware_video_acceleration' },
  debian: { name: 'Debian Wiki: HardwareVideoAcceleration', url: 'https://wiki.debian.org/HardwareVideoAcceleration' },
  flatpak: { name: 'Flathub: freedesktop-sdk 24.08', url: 'https://discourse.flathub.org/t/freedesktop-sdk-24-08-0-released/7630' },
  packman: { name: 'openSUSE: codecs do Packman', url: 'https://en.opensuse.org/SDB:Installing_codecs_from_Packman_repositories' }
};

// Whether a Flatpak runtime/extension ref is installed (user or system), asked on the host.
async function hasFlatpakRef(ref) {
  return (await run('flatpak', ['info', ref])) !== null;
}

// Whether a package is installed on the host (null: can't tell).
async function hasHostPackage(manager, name) {
  const args = { rpm: ['-q', name], pacman: ['-Q', name], dpkg: ['-W', '-f=${Status}', name] }[manager];
  const out = await run({ rpm: 'rpm', pacman: 'pacman', dpkg: 'dpkg-query' }[manager], args);
  if (out === null) return false;
  return manager === 'dpkg' ? out.includes('install ok installed') : true;
}

// What to install so Chromium can encode H.264 on the GPU (VA-API), for this distro and GPU,
// following each distro's own documentation (SOURCES). Steps: [{ text, cmd?, done? }] (done:
// the package is already there). The settings page shows it next to the live status.
// deps: overrides for tests (os, flatpak, runtimeBranch, hasPackage).
async function gpuGuide(vendorId, deps = {}) {
  const vendor = VENDORS[vendorId] || null;
  const os = deps.os || hostOs();
  const inFlatpak = deps.flatpak ?? module.exports.clips.inFlatpak;
  const hasPackage = deps.hasPackage || hasHostPackage;
  const is = (name) => os.id === name || os.like.split(' ').includes(name);
  const base = { distro: inFlatpak ? `Flatpak (${os.name || 'Linux'})` : os.name || 'Linux', vendor, steps: [], sources: [] };
  const verify = (pkg) => ({ text: `Para conferir, instale o ${pkg} e rode o comando abaixo: na lista tem que aparecer VAProfileH264 com VAEntrypointEncSlice (ou EncSliceLP).`, cmd: 'vainfo' });
  const restart = { text: 'Feche e abra o kScreen de novo.' };

  if (vendor === 'NVIDIA') {
    return { ...base, unsupported: true, note: 'Placas NVIDIA não têm encoder H.264 por VA-API no Linux (o driver nvidia-vaapi-driver só decodifica). O kScreen grava pelo processador, em até 720p a 30 FPS.', sources: [SOURCES.debian] };
  }
  if (inFlatpak) {
    const branch = deps.runtimeBranch || flatpakRuntimeBranch() || '24.08';
    // The 24.08 cycle named the branch "24.08extra" (no dash) by mistake; later ones use "-extra".
    const extra = branch === '24.08' ? '24.08extra' : `${branch}-extra`;
    const installed = await (deps.hasFlatpakRef || hasFlatpakRef)(`org.freedesktop.Platform.GL.default//${extra}`);
    return {
      ...base,
      steps: [
        { text: 'No Flatpak o driver de vídeo vem do runtime, não do sistema. Instale a versão "extra" do driver, que tem os codecs com patente (H.264):', cmd: `flatpak install flathub org.freedesktop.Platform.GL.default//${extra}`, done: installed },
        restart
      ],
      sources: [SOURCES.flatpak]
    };
  }
  if (is('fedora')) {
    const enable = vendor === 'Intel'
      ? { text: 'Ative os repositórios RPM Fusion (free e nonfree):', cmd: 'sudo dnf install https://mirrors.rpmfusion.org/free/fedora/rpmfusion-free-release-$(rpm -E %fedora).noarch.rpm https://mirrors.rpmfusion.org/nonfree/fedora/rpmfusion-nonfree-release-$(rpm -E %fedora).noarch.rpm' }
      : { text: 'Ative o repositório RPM Fusion free:', cmd: 'sudo dnf install https://mirrors.rpmfusion.org/free/fedora/rpmfusion-free-release-$(rpm -E %fedora).noarch.rpm' };
    const driver = vendor === 'Intel'
      ? { text: 'Instale o driver de vídeo da Intel (placas de 2014 em diante; nas mais antigas, libva-intel-driver):', cmd: 'sudo dnf install intel-media-driver' }
      : { text: 'O Mesa do Fedora vem sem o encoder H.264. Instale a versão do RPM Fusion:', cmd: 'sudo dnf install mesa-va-drivers-freeworld' };
    const [repoOk, driverOk] = await Promise.all([
      hasPackage('rpm', 'rpmfusion-free-release'),
      hasPackage('rpm', vendor === 'Intel' ? 'intel-media-driver' : 'mesa-va-drivers-freeworld')
    ]);
    return { ...base, steps: [{ ...enable, done: repoOk }, { ...driver, done: driverOk }, restart, verify('libva-utils')], sources: [SOURCES.rpmfusion, SOURCES.rpmfusionSetup] };
  }
  if (is('arch')) {
    const driver = vendor === 'Intel'
      ? { text: 'Instale o driver de vídeo da Intel (placas de 2014 em diante; nas mais antigas, libva-intel-driver):', cmd: 'sudo pacman -S --needed intel-media-driver' }
      : { text: 'No Arch o VA-API da AMD vem no próprio mesa. Confira se ele está instalado e atualizado:', cmd: 'sudo pacman -S --needed mesa' };
    const driverOk = await hasPackage('pacman', vendor === 'Intel' ? 'intel-media-driver' : 'mesa');
    return { ...base, steps: [{ ...driver, done: driverOk }, restart, verify('libva-utils')], sources: [SOURCES.arch] };
  }
  if (is('debian') || is('ubuntu')) {
    const driver = vendor === 'Intel'
      ? { text: is('ubuntu') ? 'Só o driver "non-free" da Intel codifica vídeo. Ele fica no repositório multiverse:' : 'Só o driver "non-free" da Intel codifica vídeo. Ative o componente non-free nas fontes do apt e instale:', cmd: 'sudo apt install intel-media-va-driver-non-free' }
      : { text: 'Instale o driver VA-API do Mesa:', cmd: 'sudo apt install mesa-va-drivers' };
    const driverOk = await hasPackage('dpkg', vendor === 'Intel' ? 'intel-media-va-driver-non-free' : 'mesa-va-drivers');
    return { ...base, steps: [{ ...driver, done: driverOk }, restart, verify('vainfo')], sources: [SOURCES.debian] };
  }
  if (is('opensuse') || is('suse')) {
    return { ...base, note: 'O Mesa oficial do openSUSE vem sem H.264. Para gravar pela placa é preciso o Mesa do repositório Packman (veja o guia abaixo).', steps: [restart, verify('libva-utils')], sources: [SOURCES.packman] };
  }
  return { ...base, note: 'Instale o driver VA-API da sua placa com suporte a H.264 (o nome do pacote muda de distro para distro).', steps: [restart, verify('libva-utils')], sources: [SOURCES.arch] };
}

let ffmpegAac = null;

// Hyprland 0.55+ can be configured in Lua (hyprland.lua) instead of hyprland.conf. Checked on
// the host: inside the Flatpak the user's ~/.config is not visible.
async function hyprlandConfigFile() {
  const out = await run('sh', ['-c', 'd="${XDG_CONFIG_HOME:-$HOME/.config}/hypr"; if [ -f "$d/hyprland.conf" ]; then echo conf; elif [ -f "$d/hyprland.lua" ]; then echo lua; else echo none; fi']);
  return out?.trim() === 'lua' ? 'hyprland.lua' : 'hyprland.conf';
}

const clips = {
  inFlatpak,
  hyprlandConfigFile,
  // The command a system shortcut should run (Wayland without a shortcuts portal).
  saveClipCommand: inFlatpak ? `flatpak run ${process.env.FLATPAK_ID || 'br.com.kennyy.kscreen'} --save-clip` : 'kscreen --save-clip',

  // Chromium on Linux has no AAC encoder, so clips come out with Opus audio, which phones,
  // QuickTime and some editors don't play. The host's ffmpeg (Fedora's ffmpeg-free included)
  // re-encodes just the audio to AAC after saving; the video is copied as is.
  hasAacEncoder() {
    ffmpegAac ??= run('ffmpeg', ['-hide_banner', '-encoders']).then(out => !!out && /^\s*A\S*\s+aac\s/m.test(out));
    return ffmpegAac;
  },

  // Resolves to true when `output` was written. Same tracks, names and timing; audio as AAC.
  toAac(input, output) {
    return new Promise((resolve) => {
      const [cmd, args] = hostCmd('ffmpeg', ['-v', 'error', '-nostdin', '-y', '-i', input, '-map', '0', '-c:v', 'copy',
        '-c:a', 'aac', '-b:a', '160k', '-map_metadata', '0', '-movflags', '+faststart', '-f', 'mp4', output]);
      execFile(cmd, args, { timeout: 180_000 }, (err) => resolve(!err));
    });
  },

  gpuGuide
};

module.exports = {
  name: 'linux',
  clips,

  capture: {
    // Wayland: only the system portal may pick a screen/window (Electron returns that one
    // source from desktopCapturer). X11: Electron lists everything, our picker works.
    get systemPicker() { return isWayland(); }
  },

  // GPU encoding through VA-API, and screen capture through PipeWire on Wayland.
  // GlobalShortcutsPortal: on Wayland, Electron's global shortcuts (Instant Replay's "save clip")
  // go through the desktop's shortcuts portal, where the desktop supports it (KDE, GNOME 48+).
  chromiumFeatures: ['AcceleratedVideoEncoder', 'VaapiVideoEncoder', 'WebRTCPipeWireCapturer', 'GlobalShortcutsPortal'],
  // Decoding stays on the CPU. VA-API decoding showed a black screen for streams from 1080p up
  // (Flatpak: the VA drivers come from the runtime and often don't match the host GPU); Chromium
  // decodes small videos in software anyway, which is why 480p always worked. H.264 1080p60 in
  // software is light for any recent CPU. KSCREEN_HW_DECODE=1 turns GPU decoding back on.
  // Only the VA-API *decoders* are turned off: --disable-accelerated-video-decode (used before)
  // shuts VA-API down entirely, encoder included, so the share and the Instant Replay were
  // encoded on the CPU too (measured in the Flatpak: encoder present without it, gone with it).
  chromiumSwitches: process.env.KSCREEN_HW_DECODE === '1'
    ? [['enable-features', 'VaapiVideoDecoder,VaapiVideoDecodeLinuxGL']]
    : [['disable-features', 'VaapiVideoDecoder,VaapiVideoDecodeLinuxGL,AcceleratedVideoDecodeLinuxGL,AcceleratedVideoDecodeLinuxZeroCopyGL']],

  audio: {
    supported() {
      probe ??= Promise.all([run('pactl', ['info']), run('pw-dump', []), run('pw-link', ['--version']), run('parec', ['--version'])])
        .then(results => results.every(r => r !== null));
      return probe;
    },
    fallbackLoopback: false,

    async listApps(selfPid) {
      const seen = new Set();
      const apps = [];
      for (const node of playbackStreams(await pwDump())) {
        if (isOwn(node, selfPid)) continue;
        const { exe, name } = appOf(node);
        if (!exe || seen.has(exe.toLowerCase())) continue;
        seen.add(exe.toLowerCase());
        apps.push({ exe, name });
      }
      return apps;
    },

    start({ selfPid, exclude }) {
      // One sink per capture: the share and the Instant Replay may each have one.
      const sinkName = `${SINK_PREFIX}_${process.pid}_${++sinkSeq}`;
      let moduleId = null;
      let recorder = null;
      let timer = null;
      let stopped = false;
      const exitHandlers = [];
      const { PassThrough } = require('node:stream');
      const stdout = new PassThrough();

      const finish = (code) => {
        if (stopped) return;
        stopped = true;
        clearInterval(timer);
        try { recorder?.kill(); } catch { /* gone */ }
        if (moduleId) run('pactl', ['unload-module', moduleId]);
        stdout.end();
        exitHandlers.forEach(cb => cb(code));
      };

      (async () => {
        await cleanStaleSinksOnce();
        const id = await run('pactl', ['load-module', 'module-null-sink', `sink_name=${sinkName}`,
          // Lowest priority: our sink must never become the system's default output.
          "sink_properties='device.description=kScreen priority.session=1 priority.driver=1'", 'rate=48000', 'channels=2', 'channel_map=front-left,front-right']);
        if (stopped) { if (id) run('pactl', ['unload-module', id.trim()]); return; }
        if (!id) return finish(1);
        moduleId = id.trim();
        recorder = spawn(...hostCmd('parec', ['-d', `${sinkName}.monitor`, '--format=s16le', '--rate=48000', '--channels=2', '--raw', '--latency-msec=20']),
          { stdio: ['ignore', 'pipe', 'ignore'] });
        recorder.on('error', () => finish(1));
        recorder.on('exit', (code) => finish(code ?? 0));
        recorder.stdout.pipe(stdout, { end: false });
        // Apps that start playing later are linked within a second.
        const relink = () => linkStreams(sinkName, selfPid, exclude).catch(() => {});
        await relink();
        timer = setInterval(relink, 1000);
      })().catch(() => finish(1));

      return {
        stdout,
        stop: () => finish(0),
        onExit(cb) { exitHandlers.push(cb); }
      };
    }
  },

  game: null
};
