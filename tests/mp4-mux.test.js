// MP4 writer of the Instant Replay clips (src/mp4-mux.js): file layout, tables and timing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMp4, durations } from '../src/mp4-mux.js';

// ---- a tiny MP4 reader ------------------------------------------------------------------------

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf']);

function parse(bytes, start = 0, end = bytes.length) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const boxes = [];
  let at = start;
  while (at < end) {
    const size = view.getUint32(at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    assert.ok(size >= 8 && at + size <= end, `box ${type} at ${at} has a bad size ${size}`);
    const box = { type, start: at, size, body: bytes.subarray(at + 8, at + size) };
    if (CONTAINERS.has(type)) box.children = parse(bytes, at + 8, at + size);
    boxes.push(box);
    at += size;
  }
  assert.equal(at, end, 'boxes must fill their parent exactly');
  return boxes;
}

const find = (boxes, path) => {
  const [head, ...rest] = path.split('/');
  const box = boxes.find(b => b.type === head);
  return !box || !rest.length ? box : find(box.children || [], rest.join('/'));
};
const findAll = (boxes, type) => boxes.filter(b => b.type === type);
const u32s = (body, from) => {
  const v = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const out = [];
  for (let at = from; at + 4 <= body.byteLength; at += 4) out.push(v.getUint32(at));
  return out;
};

function table(trak, name) {
  const box = find(trak.children, `mdia/minf/stbl/${name}`);
  return box && u32s(box.body, 4); // after version + flags
}

function sttsDurations(trak) {
  const [count, ...runs] = table(trak, 'stts');
  const out = [];
  for (let i = 0; i < count; i++) for (let n = 0; n < runs[i * 2]; n++) out.push(runs[i * 2 + 1]);
  return out;
}

function file(mp4) {
  const out = new Uint8Array(mp4.size);
  out.set(mp4.header, 0);
  let at = mp4.header.byteLength;
  for (const part of mp4.parts) { out.set(part, at); at += part.byteLength; }
  assert.equal(at, mp4.size, 'size must match header + parts');
  return out;
}

// ---- synthetic clips --------------------------------------------------------------------------

let seed = 7;
const bytes = (n, tag) => {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) { seed = (seed * 1103515245 + 12345) >>> 0; b[i] = seed >>> 24; }
  b[0] = tag;
  return b;
};

function video({ frames = 90, frameUs = 33_333, gop = 30, t0 = 5_000_000 } = {}) {
  return {
    width: 1280,
    height: 720,
    bitrate: 6_000_000,
    description: Uint8Array.of(1, 0x64, 0, 0x28, 0xff, 0xe1, 0, 0),
    samples: Array.from({ length: frames }, (_, i) => ({ t: t0 + i * frameUs, key: i % gop === 0, data: bytes(200 + (i % 7) * 30, 0xa0) }))
  };
}

function aac({ from, count, name = 'Áudio da transmissão' }) {
  const dur = 1024 / 48000 * 1e6;
  return {
    name,
    codec: 'aac',
    sampleRate: 48000,
    channels: 2,
    bitrate: 160_000,
    description: Uint8Array.of(0x11, 0x90),
    samples: Array.from({ length: count }, (_, i) => ({ t: from + i * dur, duration: dur, data: bytes(40 + (i % 5), 0xb0) }))
  };
}

// ---- tests ------------------------------------------------------------------------------------

test('layout: ftyp, moov, then one mdat; sizes add up', () => {
  const mp4 = buildMp4({ video: video(), audios: [aac({ from: 5_000_000, count: 140 })] });
  const all = file(mp4);
  const top = parse(all);
  assert.deepEqual(top.map(b => b.type), ['ftyp', 'moov', 'mdat']);
  assert.equal(top[2].start, mp4.header.byteLength - 8, 'mdat starts right after the header');
  assert.equal(findAll(top[1].children, 'trak').length, 2);
});

test('every sample offset points at its own bytes', () => {
  const v = video();
  const a = aac({ from: 5_010_000, count: 140 });
  const all = file(buildMp4({ video: v, audios: [a] }));
  const traks = findAll(parse(all)[1].children, 'trak');
  for (const [trak, samples] of [[traks[0], v.samples], [traks[1], a.samples]]) {
    const [count, ...offsets] = table(trak, 'stco');
    const [, n, ...sizes] = table(trak, 'stsz'); // sample_size (0), count, sizes
    assert.equal(count, samples.length);
    assert.equal(n, samples.length);
    samples.forEach((s, i) => {
      assert.equal(sizes[i], s.data.byteLength);
      assert.deepEqual(all.subarray(offsets[i], offsets[i] + sizes[i]), s.data, `sample ${i}`);
    });
  }
});

test('mdat is interleaved by time', () => {
  const v = video({ frames: 30 });
  const a = aac({ from: 5_000_000, count: 47 });
  const all = file(buildMp4({ video: v, audios: [a] }));
  const traks = findAll(parse(all)[1].children, 'trak');
  const [, ...vOff] = table(traks[0], 'stco');
  const [, ...aOff] = table(traks[1], 'stco');
  const merged = [...vOff.map((o, i) => [o, v.samples[i].t]), ...aOff.map((o, i) => [o, a.samples[i].t])].sort((x, y) => x[0] - y[0]);
  for (let i = 1; i < merged.length; i++) assert.ok(merged[i][1] >= merged[i - 1][1], 'file order follows time');
});

test('keyframes go to stss (1-based)', () => {
  const all = file(buildMp4({ video: video({ frames: 90, gop: 30 }) }));
  const trak = findAll(parse(all)[1].children, 'trak')[0];
  const [count, ...keys] = table(trak, 'stss');
  assert.equal(count, 3);
  assert.deepEqual(keys, [1, 31, 61]);
});

test('video timing comes from the timestamps (90 kHz)', () => {
  const all = file(buildMp4({ video: video({ frames: 10, frameUs: 16_667 }) }));
  const trak = findAll(parse(all)[1].children, 'trak')[0];
  const durs = sttsDurations(trak);
  assert.equal(durs.length, 10);
  for (const d of durs) assert.ok(Math.abs(d - 1500) <= 1, `60 fps frame = 1500 ticks, got ${d}`);
});

test('audio starting after the video gets an edit list delay', () => {
  const all = file(buildMp4({ video: video(), audios: [aac({ from: 5_250_000, count: 100 })] }));
  const trak = findAll(parse(all)[1].children, 'trak')[1];
  const elst = find(trak.children, 'edts/elst');
  assert.ok(elst, 'edts/elst present');
  const [count, emptyDuration] = u32s(elst.body, 4);
  assert.equal(count, 2);
  assert.equal(emptyDuration, 250, '250 ms empty edit in the 1000 Hz movie timescale');
});

test('audio before the first video frame is cut', () => {
  const a = aac({ from: 4_500_000, count: 140 });
  const all = file(buildMp4({ video: video(), audios: [a] }));
  const trak = findAll(parse(all)[1].children, 'trak')[1];
  const kept = a.samples.filter(s => s.t >= 5_000_000).length;
  assert.equal(table(trak, 'stsz')[1], kept);
  // Only the sub-block offset of the first kept block is left as a delay (< one AAC block).
  const elst = find(trak.children, 'edts/elst');
  if (elst) assert.ok(u32s(elst.body, 4)[1] < 22, 'delay under one block');
});

test('tracks keep their order and names; empty audio tracks are left out', () => {
  const all = file(buildMp4({
    video: video(),
    audios: [aac({ from: 5_000_000, count: 50, name: 'Áudio (tudo junto)' }), { ...aac({ from: 0, count: 0 }), name: 'vazia' }, aac({ from: 5_000_000, count: 50, name: 'Vozes da sala' })]
  }));
  const traks = findAll(parse(all)[1].children, 'trak');
  assert.equal(traks.length, 3);
  const names = traks.slice(1).map(t => new TextDecoder().decode(find(t.children, 'mdia/hdlr').body.subarray(24)).replace(/\0$/, ''));
  assert.deepEqual(names, ['Áudio (tudo junto)', 'Vozes da sala']);
});

test('opus tracks get an Opus/dOps entry', () => {
  const opus = { ...aac({ from: 5_000_000, count: 50 }), codec: 'opus', description: null };
  const all = file(buildMp4({ video: video(), audios: [opus] }));
  const trak = findAll(parse(all)[1].children, 'trak')[1];
  const stsd = find(trak.children, 'mdia/minf/stbl/stsd');
  assert.equal(String.fromCharCode(...stsd.body.subarray(12, 16)), 'Opus');
});

test('a clip must start on a keyframe', () => {
  const v = video();
  v.samples = v.samples.slice(1);
  assert.throws(() => buildMp4({ video: v }), /keyframe/);
});

test('durations: chunk durations, holes stretched, video from timestamps', () => {
  const d = 1024 / 48000 * 1e6;
  const samples = [0, d, 2 * d, 2 * d + 500_000, 3 * d + 500_000].map(t => ({ t, duration: d }));
  const out = durations(samples, 48000);
  assert.deepEqual(out.slice(0, 2), [1024, 1024]);
  // The hole after the third block: that sample lasts until the next one, keeping sync.
  assert.equal(out[2], Math.round((2 * d + 500_000) * 48000 / 1e6) - Math.round(2 * d * 48000 / 1e6));
  assert.equal(out[3], 1024);
  assert.equal(out.reduce((a, b) => a + b, 0), Math.round((3 * d + 500_000) * 48000 / 1e6) + 1024 - 0);
  // Small jitter is not a hole.
  const jitter = durations([{ t: 0, duration: d }, { t: d + 2000, duration: d }], 48000);
  assert.equal(jitter[0], 1024);
  // Video (no durations): spacing of the timestamps, last one repeated.
  assert.deepEqual(durations([{ t: 0 }, { t: 33_333 }, { t: 66_667 }], 90000), [3000, 3000, 3000]);
});

test('audio after a hole stays where its timestamps say (no drift ahead of the video)', () => {
  const a = aac({ from: 5_000_000, count: 100 });
  // A 400 ms hole after block 49 (a source switch the recorder could not fill).
  a.samples = a.samples.map((s, i) => (i >= 50 ? { ...s, t: s.t + 400_000 } : s));
  const all = file(buildMp4({ video: video(), audios: [a] }));
  const trak = findAll(parse(all)[1].children, 'trak')[1];
  const durs = sttsDurations(trak);
  const startOf51 = durs.slice(0, 50).reduce((x, y) => x + y, 0);
  const expected = Math.round((a.samples[50].t - 5_000_000) * 48000 / 1e6);
  assert.ok(Math.abs(startOf51 - expected) <= 2, `block 50 plays at ${startOf51}, expected ${expected}`);
});
