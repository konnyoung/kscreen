// Noise suppression for the microphone: RNNoise (src/vendor/rnnoise) inside an AudioWorklet.
//
// RNNoise works on 10 ms frames (480 samples at 48 kHz, int16 scale). Audio arrives in 128-sample
// blocks, so input is queued until a frame is full and the frame is cleaned. Output is two frames
// behind (20 ms): one for the frame itself, one of look-ahead for the gate below.
//
// Three stages, all driven by "strength" (0..1, the slider):
// 1. High-pass at 80 Hz: rumble, desk thumps and mic handling never reach RNNoise.
// 2. RNNoise, mixed with the original of the SAME frame (aligned, so no hollow/phasey sound).
//    The original's share falls 5 dB per 10% of the slider: -40 dB at the default 80%.
// 3. Voice gate: RNNoise leaves a hiss and lets keyboard clicks through between words. Frames
//    it doesn't think are speech are pulled down by up to 40 dB * strength. It opens fast (5 ms)
//    and looks one frame ahead, so the first syllable isn't clipped; it holds 250 ms after the
//    last speech frame and closes slowly (80 ms), so word endings and breaths stay natural.
const FRAME = 480;
const RATE = 48000;
const dryShare = (strength) => (strength >= 1 ? 0 : Math.pow(10, -2.5 * strength)); // -50 dB * s
const GATE_OPEN = 0.35;         // RNNoise speech probability that opens the gate
const GATE_HOLD_FRAMES = 25;    // 250 ms
const GATE_FLOOR_DB = 40;       // attenuation in pauses at full strength
const ATTACK = 1 - Math.exp(-1 / (0.005 * RATE));
const RELEASE = 1 - Math.exp(-1 / (0.08 * RATE));

// 2nd-order Butterworth high-pass (RBJ cookbook) at 80 Hz, 48 kHz.
const HP = (() => {
  const w = 2 * Math.PI * 80 / RATE;
  const alpha = Math.sin(w) / (2 * Math.SQRT1_2);
  const cos = Math.cos(w);
  const a0 = 1 + alpha;
  return { b0: (1 + cos) / 2 / a0, b1: -(1 + cos) / a0, b2: (1 + cos) / 2 / a0, a1: -2 * cos / a0, a2: (1 - alpha) / a0 };
})();

// Voice activity (the "speaking" ring), like Discord: RNNoise also says, per frame, how likely
// it is that the frame is speech - independent of how loud it is, so quiet voices and quiet mics
// count. A frame is voice when that probability is high AND the frame stands out from this mic's
// own background noise (steady fans can fool the probability alone), and isn't digital silence.
// The background is the quiet end (10th percentile) of the last 3 s, so it follows each person's
// room and mic - there is no fixed loudness line.
// Starts after 2 voice frames (20 ms, ignores clicks) and ends after 300 ms without voice
// (no flicker between words).
const VAD_ON = 0.6;
const VAD_START_FRAMES = 2;
const VAD_HOLD_FRAMES = 30;
const SILENCE_DB = -70;
const ABOVE_FLOOR_DB = 6;
const FLOOR_FRAMES = 300; // 3 s of 10 ms frames

class KscreenNoiseSuppressor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { wasm, strength = 1 } = options.processorOptions || {};
    this.strength = strength;
    this.port.onmessage = (e) => {
      if (typeof e.data?.strength === 'number') this.strength = Math.max(0, Math.min(1, e.data.strength));
      if (e.data?.destroy && this.alive) {
        this.alive = false;
        this.ex.i(this.state); // rnnoise_destroy
      }
    };

    let memory = null;
    const instance = new WebAssembly.Instance(new WebAssembly.Module(wasm), {
      a: {
        // emscripten_resize_heap(requestedBytes)
        a: (requested) => {
          try {
            memory.grow(Math.ceil((requested - memory.buffer.byteLength) / 65536));
            return 1;
          } catch {
            return 0;
          }
        },
        // emscripten_memcpy_big(dest, src, count)
        b: (dest, src, count) => {
          new Uint8Array(memory.buffer).copyWithin(dest, src, src + count);
        }
      }
    });
    const ex = instance.exports;
    memory = ex.c;
    ex.d(); // static constructors
    this.ex = ex;
    this.memory = memory;
    this.state = ex.h(0); // rnnoise_create(default model)
    this.inPtr = ex.e(FRAME * 4);
    this.outPtr = ex.e(FRAME * 4);

    this.frame = new Float32Array(FRAME); // samples waiting to be cleaned
    this.frameFill = 0;
    // Cleaned audio waiting to be played. Two silent frames to start: frame k only leaves when
    // frame k+1 is done (look-ahead), so less than that would run dry between frames (clicks).
    this.out = new Float32Array(FRAME * 4);
    this.outRead = 0;
    this.outFill = FRAME * 2;
    this.pending = new Float32Array(FRAME); // cleaned frame waiting for the next one
    this.pendingVoice = false;
    this.hasPending = false;
    this.gateHold = 0;
    this.gateGain = 1;
    this.hp = { x1: 0, x2: 0, y1: 0, y2: 0 };
    this.alive = true;
    this.voiceRun = 0;
    this.quietRun = 0;
    this.speaking = false;
    this.levels = new Float32Array(FLOOR_FRAMES).fill(-100);
    this.levelIndex = 0;
    this.floor = -100;
  }

  detectVoice(probability) {
    let energy = 0;
    for (let i = 0; i < FRAME; i++) energy += this.frame[i] * this.frame[i];
    const db = 10 * Math.log10(energy / FRAME + 1e-12);
    this.levels[this.levelIndex] = db;
    this.levelIndex = (this.levelIndex + 1) % FLOOR_FRAMES;
    if (this.levelIndex % 10 === 0) {
      const sorted = Float32Array.from(this.levels).sort();
      this.floor = sorted[Math.floor(FLOOR_FRAMES * 0.1)];
    }
    if (probability >= VAD_ON && db > Math.max(SILENCE_DB, this.floor + ABOVE_FLOOR_DB)) {
      this.voiceRun++;
      this.quietRun = 0;
    } else {
      this.voiceRun = 0;
      this.quietRun++;
    }
    const speaking = this.speaking ? this.quietRun < VAD_HOLD_FRAMES : this.voiceRun >= VAD_START_FRAMES;
    if (speaking !== this.speaking) {
      this.speaking = speaking;
      this.port.postMessage({ speaking });
    }
  }

  heap() {
    // The views must be rebuilt if the wasm memory grew.
    if (this.heapBuffer !== this.memory.buffer) {
      this.heapBuffer = this.memory.buffer;
      this.heapF32 = new Float32Array(this.memory.buffer);
    }
    return this.heapF32;
  }

  processFrame() {
    const heap = this.heap();
    const inBase = this.inPtr >> 2;
    const outBase = this.outPtr >> 2;
    for (let i = 0; i < FRAME; i++) heap[inBase + i] = this.frame[i] * 32768;
    const voiceProbability = this.ex.j(this.state, this.outPtr, this.inPtr); // rnnoise_process_frame
    this.detectVoice(voiceProbability);
    const dry = dryShare(this.strength);
    const wet = 1 - dry;
    const voice = voiceProbability >= GATE_OPEN;
    // The previous frame leaves now, gated with what this frame says (look-ahead).
    if (this.hasPending) this.releasePending(this.pendingVoice || voice);
    for (let i = 0; i < FRAME; i++) this.pending[i] = (heap[outBase + i] / 32768) * wet + this.frame[i] * dry;
    this.pendingVoice = voice;
    this.hasPending = true;
  }

  releasePending(voice) {
    if (voice) this.gateHold = GATE_HOLD_FRAMES;
    else if (this.gateHold > 0) this.gateHold--;
    const floor = Math.pow(10, -GATE_FLOOR_DB * this.strength / 20);
    const target = this.gateHold > 0 ? 1 : floor;
    let g = this.gateGain;
    for (let i = 0; i < FRAME; i++) {
      g += (target - g) * (target > g ? ATTACK : RELEASE);
      this.pushOut(this.pending[i] * g);
    }
    this.gateGain = g;
  }

  highPass(x) {
    const f = this.hp;
    const y = HP.b0 * x + HP.b1 * f.x1 + HP.b2 * f.x2 - HP.a1 * f.y1 - HP.a2 * f.y2;
    f.x2 = f.x1; f.x1 = x;
    f.y2 = f.y1; f.y1 = y;
    return y;
  }

  pushOut(sample) {
    const size = this.out.length;
    this.out[(this.outRead + this.outFill) % size] = sample;
    this.outFill = Math.min(size, this.outFill + 1);
  }

  process(inputs, outputs) {
    if (!this.alive) return false;
    const input = inputs[0];
    const output = outputs[0];
    const n = output[0]?.length || 128;
    // Mono: the mic chain is mono already; mix down just in case.
    const a = input[0];
    const b = input[1];
    for (let i = 0; i < n; i++) {
      const sample = a ? (b ? (a[i] + b[i]) / 2 : a[i]) : 0;
      this.frame[this.frameFill++] = this.highPass(sample);
      if (this.frameFill === FRAME) {
        this.processFrame();
        this.frameFill = 0;
      }
    }
    const size = this.out.length;
    for (let i = 0; i < n; i++) {
      let sample = 0;
      if (this.outFill > 0) {
        sample = this.out[this.outRead];
        this.outRead = (this.outRead + 1) % size;
        this.outFill--;
      }
      for (const channel of output) channel[i] = sample;
    }
    return true;
  }
}

registerProcessor('kscreen-noise-suppressor', KscreenNoiseSuppressor);
