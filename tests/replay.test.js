// Instant Replay logic (src/replay.js) with fake tracks, encoders and app bridge: buffer limits,
// saving, the mic it opens, share changes and the silence that fills audio holes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InstantReplay, Recorder, AudioTrackRecorder, bufferCap, sameAspect } from '../src/replay.js';

// ---- fakes ------------------------------------------------------------------------------------

class FakeAudioData {
  constructor(init) {
    Object.assign(this, init);
    this.duration = init.numberOfFrames / init.sampleRate * 1e6;
  }
  close() { this.closed = true; }
}
globalThis.AudioData = FakeAudioData;

function fakeTrack({ width = 1920, height = 1080 } = {}) {
  const settings = { width, height };
  return { kind: 'video', readyState: 'live', enabled: true, settings, getSettings: () => ({ ...settings }) };
}

function fakeEngine(track = fakeTrack()) {
  return {
    localStream: { getVideoTracks: () => [track], getAudioTracks: () => [] },
    shareSettings: { fps: 60 },
    micStream: null,
    released: 0,
    releaseMutedMic() { this.released++; return true; }
  };
}

function fakeBridge(overrides = {}) {
  const calls = { active: [], shown: [], diag: [] };
  const bridge = {
    calls,
    setSettings: async (patch) => ({ ...bridge.current, ...patch }),
    getSettings: async () => bridge.current,
    setActive: async (on) => { calls.active.push(on); return { registered: true }; },
    onHotkey: (fn) => { bridge.hotkey = fn; },
    showClip: (p) => calls.shown.push(p),
    diag: (e) => calls.diag.push(e),
    openFolder: async () => true,
    pcAudio: { start: async () => null, stop() {} },
    clip: { begin: async () => ({ id: 1 }), write: async () => ({ ok: true }), end: async () => ({ path: '/v/kScreen/a.mp4', name: 'a.mp4' }), abort: async () => {} },
    current: { enabled: true, seconds: 30, hotkey: 'Alt+F10', mic: true, micAlways: false, pcAudio: false, voices: false, micMode: 'mixed' },
    ...overrides
  };
  return bridge;
}

function makeReplay({ engine = fakeEngine(), bridge = fakeBridge() } = {}) {
  const toasts = [];
  const saved = [];
  const replay = new InstantReplay(engine, bridge, { durations: [15, 30, 60, 120], hotkeys: ['Alt+F10'] }, { ...bridge.current }, {
    onChange() {},
    toast: (message, duration, options) => toasts.push({ message, options }),
    onSaved: (r) => saved.push(r),
    roomVoices: () => null
  });
  clearInterval(replay.timer); // tests call watch() themselves
  return { replay, engine, bridge, toasts, saved };
}

// A recorder that is "running", for the parts that don't need real encoders.
function runningRecorder(replay, track) {
  const r = new Recorder(replay, track);
  r.ready = true;
  r.video = { width: 1920, height: 1080, bitrate: 12_000_000, description: Uint8Array.of(1) };
  r.maxBytes = bufferCap(r.video.bitrate, r.keepUs / 1e6);
  r.videoOffset = 0;
  r.intervalUs = 1e6 / 60;
  r.syncAudio = () => {};
  return r;
}

function chunk(t, key, size = 1000) {
  return { timestamp: t, type: key ? 'key' : 'delta', byteLength: size, copyTo(dst) { dst.fill(key ? 1 : 2); } };
}

// Feeds `seconds` of 60 fps video, a keyframe every 2 s.
function feedVideo(r, seconds, { from = 0, size = 1000 } = {}) {
  const frame = 1e6 / 60;
  for (let i = 0; i < seconds * 60; i++) {
    const t = from + i * frame;
    r.onVideo(chunk(t, i % 120 === 0, size), {});
  }
}

// ---- pure helpers -----------------------------------------------------------------------------

test('bufferCap: grows with the clip length, within 32 MB..512 MB', () => {
  assert.ok(bufferCap(12e6, 120) > bufferCap(12e6, 15) * 4);
  assert.equal(bufferCap(1e5, 15), 32 * 1024 * 1024);
  assert.equal(bufferCap(16e6, 600), 512 * 1024 * 1024);
  // 120 s at 16 Mbps fits: no clip is cut short by the cap.
  assert.ok(bufferCap(16e6, 120) >= (16e6 + 3 * 160e3) / 8 * 124);
});

test('sameAspect: small aspect changes are scaled, others are not', () => {
  assert.ok(sameAspect({ width: 1280, height: 720 }, { width: 1920, height: 1080 }));
  assert.ok(sameAspect({ width: 1914, height: 1080 }, { width: 1920, height: 1080 }));
  assert.ok(!sameAspect({ width: 1080, height: 1080 }, { width: 1920, height: 1080 }));
  assert.ok(!sameAspect({}, { width: 1920, height: 1080 }));
});

// ---- the GOP ring -----------------------------------------------------------------------------

test('buffer keeps the configured length, starting on a keyframe', () => {
  const { replay } = makeReplay();
  const r = runningRecorder(replay, fakeTrack());
  r.setKeep(15);
  feedVideo(r, 40);
  const span = (r.lastVideoT - r.gops[0].t) / 1e6;
  assert.ok(span >= 15 && span < 17.1, `kept ${span} s`);
  assert.ok(r.gops.every(g => g.samples[0].key));
  const snap = r.snapshot(10);
  assert.ok(snap.video.samples[0].key);
  assert.ok(snap.seconds >= 10 && snap.seconds < 12.1, `clip of ${snap.seconds} s`);
});

test('raising the length mid-share raises the memory cap too (clips were stuck at the old size)', () => {
  const { replay } = makeReplay();
  const r = runningRecorder(replay, fakeTrack());
  r.setKeep(15);
  const capAt15 = r.maxBytes;
  r.setKeep(120);
  assert.ok(r.maxBytes > capAt15);
  // 100 s at the encoder's bitrate: all of it stays.
  const perFrame = Math.round(12e6 / 8 / 60);
  feedVideo(r, 100, { size: perFrame });
  const span = (r.lastVideoT - r.gops[0].t) / 1e6;
  assert.ok(span > 99, `kept ${span} s of 100`);
});

test('memory cap drops the oldest GOPs', () => {
  const { replay } = makeReplay();
  const r = runningRecorder(replay, fakeTrack());
  r.setKeep(120);
  r.maxBytes = 5_000_000;
  feedVideo(r, 60, { size: 10_000 });
  assert.ok(r.bytes <= 5_000_000 + 120 * 10_000, `${r.bytes} bytes`);
  assert.ok(r.gops.length >= 1);
});

// ---- saving -----------------------------------------------------------------------------------

test('save: writes the clip, plays the sound, and the toast shows it in its folder', async () => {
  const { replay, bridge, toasts, saved } = makeReplay();
  const r = runningRecorder(replay, fakeTrack());
  feedVideo(r, 5);
  replay.recorder = r;
  replay.writeClip = async () => ({ path: '/v/kScreen/a.mp4', name: 'a.mp4' });
  const result = await replay.save();
  assert.equal(result.name, 'a.mp4');
  assert.equal(saved.length, 1);
  const toast = toasts.at(-1);
  assert.match(toast.message, /Clipe salvo/);
  toast.options.onClick();
  assert.deepEqual(bridge.calls.shown, ['/v/kScreen/a.mp4']);
  assert.equal(replay.busy, false);
});

test('save: a held shortcut saves one clip, not one per key repeat', async () => {
  const { replay } = makeReplay();
  const r = runningRecorder(replay, fakeTrack());
  feedVideo(r, 5);
  replay.recorder = r;
  let writes = 0;
  replay.writeClip = async () => { writes++; return { path: '/x.mp4', name: 'x.mp4' }; };
  await Promise.all([replay.save(), replay.save(), replay.save()]);
  assert.equal(writes, 1);
  replay.lastSaveAt -= 2000; // a new press later
  await replay.save();
  assert.equal(writes, 2);
});

test('save: nothing recorded yet / errors become a message', async () => {
  const { replay, toasts } = makeReplay();
  assert.equal(await replay.save(), null);
  assert.match(toasts.at(-1).message, /ainda não gravou/);
  const r = runningRecorder(replay, fakeTrack());
  feedVideo(r, 5);
  replay.recorder = r;
  replay.writeClip = async () => { throw new Error('disk-full'); };
  assert.equal(await replay.save(), null);
  assert.match(toasts.at(-1).message, /Sem espaço/);
  assert.equal(replay.busy, false);
});

test('writeClip: sends the MP4 in pieces of at most ~4 MB and aborts on a failed write', async () => {
  const sizes = [];
  let aborted = 0;
  const bridge = fakeBridge({});
  bridge.clip = {
    begin: async ({ size }) => { bridge.total = size; return { id: 9 }; },
    write: async (id, bytes) => { sizes.push(bytes.byteLength); return { ok: true }; },
    end: async () => ({ path: '/v/kScreen/b.mp4', name: 'b.mp4' }),
    abort: async () => { aborted++; }
  };
  const { replay } = makeReplay({ bridge });
  const r = runningRecorder(replay, fakeTrack());
  feedVideo(r, 20, { size: 60_000 });
  await replay.writeClip(r.snapshot(20));
  assert.equal(sizes.reduce((a, b) => a + b, 0), bridge.total);
  assert.ok(sizes.length > 1 && sizes.every(n => n <= 4 * 1024 * 1024 + 60_000));
  bridge.clip.write = async () => ({ error: 'disk-full' });
  await assert.rejects(replay.writeClip(r.snapshot(20)), /disk-full/);
  assert.equal(aborted, 1);
});

// ---- the mic opened for "record even muted" ---------------------------------------------------

test('mic opened by the replay is closed when the share ends', () => {
  const { replay, engine } = makeReplay();
  replay.recorder = runningRecorder(replay, fakeTrack());
  replay.micOpened = true;
  replay.stop({ quiet: true }); // a restart keeps it
  assert.equal(engine.released, 0);
  replay.recorder = runningRecorder(replay, fakeTrack());
  replay.shareEnded();
  assert.equal(engine.released, 1);
  replay.shareEnded();
  assert.equal(engine.released, 1, 'only once');
});

test('mic opened by the replay is closed when "even muted" is turned off', async () => {
  const { replay, engine } = makeReplay();
  replay.micOpened = true;
  await replay.setSettings({ micAlways: false });
  assert.equal(engine.released, 1);
});

test('a mic the replay did not open is never closed by it', async () => {
  const { replay, engine } = makeReplay();
  replay.recorder = runningRecorder(replay, fakeTrack());
  replay.shareEnded();
  await replay.setSettings({ micAlways: false });
  assert.equal(engine.released, 0);
});

// ---- share changes ----------------------------------------------------------------------------

test('watch: a window resized in the same proportions keeps the buffer', () => {
  const track = fakeTrack();
  const { replay } = makeReplay({ engine: fakeEngine(track) });
  const r = runningRecorder(replay, track);
  replay.recorder = r;
  let restarts = 0;
  replay.restart = () => { restarts++; };
  Object.assign(track.settings, { width: 1280, height: 720 });
  replay.watch();
  assert.equal(restarts, 0);
  assert.deepEqual(r.sourceSize, { width: 1280, height: 720 });
});

test('watch: other proportions restart only once the size settles', () => {
  const track = fakeTrack();
  const { replay } = makeReplay({ engine: fakeEngine(track) });
  const r = runningRecorder(replay, track);
  replay.recorder = r;
  let restarts = 0;
  replay.restart = () => { restarts++; };
  Object.assign(track.settings, { width: 1000, height: 1000 });
  replay.watch();
  Object.assign(track.settings, { width: 1010, height: 1000 }); // still being dragged
  replay.watch();
  assert.equal(restarts, 0);
  r.pendingSize.at -= 2000;
  replay.watch();
  assert.equal(restarts, 1);
});

test('watch: a new FPS keeps the encoder; a new source restarts', () => {
  const track = fakeTrack();
  const engine = fakeEngine(track);
  const { replay } = makeReplay({ engine });
  const r = runningRecorder(replay, track);
  replay.recorder = r;
  let restarts = 0;
  replay.restart = () => { restarts++; };
  engine.shareSettings.fps = 30;
  replay.watch();
  assert.equal(restarts, 0);
  assert.equal(r.shareFps, 30);
  assert.equal(Math.round(r.intervalUs), 33_333);
  const other = fakeTrack();
  engine.localStream.getVideoTracks = () => [other];
  replay.watch();
  assert.equal(restarts, 1);
});

test('watch: a failure is not retried on the same capture, only on a new one', () => {
  const track = fakeTrack();
  const engine = fakeEngine(track);
  const { replay, toasts } = makeReplay({ engine });
  replay.supported = false;
  replay.start();
  assert.equal(replay.failedTrack, track);
  const before = toasts.length;
  replay.watch();
  replay.watch();
  assert.equal(toasts.length, before, 'no toast loop');
  const other = fakeTrack();
  engine.localStream.getVideoTracks = () => [other];
  replay.watch();
  assert.equal(replay.failedTrack, other, 'tried (and failed) once on the new source');
});

test('watch: share gone stops the replay and frees the shortcut', () => {
  const track = fakeTrack();
  const engine = fakeEngine(track);
  const { replay, bridge } = makeReplay({ engine });
  replay.recorder = runningRecorder(replay, track);
  engine.localStream = null;
  replay.watch();
  assert.equal(replay.recorder, null);
  assert.deepEqual(bridge.calls.active, [false]);
});

// ---- audio holes ------------------------------------------------------------------------------

function audioRecorder({ inherit = null } = {}) {
  const { replay } = makeReplay();
  const r = runningRecorder(replay, fakeTrack());
  const a = new AudioTrackRecorder(r, 'screen', { enabled: true, readyState: 'live' }, { inherit });
  const encoded = [];
  a.encoder = { state: 'configured', encodeQueueSize: 0, encode: (d) => encoded.push({ t: d.timestamp, frames: d.numberOfFrames, silent: d instanceof FakeAudioData }) };
  a.info = { codec: 'aac', sampleRate: 48000, channels: 2 };
  a.offset = 0;
  return { a, encoded };
}

const block = (t, frames = 480) => ({ timestamp: t, sampleRate: 48000, numberOfFrames: frames, numberOfChannels: 2, duration: frames / 48000 * 1e6 });

test('audio: holes are filled with silence, back to back with the real audio', () => {
  const { a, encoded } = audioRecorder();
  a.feed(block(0));
  a.feed(block(10_000));
  a.feed(block(520_000)); // 500 ms hole
  const silence = encoded.filter(e => e.silent);
  const frames = silence.reduce((n, e) => n + e.frames, 0);
  assert.equal(frames, 500_000 * 48000 / 1e6);
  // Contiguous: every block starts where the previous ended (within one sample).
  for (let i = 1; i < encoded.length; i++) {
    const prevEnd = encoded[i - 1].t + encoded[i - 1].frames / 48000 * 1e6;
    assert.ok(Math.abs(encoded[i].t - prevEnd) <= 21, `block ${i} starts at ${encoded[i].t}, previous ended ${prevEnd}`);
  }
});

test('audio: jitter is not a hole; absurd holes are left to the muxer', () => {
  const { a, encoded } = audioRecorder();
  a.feed(block(0));
  a.feed(block(10_000 + 5_000));
  assert.equal(encoded.filter(e => e.silent).length, 0);
  a.feed(block(20_000_000));
  assert.equal(encoded.filter(e => e.silent).length, 0);
});

test('audio: a switched source continues the old audio with silence in between', () => {
  const prev = { info: { codec: 'aac', sampleRate: 48000, channels: 2 }, samples: [{ t: 0, duration: 21_333, data: new Uint8Array(1) }], bytes: 1 };
  const { a, encoded } = audioRecorder({ inherit: prev });
  a.feed(block(300_000));
  const silence = encoded.filter(e => e.silent).reduce((n, e) => n + e.frames, 0);
  assert.ok(Math.abs(silence - (300_000 - 21_333) * 48000 / 1e6) <= 1, `${silence} frames of silence`);
});

test('audio: a different format is not continued', () => {
  const prev = { info: { codec: 'opus', sampleRate: 48000, channels: 2 }, samples: [{ t: 0, duration: 20_000, data: new Uint8Array(1) }], bytes: 1 };
  const { a, encoded } = audioRecorder({ inherit: prev });
  a.feed(block(300_000));
  assert.equal(encoded.filter(e => e.silent).length, 0);
});

test('audio: a stuck encoder skips blocks and the hole is filled once it recovers', () => {
  const { a, encoded } = audioRecorder();
  a.feed(block(0));
  a.encoder.encodeQueueSize = 500;
  a.feed(block(10_000));
  a.feed(block(20_000));
  a.encoder.encodeQueueSize = 0;
  a.feed(block(30_000));
  const silence = encoded.filter(e => e.silent).reduce((n, e) => n + e.frames, 0);
  assert.equal(silence, 960);
});

// ---- the processor encoder and a GPU encoder that breaks -------------------------------------

import { fitWithin } from '../src/replay.js';

test('fitWithin: the processor encoder works on at most 720p, same proportions', () => {
  assert.deepEqual(fitWithin(1920, 1080, { width: 1280, height: 720 }), { width: 1280, height: 720 });
  assert.deepEqual(fitWithin(2560, 1080, { width: 1280, height: 720 }), { width: 1280, height: 540 });
  assert.deepEqual(fitWithin(1080, 1920, { width: 1280, height: 720 }), { width: 404, height: 720 });
  assert.deepEqual(fitWithin(800, 600, { width: 1280, height: 720 }), { width: 800, height: 600 });
});

test('a GPU encoder that breaks falls back to the processor once, then the replay stops', () => {
  const track = fakeTrack();
  const { replay, toasts } = makeReplay({ engine: fakeEngine(track) });
  let restarts = 0;
  replay.restart = () => { restarts++; };
  const r = runningRecorder(replay, track);
  r.software = false;
  replay.recorder = r;
  r.encoderFailed(new Error('driver'));
  assert.equal(replay.forceSoftware, true);
  assert.equal(restarts, 1);
  assert.equal(replay.lastError, null, 'no error shown for the fallback');
  const soft = runningRecorder(replay, track);
  soft.software = true;
  replay.recorder = soft;
  soft.encoderFailed(new Error('broken'));
  assert.equal(restarts, 1);
  assert.equal(replay.recorder, null);
  assert.match(toasts.at(-1).message, /Instant Replay parou/);
});

test('the clip tells the app when its audio is Opus (Linux re-encodes it to AAC)', async () => {
  const bridge = fakeBridge();
  let info = null;
  bridge.clip.begin = async (i) => { info = i; return { id: 1 }; };
  const { replay } = makeReplay({ bridge });
  const r = runningRecorder(replay, fakeTrack());
  feedVideo(r, 3);
  const snap = r.snapshot(3);
  snap.audios = [{ codec: 'opus', name: 'x', sampleRate: 48000, channels: 2, samples: [{ t: snap.video.samples[0].t, duration: 20_000, data: new Uint8Array(3) }] }];
  await replay.writeClip(snap);
  assert.equal(info.opus, true);
  snap.audios[0].codec = 'aac';
  snap.audios[0].description = Uint8Array.of(0x11, 0x90);
  await replay.writeClip(snap);
  assert.equal(info.opus, false);
});
