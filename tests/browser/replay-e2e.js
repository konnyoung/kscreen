// End-to-end Instant Replay run with the browser's real WebCodecs (see replay-e2e.html).
//
// A fake share: a canvas that flashes white for 200 ms every 2 s and, at the same instants, a
// beep on the "share audio" track. A second oscillator plays the "mic". Each scenario records,
// saves a clip through a fake app bridge, and keeps the MP4 bytes in window.__clips[name].
// With tests/browser/clip-receiver.mjs running, uploadClip(name) sends one to disk, where
// tests/browser/check-clip.sh checks its tracks, decode errors and A/V sync.
//
// window.runReplayE2E({ scenario, seconds }) -> { name, size, stats, toasts }
// window.uploadClip(name, url = 'http://127.0.0.1:8765/') -> 'ok'
import { InstantReplay } from '/src/replay.js';

const logEl = document.getElementById('log');
const log = (...args) => { logEl.textContent += args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') + '\n'; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const FLASH_EVERY_MS = 2000;
const FLASH_MS = 200;

function fakeShare() {
  const canvas = document.getElementById('screen');
  const g = canvas.getContext('2d');
  const ctx = new AudioContext({ sampleRate: 48000 });
  const beepGain = ctx.createGain();
  beepGain.gain.value = 0;
  const osc = ctx.createOscillator();
  osc.frequency.value = 1000;
  osc.connect(beepGain);
  const share = ctx.createMediaStreamDestination();
  beepGain.connect(share);
  osc.start();
  // The "mic": a quieter low tone, always on.
  const micOsc = ctx.createOscillator();
  micOsc.frequency.value = 220;
  const micGain = ctx.createGain();
  micGain.gain.value = 0.05;
  const mic = ctx.createMediaStreamDestination();
  micOsc.connect(micGain).connect(mic);
  micOsc.start();

  // Frames come from a generator fed by a worker's clock: a hidden page gets no
  // requestAnimationFrame and throttles its own timers, a worker's messages still arrive.
  const video = new MediaStreamTrackGenerator({ kind: 'video' });
  // A generated track reports no size: answer like a real capture, from the canvas.
  video.getSettings = () => ({ width: canvas.width, height: canvas.height, frameRate: 30 });
  const writer = video.writable.getWriter();
  const ticker = new Worker(URL.createObjectURL(new Blob(['setInterval(() => postMessage(0), 1000 / 30)'], { type: 'text/javascript' })));
  let lit = false;
  const start = performance.now();
  ticker.onmessage = () => {
    const now = performance.now();
    const on = (now - start) % FLASH_EVERY_MS < FLASH_MS;
    if (on !== lit) {
      lit = on;
      // Picture and sound switch at the same moment.
      beepGain.gain.setValueAtTime(on ? 0.8 : 0, ctx.currentTime);
    }
    g.fillStyle = on ? '#fff' : '#000';
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.fillStyle = on ? '#000' : '#888';
    g.font = '28px monospace';
    g.fillText(`${((now - start) / 1000).toFixed(2)} s`, 20, 50);
    const frame = new VideoFrame(canvas, { timestamp: Math.round(now * 1000) });
    writer.write(frame).catch(() => frame.close());
  };
  const shareAudio = share.stream.getAudioTracks()[0];
  return {
    ctx,
    video,
    shareAudio,
    micTrack: mic.stream.getAudioTracks()[0],
    stop() { ticker.terminate(); writer.close().catch(() => {}); video.stop(); osc.stop(); micOsc.stop(); ctx.close(); }
  };
}

function fakeBridge(settings, chunks) {
  let total = 0;
  return {
    api: 1,
    setSettings: async (patch) => Object.assign(settings, patch) && { ...settings },
    getSettings: async () => ({ ...settings }),
    setActive: async () => ({ registered: true }),
    onHotkey() {},
    diag: (event, data) => log('[diag]', event, data),
    showClip() {},
    openFolder: async () => true,
    pcAudio: { start: async () => null, stop() {} },
    clip: {
      begin: async ({ size }) => { total = size; chunks.length = 0; return { id: 1 }; },
      write: async (id, bytes) => { chunks.push(bytes.slice()); return { ok: true }; },
      end: async () => {
        const got = chunks.reduce((n, c) => n + c.byteLength, 0);
        return got === total ? { path: '/clip.mp4', name: 'clip.mp4' } : { error: 'incomplete' };
      },
      abort: async () => {}
    }
  };
}

function joined(chunks) {
  const all = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.byteLength; }
  return all;
}

window.uploadClip = async (name, url = 'http://127.0.0.1:8765/') => {
  const res = await fetch(`${url}?name=${encodeURIComponent(name)}`, { method: 'POST', body: window.__clips[name] });
  return res.text();
};

window.__clips = {};

// Scenarios:
//  separate  share audio + mic, each on its own track
//  mixed     both summed into one track
//  switch    starts separate, switches to mixed halfway (audio carried over, hole filled)
//  resize    the share is resized (same proportions) halfway: buffer kept, frames scaled
//  lengthen  starts at 15 s, raised to 30 s halfway: the whole span must be kept
window.runReplayE2E = async ({ scenario = 'separate', seconds = 10 } = {}) => {
  logEl.textContent = '';
  const share = fakeShare();
  await share.ctx.resume();
  const settings = { enabled: true, seconds: scenario === 'lengthen' ? 15 : 30, hotkey: 'Alt+F10', mic: true, micAlways: false, pcAudio: false, voices: false, micMode: scenario === 'mixed' ? 'mixed' : 'separate', excludedApps: 0 };
  const chunks = [];
  const bridge = fakeBridge(settings, chunks);
  const engine = {
    localStream: new MediaStream([share.video, share.shareAudio]),
    micStream: new MediaStream([share.micTrack]),
    shareSettings: { fps: 30 },
    openMicMuted: async () => {},
    releaseMutedMic: () => false
  };
  const toasts = [];
  const replay = new InstantReplay(engine, bridge, { durations: [15, 30, 60, 120], hotkeys: ['Alt+F10'] }, { ...settings }, {
    onChange() {},
    toast: (m) => { toasts.push(m); log('[toast]', m); },
    onSaved() {},
    roomVoices: () => null
  });
  await replay.shareStarted();
  for (let i = 0; i < 50 && !replay.active; i++) await sleep(100);
  if (!replay.active) throw new Error(`replay did not start: ${replay.lastError}`);
  const half = seconds * 500;
  await sleep(half);
  if (scenario === 'switch') await replay.setSettings({ micMode: 'mixed' });
  if (scenario === 'lengthen') await replay.setSettings({ seconds: 30 });
  if (scenario === 'resize') {
    // A new capture size in the same proportions (the encoder scales it).
    const canvas = document.getElementById('screen');
    canvas.width = 480;
    canvas.height = 270;
  }
  await sleep(seconds * 1000 - half);
  const r = replay.recorder;
  const stats = { ...r.stats, gops: r.gops.length, bufferedS: replay.bufferedSeconds(), software: r.software, maxMB: Math.round(r.maxBytes / 1048576), filledMs: Object.fromEntries(Object.entries(r.audioTracks).filter(([, t]) => t).map(([k, t]) => [k, Math.round(t.filledUs / 1000)])) };
  const result = await replay.save(scenario === 'lengthen' ? 30 : seconds);
  replay.shareEnded();
  clearInterval(replay.timer);
  share.stop();
  if (!result) throw new Error(`save failed: ${toasts.join(' | ')}`);
  window.__clips[scenario] = joined(chunks);
  return { name: scenario, size: window.__clips[scenario].byteLength, stats, toasts };
};

log('pronto: window.runReplayE2E({ scenario, seconds })');
