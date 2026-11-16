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

// Leftovers from a crash: sinks we created and never unloaded.
async function unloadStaleSinks() {
  const list = await run('pactl', ['list', 'short', 'modules']) || '';
  for (const line of list.split('\n')) {
    const [id, name, args = ''] = line.split('\t');
    if (name === 'module-null-sink' && args.includes(`sink_name=${SINK_PREFIX}`)) await run('pactl', ['unload-module', id]);
  }
}

module.exports = {
  name: 'linux',

  capture: {
    // Wayland: only the system portal may pick a screen/window (Electron returns that one
    // source from desktopCapturer). X11: Electron lists everything, our picker works.
    get systemPicker() { return isWayland(); }
  },

  // GPU encoding through VA-API, and screen capture through PipeWire on Wayland.
  chromiumFeatures: ['AcceleratedVideoEncoder', 'VaapiVideoEncoder', 'WebRTCPipeWireCapturer'],
  // Decoding stays on the CPU. VA-API decoding showed a black screen for streams from 1080p up
  // (Flatpak: the VA drivers come from the runtime and often don't match the host GPU); Chromium
  // decodes small videos in software anyway, which is why 480p always worked. H.264 1080p60 in
  // software is light for any recent CPU. KSCREEN_HW_DECODE=1 turns GPU decoding back on.
  chromiumSwitches: process.env.KSCREEN_HW_DECODE === '1'
    ? [['enable-features', 'VaapiVideoDecoder,VaapiVideoDecodeLinuxGL']]
    : [['disable-accelerated-video-decode']],

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
      const sinkName = `${SINK_PREFIX}_${process.pid}`;
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
        await unloadStaleSinks();
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
