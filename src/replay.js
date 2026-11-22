// Instant Replay (Clips): keeps the last seconds of YOUR OWN share in memory and saves them as an
// MP4 on demand (button in the live menu or the global shortcut).
//
// Desktop app only: main.js loads this file only when window.kscreenDesktop.replay exists, and it
// stays unavailable unless the app lists the 'replay' feature (see desktop/src/replay.js). There
// is no browser fallback.
//
// How it works:
//  - no second screen capture: a clone of the share's own video track feeds a dedicated
//    WebCodecs H.264 encoder (hardware first; software at 30 FPS only when there is none);
//  - the share's audio, the mic (as the room hears it) and, optionally, the room's voices (as you
//    hear them) each feed an AAC encoder (Opus when AAC is missing). They become separate MP4
//    tracks, or one mixed track that plays in any player ("Tudo junto", the default);
//  - audio holes (a source switching, a late block) are filled with encoded silence, so the
//    audio never drifts ahead of the video;
//  - encoded chunks wait in memory grouped by GOP (a keyframe every 2 s), so a clip can always
//    start on a keyframe; old GOPs are dropped by time and by a memory cap;
//  - saving copies nothing but the requested chunks: src/mp4-mux.js lays out the file and the app
//    writes it piece by piece (desktop/src/replay.js);
//  - it only runs while sharing, and everything is thrown away when the share stops.
// Nobody needs to be watching: it records the local capture, not what is sent to the room.

import { buildMp4 } from './mp4-mux.js';
import { targetBitrate } from './webrtc.js';

const REPLAY_API = 1;
const GOP_US = 2_000_000;
const MAX_VIDEO_BITRATE = 16_000_000;
const SOFTWARE_MAX_BITRATE = 6_000_000;
// The processor encoder (no GPU encoder: Linux without VA-API, NVIDIA on Linux) works on at most
// 1280x720 at 30 FPS, so it stays light next to a game. The frames are scaled to that size.
const SOFTWARE_MAX = { width: 1280, height: 720, fps: 30 };
const AUDIO_BITRATE = 160_000;
// Frames waiting in the encoder before new ones are skipped: the replay never queues work up.
const MAX_ENCODE_QUEUE = 2;
// Audio is cheap to encode: only a stuck encoder gets this far behind (the hole is then filled).
const MAX_AUDIO_QUEUE = 100;
// Holes between audio blocks above this are filled with silence; above the max they're left
// (something went very wrong: the muxer then stretches the timing instead).
const GAP_FILL_MIN_US = 15_000;
const GAP_FILL_MAX_US = 5_000_000;
const MAX_BUFFER_BYTES = 512 * 1024 * 1024;
const WRITE_BATCH = 4 * 1024 * 1024;
// A held shortcut repeats: one clip per press.
const SAVE_DEBOUNCE_MS = 1500;
// A window share being resized: wait for its size to settle before starting a new buffer.
const RESIZE_SETTLE_MS = 1500;
// Up to this aspect change the encoder just scales the frames and the buffer is kept.
const ASPECT_TOLERANCE = 0.03;
const H264_CODECS = ['avc1.640034', 'avc1.640033', 'avc1.640032', 'avc1.640028', 'avc1.4d0034', 'avc1.4d0028', 'avc1.42e034', 'avc1.42e028'];

const even = (n) => Math.max(2, Math.floor(n / 2) * 2);
const nowUs = () => Math.round(performance.now() * 1000);
const yieldToPage = () => new Promise(r => setTimeout(r, 0));

// Whether WebCodecs has a GPU H.264 encoder here (Linux: VA-API with a driver that has it).
async function probeHardwareEncoder() {
  if (typeof VideoEncoder !== 'function') return false;
  for (const codec of ['avc1.42e028', 'avc1.4d0028', 'avc1.640028']) {
    try {
      if ((await VideoEncoder.isConfigSupported({ codec, width: 1280, height: 720, bitrate: 4_000_000, framerate: 30, hardwareAcceleration: 'prefer-hardware', latencyMode: 'realtime', avc: { format: 'avc' } })).supported) return true;
    } catch { /* next */ }
  }
  return false;
}

// True the first time on this computer (per-viewer convenience: browser storage is fine).
function seenOnce(key) {
  try {
    if (localStorage.getItem(key)) return true;
    localStorage.setItem(key, '1');
  } catch { /* storage blocked: show it */ }
  return false;
}

const CLIP_ERRORS = {
  'disk-full': 'Sem espaço em disco para salvar o clipe.',
  folder: 'Não foi possível criar o clipe na pasta Vídeos.',
  busy: 'Já tem um clipe sendo salvo. Espere um instante.',
  write: 'Erro ao gravar o clipe no disco.'
};

// Bytes kept for `seconds` of video + audio at `bitrate`, with room for VBR peaks.
export function bufferCap(bitrate, seconds) {
  return Math.min(MAX_BUFFER_BYTES, Math.max(32 * 1024 * 1024, Math.round((bitrate + 3 * AUDIO_BITRATE) / 8 * (seconds + 4) * 1.5)));
}

// The largest size within `max` with the proportions of width x height (even numbers).
export function fitWithin(width, height, max) {
  const scale = Math.min(1, max.width / width, max.height / height);
  return { width: even(width * scale), height: even(height * scale) };
}

// Whether a capture of `size` can go into an encoder set up for `video` (scaled, not stretched).
export function sameAspect(size, video) {
  if (!size?.width || !size?.height || !video?.width || !video?.height) return false;
  const a = size.width / size.height;
  const b = video.width / video.height;
  return Math.abs(a - b) / b <= ASPECT_TOLERANCE;
}

// Null when there's no replay here (web, old app, missing feature).
export async function initReplay(engine, { onChange = () => {}, toast = () => {}, onSaved = () => {}, roomVoices = () => null } = {}) {
  const bridge = window.kscreenDesktop?.replay;
  if (!bridge || bridge.api !== REPLAY_API || typeof bridge.capabilities !== 'function') return null;
  let caps;
  try { caps = await bridge.capabilities(); } catch { return null; }
  if (caps?.api !== REPLAY_API || !Array.isArray(caps.features) || !caps.features.includes('replay')) return null;
  if (typeof bridge.getSettings !== 'function' || typeof bridge.clip?.begin !== 'function') return null;
  const settings = await bridge.getSettings().catch(() => null);
  if (!settings) return null;
  const replay = new InstantReplay(engine, bridge, caps, settings, { onChange, toast, onSaved, roomVoices });
  if (engine.localStream) replay.shareStarted();
  return replay;
}

export class InstantReplay {
  constructor(engine, bridge, caps, settings, { onChange, toast, onSaved, roomVoices }) {
    this.engine = engine;
    this.bridge = bridge;
    this.DURATIONS = caps.durations || [15, 30, 60, 120];
    this.HOTKEYS = caps.hotkeys || ['Alt+F10'];
    this.settings = settings;
    this.onChange = onChange;
    this.toast = toast;
    this.onSaved = onSaved;
    this.roomVoices = roomVoices;
    this.recorder = null;
    this.hotkeyRegistered = false;
    this.hotkeyWarned = false;   // the "shortcut taken" toast, once per share
    this.failedTrack = null;     // a capture the replay failed on: not retried until a new one
    this.saving = Promise.resolve();
    this.savingCount = 0;
    this.lastSaveAt = -Infinity;
    this.lastError = null;
    this.supported = typeof VideoEncoder === 'function' && typeof MediaStreamTrackProcessor === 'function';
    // "All PC sound" needs the app's own PC capture (see desktop/src/replay.js).
    this.pcAudioAvailable = !!caps.pcAudio && typeof bridge.pcAudio?.start === 'function';
    // Wayland: global keys depend on the desktop (portal) or a system shortcut to --save-clip.
    this.wayland = !!caps.wayland;
    this.saveClipCommand = caps.saveClipCommand || 'kscreen --save-clip';
    // Linux: 'ffmpeg' = Opus audio becomes AAC after saving; 'none' = clips keep Opus.
    this.aac = caps.aac || 'native';
    // Linux: what to install for GPU encoding, for this distro and GPU (settings page).
    this.gpuGuide = caps.gpuGuide || null;
    // Whether this app can encode H.264 on the GPU (null until checked); the settings page
    // shows it before any share.
    this.hwEncoder = null;
    probeHardwareEncoder().then((ok) => { this.hwEncoder = ok; this.onChange(); });
    this.forceSoftware = false; // the GPU encoder broke once: the processor from then on
    // { via: 'portal' | 'electron', desktop, bindLine }: on Wayland the system owns the key.
    this.shortcut = caps.shortcut || { via: 'electron' };
    this.hotkeyTrigger = '';    // the key the system reports for the portal shortcut
    this.pcAudio = null;      // { track, ctx } while the replay captures the PC by itself
    this.pcAudioStarting = false;
    this.micTriedAt = 0;
    this.micOpened = false;   // the replay opened the mic (muted) and must close it when done
    bridge.onHotkey(() => this.save());
    // Once a second: the share ended, or its source/size changed.
    this.timer = setInterval(() => this.watch(), 1000);
  }

  // ---- state for the UI ----------------------------------------------------------------------

  get enabled() { return !!this.settings.enabled; }
  get active() { return !!this.recorder?.ready; }
  get busy() { return this.savingCount > 0; }
  // The key to show in the UI: the system's on Wayland (may be unknown: ''), ours elsewhere.
  get hotkeyLabel() { return this.shortcut.via === 'portal' ? this.hotkeyTrigger : this.settings.hotkey; }

  bufferedSeconds() {
    const r = this.recorder;
    if (!r?.gops.length) return 0;
    return Math.min(this.settings.seconds, Math.max(0, (r.lastVideoT - r.gops[0].t) / 1e6));
  }

  async setSettings(patch) {
    const next = await this.bridge.setSettings(patch);
    if (!next) return this.settings;
    const wasEnabled = this.settings.enabled;
    this.settings = next;
    if ('hotkeyRegistered' in next && next.hotkeyRegistered !== null) this.hotkeyRegistered = next.hotkeyRegistered;
    if (next.enabled && !wasEnabled) {
      this.failedTrack = null; // turning it on again is a new try
      if (this.engine.localStream) this.start();
    }
    if (!next.enabled && wasEnabled) this.stop();
    // The mic was opened only for "even muted": close it when that is no longer wanted.
    if (!next.enabled || next.mic === false || !next.micAlways) this.releaseMic();
    if (this.recorder) {
      this.recorder.setKeep(next.seconds);
      this.recorder.syncAudio();
    }
    this.onChange();
    return next;
  }

  // Short notes for the app's own log (where a failure can be looked at without DevTools).
  diag(event, data = {}) {
    console.info(`[replay] ${event}`, data);
    try { this.bridge.diag?.(event, data); } catch { /* old app */ }
  }

  openFolder() {
    return this.bridge.openFolder();
  }

  // ---- share lifecycle -----------------------------------------------------------------------

  async shareStarted() {
    this.hotkeyWarned = false;
    this.failedTrack = null;
    if (!this.enabled || this.recorder) return;
    // The picker may have changed which apps are left out of the share: read them again.
    const fresh = await this.bridge.getSettings().catch(() => null);
    if (fresh) this.settings = { ...this.settings, ...fresh };
    if (this.enabled && !this.recorder && this.engine.localStream) this.start();
  }

  shareEnded() {
    this.stop();
  }

  watch() {
    const stream = this.engine.localStream;
    if (!stream) {
      if (this.recorder) this.stop();
      return;
    }
    const track = stream.getVideoTracks()[0];
    const r = this.recorder;
    if (!r) {
      // Should be running (e.g. a resize restart, or a new source after a failure).
      if (this.enabled && track && track.readyState === 'live' && track !== this.failedTrack) this.start();
      return;
    }
    if (!r.ready) return;
    r.syncAudio();
    // The replay's own PC capture only lives while it feeds the clip.
    if (this.pcAudio && !r.usesTrack(this.pcAudio.track)) this.stopPcAudio();
    // A new FPS only changes the pace frames are taken at: same encoder, same buffer.
    const fps = this.engine.shareSettings?.fps;
    if (fps && fps !== r.shareFps) r.setFps(fps);
    if (track !== r.source) {
      // Another screen/window: a fresh buffer (a clip has one picture size).
      this.restart();
      return;
    }
    const s = track.getSettings() || {};
    if (!s.width || !s.height || (s.width === r.sourceSize.width && s.height === r.sourceSize.height)) {
      r.pendingSize = null;
      return;
    }
    if (sameAspect(s, r.video)) {
      // The encoder scales frames to its size: a window resized keeps its buffer.
      r.sourceSize = { width: s.width, height: s.height };
      r.pendingSize = null;
      return;
    }
    // Other proportions: wait until the size settles (a window being dragged), then restart.
    const key = `${s.width}x${s.height}`;
    if (r.pendingSize?.key !== key) r.pendingSize = { key, at: performance.now() };
    else if (performance.now() - r.pendingSize.at >= RESIZE_SETTLE_MS) this.restart();
  }

  restart() {
    this.diag('restart');
    this.stop({ quiet: true });
    this.start();
  }

  async start() {
    if (this.recorder || !this.enabled) return;
    const track = this.engine.localStream?.getVideoTracks()[0];
    if (!track || track.readyState !== 'live') return;
    if (!this.supported) {
      this.failedTrack = track;
      this.fail('Este app não tem WebCodecs: o Instant Replay não funciona aqui.');
      return;
    }
    const recorder = new Recorder(this, track);
    this.recorder = recorder;
    try {
      await recorder.start();
    } catch (err) {
      if (this.recorder === recorder) {
        this.recorder = null;
        recorder.close();
        this.failedTrack = track;
        this.fail(err.message);
      }
      return;
    }
    if (this.recorder !== recorder) return; // stopped meanwhile
    this.lastError = null;
    const res = await this.bridge.setActive(true).catch(() => null);
    if (this.recorder !== recorder) return;
    this.hotkeyRegistered = !!res?.registered;
    this.hotkeyTrigger = res?.trigger || '';
    // Hyprland binds portal shortcuts only in hyprland.conf: say how, once ever (the settings
    // page keeps the line to copy).
    if (this.hotkeyRegistered && this.shortcut.bindLine && !this.hotkeyWarned && !seenOnce('kscreen.replay.hyprlandHint')) {
      this.hotkeyWarned = true;
      this.toast(`Para salvar clipes por atalho no Hyprland, adicione ao ${this.shortcut.configFile || 'hyprland.conf'}: ${this.shortcut.bindLine}`, 12000);
    }
    if (!this.hotkeyRegistered && !this.hotkeyWarned) {
      this.hotkeyWarned = true;
      this.toast(this.wayland
        ? `No Wayland o atalho depende do sistema. Use o botão no menu da transmissão, ou crie um atalho do sistema com o comando ${this.saveClipCommand}.`
        : `O atalho ${this.settings.hotkey} está em uso por outro programa. Use o botão no menu da transmissão ou escolha outro atalho.`, 7000);
    }
    this.onChange();
  }

  stop({ quiet = false } = {}) {
    const r = this.recorder;
    if (!r) return;
    this.recorder = null;
    r.close();
    this.stopPcAudio();
    if (!quiet) {
      this.bridge.setActive(false).catch(() => {});
      this.releaseMic();
    }
    this.onChange();
  }

  fail(message) {
    this.lastError = message;
    this.diag('error', { message });
    this.toast(`Instant Replay parou: ${message}`, 6000);
    this.bridge.setActive(false).catch(() => {});
    this.releaseMic();
    this.onChange();
  }

  // Called by the recorder when its encoder breaks: no retry on the same capture.
  recorderFailed(recorder, message) {
    if (this.recorder !== recorder) return;
    this.recorder = null;
    this.failedTrack = recorder.source;
    recorder.close();
    this.stopPcAudio();
    this.fail(message);
  }

  // ---- saving --------------------------------------------------------------------------------

  // Saves the last `seconds` (default: the configured length). Saves queue up, one at a time.
  save(seconds = this.settings.seconds) {
    const r = this.recorder;
    if (!r?.ready || !r.gops.length) {
      this.toast(this.enabled ? 'O Instant Replay ainda não gravou nada. Tente de novo em alguns segundos.' : 'O Instant Replay está desligado.');
      return Promise.resolve(null);
    }
    const at = performance.now();
    if (at - this.lastSaveAt < SAVE_DEBOUNCE_MS) return Promise.resolve(null);
    this.lastSaveAt = at;
    // The snapshot is taken now (what the user wanted to keep), the file is written after.
    const snapshot = r.snapshot(seconds);
    this.diag('save', { seconds: Math.round(snapshot.seconds * 10) / 10, videoFrames: snapshot.video.samples.length, audio: snapshot.audios.map(a => ({ name: a.name, codec: a.codec, packets: a.samples.length })), levels: snapshot.levels, dropped: r.stats.dropped });
    this.savingCount++;
    this.onChange();
    const job = this.saving.then(() => this.writeClip(snapshot)).then((result) => {
      if (result?.path) {
        this.onSaved(result);
        // Linux: ffmpeg was there but failed, so the clip kept its Opus audio.
        if (result.audio === 'opus') this.diag('aac-failed');
        this.toast(`Clipe salvo (${Math.round(snapshot.seconds)} s): ${result.name}`, 5000, {
          onClick: () => this.showClip(result.path),
          title: 'Mostrar na pasta'
        });
        console.info('[replay] clipe salvo', result.path);
      }
      return result;
    }).catch((err) => {
      this.toast(CLIP_ERRORS[err.message] || 'Não foi possível salvar o clipe.', 5000);
      console.warn('[replay] falha ao salvar', err);
      this.diag('save-error', { message: err.message, step: err.step, reply: err.reply, bytes: err.bytes });
      return null;
    }).finally(() => {
      this.savingCount--;
      this.onChange();
    });
    this.saving = job;
    return job;
  }

  async writeClip(snapshot) {
    const mp4 = buildMp4(snapshot);
    const begin = await this.bridge.clip.begin({ size: mp4.size, opus: snapshot.audios.some(a => a.codec === 'opus') });
    if (!begin?.id) throw Object.assign(new Error(begin?.error || 'write'), { step: 'begin', reply: begin });
    const id = begin.id;
    try {
      // Pieces of ~4 MB with a pause between them: the page (and the share) never stall.
      let batch = [mp4.header];
      let batchBytes = mp4.header.byteLength;
      const flush = async () => {
        const bytes = new Uint8Array(batchBytes);
        let at = 0;
        for (const part of batch) { bytes.set(part, at); at += part.byteLength; }
        batch = [];
        batchBytes = 0;
        const res = await this.bridge.clip.write(id, bytes);
        if (!res?.ok) throw Object.assign(new Error(res?.error || 'write'), { step: 'write', reply: res, bytes: bytes.byteLength });
        await yieldToPage();
      };
      for (const part of mp4.parts) {
        if (batchBytes + part.byteLength > WRITE_BATCH && batchBytes) await flush();
        batch.push(part);
        batchBytes += part.byteLength;
      }
      if (batchBytes) await flush();
      const end = await this.bridge.clip.end(id);
      if (!end?.path) throw Object.assign(new Error(end?.error || 'write'), { step: 'end', reply: end });
      return end;
    } catch (err) {
      this.bridge.clip.abort(id).catch(() => {});
      throw err;
    }
  }

  // ---- sources the replay opens itself -------------------------------------------------------

  // "Record the mic even muted": opens it muted when nobody has yet. A refused permission is
  // retried at most every 30 s, never in a loop.
  openMicMuted() {
    if (this.micOpening || Date.now() - this.micTriedAt < 30_000 || typeof this.engine.openMicMuted !== 'function') return;
    this.micTriedAt = Date.now();
    this.micOpening = true;
    this.engine.openMicMuted()
      .then(() => {
        this.micOpened = true;
        this.diag('mic-opened-muted');
        // Turned off (or the share ended) while the mic was opening.
        if (!this.recorder || !this.settings.micAlways || this.settings.mic === false) this.releaseMic();
      })
      .catch(err => this.diag('mic-error', { message: err.message }))
      .finally(() => { this.micOpening = false; });
  }

  // Closes the mic the replay opened, unless the user has unmuted it since (then it's theirs).
  releaseMic() {
    if (!this.micOpened) return;
    this.micOpened = false;
    if (this.engine.releaseMutedMic?.()) this.diag('mic-released');
  }

  // The PC's sound (without kScreen and the excluded apps), for a share that has no audio.
  // Returns the track once it is running; null meanwhile.
  pcAudioTrack() {
    if (this.pcAudio) return this.pcAudio.track;
    // A failed start is retried at most every 30 s (each try runs the app's capture helper).
    if (!this.pcAudioStarting && Date.now() - (this.pcTriedAt || 0) > 30_000) {
      this.pcTriedAt = Date.now();
      this.startPcAudio();
    }
    return null;
  }

  async startPcAudio() {
    this.pcAudioStarting = true;
    let ctx = null;
    try {
      ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
      await ctx.audioWorklet.addModule('/desktop-audio-worklet.js');
      const node = new AudioWorkletNode(ctx, 'kscreen-pcm-player', { numberOfInputs: 0, outputChannelCount: [2], processorOptions: { channels: 2 } });
      const dest = ctx.createMediaStreamDestination();
      dest.channelCount = 2;
      node.connect(dest);
      const format = await this.bridge.pcAudio.start({
        data: (chunk) => {
          const copy = new Uint8Array(chunk.byteLength);
          copy.set(chunk);
          node.port.postMessage(copy.buffer, [copy.buffer]);
        },
        ended: () => this.diag('pc-audio-ended')
      });
      if (!format || !this.recorder) throw new Error(format ? 'replay parado' : 'captura do som do PC indisponível');
      await ctx.resume();
      this.pcAudio = { ctx, track: dest.stream.getAudioTracks()[0] };
      this.pcTriedAt = 0; // the 30 s wait is only for failed starts
      this.diag('pc-audio-start');
      this.recorder.syncAudio();
    } catch (err) {
      this.bridge.pcAudio.stop();
      ctx?.close().catch(() => {});
      this.diag('pc-audio-error', { message: err.message });
    } finally {
      this.pcAudioStarting = false;
    }
  }

  stopPcAudio() {
    const pc = this.pcAudio;
    if (!pc) return;
    this.pcAudio = null;
    this.bridge.pcAudio.stop();
    pc.track.stop();
    pc.ctx.close().catch(() => {});
  }

  showClip(path) {
    this.bridge.showClip?.(path);
  }
}

// One running buffer: encoders + the GOP ring. Thrown away whole when the share stops or changes.
export class Recorder {
  constructor(owner, track) {
    this.owner = owner;
    this.source = track;
    const s = track.getSettings();
    this.sourceSize = { width: s.width, height: s.height };
    this.pendingSize = null;
    this.shareFps = owner.engine.shareSettings?.fps || 30;
    this.keepUs = owner.settings.seconds * 1e6;
    this.closed = false;
    this.ready = false;
    this.gops = [];            // [{ t, samples: [{ t, key, data }], bytes }]
    // One track per sound source, apart in the MP4 (screen first: players that play one pick it).
    this.audioTracks = { screen: null, mic: null, room: null };
    this.bytes = 0;
    this.lastVideoT = 0;
    this.stats = { frames: 0, skipped: 0, dropped: 0 };
  }

  async start() {
    const { width: sw = 1920, height: sh = 1080 } = this.source.getSettings();
    let width = even(sw);
    let height = even(sh);
    let fps = this.shareFps;
    let bitrate = Math.min(targetBitrate(width, height, fps), MAX_VIDEO_BITRATE);
    const pick = async (base) => {
      for (const codec of H264_CODECS) {
        try {
          if ((await VideoEncoder.isConfigSupported({ ...base, codec })).supported) return { ...base, codec };
        } catch { /* try the next */ }
      }
      return null;
    };
    const common = { width, height, bitrateMode: 'variable', latencyMode: 'realtime', avc: { format: 'avc' } };
    let config = this.owner.forceSoftware ? null : await pick({ ...common, framerate: fps, bitrate, hardwareAcceleration: 'prefer-hardware' });
    this.software = false;
    if (!config) {
      // No hardware encoder (Linux without VA-API, NVIDIA on Linux, a Flatpak whose drivers
      // don't match the GPU) or it broke: the processor, at up to 720p30 and a lower bitrate,
      // and the user is told what would enable the GPU.
      ({ width, height } = fitWithin(width, height, SOFTWARE_MAX));
      fps = Math.min(fps, SOFTWARE_MAX.fps);
      bitrate = Math.min(targetBitrate(width, height, fps), SOFTWARE_MAX_BITRATE);
      const soft = { ...common, width, height, framerate: fps, bitrate, hardwareAcceleration: 'prefer-software' };
      config = await pick(soft);
      if (!config) throw new Error('nenhum encoder H.264 disponível nesta resolução.');
      this.software = true;
      if (!this.owner.softwareWarned) {
        this.owner.softwareWarned = true;
        // Short: what to install is on the settings page, for this distro and GPU.
        this.owner.toast('Instant Replay gravando pelo processador (até 720p30). Veja em Configurações → Transmissão como gravar pela placa.', 7000);
      }
    }
    if (this.closed) return;
    this.maxFps = this.software ? 30 : Infinity;
    this.intervalUs = 1e6 / fps;
    this.video = { width, height, bitrate, description: null };
    this.maxBytes = bufferCap(bitrate, this.keepUs / 1e6);
    this.videoEncoder = new VideoEncoder({
      output: (chunk, meta) => this.onVideo(chunk, meta),
      error: (err) => this.encoderFailed(err)
    });
    this.videoEncoder.configure(config);
    this.videoClone = this.source.clone();
    this.videoReader = new MediaStreamTrackProcessor({ track: this.videoClone, maxBufferSize: 2 }).readable.getReader();
    this.pumpVideo().catch((err) => this.owner.recorderFailed(this, `erro na leitura da captura (${err.message})`));
    this.syncAudio();
    this.ready = true;
    this.owner.diag('start', { codec: config.codec, software: this.software, width, height, fps, kbps: Math.round(bitrate / 1000), seconds: this.keepUs / 1e6, maxMB: Math.round(this.maxBytes / 1048576), screenAudio: !!this.audioTracks.screen, mic: !!this.audioTracks.mic, room: !!this.audioTracks.room });
  }

  // A GPU encoder that breaks while running (a driver that announced H.264 but can't keep it up)
  // gets one second chance on the processor; a broken processor encoder stops the replay.
  encoderFailed(err) {
    if (this.closed) return;
    const owner = this.owner;
    if (!this.software && !owner.forceSoftware && owner.recorder === this) {
      owner.forceSoftware = true;
      owner.diag('gpu-encoder-failed', { message: err?.message });
      owner.restart();
      return;
    }
    owner.recorderFailed(this, `erro no encoder de vídeo (${err?.message})`);
  }

  // A new clip length: the time window and the memory cap follow (the cap was the bug that kept
  // clips at the old length after raising it mid-share).
  setKeep(seconds) {
    this.keepUs = seconds * 1e6;
    if (this.video) this.maxBytes = bufferCap(this.video.bitrate, seconds);
  }

  setFps(fps) {
    this.shareFps = fps;
    this.intervalUs = 1e6 / Math.min(fps, this.maxFps || Infinity);
  }

  // Picks each audio track's source, once a second and on every settings change:
  //  - screen: the share's own sound; with "all PC sound" it is recorded even when the share's
  //    audio is off, and when the share has none, the app captures the PC for the replay alone;
  //  - mic: the voice as the room hears it, joining whenever it is opened (often after going
  //    live); with "even muted" it is opened muted if needed and recorded while muted;
  //  - room: the others' voices as you hear them (optional).
  syncAudio() {
    if (this.closed) return;
    const owner = this.owner;
    const s = owner.settings;
    const share = owner.engine.localStream?.getAudioTracks()[0] || null;
    const pcAll = !!s.pcAudio && owner.pcAudioAvailable;
    // "All PC sound" means the apps left out of the share too: then the replay captures the PC
    // by itself (still without kScreen, so no room voices). The share's own track only does when
    // nothing is excluded.
    const shareHasAll = !!share && !(s.excludedApps > 0);
    const screen = pcAll ? (shareHasAll ? share : owner.pcAudioTrack()) : share;
    const wantMic = s.mic !== false;
    if (wantMic && s.micAlways && !owner.engine.micStream) owner.openMicMuted();
    const mic = wantMic ? owner.engine.micStream?.getAudioTracks()[0] || null : null;
    const micForce = wantMic && !!s.micAlways;
    let room = null;
    if (s.voices) {
      try { room = owner.roomVoices() || null; } catch { room = null; }
    }
    // "Tudo junto": every source summed live into the first track (saving stays a plain copy, no
    // re-encoding). With a single source there is nothing to mix.
    const parts = [
      screen && { source: screen, force: pcAll },
      mic && { source: mic, force: micForce },
      room && { source: room, force: true }
    ].filter(Boolean);
    if (s.micMode === 'mixed' && parts.length > 1) {
      if (!this.mixer?.matches(parts)) {
        this.mixer?.close();
        this.mixer = new AudioMixer(parts);
      }
      this.useAudio('screen', this.mixer.track, true, 'mix');
      this.useAudio('mic', null, false);
      this.useAudio('room', null, false);
      return;
    }
    this.useAudio('screen', screen, pcAll);
    this.useAudio('mic', mic, micForce);
    this.useAudio('room', room, true);
    if (this.mixer) {
      this.mixer.close();
      this.mixer = null;
    }
  }

  // Whether a source feeds the clip, directly or through the mixer.
  usesTrack(track) {
    return Object.values(this.audioTracks).some(t => t?.source === track) || !!this.mixer?.parts.some(p => p.source === track);
  }

  useAudio(kind, source, force, name = null) {
    const current = this.audioTracks[kind];
    if (current && current.source === source && current.force === force) return;
    const live = !!source && source.readyState === 'live';
    if (current) {
      // A new source for the same track (mode or option changed): the audio already in the
      // buffer moves over to it when the formats match (the hole between them is filled with
      // silence), so the clip doesn't go quiet up to the change. Otherwise it is dropped.
      current.close({ keepSamples: live });
      if (!live) this.bytes -= current.bytes;
      this.audioTracks[kind] = null;
    }
    if (live) {
      const own = source === this.owner.pcAudio?.track;
      this.audioTracks[kind] = new AudioTrackRecorder(this, kind, source, { force, name: name || (own ? 'pc' : kind), inherit: current });
      this.audioTracks[kind].start();
    }
  }

  async pumpVideo() {
    let next = -Infinity;
    let lastKey = -Infinity;
    while (!this.closed) {
      const { value: frame, done } = await this.videoReader.read();
      if (done || this.closed) { frame?.close(); break; }
      // The clone follows the share's own on/off: a paused share (game not in front) records
      // black here too, never what is behind the game.
      if (this.videoClone.enabled !== this.source.enabled) this.videoClone.enabled = this.source.enabled;
      this.stats.frames++;
      // The clock of the whole clip: this page's clock at the first frame, then the capture's
      // own spacing (steady even when this loop runs late).
      this.videoOffset ??= nowUs() - frame.timestamp;
      const t = frame.timestamp;
      const intervalUs = this.intervalUs;
      // FPS cap that tolerates jittery captures (a strict gap check dropped good frames).
      if (t < next - intervalUs * 0.5) { this.stats.skipped++; frame.close(); continue; }
      if (this.videoEncoder.state !== 'configured' || this.videoEncoder.encodeQueueSize > MAX_ENCODE_QUEUE) { this.stats.dropped++; frame.close(); continue; }
      next = Math.max(next + intervalUs, t);
      const keyFrame = t - lastKey >= GOP_US;
      if (keyFrame) lastKey = t;
      try {
        this.videoEncoder.encode(frame, { keyFrame });
      } finally {
        frame.close();
      }
    }
  }

  onVideo(chunk, meta) {
    if (this.closed) return;
    if (meta?.decoderConfig?.description) this.video.description = meta.decoderConfig.description;
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    const sample = { t: chunk.timestamp + this.videoOffset, key: chunk.type === 'key', data };
    if (sample.key) this.gops.push({ t: sample.t, samples: [sample], bytes: data.byteLength });
    else if (this.gops.length) {
      const gop = this.gops[this.gops.length - 1];
      gop.samples.push(sample);
      gop.bytes += data.byteLength;
    } else return; // nothing before the first keyframe
    this.bytes += data.byteLength;
    this.lastVideoT = sample.t;
    this.trim();
  }

  // Drops the oldest GOPs once the next one alone covers the configured length, or when the
  // buffer goes over its memory cap; audio older than the oldest GOP goes with them.
  trim() {
    const newest = this.lastVideoT;
    while (this.gops.length > 1 && (this.gops[1].t <= newest - this.keepUs || this.bytes > this.maxBytes)) {
      this.bytes -= this.gops.shift().bytes;
    }
    const from = (this.gops[0]?.t ?? newest) - 500_000;
    for (const track of Object.values(this.audioTracks)) track?.trim(from);
  }

  // The last `seconds`, starting at the keyframe right before that point (so up to one GOP more).
  snapshot(seconds) {
    const from = this.lastVideoT - seconds * 1e6;
    let first = 0;
    for (let i = this.gops.length - 1; i >= 0; i--) {
      if (this.gops[i].t <= from) { first = i; break; }
    }
    const samples = this.gops.slice(first).flatMap(g => g.samples);
    const start = samples[0].t;
    const audios = [this.audioTracks.screen, this.audioTracks.mic, this.audioTracks.room]
      .map(track => track?.snapshot(start))
      .filter(Boolean);
    return {
      seconds: (this.lastVideoT - start) / 1e6,
      video: { ...this.video, samples },
      audios,
      levels: Object.fromEntries(Object.entries(this.audioTracks).filter(([, t]) => t).map(([k, t]) => [k, t.level()]))
    };
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    try { if (this.videoEncoder && this.videoEncoder.state !== 'closed') this.videoEncoder.close(); } catch { /* already closed */ }
    this.videoReader?.cancel().catch(() => {});
    this.videoClone?.stop();
    for (const track of Object.values(this.audioTracks)) track?.close();
    this.mixer?.close();
    this.mixer = null;
    // Drop the memory right away.
    this.gops = [];
    this.audioTracks = { screen: null, mic: null, room: null };
    this.bytes = 0;
    if (this.stats.frames) console.info('[replay] parado', this.stats);
  }
}

// MP4 track names (editors show them).
const TRACK_NAMES = { screen: 'Áudio da transmissão', pc: 'Som do PC', mic: 'Microfone', room: 'Vozes da sala', mix: 'Áudio (tudo junto)' };

// "Tudo junto": the sources summed into one track by a small WebAudio graph. Each input is its
// own clone, so muting follows the same rules as separate tracks (a muted mic is silent unless
// "record the mic even muted"), checked every 100 ms.
class AudioMixer {
  constructor(parts) {
    this.parts = parts.map(p => ({ ...p }));
    // 'interactive': the smallest buffers, so the mix lags its sources as little as possible.
    this.ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    const dest = this.ctx.createMediaStreamDestination();
    dest.channelCount = 2;
    for (const part of this.parts) {
      part.clone = part.source.clone();
      part.clone.enabled = part.force || part.source.enabled;
      // A mono mic is spread to both sides by WebAudio's up-mixing.
      this.ctx.createMediaStreamSource(new MediaStream([part.clone])).connect(dest);
    }
    this.track = dest.stream.getAudioTracks()[0];
    this.timer = setInterval(() => {
      for (const part of this.parts) {
        const on = part.force || part.source.enabled;
        if (part.clone.enabled !== on) part.clone.enabled = on;
      }
    }, 100);
    this.ctx.resume().catch(() => {});
  }

  matches(parts) {
    return parts.length === this.parts.length && parts.every((p, i) => p.source === this.parts[i].source && p.force === this.parts[i].force);
  }

  close() {
    clearInterval(this.timer);
    for (const part of this.parts) part.clone?.stop();
    this.track.stop();
    this.ctx.close().catch(() => {});
  }
}

// One audio source encoded into its own MP4 track. Audio problems never stop the video replay:
// that track is then just left out of the clip.
export class AudioTrackRecorder {
  constructor(recorder, kind, source, { force = false, name = null, inherit = null } = {}) {
    this.recorder = recorder;
    this.kind = kind;
    this.source = source;
    // Recorded even while the source is switched off (muted mic / share audio off), by choice.
    this.force = force;
    this.name = name || kind;
    this.inherit = inherit;   // the previous recorder of this track, until its audio is taken or dropped
    this.samples = [];        // [{ t, duration, data }]
    this.bytes = 0;
    this.info = null;
    this.closed = false;
    this.nextT = null;        // where the next block should start (shared clock, µs)
    this.filledUs = 0;        // silence inserted into holes (diagnostics)
    this.peak = 0;            // loudest input since the last level() (diagnostics)
    this.checked = 0;
  }

  start() {
    if (typeof AudioEncoder !== 'function') return;
    this.clone = this.source.clone();
    // A clone starts with the source's on/off (off for a muted mic): set ours right away.
    this.clone.enabled = this.force || this.source.enabled;
    this.reader = new MediaStreamTrackProcessor({ track: this.clone }).readable.getReader();
    this.secAt = performance.now();
    this.secPeak = 0;
    this.timeline = [];       // last ~2 min, one entry per second: [source on (1/0), peak]
    this.pump().catch((err) => console.warn(`[replay] áudio (${this.kind}) parou:`, err));
  }

  async pump() {
    while (!this.closed) {
      const { value: data, done } = await this.reader.read();
      if (done || this.closed) { data?.close(); break; }
      try {
        // Muted mic / share audio switched off: the clone goes silent with it, unless the user
        // asked to record that source anyway.
        const on = this.force || this.source.enabled;
        if (this.clone.enabled !== on) this.clone.enabled = on;
        if (!this.encoder) await this.open(data);
        if (this.closed) break;
        this.offset ??= nowUs() - data.timestamp;
        if ((this.checked++ & 7) === 0) this.measure(data);
        if (performance.now() - this.secAt >= 1000) {
          this.timeline.push([this.source.enabled ? 1 : 0, Math.round(this.secPeak * 100) / 100]);
          if (this.timeline.length > 130) this.timeline.shift();
          this.secAt = performance.now();
          this.secPeak = 0;
        }
        this.feed(data);
      } finally {
        data.close();
      }
    }
  }

  // Encodes one block, first filling any hole since the previous one with silence: the muxer
  // lays audio out back to back, so a hole would pull everything after it ahead of the video.
  feed(data) {
    const encoder = this.encoder;
    if (encoder?.state !== 'configured') return;
    const t = data.timestamp + this.offset;
    if (this.nextT == null && this.inherit) this.nextT = this.inheritEnd();
    if (this.nextT != null) {
      const gap = t - this.nextT;
      if (gap > GAP_FILL_MIN_US && gap <= GAP_FILL_MAX_US) this.fillSilence(this.nextT, t, data);
    }
    // Only a stuck encoder lets the queue grow this far: skip the block; the next one fills it.
    if (encoder.encodeQueueSize >= MAX_AUDIO_QUEUE) return;
    encoder.encode(data);
    this.nextT = t + (data.duration || (data.numberOfFrames / data.sampleRate) * 1e6);
  }

  // Where the inherited audio ends, when it can continue into this track (same format).
  inheritEnd() {
    const prev = this.inherit;
    const a = prev?.info;
    const b = this.info;
    const last = prev?.samples[prev.samples.length - 1];
    if (!last || !a || !b || a.codec !== b.codec || a.sampleRate !== b.sampleRate || a.channels !== b.channels) return null;
    return last.t + (last.duration || (a.codec === 'aac' ? 1024 : 960) / a.sampleRate * 1e6);
  }

  fillSilence(from, to, like) {
    const rate = like.sampleRate;
    const channels = this.info.channels;
    const block = Math.round(rate / 50); // 20 ms
    let t = from;
    while (to - t >= 1e6 / rate) {
      const frames = Math.min(block, Math.floor((to - t) * rate / 1e6));
      if (frames <= 0) break;
      const silence = new AudioData({
        format: 'f32-planar',
        sampleRate: rate,
        numberOfFrames: frames,
        numberOfChannels: channels,
        timestamp: Math.round(t - this.offset),
        data: new Float32Array(frames * channels)
      });
      try { this.encoder.encode(silence); } finally { silence.close(); }
      t += frames * 1e6 / rate;
    }
    this.filledUs += t - from;
  }

  // Peak of one channel of every 8th block: enough to tell "silent" from "has sound".
  measure(data) {
    try {
      const opts = { planeIndex: 0, format: 'f32-planar' };
      const values = new Float32Array(data.allocationSize(opts) / 4);
      data.copyTo(values, opts);
      for (let i = 0; i < values.length; i += 4) {
        const v = Math.abs(values[i]);
        if (v > this.peak) this.peak = v;
        if (v > this.secPeak) this.secPeak = v;
      }
    } catch { /* format not convertible: skip */ }
  }

  level() {
    const peak = Math.round(this.peak * 1000) / 1000;
    this.peak = 0;
    // "on:peak" per second, oldest first: tells muted-and-silent apart from muted-but-recorded.
    const timeline = (this.timeline || []).slice(-40).map(([on, p]) => `${on}:${p}`).join(' ');
    return { peak, enabled: this.source.enabled, forced: this.force, codec: this.info?.codec || null, source: this.source.label || null, filledMs: Math.round(this.filledUs / 1000), timeline };
  }

  async open(first) {
    const sampleRate = first.sampleRate;
    const numberOfChannels = Math.min(2, first.numberOfChannels);
    let config = null;
    for (const codec of ['mp4a.40.2', 'opus']) {
      const c = { codec, sampleRate, numberOfChannels, bitrate: AUDIO_BITRATE };
      try {
        if ((await AudioEncoder.isConfigSupported(c)).supported) { config = c; break; }
      } catch { /* next */ }
    }
    if (!config || this.closed) {
      this.encoder = { state: 'closed' }; // no audio encoder: this track stays out of the clip
      return;
    }
    this.info = { name: TRACK_NAMES[this.name] || TRACK_NAMES[this.kind], codec: config.codec === 'opus' ? 'opus' : 'aac', sampleRate, channels: numberOfChannels, bitrate: AUDIO_BITRATE, description: null };
    this.encoder = new AudioEncoder({
      output: (chunk, meta) => {
        if (this.closed) return;
        if (meta?.decoderConfig?.description) this.info.description = meta.decoderConfig.description;
        if (this.inherit) this.takeInherited();
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        this.samples.push({ t: chunk.timestamp + this.offset, duration: chunk.duration || 0, data });
        this.bytes += data.byteLength;
        this.recorder.bytes += data.byteLength;
      },
      error: (err) => {
        console.warn(`[replay] encoder de áudio (${this.kind}) parou:`, err);
        this.info = null;
      }
    });
    this.encoder.configure(config);
  }

  // Keeps the previous recorder's audio if it decodes with this track's settings (same codec,
  // rate, channels and decoder description); drops it otherwise.
  takeInherited() {
    const prev = this.inherit;
    this.inherit = null;
    const a = prev.info;
    const b = this.info;
    const same = !!a && !!b && a.codec === b.codec && a.sampleRate === b.sampleRate && a.channels === b.channels && sameBytes(a.description, b.description);
    if (same && prev.samples.length) {
      this.samples = prev.samples.concat(this.samples);
      this.bytes += prev.bytes;
      this.recorder.owner.diag('audio-kept', { track: this.kind, seconds: Math.round((prev.samples[prev.samples.length - 1].t - prev.samples[0].t) / 1e5) / 10 });
    } else {
      this.recorder.bytes -= prev.bytes;
    }
    prev.samples = [];
  }

  trim(from) {
    let drop = 0;
    let freed = 0;
    while (drop < this.samples.length && this.samples[drop].t < from) freed += this.samples[drop++].data.byteLength;
    if (!drop) return;
    this.samples.splice(0, drop);
    this.bytes -= freed;
    this.recorder.bytes -= freed;
  }

  snapshot(start) {
    // AAC needs its decoder description; Opus can do without (defaults).
    if (!this.info || (!this.info.description && this.info.codec !== 'opus')) return null;
    const samples = this.samples.filter(a => a.t >= start);
    return samples.length ? { ...this.info, samples } : null;
  }

  close({ keepSamples = false } = {}) {
    if (this.closed) return;
    this.closed = true;
    try { if (this.encoder?.state && this.encoder.state !== 'closed' && typeof this.encoder.close === 'function') this.encoder.close(); } catch { /* already closed */ }
    this.reader?.cancel().catch(() => {});
    this.clone?.stop();
    if (this.inherit) {
      this.recorder.bytes -= this.inherit.bytes;
      this.inherit.samples = [];
      this.inherit = null;
    }
    // keepSamples: the next recorder of this track may take them (see takeInherited).
    if (!keepSamples) this.samples = [];
  }
}

export function sameBytes(x, y) {
  if (!x && !y) return true;
  if (!x || !y || x.byteLength !== y.byteLength) return false;
  const a = x instanceof ArrayBuffer ? new Uint8Array(x) : new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
  const b = y instanceof ArrayBuffer ? new Uint8Array(y) : new Uint8Array(y.buffer, y.byteOffset, y.byteLength);
  return a.every((v, i) => v === b[i]);
}
