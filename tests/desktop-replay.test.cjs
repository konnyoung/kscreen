// App side of Instant Replay (desktop/src/replay.js) with a fake Electron: settings, clip files,
// the global shortcut and who may call what.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { execFileSync } = require('node:child_process');

// X11 unless a test says otherwise (the shortcut path differs on Wayland).
const sessionEnv = { XDG_SESSION_TYPE: process.env.XDG_SESSION_TYPE, WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY, XDG_CURRENT_DESKTOP: process.env.XDG_CURRENT_DESKTOP };
function setSession(type, desktop = '') {
  process.env.XDG_SESSION_TYPE = type;
  if (type === 'wayland') process.env.WAYLAND_DISPLAY = 'wayland-1'; else delete process.env.WAYLAND_DISPLAY;
  process.env.XDG_CURRENT_DESKTOP = desktop;
}
setSession('x11');

let root;
let electron;

function fakeElectron() {
  const handlers = new Map();
  const listeners = new Map();
  const registered = new Map();
  const quitHandlers = [];
  return {
    handlers,
    listeners,
    registered,
    taken: new Set(),
    shown: [],
    opened: [],
    primary: true,
    app: {
      getPath: (name) => path.join(root, name),
      whenReady: async () => {},
      hasSingleInstanceLock: () => electron.primary,
      on: (event, fn) => { if (event === 'will-quit') quitHandlers.push(fn); },
      quit: () => quitHandlers.forEach(fn => fn())
    },
    ipcMain: {
      handle: (channel, fn) => handlers.set(channel, fn),
      on: (channel, fn) => listeners.set(channel, fn)
    },
    globalShortcut: {
      register(key, fn) {
        if (electron.taken.has(key)) return false;
        registered.set(key, fn);
        return true;
      },
      unregister: (key) => registered.delete(key)
    },
    shell: {
      openPath: async (p) => { electron.opened.push(p); return ''; },
      showItemInFolder: (p) => electron.shown.push(p)
    }
  };
}

function page(url = 'https://kscreen.app/') {
  const sent = [];
  const events = new Map();
  return {
    sent,
    id: Math.floor(Math.random() * 1e6),
    getURL: () => url,
    isDestroyed: () => false,
    send: (...args) => sent.push(args),
    once: (event, fn) => events.set(event, fn),
    on: (event, fn) => events.set(event, fn),
    fire: (event, ...args) => events.get(event)?.(...args)
  };
}

function load(platform = { audio: { supported: async () => false } }, portalShortcuts = null) {
  const file = require.resolve('../desktop/src/replay.js');
  delete require.cache[file];
  const original = Module._load;
  Module._load = function (request, ...rest) {
    if (request === 'electron') return electron;
    return original.call(this, request, ...rest);
  };
  try {
    return require(file)({
      isAppUrl: (url) => url.startsWith('https://kscreen.app/'),
      platform,
      portalShortcuts,
      audioExclude: () => ['game.exe']
    });
  } finally {
    Module._load = original;
  }
}

const call = (channel, sender, ...args) => electron.handlers.get(channel)({ sender }, ...args);
const send = (channel, sender, ...args) => electron.listeners.get(channel)({ sender }, ...args);
const clipsDir = () => path.join(root, 'videos', 'kScreen');
const settle = () => new Promise(r => setTimeout(r, 30));

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kscreen-replay-'));
  electron = fakeElectron();
});

test('defaults: off, 30 s, Alt+F10, one mixed audio track', async () => {
  load();
  const s = await call('replay:get-settings', page());
  assert.equal(s.enabled, false);
  assert.equal(s.seconds, 30);
  assert.equal(s.hotkey, 'Alt+F10');
  assert.equal(s.micMode, 'mixed');
  assert.equal(s.voices, false);
  assert.equal(s.excludedApps, 1);
  assert.equal(s.folder, clipsDir());
});

test('settings: bad values are cleaned and saved to replay.json', async () => {
  load();
  const s = await call('replay:set-settings', page(), { enabled: true, seconds: 999, hotkey: 'Ctrl+Alt+Delete', micMode: 'x', voices: true, extra: 1 });
  assert.equal(s.seconds, 30);
  assert.equal(s.hotkey, 'Alt+F10');
  assert.equal(s.micMode, 'mixed');
  assert.equal(s.voices, true);
  await settle();
  const saved = JSON.parse(fs.readFileSync(path.join(root, 'userData', 'replay.json'), 'utf8'));
  assert.equal(saved.enabled, true);
  assert.equal(saved.extra, undefined);
  // A new start reads them back.
  electron = fakeElectron();
  load();
  assert.equal((await call('replay:get-settings', page())).voices, true);
});

test('only the app page gets anything', async () => {
  load();
  const evil = page('https://evil.example/');
  assert.equal(await call('replay:capabilities', evil), null);
  assert.equal(await call('replay:get-settings', evil), null);
  assert.equal(await call('replay:set-settings', evil, { enabled: true }), null);
  assert.deepEqual(await call('replay:clip-begin', evil, { size: 10 }), { error: 'denied' });
  assert.equal(await call('replay:set-active', evil, true), null);
  assert.equal(await call('replay:open-folder', evil), false);
});

test('capabilities list the replay feature and nothing of the old probe', async () => {
  load();
  const caps = await call('replay:capabilities', page());
  assert.deepEqual(caps.features, ['replay']);
  assert.equal(caps.api, 1);
  assert.ok(caps.hotkeys.includes('Alt+F10'));
  assert.equal(caps.probe, undefined);
});

test('a clip is written as .part and renamed when complete', async () => {
  load();
  const p = page();
  const data = Buffer.from('ftyp....moov....mdat....');
  const { id } = await call('replay:clip-begin', p, { size: data.length });
  assert.ok(id);
  const parts = fs.readdirSync(clipsDir());
  assert.equal(parts.length, 1);
  assert.match(parts[0], /^kScreen \d{4}-\d\d-\d\d \d\d-\d\d-\d\d\.mp4\.part$/);
  assert.deepEqual(await call('replay:clip-write', p, id, new Uint8Array(data.subarray(0, 10))), { ok: true });
  assert.deepEqual(await call('replay:clip-write', p, id, new Uint8Array(data.subarray(10))), { ok: true });
  const end = await call('replay:clip-end', p, id);
  assert.match(end.name, /\.mp4$/);
  assert.deepEqual(fs.readFileSync(end.path), data);
  assert.deepEqual(fs.readdirSync(clipsDir()), [end.name]);
});

test('two clips in the same second get different names', async () => {
  load();
  const p = page();
  const names = [];
  for (let i = 0; i < 2; i++) {
    const { id } = await call('replay:clip-begin', p, { size: 1 });
    await call('replay:clip-write', p, id, Uint8Array.of(i));
    names.push((await call('replay:clip-end', p, id)).name);
  }
  assert.notEqual(names[0], names[1]);
});

test('writing past the announced size, or ending early, leaves no file behind', async () => {
  load();
  const p = page();
  let { id } = await call('replay:clip-begin', p, { size: 4 });
  assert.deepEqual(await call('replay:clip-write', p, id, new Uint8Array(5)), { error: 'size' });
  ({ id } = await call('replay:clip-begin', p, { size: 4 }));
  await call('replay:clip-write', p, id, new Uint8Array(2));
  assert.deepEqual(await call('replay:clip-end', p, id), { error: 'incomplete' });
  await settle();
  assert.deepEqual(fs.readdirSync(clipsDir()), []);
});

test('sizes out of range and other pages are refused', async () => {
  load();
  const p = page();
  assert.deepEqual(await call('replay:clip-begin', p, { size: 0 }), { error: 'size' });
  assert.deepEqual(await call('replay:clip-begin', p, { size: 3 * 1024 ** 3 }), { error: 'size' });
  const { id } = await call('replay:clip-begin', p, { size: 2 });
  const other = page();
  assert.deepEqual(await call('replay:clip-write', other, id, new Uint8Array(2)), { error: 'unknown' });
  assert.deepEqual(await call('replay:clip-write', p, id, 'not bytes'), { error: 'size' });
});

test('a reload drops the half-written clip and frees the shortcut', async () => {
  load();
  const p = page();
  await call('replay:set-active', p, true);
  const { id } = await call('replay:clip-begin', p, { size: 10 });
  await call('replay:clip-write', p, id, new Uint8Array(3));
  p.fire('did-start-navigation', { isMainFrame: true, isSameDocument: false });
  await settle();
  assert.deepEqual(fs.readdirSync(clipsDir()), []);
  assert.equal(electron.registered.size, 0);
});

test('leftover .part files from a crash are removed at start', async () => {
  fs.mkdirSync(clipsDir(), { recursive: true });
  fs.writeFileSync(path.join(clipsDir(), 'kScreen old.mp4.part'), 'x');
  fs.writeFileSync(path.join(clipsDir(), 'kScreen good.mp4'), 'x');
  load();
  await settle();
  assert.deepEqual(fs.readdirSync(clipsDir()), ['kScreen good.mp4']);
});

test('a second launch (kscreen --save-clip) never deletes the clip being written', async () => {
  load();
  const p = page();
  const { id } = await call('replay:clip-begin', p, { size: 4 });
  await call('replay:clip-write', p, id, new Uint8Array(2));
  // The second process loads the same module, without the single-instance lock.
  const first = electron;
  electron = fakeElectron();
  electron.primary = false;
  load();
  await settle();
  electron = first;
  assert.equal(fs.readdirSync(clipsDir()).filter(n => n.endsWith('.part')).length, 1);
  await call('replay:clip-write', p, id, new Uint8Array(2));
  const end = await call('replay:clip-end', p, id);
  assert.ok(end.path, JSON.stringify(end));
});

test('shortcut: registered only while active, follows a new choice, and saveClip reaches the page', async () => {
  const replay = load();
  const p = page();
  assert.equal(replay.saveClip(), false, 'nothing active yet');
  assert.deepEqual(await call('replay:set-active', p, true), { registered: true, hotkey: 'Alt+F10', trigger: '' });
  assert.ok(electron.registered.has('Alt+F10'));
  electron.registered.get('Alt+F10')();
  assert.deepEqual(p.sent.at(-1), ['replay:hotkey']);
  const s = await call('replay:set-settings', p, { hotkey: 'F9' });
  assert.equal(s.hotkeyRegistered, true);
  assert.ok(!electron.registered.has('Alt+F10') && electron.registered.has('F9'));
  assert.equal(replay.saveClip(), true);
  await call('replay:set-active', p, false);
  assert.equal(electron.registered.size, 0);
  assert.equal(replay.saveClip(), false);
});

test('shortcut taken by another program is reported', async () => {
  electron.taken.add('Alt+F10');
  load();
  assert.deepEqual(await call('replay:set-active', page(), true), { registered: false, hotkey: 'Alt+F10', trigger: '' });
});

test('show-clip only opens files inside the clips folder', () => {
  load();
  const p = page();
  send('replay:show-clip', p, path.join(clipsDir(), 'a.mp4'));
  send('replay:show-clip', p, path.join(clipsDir(), '..', 'secret.mp4'));
  send('replay:show-clip', p, '/etc/passwd');
  send('replay:show-clip', p, path.join(clipsDir(), 'a.exe'));
  assert.deepEqual(electron.shown, [path.join(clipsDir(), 'a.mp4')]);
});

// ---- Linux: Opus clips re-encoded to AAC by the host's ffmpeg --------------------------------

function linuxPlatform({ hasAac = true, converts = true } = {}) {
  const calls = [];
  return {
    calls,
    audio: { supported: async () => false },
    clips: {
      saveClipCommand: 'flatpak run br.com.kennyy.kscreen --save-clip',
      hasAacEncoder: async () => hasAac,
      gpuGuide: async (vendor) => ({ vendor, steps: [] }),
      async toAac(input, output) {
        calls.push([input, output]);
        if (!converts) return false;
        fs.writeFileSync(output, Buffer.concat([fs.readFileSync(input), Buffer.from('+aac')]));
        return true;
      }
    }
  };
}

async function saveClip(p, bytes, opus) {
  const { id } = await call('replay:clip-begin', p, { size: bytes.length, opus });
  await call('replay:clip-write', p, id, new Uint8Array(bytes));
  return call('replay:clip-end', p, id);
}

test('linux: capabilities report the AAC route, the shortcut command and the GPU hint', async () => {
  load(linuxPlatform());
  const caps = await call('replay:capabilities', page());
  assert.equal(caps.aac, 'ffmpeg');
  assert.equal(caps.saveClipCommand, 'flatpak run br.com.kennyy.kscreen --save-clip');
  assert.deepEqual(caps.gpuGuide, { vendor: 0, steps: [] });
  load(linuxPlatform({ hasAac: false }));
  assert.equal((await call('replay:capabilities', page())).aac, 'none');
  load();
  const win = await call('replay:capabilities', page());
  assert.equal(win.aac, 'native');
  assert.equal(win.gpuGuide, null);
});

test('linux: an Opus clip comes out converted, with no leftovers', async () => {
  const platform = linuxPlatform();
  load(platform);
  const end = await saveClip(page(), Buffer.from('opus clip'), true);
  assert.equal(end.audio, 'aac');
  assert.equal(fs.readFileSync(end.path, 'utf8'), 'opus clip+aac');
  assert.deepEqual(fs.readdirSync(clipsDir()), [end.name]);
  assert.equal(platform.calls.length, 1);
});

test('linux: a failed conversion keeps the Opus clip; AAC clips are not touched', async () => {
  const platform = linuxPlatform({ converts: false });
  load(platform);
  const end = await saveClip(page(), Buffer.from('opus clip'), true);
  assert.equal(end.audio, 'opus');
  assert.equal(fs.readFileSync(end.path, 'utf8'), 'opus clip');
  assert.deepEqual(fs.readdirSync(clipsDir()), [end.name]);
  const aac = await saveClip(page(), Buffer.from('aac clip'), false);
  assert.equal(aac.audio, undefined);
  assert.equal(platform.calls.length, 1);
});

test('linux: real ffmpeg turns the Opus audio into AAC and copies the video', { skip: spawnOk('ffmpeg') ? false : 'ffmpeg not found' }, async () => {
  const { clips } = require('../desktop/src/platform/linux.js');
  if (!(await clips.hasAacEncoder())) return;
  const input = path.join(root, 'in.mp4');
  const output = path.join(root, 'out.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=500:sample_rate=48000',
    '-t', '3', '-map', '0:v', '-map', '1:a', '-map', '1:a', '-c:v', 'mpeg4', '-c:a', 'opus', '-strict', '-2', '-ac', '2',
    '-metadata:s:a:0', 'handler_name=Microfone', '-metadata:s:a:1', 'handler_name=Vozes da sala', input]);
  assert.equal(await clips.toAac(input, output), true);
  const info = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', output], { encoding: 'utf8' }));
  assert.deepEqual(info.streams.map(s => s.codec_name), ['mpeg4', 'aac', 'aac']);
  assert.deepEqual(info.streams.slice(1).map(s => s.tags.handler_name), ['Microfone', 'Vozes da sala']);
  assert.equal(await clips.toAac(path.join(root, 'missing.mp4'), output), false);
});

function spawnOk(cmd) {
  return require('node:child_process').spawnSync(cmd, ['-version']).status === 0;
}

// ---- Wayland: the shortcut goes through the desktop portal --------------------------------------

function fakePortal({ ok = true, trigger = '' } = {}) {
  const portal = { binds: [], closed: 0 };
  portal.bind = async (opts) => { portal.binds.push(opts); portal.activate = opts.onActivated; return ok ? { ok, trigger } : { ok, error: 'no portal' }; };
  portal.close = () => { portal.closed++; };
  return portal;
}

test('wayland: the shortcut is bound through the portal, not Electron, and reaches the page', async () => {
  setSession('wayland', 'KDE');
  try {
    const portal = fakePortal({ trigger: 'Alt+F10' });
    load(undefined, portal);
    const caps = await call('replay:capabilities', page());
    assert.equal(caps.shortcut.via, 'portal');
    assert.equal(caps.shortcut.bindLine, undefined);
    const p = page();
    assert.deepEqual(await call('replay:set-active', p, true), { registered: true, hotkey: 'Alt+F10', trigger: 'Alt+F10' });
    assert.equal(electron.registered.size, 0, 'Electron globalShortcut not used');
    assert.equal(portal.binds[0].id, 'save-clip');
    assert.equal(portal.binds[0].accelerator, 'Alt+F10');
    portal.activate();
    assert.deepEqual(p.sent.at(-1), ['replay:hotkey']);
    // Inactive: a press is ignored. Active again: no second bind (KDE would ask again).
    await call('replay:set-active', p, false);
    const sent = p.sent.length;
    portal.activate();
    assert.equal(p.sent.length, sent);
    await call('replay:set-active', p, true);
    assert.equal(portal.binds.length, 1);
    electron.app.quit();
    assert.equal(portal.closed, 1);
  } finally {
    setSession('x11');
  }
});

test('wayland on Hyprland: the bind line for the chosen key, in the config format in use', async () => {
  setSession('wayland', 'Hyprland');
  const before = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = path.join(root, 'config');
  const hypr = path.join(root, 'config', 'hypr');
  fs.mkdirSync(hypr, { recursive: true });
  try {
    load(undefined, fakePortal());
    await call('replay:set-settings', page(), { hotkey: 'Ctrl+Shift+F10' });
    fs.writeFileSync(path.join(hypr, 'hyprland.conf'), '');
    let caps = await call('replay:capabilities', page());
    assert.equal(caps.shortcut.desktop, 'Hyprland');
    assert.equal(caps.shortcut.configFile, 'hyprland.conf');
    assert.equal(caps.shortcut.bindLine, 'bind = CTRL SHIFT, F10, global, br.com.kennyy.kscreen:save-clip');
    // Hyprland 0.55+ with a Lua config.
    fs.rmSync(path.join(hypr, 'hyprland.conf'));
    fs.writeFileSync(path.join(hypr, 'hyprland.lua'), '');
    caps = await call('replay:capabilities', page());
    assert.equal(caps.shortcut.configFile, 'hyprland.lua');
    assert.equal(caps.shortcut.bindLine, 'hl.bind("CTRL + SHIFT + F10", hl.dsp.global("br.com.kennyy.kscreen:save-clip"))');
  } finally {
    if (before === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = before;
    setSession('x11');
  }
});

test('wayland without a working portal: reported as not registered', async () => {
  setSession('wayland', 'sway');
  try {
    load(undefined, fakePortal({ ok: false }));
    const res = await call('replay:set-active', page(), true);
    assert.equal(res.registered, false);
  } finally {
    setSession('x11');
  }
});

test.after(() => Object.entries(sessionEnv).forEach(([k, v]) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; }));

// ---- Linux: what to install to record on the GPU ------------------------------------------------

test('gpu guide: per distro and GPU, from each distro\'s documentation', async () => {
  const { clips } = require('../desktop/src/platform/linux.js');
  const none = async () => false;
  const g = (vendor, os, extra = {}) => clips.gpuGuide(vendor, { os: { id: '', like: '', name: 'X', ...os }, flatpak: false, hasPackage: none, ...extra });
  const cmds = (guide) => guide.steps.filter(s => s.cmd).map(s => s.cmd);

  const fedoraAmd = await g(0x1002, { id: 'fedora' });
  assert.deepEqual(cmds(fedoraAmd).slice(0, 2), ['sudo dnf install https://mirrors.rpmfusion.org/free/fedora/rpmfusion-free-release-$(rpm -E %fedora).noarch.rpm', 'sudo dnf install mesa-va-drivers-freeworld']);
  assert.equal(fedoraAmd.vendor, 'AMD');
  assert.equal(fedoraAmd.sources[0].url, 'https://rpmfusion.org/Howto/Multimedia');
  const fedoraIntel = await g(0x8086, { id: 'fedora' });
  assert.match(cmds(fedoraIntel)[0], /rpmfusion-nonfree-release/);
  assert.equal(cmds(fedoraIntel)[1], 'sudo dnf install intel-media-driver');

  // Steps already installed are marked.
  const installed = await g(0x1002, { id: 'fedora' }, { hasPackage: async (m, name) => name === 'rpmfusion-free-release' });
  assert.deepEqual(installed.steps.map(s => !!s.done).slice(0, 2), [true, false]);

  assert.equal(cmds(await g(0x1002, { id: 'arch' }))[0], 'sudo pacman -S --needed mesa');
  assert.equal(cmds(await g(0x8086, { id: 'endeavouros', like: 'arch' }))[0], 'sudo pacman -S --needed intel-media-driver');
  assert.equal(cmds(await g(0x1002, { id: 'ubuntu', like: 'debian' }))[0], 'sudo apt install mesa-va-drivers');
  const ubuntuIntel = await g(0x8086, { id: 'ubuntu', like: 'debian' });
  assert.equal(cmds(ubuntuIntel)[0], 'sudo apt install intel-media-va-driver-non-free');
  assert.match(ubuntuIntel.steps[0].text, /multiverse/);
  assert.match((await g(0x8086, { id: 'debian' })).steps[0].text, /non-free/);

  const nvidia = await g(0x10de, { id: 'fedora' });
  assert.equal(nvidia.unsupported, true);
  assert.equal(nvidia.steps.length, 0);

  // Flatpak: the runtime's "extra" GL driver; 24.08 named its branch without the dash.
  assert.equal(cmds(await g(0x1002, { id: 'fedora' }, { flatpak: true, runtimeBranch: '24.08' }))[0], 'flatpak install flathub org.freedesktop.Platform.GL.default//24.08extra');
  assert.equal(cmds(await g(0x1002, { id: 'fedora' }, { flatpak: true, runtimeBranch: '25.08' }))[0], 'flatpak install flathub org.freedesktop.Platform.GL.default//25.08-extra');

  const other = await g(0x1002, { id: 'gentoo' });
  assert.ok(other.note);
});
