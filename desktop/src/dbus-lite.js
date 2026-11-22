'use strict';
/**
 * A minimal D-Bus client for the session bus: method calls and signals, nothing else. Written
 * for the GlobalShortcuts portal (portal-shortcuts.js) so the app needs no npm dependency with a
 * native part (the usual D-Bus packages pull one in for abstract sockets, which Node already
 * supports on Linux).
 *
 * Values follow the D-Bus signature they are written with:
 *   y/n/q/i/u -> number, x/t -> BigInt (numbers accepted when writing), b -> boolean,
 *   s/o/g -> string, a<T> -> array, a{KV} -> plain object (string keys), (..) -> array,
 *   v -> { sig, value } (the variant's own signature and value).
 */
const net = require('node:net');
const { EventEmitter } = require('node:events');

const ALIGN = { y: 1, b: 4, n: 2, q: 2, i: 4, u: 4, x: 8, t: 8, d: 8, s: 4, o: 4, g: 1, v: 1, a: 4, '(': 8, '{': 8, h: 4 };
const TYPE = { call: 1, return: 2, error: 3, signal: 4 };
const FIELD = { path: 1, interface: 2, member: 3, errorName: 4, replySerial: 5, destination: 6, sender: 7, signature: 8 };
const FIELD_SIG = { 1: 'o', 2: 's', 3: 's', 4: 's', 5: 'u', 6: 's', 7: 's', 8: 'g' };

// End index (exclusive) of the single complete type starting at sig[i].
function typeEnd(sig, i) {
  const c = sig[i];
  if (c === 'a') return typeEnd(sig, i + 1);
  if (c === '(' || c === '{') {
    const close = c === '(' ? ')' : '}';
    let j = i + 1;
    while (sig[j] !== close) {
      if (j >= sig.length) throw new Error(`bad signature ${sig}`);
      j = typeEnd(sig, j);
    }
    return j + 1;
  }
  if (!(c in ALIGN)) throw new Error(`unsupported type ${c} in ${sig}`);
  return i + 1;
}

function splitTypes(sig) {
  const out = [];
  for (let i = 0; i < sig.length;) {
    const end = typeEnd(sig, i);
    out.push(sig.slice(i, end));
    i = end;
  }
  return out;
}

// ---- writing ------------------------------------------------------------------------------------

class Writer {
  constructor() { this.buf = Buffer.alloc(256); this.len = 0; }
  ensure(n) {
    if (this.len + n <= this.buf.length) return;
    const next = Buffer.alloc(Math.max(this.buf.length * 2, this.len + n));
    this.buf.copy(next, 0, 0, this.len);
    this.buf = next;
  }
  align(n) { const pad = (n - (this.len % n)) % n; this.ensure(pad); this.buf.fill(0, this.len, this.len + pad); this.len += pad; }
  u8(v) { this.ensure(1); this.buf.writeUInt8(v, this.len); this.len += 1; }
  u32(v) { this.align(4); this.ensure(4); this.buf.writeUInt32LE(v >>> 0, this.len); this.len += 4; }
  bytes(b) { this.ensure(b.length); b.copy(this.buf, this.len); this.len += b.length; }

  write(sig, value) {
    const c = sig[0];
    switch (c) {
      case 'y': this.u8(value); return;
      case 'b': this.u32(value ? 1 : 0); return;
      case 'n': case 'q': this.align(2); this.ensure(2); this.buf[c === 'n' ? 'writeInt16LE' : 'writeUInt16LE'](value, this.len); this.len += 2; return;
      case 'i': this.align(4); this.ensure(4); this.buf.writeInt32LE(value, this.len); this.len += 4; return;
      case 'u': case 'h': this.u32(value); return;
      case 'x': case 't': this.align(8); this.ensure(8); this.buf[c === 'x' ? 'writeBigInt64LE' : 'writeBigUInt64LE'](BigInt(value), this.len); this.len += 8; return;
      case 'd': this.align(8); this.ensure(8); this.buf.writeDoubleLE(value, this.len); this.len += 8; return;
      case 's': case 'o': { const b = Buffer.from(String(value), 'utf8'); this.u32(b.length); this.bytes(b); this.u8(0); return; }
      case 'g': { const b = Buffer.from(String(value), 'utf8'); this.u8(b.length); this.bytes(b); this.u8(0); return; }
      case 'v': this.write('g', value.sig); this.write(value.sig, value.value); return;
      case '(': {
        this.align(8);
        splitTypes(sig.slice(1, -1)).forEach((t, k) => this.write(t, value[k]));
        return;
      }
      case 'a': {
        const elem = sig.slice(1);
        this.u32(0);
        const lenAt = this.len - 4;
        this.align(ALIGN[elem[0]]);
        const start = this.len;
        if (elem[0] === '{') {
          const [kt, vt] = splitTypes(elem.slice(1, -1));
          for (const [k, v] of Object.entries(value || {})) { this.align(8); this.write(kt, k); this.write(vt, v); }
        } else {
          for (const v of value || []) this.write(elem, v);
        }
        this.buf.writeUInt32LE(this.len - start, lenAt);
        return;
      }
      default: throw new Error(`unsupported type ${c}`);
    }
  }
  result() { return this.buf.subarray(0, this.len); }
}

// ---- reading ------------------------------------------------------------------------------------

class Reader {
  constructor(buf, offset = 0) { this.buf = buf; this.pos = offset; }
  align(n) { this.pos += (n - (this.pos % n)) % n; }
  read(sig) {
    const c = sig[0];
    const b = this.buf;
    switch (c) {
      case 'y': return b.readUInt8(this.pos++);
      case 'b': this.align(4); this.pos += 4; return b.readUInt32LE(this.pos - 4) === 1;
      case 'n': this.align(2); this.pos += 2; return b.readInt16LE(this.pos - 2);
      case 'q': this.align(2); this.pos += 2; return b.readUInt16LE(this.pos - 2);
      case 'i': this.align(4); this.pos += 4; return b.readInt32LE(this.pos - 4);
      case 'u': case 'h': this.align(4); this.pos += 4; return b.readUInt32LE(this.pos - 4);
      case 'x': this.align(8); this.pos += 8; return b.readBigInt64LE(this.pos - 8);
      case 't': this.align(8); this.pos += 8; return b.readBigUInt64LE(this.pos - 8);
      case 'd': this.align(8); this.pos += 8; return b.readDoubleLE(this.pos - 8);
      case 's': case 'o': { const n = this.read('u'); const s = b.toString('utf8', this.pos, this.pos + n); this.pos += n + 1; return s; }
      case 'g': { const n = this.read('y'); const s = b.toString('utf8', this.pos, this.pos + n); this.pos += n + 1; return s; }
      case 'v': { const vs = this.read('g'); return { sig: vs, value: this.read(vs) }; }
      case '(': { this.align(8); return splitTypes(sig.slice(1, -1)).map(t => this.read(t)); }
      case 'a': {
        const n = this.read('u');
        const elem = sig.slice(1);
        this.align(ALIGN[elem[0]]);
        const end = this.pos + n;
        if (elem[0] === '{') {
          const [kt, vt] = splitTypes(elem.slice(1, -1));
          const out = {};
          while (this.pos < end) { this.align(8); const k = this.read(kt); out[k] = this.read(vt); }
          return out;
        }
        const out = [];
        while (this.pos < end) out.push(this.read(elem));
        return out;
      }
      default: throw new Error(`unsupported type ${c}`);
    }
  }
}

// ---- messages -----------------------------------------------------------------------------------

function encodeMessage({ type, serial, flags = 0, fields, signature = '', body = [] }) {
  const bodyWriter = new Writer();
  splitTypes(signature).forEach((t, k) => bodyWriter.write(t, body[k]));
  const bodyBuf = bodyWriter.result();
  const w = new Writer();
  w.u8(0x6c); // 'l': little endian
  w.u8(type);
  w.u8(flags);
  w.u8(1);
  w.u32(bodyBuf.length);
  w.u32(serial);
  const list = Object.entries({ ...fields, ...(signature ? { signature } : {}) })
    .filter(([, v]) => v !== undefined)
    .map(([name, v]) => [FIELD[name], { sig: FIELD_SIG[FIELD[name]], value: v }]);
  w.write('a(yv)', list);
  w.align(8);
  w.bytes(bodyBuf);
  return w.result();
}

// Returns { message, size } for the first complete message in buf, or null.
function decodeMessage(buf) {
  if (buf.length < 16) return null;
  if (buf[0] !== 0x6c && buf[0] !== 0x42) throw new Error('bad endianness');
  if (buf[0] === 0x42) throw new Error('big-endian messages are not supported');
  const bodyLen = buf.readUInt32LE(4);
  const fieldsLen = buf.readUInt32LE(12);
  const headerEnd = 16 + fieldsLen + ((8 - ((16 + fieldsLen) % 8)) % 8);
  const size = headerEnd + bodyLen;
  if (buf.length < size) return null;
  const r = new Reader(buf, 12);
  const fieldList = r.read('a(yv)');
  const fields = {};
  const names = Object.fromEntries(Object.entries(FIELD).map(([k, v]) => [v, k]));
  for (const [code, v] of fieldList) if (names[code]) fields[names[code]] = v.value;
  const msg = { type: buf[1], serial: buf.readUInt32LE(8), ...fields, body: [] };
  if (fields.signature) {
    const body = new Reader(buf.subarray(headerEnd, size));
    msg.body = splitTypes(fields.signature).map(t => body.read(t));
  }
  return { message: msg, size };
}

// ---- connection ---------------------------------------------------------------------------------

function busPath(address = process.env.DBUS_SESSION_BUS_ADDRESS || `unix:path=/run/user/${process.getuid?.()}/bus`) {
  for (const entry of address.split(';')) {
    const [transport, params = ''] = entry.split(':');
    if (transport !== 'unix') continue;
    const kv = Object.fromEntries(params.split(',').map(p => p.split('=')).map(([k, v]) => [k, decodeURIComponent(v || '')]));
    if (kv.path) return kv.path;
    if (kv.abstract) return `\0${kv.abstract}`; // Node connects to Linux abstract sockets this way
  }
  throw new Error('no usable D-Bus session bus address');
}

class Connection extends EventEmitter {
  constructor() {
    super();
    this.serial = 0;
    this.pending = new Map();
    this.input = Buffer.alloc(0);
    this.name = null;
  }

  async open(address) {
    this.socket = net.createConnection(busPath(address));
    await new Promise((resolve, reject) => { this.socket.once('connect', resolve); this.socket.once('error', reject); });
    await this.auth();
    this.socket.on('data', (chunk) => this.onData(chunk));
    this.socket.on('error', (err) => this.fail(err));
    this.socket.on('close', () => this.fail(new Error('D-Bus connection closed')));
    [this.name] = await this.call({ destination: 'org.freedesktop.DBus', path: '/org/freedesktop/DBus', interface: 'org.freedesktop.DBus', member: 'Hello' });
    return this;
  }

  auth() {
    return new Promise((resolve, reject) => {
      let text = '';
      const uid = Buffer.from(String(process.getuid())).toString('hex');
      const onData = (chunk) => {
        text += chunk.toString('latin1');
        if (!text.includes('\r\n')) return;
        this.socket.off('data', onData);
        if (!text.startsWith('OK')) { reject(new Error(`D-Bus auth failed: ${text.trim()}`)); return; }
        this.socket.write('BEGIN\r\n');
        resolve();
      };
      this.socket.on('data', onData);
      this.socket.write(Buffer.concat([Buffer.from([0]), Buffer.from(`AUTH EXTERNAL ${uid}\r\n`)]));
    });
  }

  onData(chunk) {
    this.input = Buffer.concat([this.input, chunk]);
    for (;;) {
      let decoded;
      try { decoded = decodeMessage(this.input); } catch (err) { this.fail(err); return; }
      if (!decoded) return;
      this.input = this.input.subarray(decoded.size);
      const msg = decoded.message;
      if (msg.type === TYPE.return || msg.type === TYPE.error) {
        const waiter = this.pending.get(msg.replySerial);
        if (!waiter) continue;
        this.pending.delete(msg.replySerial);
        if (msg.type === TYPE.error) waiter.reject(new Error(`${msg.errorName}: ${msg.body[0] || ''}`));
        else waiter.resolve(msg.body);
      } else if (msg.type === TYPE.signal) {
        this.emit('signal', msg);
      }
    }
  }

  fail(err) {
    for (const waiter of this.pending.values()) waiter.reject(err);
    this.pending.clear();
    if (!this.closed) { this.closed = true; this.emit('close', err); }
  }

  // Resolves to the reply's body (array of values); rejects on a D-Bus error.
  call({ destination, path, interface: iface, member, signature = '', body = [] }) {
    if (this.closed) return Promise.reject(new Error('D-Bus connection closed'));
    const serial = ++this.serial;
    const data = encodeMessage({ type: TYPE.call, serial, fields: { path, interface: iface, member, destination }, signature, body });
    return new Promise((resolve, reject) => {
      this.pending.set(serial, { resolve, reject });
      this.socket.write(data);
    });
  }

  addMatch(rule) {
    return this.call({ destination: 'org.freedesktop.DBus', path: '/org/freedesktop/DBus', interface: 'org.freedesktop.DBus', member: 'AddMatch', signature: 's', body: [rule] });
  }

  close() {
    this.closed = true;
    try { this.socket?.end(); } catch { /* gone */ }
  }
}

async function sessionBus(address) {
  return new Connection().open(address);
}

module.exports = { sessionBus, encodeMessage, decodeMessage, splitTypes, Writer, Reader, busPath };
