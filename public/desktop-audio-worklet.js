// kScreen desktop app: plays interleaved s16 PCM (from the app's echo-free system-audio capture)
// into an AudioWorklet so it becomes a normal MediaStreamTrack for WebRTC.
// Small jitter buffer (~50 ms); drops the backlog if it ever grows, so latency never creeps up.
class PcmPlayer extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.channels = options.processorOptions?.channels || 2;
    this.capacity = sampleRate; // 1 s
    this.buffers = Array.from({ length: this.channels }, () => new Float32Array(this.capacity));
    this.read = 0;
    this.write = 0;
    this.size = 0;
    this.primed = false;
    this.prebuffer = Math.round(sampleRate * 0.05);
    this.maxBuffered = Math.round(sampleRate * 0.25);
    this.port.onmessage = (e) => this.push(new Int16Array(e.data));
  }

  push(samples) {
    const frames = Math.floor(samples.length / this.channels);
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < this.channels; c++) this.buffers[c][this.write] = samples[i * this.channels + c] / 32768;
      this.write = (this.write + 1) % this.capacity;
    }
    this.size = Math.min(this.capacity, this.size + frames);
    if (this.size > this.maxBuffered) {
      // Fell behind (tab hiccup): skip ahead to the prebuffer target.
      const drop = this.size - this.prebuffer;
      this.read = (this.read + drop) % this.capacity;
      this.size -= drop;
    }
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const frames = out[0].length;
    if (!this.primed) {
      if (this.size < this.prebuffer) return true; // outputs stay silent
      this.primed = true;
    }
    if (this.size < frames) {
      this.primed = false; // underrun: wait for a small cushion again instead of crackling
      return true;
    }
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < out.length; c++) out[c][i] = this.buffers[Math.min(c, this.channels - 1)][this.read];
      this.read = (this.read + 1) % this.capacity;
    }
    this.size -= frames;
    return true;
  }
}

registerProcessor('kscreen-pcm-player', PcmPlayer);
