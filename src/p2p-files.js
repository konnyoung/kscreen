// Chat media over WebRTC, torrent-style: images go from person to person on each connection's
// "files" data channel (direct P2P, or through the media server in SFU rooms). The server
// only keeps the message and a description of each file (SHA-256, size, type), never the bytes.
//
// Everyone who receives a file keeps it in memory and serves it too ("seeds"). A download first asks
// who has the file, then pulls 256 KB pieces from all of them in parallel, so it doesn't depend on
// the sender: once anyone else has a copy, the sender can leave. Every client fetches the images of
// the messages it shows right away, so copies spread through the room within seconds.
// The whole file is checked against its hash, so a peer can't swap the content.
//
// Protocol on the channel (strings are JSON, binary messages are chunks of the current transfer):
//   {t:'has', hash}                   do you have it?   -> {t:'have', hash, yes}
//   {t:'get', hash, off, len}         send this byte range (whole file without off/len)
//   {t:'start', hash, off, size}      the chunks of that range follow, `size` bytes in total
//   {t:'miss', hash, off}             don't have it

const CHUNK = 16 * 1024;
const PIECE = 256 * 1024;
const HIGH_WATER = 1024 * 1024;
const LOW_WATER = 256 * 1024;
const STALL_MS = 15000;
// Generous: over a busy media server (a stream going through it) answers can take a while.
const HAS_TIMEOUT_MS = 4000;
const MAX_FILE = 50 * 1024 * 1024;

export async function sha256Hex(data) {
  const buf = data instanceof Blob ? await data.arrayBuffer() : data;
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
}

const validHash = (h) => (typeof h === 'string' && /^[0-9a-f]{64}$/.test(h) ? h : null);
const keyOf = (hash, off) => `${hash}:${off}`;

export class P2PFiles {
  constructor(engine, { maxBytes = 300 * 1024 * 1024 } = {}) {
    this.engine = engine;
    this.maxBytes = maxBytes;
    this.store = new Map(); // hash -> Blob, oldest first
    this.pinned = new Map(); // hash -> Blob that is never evicted nor cleared (own profile photo)
    this.bytes = 0;
    this.urls = new Map(); // hash -> object URL
    this.inflight = new Map(); // hash -> Promise<Blob|null>
    this.state = new WeakMap(); // channel -> per-connection state
    this.onPeerReady = () => {}; // a connection's file channel opened (retry what was missing)
    this.openWaiters = new Set();
    // Last resort when no WebRTC route (direct or media server) can deliver: (hash, type) => Blob | null.
    this.relay = null;
    engine.onFileChannel = (peer, channel) => this.attach(peer, channel);
  }

  has(hash) { return this.store.has(hash); }

  // Kept for the whole session and served to the room (our own profile photo).
  pin(hash, blob) {
    this.pinned.set(hash, blob);
    this.put(hash, blob);
  }

  put(hash, blob) {
    if (this.store.has(hash)) {
      // Most recently used goes last.
      this.store.delete(hash);
      this.store.set(hash, blob);
      return;
    }
    this.store.set(hash, blob);
    this.bytes += blob.size;
    for (const [h, b] of this.store) {
      if (this.bytes <= this.maxBytes) break;
      if (h === hash || this.pinned.has(h)) continue;
      this.store.delete(h);
      this.bytes -= b.size;
      const url = this.urls.get(h);
      if (url) { URL.revokeObjectURL(url); this.urls.delete(h); }
    }
  }

  url(hash) {
    const blob = this.store.get(hash);
    if (!blob) return null;
    let url = this.urls.get(hash);
    if (!url) { url = URL.createObjectURL(blob); this.urls.set(hash, url); }
    return url;
  }

  // Leaving the room frees everything.
  clear() {
    for (const url of this.urls.values()) URL.revokeObjectURL(url);
    this.urls.clear();
    this.store.clear();
    this.bytes = 0;
    for (const [h, b] of this.pinned) this.put(h, b);
  }

  openPeers() {
    return [...this.engine.peers.values()].filter(p => p.fileDc?.readyState === 'open' && this.state.get(p.fileDc));
  }

  // Resolves to a Blob, or null when nobody connected has the file.
  fetch(hash, { size, type, preferPeer, noRelay = false } = {}) {
    if (this.store.has(hash)) return Promise.resolve(this.store.get(hash));
    if (this.inflight.has(hash)) return this.inflight.get(hash);
    const job = (async () => {
      // Right after joining (or a reload) the connections are still opening: wait a little.
      if (!this.openPeers().length && this.engine.peers.size) await this.waitForOpen(10000);
      // Connections may still be opening, or a holder may be busy: ask again a few times
      // (sooner when a new connection opens) before giving up on WebRTC.
      let blob = null;
      for (let attempt = 0; attempt < 4 && !blob; attempt++) {
        if (attempt) await this.waitForOpen(1500 * attempt);
        const holders = await this.findHolders(hash);
        if (holders.length) blob = await this.download(hash, size, type, holders, preferPeer).catch(() => null);
      }
      if (!blob && this.relay && !noRelay) {
        const relayed = await this.relay(hash, type).catch(() => null);
        if (relayed && await sha256Hex(relayed) === hash) blob = relayed;
      }
      if (blob) this.put(hash, blob);
      return blob;
    })().finally(() => this.inflight.delete(hash));
    this.inflight.set(hash, job);
    return job;
  }

  waitForOpen(ms) {
    return new Promise((resolve) => {
      const done = () => { clearTimeout(timer); this.openWaiters.delete(done); resolve(); };
      const timer = setTimeout(done, ms);
      this.openWaiters.add(done);
    });
  }

  // Asks every open connection whether it has the file; answers after HAS_TIMEOUT_MS count as no.
  findHolders(hash) {
    const peers = this.openPeers();
    return Promise.all(peers.map(peer => new Promise((resolve) => {
      const st = this.state.get(peer.fileDc);
      const timer = setTimeout(() => { st.asking.delete(hash); resolve(null); }, HAS_TIMEOUT_MS);
      const list = st.asking.get(hash) || [];
      list.push((yes) => { clearTimeout(timer); resolve(yes ? peer : null); });
      st.asking.set(hash, list);
      try { peer.fileDc.send(JSON.stringify({ t: 'has', hash })); } catch { clearTimeout(timer); resolve(null); }
    }))).then(list => list.filter(Boolean));
  }

  // Pieces are handed out to the holders as each finishes its last one (faster links take more);
  // a holder that fails is dropped and its piece goes back in the queue.
  async download(hash, size, type, holders, preferPeer) {
    if (!Number.isInteger(size) || size <= 0 || size > MAX_FILE) size = 0;
    // The sender goes last, so the load spreads over the people who already have a copy.
    holders.sort((a, b) => (a.id === preferPeer) - (b.id === preferPeer));
    if (!size) {
      // Unknown size (shouldn't happen): whole file from one holder at a time.
      for (const peer of holders) {
        const part = await this.request(peer, hash, null, null).catch(() => null);
        if (part && await sha256Hex(part) === hash) return new Blob([part], { type: type || '' });
      }
      return null;
    }
    const pieces = [];
    for (let off = 0; off < size; off += PIECE) pieces.push({ off, len: Math.min(PIECE, size - off) });
    const parts = new Array(pieces.length);
    const queue = pieces.map((_, i) => i);
    const alive = new Set(holders);
    const worker = async (peer) => {
      while (queue.length && alive.has(peer)) {
        const i = queue.shift();
        const { off, len } = pieces[i];
        const data = await this.request(peer, hash, off, len).catch(() => null);
        if (data && data.size === len) {
          parts[i] = data;
        } else {
          alive.delete(peer);
          queue.unshift(i);
        }
      }
    };
    // Rounds until every piece is in or nobody is left to ask.
    while (queue.length && alive.size) await Promise.all([...alive].map(worker));
    if (queue.length || parts.some(p => !p)) return null;
    const blob = new Blob(parts, { type: type || '' });
    return (await sha256Hex(blob)) === hash ? blob : null;
  }

  // One byte range (or the whole file when off is null) from one connection.
  request(peer, hash, off, len) {
    const channel = peer.fileDc;
    const st = this.state.get(channel);
    if (!st || channel.readyState !== 'open') return Promise.resolve(null);
    const key = keyOf(hash, off ?? 0);
    return new Promise((resolve, reject) => {
      const w = { len, timer: 0 };
      const settle = (fn) => (v) => { clearTimeout(w.timer); st.waiting.delete(key); fn(v); };
      w.resolve = settle(resolve);
      w.reject = settle(reject);
      w.bump = () => {
        clearTimeout(w.timer);
        w.timer = setTimeout(() => {
          if (st.incoming?.key === key) st.incoming = null;
          w.reject(new Error('timeout'));
        }, STALL_MS);
      };
      st.waiting.set(key, w);
      w.bump();
      const msg = off === null ? { t: 'get', hash } : { t: 'get', hash, off, len };
      try { channel.send(JSON.stringify(msg)); } catch (err) { w.reject(err); }
    });
  }

  // ------------------------------------------------------------------ channel

  attach(peer, channel) {
    const st = { peer, queue: [], sending: false, waiting: new Map(), asking: new Map(), incoming: null };
    this.state.set(channel, st);
    channel.bufferedAmountLowThreshold = LOW_WATER;
    channel.onmessage = (e) => {
      if (typeof e.data === 'string') this.onControl(channel, st, e.data);
      else this.onChunk(st, e.data);
    };
    const opened = () => {
      for (const done of [...this.openWaiters]) done();
      this.onPeerReady(peer);
    };
    if (channel.readyState === 'open') queueMicrotask(opened);
    else channel.addEventListener('open', opened, { once: true });
    channel.onclose = () => {
      for (const w of [...st.waiting.values()]) w.reject(new Error('closed'));
      for (const list of st.asking.values()) for (const cb of list) cb(false);
      st.asking.clear();
      st.incoming = null;
      st.queue = [];
    };
  }

  onControl(channel, st, text) {
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    const hash = validHash(msg.hash);
    if (!hash) return;
    if (msg.t === 'has') {
      try { channel.send(JSON.stringify({ t: 'have', hash, yes: this.store.has(hash) })); } catch { /* closing */ }
    } else if (msg.t === 'have') {
      const list = st.asking.get(hash);
      st.asking.delete(hash);
      for (const cb of list || []) cb(!!msg.yes);
    } else if (msg.t === 'get') {
      const off = Number.isInteger(msg.off) && msg.off >= 0 ? msg.off : null;
      const len = Number.isInteger(msg.len) && msg.len > 0 && msg.len <= 4 * PIECE ? msg.len : null;
      if (st.queue.length < 400) st.queue.push({ hash, off: off ?? 0, len: off === null ? null : len });
      this.pump(channel, st);
    } else if (msg.t === 'miss') {
      st.waiting.get(keyOf(hash, Number(msg.off) || 0))?.resolve(null);
    } else if (msg.t === 'start') {
      const key = keyOf(hash, Number(msg.off) || 0);
      const w = st.waiting.get(key);
      const size = Number(msg.size);
      // Only what we asked for, and never more than we asked for.
      if (!w || !Number.isInteger(size) || size <= 0 || size > MAX_FILE || (w.len && size !== w.len)) {
        st.incoming = null;
        w?.resolve(null);
        return;
      }
      st.incoming = { key, size, received: 0, chunks: [] };
      w.bump();
    }
  }

  onChunk(st, data) {
    const cur = st.incoming;
    if (!cur) return;
    const w = st.waiting.get(cur.key);
    if (!w) { st.incoming = null; return; }
    cur.chunks.push(data);
    cur.received += data.byteLength;
    // Requests queued behind this transfer are making progress too.
    for (const other of st.waiting.values()) other.bump();
    if (cur.received < cur.size) return;
    st.incoming = null;
    if (cur.received !== cur.size) { w.resolve(null); return; }
    w.resolve(new Blob(cur.chunks));
  }

  // Serves queued requests one at a time, respecting the channel's buffer.
  async pump(channel, st) {
    if (st.sending) return;
    st.sending = true;
    try {
      while (st.queue.length && channel.readyState === 'open') {
        const { hash, off, len } = st.queue.shift();
        const blob = this.store.get(hash);
        if (!blob || off >= blob.size) { channel.send(JSON.stringify({ t: 'miss', hash, off })); continue; }
        const buf = await blob.slice(off, len === null ? blob.size : off + len).arrayBuffer();
        channel.send(JSON.stringify({ t: 'start', hash, off, size: buf.byteLength }));
        for (let pos = 0; pos < buf.byteLength; pos += CHUNK) {
          if (channel.readyState !== 'open') return;
          if (channel.bufferedAmount > HIGH_WATER) {
            await new Promise((resolve) => {
              const done = () => { channel.removeEventListener('bufferedamountlow', done); channel.removeEventListener('close', done); resolve(); };
              channel.addEventListener('bufferedamountlow', done);
              channel.addEventListener('close', done);
            });
            if (channel.readyState !== 'open') return;
          }
          channel.send(buf.slice(pos, pos + CHUNK));
        }
      }
    } catch { /* channel closed mid-transfer */ } finally {
      st.sending = false;
    }
  }
}
