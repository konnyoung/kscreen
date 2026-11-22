// The muxer with real H.264 + AAC made by ffmpeg (the codecs of the Windows app), checked by
// ffprobe/ffmpeg: the file must decode cleanly and keep its timing. Skipped without ffmpeg.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildMp4 } from '../src/mp4-mux.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kscreen-mux-'));

// ---- H.264 Annex B -> WebCodecs "avc" samples (length-prefixed) + avcC ---------------------------

function nalUnits(bytes) {
  const units = [];
  let i = 0;
  let start = -1;
  while (i + 3 <= bytes.length) {
    const three = bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 1;
    const four = i + 4 <= bytes.length && bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 0 && bytes[i + 3] === 1;
    if (three || four) {
      if (start >= 0) units.push(bytes.subarray(start, i));
      i += four ? 4 : 3;
      start = i;
    } else i++;
  }
  if (start >= 0) units.push(bytes.subarray(start));
  return units;
}

function h264Samples(file, fps) {
  const units = nalUnits(fs.readFileSync(file));
  let sps = null;
  let pps = null;
  const frames = [];
  let current = null;
  for (const nal of units) {
    const type = nal[0] & 0x1f;
    if (type === 7) { sps ??= nal; continue; }
    if (type === 8) { pps ??= nal; continue; }
    if (type !== 1 && type !== 5) continue; // SEI, AUD...
    // A slice with first_mb_in_slice = 0 (ue(v) "1": top bit set) starts a new picture.
    if (!current || nal[1] & 0x80) { current = { nals: [], key: false }; frames.push(current); }
    if (type === 5) current.key = true;
    current.nals.push(nal);
  }
  const avcC = Uint8Array.from([1, sps[1], sps[2], sps[3], 0xff, 0xe1, sps.length >> 8, sps.length & 0xff, ...sps, 1, pps.length >> 8, pps.length & 0xff, ...pps]);
  const samples = frames.filter(f => f.nals.length).map((f, i) => {
    const size = f.nals.reduce((n, u) => n + 4 + u.length, 0);
    const data = new Uint8Array(size);
    let at = 0;
    for (const u of f.nals) {
      new DataView(data.buffer).setUint32(at, u.length);
      data.set(u, at + 4);
      at += 4 + u.length;
    }
    return { t: Math.round(i * 1e6 / fps), key: f.key, data };
  });
  return { description: avcC, samples };
}

// ---- AAC ADTS -> raw frames + AudioSpecificConfig ------------------------------------------------

function aacSamples(file) {
  const b = fs.readFileSync(file);
  const samples = [];
  let asc = null;
  let rate = 48000;
  for (let i = 0; i + 7 <= b.length;) {
    assert.equal(b[i], 0xff, 'ADTS sync');
    const protectionAbsent = b[i + 1] & 1;
    const profile = ((b[i + 2] >> 6) & 3) + 1;
    const srIndex = (b[i + 2] >> 2) & 0xf;
    const channels = ((b[i + 2] & 1) << 2) | (b[i + 3] >> 6);
    const length = ((b[i + 3] & 3) << 11) | (b[i + 4] << 3) | (b[i + 5] >> 5);
    const header = protectionAbsent ? 7 : 9;
    rate = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000][srIndex];
    asc ??= Uint8Array.of((profile << 3) | (srIndex >> 1), ((srIndex & 1) << 7) | (channels << 3));
    samples.push({ data: Uint8Array.from(b.subarray(i + header, i + length)) });
    i += length;
  }
  const dur = 1024 / rate * 1e6;
  samples.forEach((s, i) => { s.t = i * dur; s.duration = dur; });
  return { asc, rate, samples };
}

function ffprobe(file, args) {
  return JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-of', 'json', ...args, file], { encoding: 'utf8' }));
}

function write(name, mp4) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, Buffer.concat([mp4.header, ...mp4.parts]));
  return file;
}

function decodeErrors(file) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-map', '0', '-fps_mode', 'passthrough', '-f', 'null', '-'], { encoding: 'utf8' });
  return r.stderr.split('\n').filter(l => l.trim() && !l.startsWith('[null @')).join('\n');
}

let media = null;
function makeMedia() {
  if (media) return media;
  const h264 = path.join(dir, 'v.h264');
  const adts = path.join(dir, 'a.aac');
  // libx264 when the ffmpeg build has it, else OpenH264 (Fedora's): no B-frames either way, like
  // a realtime WebCodecs encoder.
  const x264 = execFileSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' }).includes('libx264');
  const codec = x264 ? ['-c:v', 'libx264', '-profile:v', 'high', '-bf', '0'] : ['-c:v', 'libopenh264'];
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-t', '6',
    ...codec, '-g', '60', '-b:v', '2M', '-pix_fmt', 'yuv420p', '-f', 'h264', h264]);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000', '-ac', '2', '-t', '6',
    '-c:a', 'aac', '-b:a', '160k', '-f', 'adts', adts]);
  media = { video: h264Samples(h264, 30), audio: aacSamples(adts) };
  return media;
}

function clip({ audioFrom = 0, dropAudio = null } = {}) {
  const { video, audio } = makeMedia();
  const t0 = 3_000_000;
  let samples = audio.samples.map(s => ({ ...s, t: s.t + t0 + audioFrom }));
  if (dropAudio) samples = samples.filter((_, i) => i < dropAudio[0] || i >= dropAudio[1]);
  return buildMp4({
    video: { width: 640, height: 360, description: video.description, samples: video.samples.map(s => ({ ...s, t: s.t + t0 })) },
    audios: [{ name: 'Áudio (tudo junto)', codec: 'aac', sampleRate: audio.rate, channels: 2, bitrate: 160_000, description: audio.asc, samples }]
  });
}

test('real H.264 + AAC: decodes cleanly with the right streams and length', { skip: !hasFfmpeg && 'ffmpeg not found' }, () => {
  const file = write('plain.mp4', clip());
  assert.equal(decodeErrors(file), '');
  const info = ffprobe(file, ['-show_streams', '-show_format']);
  const [v, a] = info.streams;
  assert.equal(v.codec_name, 'h264');
  assert.equal(v.width, 640);
  assert.equal(Number(v.nb_frames), 180);
  assert.equal(a.codec_name, 'aac');
  assert.equal(a.channels, 2);
  assert.equal(a.tags.handler_name, 'Áudio (tudo junto)');
  assert.ok(Math.abs(Number(info.format.duration) - 6) < 0.1, `duration ${info.format.duration}`);
});

test('real AAC starting late: delayed by the edit list, not shifted', { skip: !hasFfmpeg && 'ffmpeg not found' }, () => {
  const file = write('late.mp4', clip({ audioFrom: 500_000 }));
  assert.equal(decodeErrors(file), '');
  const pkts = ffprobe(file, ['-select_streams', 'a:0', '-show_entries', 'packet=pts_time']).packets;
  assert.ok(Math.abs(Number(pkts[0].pts_time) - 0.5) < 0.03, `first audio at ${pkts[0].pts_time}`);
});

test('real AAC with a hole: audio after it plays at its own time', { skip: !hasFfmpeg && 'ffmpeg not found' }, () => {
  // Blocks 100..119 missing (~427 ms): block 120 must still play at 120 * 1024 / 48000 s.
  const file = write('hole.mp4', clip({ dropAudio: [100, 120] }));
  assert.equal(decodeErrors(file), '');
  const pkts = ffprobe(file, ['-select_streams', 'a:0', '-show_entries', 'packet=pts_time']).packets;
  const expected = 120 * 1024 / 48000;
  assert.ok(Math.abs(Number(pkts[100].pts_time) - expected) < 0.005, `block after the hole at ${pkts[100].pts_time}, expected ${expected}`);
});

test('real H.264: keyframes are seekable sync samples', { skip: !hasFfmpeg && 'ffmpeg not found' }, () => {
  const file = write('keys.mp4', clip());
  const pkts = ffprobe(file, ['-select_streams', 'v:0', '-show_entries', 'packet=pts_time,flags']).packets;
  const keys = pkts.filter(p => p.flags.startsWith('K')).map(p => Math.round(Number(p.pts_time)));
  assert.deepEqual(keys, [0, 2, 4]);
});
