// Minimal MP4 writer for Instant Replay clips: H.264 video (from WebCodecs, "avc" format, so the
// samples are already length-prefixed and the avcC comes as the decoder description) plus AAC or
// Opus audio. Nothing is re-encoded: the encoded chunks are copied into the file as they are.
//
// The whole clip is known up front (it comes from the in-memory buffer), so this writes a plain
// "fast start" file: ftyp, moov (all the tables), then one mdat with the samples interleaved by
// time. buildMp4 returns the header and the list of sample buffers in file order; the caller
// writes them one after another, never holding a second copy of the whole clip.

const te = new TextEncoder();

function box(type, ...parts) {
  const body = concat(parts);
  const out = new Uint8Array(8 + body.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, out.length);
  out.set(te.encode(type), 4);
  out.set(body, 8);
  return out;
}

function full(type, version, flags, ...parts) {
  return box(type, u8(version), u24(flags), ...parts);
}

function concat(parts) {
  const list = parts.flat(Infinity).filter(Boolean);
  const size = list.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of list) { out.set(p, at); at += p.length; }
  return out;
}

const u8 = (n) => Uint8Array.of(n & 0xff);
const u16 = (n) => Uint8Array.of((n >>> 8) & 0xff, n & 0xff);
const u24 = (n) => Uint8Array.of((n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
const u32 = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0); return b; };
const i32 = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, n); return b; };
const zeros = (n) => new Uint8Array(n);
// Decoder descriptions arrive as ArrayBuffer or any ArrayBufferView.
const bytesOf = (x) => (x instanceof ArrayBuffer ? new Uint8Array(x) : new Uint8Array(x.buffer, x.byteOffset, x.byteLength));
const MATRIX = [u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000)];
const MOVIE_TIMESCALE = 1000;
const VIDEO_TIMESCALE = 90000;

const toScale = (us, scale) => Math.round(us * scale / 1e6);

// Sample durations (in the track's timescale). Audio chunks carry their own duration; a hole
// after one (the recorder fills holes with silence, so only a leftover one) stretches that
// sample up to the next timestamp, so what follows stays in sync with the video instead of
// moving ahead. Video uses the timestamps; the last sample repeats the previous duration.
export function durations(samples, scale) {
  const out = [];
  for (let i = 0; i < samples.length; i++) {
    const next = samples[i + 1];
    const own = samples[i].duration ? toScale(samples[i].duration, scale) : 0;
    const gap = next ? toScale(next.t, scale) - toScale(samples[i].t, scale) : 0;
    let d;
    if (own) d = gap > own * 1.5 ? gap : own;
    else if (next) d = gap;
    else d = out.length ? out[out.length - 1] : toScale(1e6 / 30, scale);
    out.push(Math.max(1, d));
  }
  return out;
}

function stts(durs) {
  const runs = [];
  for (const d of durs) {
    const last = runs[runs.length - 1];
    if (last && last[1] === d) last[0]++;
    else runs.push([1, d]);
  }
  return full('stts', 0, 0, u32(runs.length), runs.map(([n, d]) => [u32(n), u32(d)]));
}

function stbl(entry, samples, durs, offsets, keyframes) {
  return box('stbl',
    full('stsd', 0, 0, u32(1), entry),
    stts(durs),
    keyframes ? full('stss', 0, 0, u32(keyframes.length), keyframes.map(i => u32(i + 1))) : null,
    // One sample per chunk: every sample has its own offset, so the mdat can interleave freely.
    full('stsc', 0, 0, u32(1), u32(1), u32(1), u32(1)),
    full('stsz', 0, 0, u32(0), u32(samples.length), samples.map(s => u32(s.data.byteLength))),
    full('stco', 0, 0, u32(offsets.length), offsets.map(o => u32(o))));
}

function avc1(v) {
  return box('avc1',
    zeros(6), u16(1),               // reserved, data_reference_index
    zeros(16),                      // pre_defined / reserved
    u16(v.width), u16(v.height),
    u32(0x00480000), u32(0x00480000), // 72 dpi
    u32(0), u16(1),                 // reserved, frame_count
    zeros(32),                      // compressorname
    u16(0x0018), u16(0xffff),       // depth, pre_defined
    box('avcC', bytesOf(v.description)));
}

// MPEG-4 descriptor with a one-byte length (our descriptors are always small).
const descriptor = (tag, ...parts) => { const body = concat(parts); return concat([u8(tag), u8(body.length), body]); };

function audioEntry(a) {
  const head = [zeros(6), u16(1), zeros(8), u16(a.channels), u16(16), zeros(4), u32(a.sampleRate * 65536)];
  if (a.codec === 'opus') {
    // dOps from the OpusHead the encoder gives as description (little-endian), or defaults.
    let preSkip = 0;
    let gain = 0;
    if (a.description && a.description.byteLength >= 19) {
      const opusHead = bytesOf(a.description);
      const d = new DataView(opusHead.buffer, opusHead.byteOffset, opusHead.byteLength);
      preSkip = d.getUint16(10, true);
      gain = d.getInt16(16, true);
    }
    return box('Opus', ...head, box('dOps', u8(0), u8(a.channels), u16(preSkip), u32(a.sampleRate), u16(gain & 0xffff), u8(0)));
  }
  const asc = bytesOf(a.description);
  const esds = full('esds', 0, 0,
    descriptor(0x03, u16(0), u8(0),
      descriptor(0x04, u8(0x40), u8(0x15), u24(0), u32(a.bitrate || 0), u32(a.bitrate || 0),
        descriptor(0x05, asc)),
      descriptor(0x06, u8(0x02))));
  return box('mp4a', ...head, esds);
}

function trak({ id, kind, name, entry, samples, scale, offsets, keyframes, width = 0, height = 0, delayUs = 0, movieDuration }) {
  const durs = durations(samples, scale);
  const mediaDuration = durs.reduce((a, b) => a + b, 0);
  const trackDuration = Math.round(mediaDuration * MOVIE_TIMESCALE / scale);
  const delay = toScale(delayUs, MOVIE_TIMESCALE);
  // Audio that starts after the video: an empty edit keeps it in sync.
  const edts = delay > 0
    ? box('edts', full('elst', 0, 0, u32(2), u32(delay), i32(-1), u32(0x00010000), u32(trackDuration), i32(0), u32(0x00010000)))
    : null;
  return box('trak',
    full('tkhd', 0, 3, u32(0), u32(0), u32(id), u32(0), u32(Math.min(movieDuration, delay + trackDuration)), zeros(8),
      u16(0), u16(kind === 'audio' ? 1 : 0), u16(kind === 'audio' ? 0x0100 : 0), u16(0), MATRIX, u32(width * 65536), u32(height * 65536)),
    edts,
    box('mdia',
      full('mdhd', 0, 0, u32(0), u32(0), u32(scale), u32(mediaDuration), u16(0x55c4), u16(0)), // language "und"
      full('hdlr', 0, 0, u32(0), te.encode(kind === 'audio' ? 'soun' : 'vide'), zeros(12), te.encode(`${name || (kind === 'audio' ? 'kScreen audio' : 'kScreen video')}\0`)),
      box('minf',
        kind === 'audio' ? full('smhd', 0, 0, u16(0), u16(0)) : full('vmhd', 0, 1, zeros(8)),
        box('dinf', full('dref', 0, 0, u32(1), full('url ', 0, 1))),
        stbl(entry, samples, durs, offsets, keyframes))));
}

/**
 * video:  { width, height, description (avcC), samples: [{ t (µs), data (Uint8Array), key }] }
 * audios: [{ name, codec: 'aac' | 'opus', sampleRate, channels, bitrate, description,
 *            samples: [{ t (µs), duration (µs), data }] }], one MP4 track each, in this order
 *         (players that play a single track pick the first; editors show them all, apart).
 * Timestamps are on one shared clock; the clip starts at the first video sample (a keyframe).
 * Returns { header: Uint8Array, parts: Uint8Array[], size, durationMs }.
 */
export function buildMp4({ video, audios = [] }) {
  if (!video?.samples?.length || !video.samples[0].key) throw new Error('o clipe precisa começar num keyframe');
  const t0 = video.samples[0].t;
  const vs = video.samples.map(s => ({ ...s, t: s.t - t0 }));
  const tracks = audios
    .map(a => ({ ...a, samples: (a.samples || []).filter(s => s.t >= t0).map(s => ({ ...s, t: s.t - t0 })) }))
    .filter(a => a.samples.length);

  // mdat order: interleaved by time, so players read every track moving forward.
  const order = [
    ...vs.map((s, i) => ({ s, track: -1, i })),
    ...tracks.flatMap((a, k) => a.samples.map((s, i) => ({ s, track: k, i })))
  ].sort((x, y) => x.s.t - y.s.t || x.track - y.track);

  const keyframes = vs.map((s, i) => (s.key ? i : -1)).filter(i => i >= 0);
  const videoDurUs = vs[vs.length - 1].t + (vs.length > 1 ? vs[vs.length - 1].t - vs[vs.length - 2].t : 33_333);
  const audioDurUs = Math.max(0, ...tracks.map(a => a.samples[a.samples.length - 1].t + (a.samples[a.samples.length - 1].duration || 20_000)));
  const movieDuration = toScale(Math.max(videoDurUs, audioDurUs), MOVIE_TIMESCALE);

  const build = (vOffsets, aOffsets) => {
    const ftyp = box('ftyp', te.encode('isom'), u32(512), te.encode('isom'), te.encode('iso2'), te.encode('avc1'), te.encode('mp41'));
    const moov = box('moov',
      full('mvhd', 0, 0, u32(0), u32(0), u32(MOVIE_TIMESCALE), u32(movieDuration), u32(0x00010000), u16(0x0100), zeros(10), MATRIX, zeros(24), u32(tracks.length + 2)),
      trak({ id: 1, kind: 'video', entry: avc1(video), samples: vs, scale: VIDEO_TIMESCALE, offsets: vOffsets, keyframes, width: video.width, height: video.height, movieDuration }),
      tracks.map((a, k) => trak({ id: k + 2, kind: 'audio', name: a.name, entry: audioEntry(a), samples: a.samples, scale: a.sampleRate, offsets: aOffsets[k], delayUs: a.samples[0].t, movieDuration })));
    return concat([ftyp, moov]);
  };

  // The tables have a fixed size whatever the offsets are: measure once, then fill them in.
  const headSize = build(vs.map(() => 0), tracks.map(a => a.samples.map(() => 0))).length;
  const dataSize = order.reduce((n, o) => n + o.s.data.byteLength, 0);
  if (headSize + 8 + dataSize > 0xffffffff) throw new Error('clipe grande demais');
  const vOffsets = new Array(vs.length);
  const aOffsets = tracks.map(a => new Array(a.samples.length));
  let at = headSize + 8;
  for (const o of order) {
    (o.track < 0 ? vOffsets : aOffsets[o.track])[o.i] = at;
    at += o.s.data.byteLength;
  }
  const head = build(vOffsets, aOffsets);
  const mdatHeader = new Uint8Array(8);
  new DataView(mdatHeader.buffer).setUint32(0, 8 + dataSize);
  mdatHeader.set(te.encode('mdat'), 4);
  return {
    header: concat([head, mdatHeader]),
    parts: order.map(o => o.s.data),
    size: head.length + 8 + dataSize,
    durationMs: movieDuration
  };
}
