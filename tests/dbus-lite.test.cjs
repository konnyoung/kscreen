// The minimal D-Bus client (desktop/src/dbus-lite.js): wire format and a fake bus round trip.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { encodeMessage, decodeMessage, splitTypes, Writer, Reader, sessionBus, busPath } = require('../desktop/src/dbus-lite.js');

test('signatures split into complete types', () => {
  assert.deepEqual(splitTypes('oa(sa{sv})sa{sv}'), ['o', 'a(sa{sv})', 's', 'a{sv}']);
  assert.deepEqual(splitTypes('uta{sv}(ii)'), ['u', 't', 'a{sv}', '(ii)']);
  assert.throws(() => splitTypes('(s'), /bad signature/);
});

test('values survive a write/read round trip with D-Bus alignment', () => {
  const sig = 'yba{sv}a(sa{sv})tox';
  const values = [7, true, { a: { sig: 's', value: 'x' }, n: { sig: 'u', value: 42 } },
    [['save-clip', { description: { sig: 's', value: 'Salvar clipe' } }]], 123456789012n, '/a/b', -5n];
  const w = new Writer();
  splitTypes(sig).forEach((t, k) => w.write(t, values[k]));
  const r = new Reader(w.result());
  assert.deepEqual(splitTypes(sig).map(t => r.read(t)), values);
});

test('known bytes: a{sv} with one string entry', () => {
  const w = new Writer();
  w.write('a{sv}', { k: { sig: 's', value: 'v' } });
  // len 18 | pad to 8 | key "k" (u32 1, 'k', NUL) | variant sig (1, 's', NUL) | pad to 4 | "v"
  assert.equal(w.result().toString('hex'), '12000000' + '00000000' + '01000000' + '6b00' + '017300' + '000000' + '01000000' + '7600');
});

test('messages: encode, decode, partial input', () => {
  const data = encodeMessage({ type: 1, serial: 9, fields: { path: '/p', interface: 'i.f', member: 'M', destination: 'd.e' }, signature: 'su', body: ['olá', 3] });
  assert.equal(decodeMessage(data.subarray(0, 20)), null);
  const { message, size } = decodeMessage(Buffer.concat([data, Buffer.from([1, 2, 3])]));
  assert.equal(size, data.length);
  assert.equal(message.serial, 9);
  assert.equal(message.member, 'M');
  assert.equal(message.path, '/p');
  assert.deepEqual(message.body, ['olá', 3]);
});

test('bus addresses: path, abstract, first usable', () => {
  assert.equal(busPath('unix:path=/run/user/1000/bus'), '/run/user/1000/bus');
  assert.equal(busPath('unix:abstract=/tmp/dbus-x,guid=1'), '\0/tmp/dbus-x');
  assert.equal(busPath('tcp:host=x;unix:path=/b'), '/b');
  assert.throws(() => busPath('tcp:host=x'), /no usable/);
});

// A tiny fake bus daemon: EXTERNAL auth, Hello, one method and one signal.
test('connection: auth, calls, errors and signals against a fake bus', async () => {
  const sock = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kscreen-dbus-')), 'bus');
  const server = net.createServer((c) => {
    let authed = false;
    let input = Buffer.alloc(0);
    c.on('data', (chunk) => {
      if (!authed) {
        const text = chunk.toString('latin1');
        if (text.includes('AUTH EXTERNAL')) c.write('OK 1234\r\n');
        if (!text.includes('BEGIN')) return;
        authed = true;
        chunk = chunk.subarray(chunk.indexOf('BEGIN\r\n') + 7);
      }
      input = Buffer.concat([input, chunk]);
      for (let d; (d = decodeMessage(input));) {
        input = input.subarray(d.size);
        const m = d.message;
        const reply = (fields, signature, body, type = 2) => c.write(encodeMessage({ type, serial: 100 + m.serial, fields: { replySerial: m.serial, ...fields }, signature, body }));
        if (m.member === 'Hello') reply({}, 's', [':1.42']);
        else if (m.member === 'Echo') {
          reply({}, 'sa{sv}', [m.body[0], m.body[1]]);
          c.write(encodeMessage({ type: 4, serial: 999, fields: { path: '/x', interface: 'i.f', member: 'Ping' }, signature: 'ou', body: ['/s', 5] }));
        } else reply({ errorName: 'org.test.Nope' }, 's', ['no such method'], 3);
      }
    });
  });
  await new Promise(r => server.listen(sock, r));
  try {
    const bus = await sessionBus(`unix:path=${sock}`);
    assert.equal(bus.name, ':1.42');
    const signal = new Promise(r => bus.once('signal', r));
    const body = await bus.call({ destination: 'd', path: '/', interface: 'i.f', member: 'Echo', signature: 'sa{sv}', body: ['hi', { k: { sig: 'b', value: true } }] });
    assert.deepEqual(body, ['hi', { k: { sig: 'b', value: true } }]);
    const sig = await signal;
    assert.equal(sig.member, 'Ping');
    assert.deepEqual(sig.body, ['/s', 5]);
    await assert.rejects(bus.call({ destination: 'd', path: '/', interface: 'i.f', member: 'Missing' }), /org.test.Nope: no such method/);
    bus.close();
  } finally {
    server.close();
    server.unref();
  }
});

// The portal flow (desktop/src/portal-shortcuts.js) over a scripted bus.
const { createPortalShortcuts, toPortalTrigger } = require('../desktop/src/portal-shortcuts.js');
const { EventEmitter } = require('node:events');

test('portal: accelerators become portal triggers', () => {
  assert.equal(toPortalTrigger('Alt+F10'), 'ALT+F10');
  assert.equal(toPortalTrigger('Ctrl+Shift+S'), 'CTRL+SHIFT+S');
});

test('portal: registry, session, bind, activation; one bind per id', async () => {
  const calls = [];
  const bus = new EventEmitter();
  bus.name = ':1.7';
  bus.addMatch = async () => {};
  bus.close = () => {};
  const respond = (body) => {
    const token = body.at(-1).handle_token.value;
    setImmediate(() => bus.emit('signal', { path: `/org/freedesktop/portal/desktop/request/1_7/${token}`, member: 'Response', body: [0, results(body)] }));
  };
  let results = () => ({});
  bus.call = async (m) => {
    calls.push(m.member);
    if (m.member === 'CreateSession') { results = () => ({ session_handle: { sig: 'o', value: '/s/1' } }); respond(m.body); }
    if (m.member === 'BindShortcuts') { results = () => ({ shortcuts: { sig: 'a(sa{sv})', value: [['save-clip', { trigger_description: { sig: 's', value: 'Alt+F10' } }]] } }); respond(m.body); }
    return [];
  };
  let hits = 0;
  const portal = createPortalShortcuts({ appId: 'app.id', connect: async () => bus });
  const res = await portal.bind({ id: 'save-clip', description: 'd', accelerator: 'Alt+F10', onActivated: () => hits++ });
  assert.deepEqual(res, { ok: true, trigger: 'Alt+F10' });
  assert.deepEqual(calls, ['Register', 'CreateSession', 'BindShortcuts']);
  bus.emit('signal', { interface: 'org.freedesktop.portal.GlobalShortcuts', member: 'Activated', body: ['/s/1', 'save-clip', 0n, {}] });
  bus.emit('signal', { interface: 'org.freedesktop.portal.GlobalShortcuts', member: 'Activated', body: ['/other', 'save-clip', 0n, {}] });
  assert.equal(hits, 1, 'only our session');
  await portal.bind({ id: 'save-clip', description: 'd', accelerator: 'Alt+F10', onActivated: () => hits++ });
  assert.equal(calls.filter(c => c === 'BindShortcuts').length, 1);
});

test('portal: a refused session is reported, not thrown', async () => {
  const bus = new EventEmitter();
  bus.name = ':1.8';
  bus.addMatch = async () => {};
  bus.close = () => {};
  bus.call = async (m) => {
    if (m.member === 'CreateSession') {
      const token = m.body[0].handle_token.value;
      setImmediate(() => bus.emit('signal', { path: `/org/freedesktop/portal/desktop/request/1_8/${token}`, member: 'Response', body: [2, {}] }));
    }
    return [];
  };
  const portal = createPortalShortcuts({ appId: 'app.id', connect: async () => bus });
  const res = await portal.bind({ id: 'save-clip', description: 'd', accelerator: 'Alt+F10', onActivated() {} });
  assert.equal(res.ok, false);
});
