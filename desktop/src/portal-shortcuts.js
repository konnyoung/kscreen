'use strict';
/**
 * Global shortcuts on Wayland through the desktop portal (org.freedesktop.portal.GlobalShortcuts),
 * the way Discord and OBS do it. Electron's own globalShortcut reports success on Wayland but
 * never reaches the portal (seen on Hyprland: `hyprctl globalshortcuts` stays empty).
 *
 * How each desktop uses it:
 *  - KDE / GNOME 48+: the system asks the user to confirm or pick the key (preferred_trigger is
 *    the suggestion) and remembers it;
 *  - Hyprland: the shortcut shows up as "<app id>:<id>" and the user binds it in hyprland.conf:
 *      bind = ALT, F10, global, br.com.kennyy.kscreen:save-clip
 *
 * One session for the whole run: binding again would make KDE ask again. The D-Bus client is
 * our own (dbus-lite.js, pure JS), loaded only here, only on Wayland.
 */

const REQUEST = 'org.freedesktop.portal.Request';
const SHORTCUTS = 'org.freedesktop.portal.GlobalShortcuts';
const PORTAL = 'org.freedesktop.portal.Desktop';
const PORTAL_PATH = '/org/freedesktop/portal/desktop';

// "Alt+F10" (Electron) -> "ALT+F10" (the portal's shortcut format).
function toPortalTrigger(accelerator) {
  const names = { alt: 'ALT', ctrl: 'CTRL', control: 'CTRL', shift: 'SHIFT', super: 'LOGO', meta: 'LOGO', cmdorctrl: 'CTRL' };
  return String(accelerator).split('+').map(k => names[k.toLowerCase()] || k).join('+');
}

const str = (value) => ({ sig: 's', value });

function createPortalShortcuts({ appId, connect = () => require('./dbus-lite').sessionBus() } = {}) {
  let bus = null;
  let session = null;
  let starting = null;
  let seq = 0;
  const handlers = new Map(); // shortcut id -> callback
  const bound = new Map();    // shortcut id -> result of its BindShortcuts (once per session)

  const portalCall = (iface, member, signature, body) => bus.call({ destination: PORTAL, path: PORTAL_PATH, interface: iface, member, signature, body });

  // Portal calls answer through a Request object's Response signal, subscribed before the call.
  async function request(call) {
    const token = `kscreen${process.pid}_${++seq}`;
    const sender = bus.name.slice(1).replace(/\./g, '_');
    const path = `${PORTAL_PATH}/request/${sender}/${token}`;
    await bus.addMatch(`type='signal',interface='${REQUEST}',member='Response',path='${path}'`);
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { bus.off('signal', onSignal); reject(new Error('portal timeout')); }, 120_000);
      function onSignal(msg) {
        if (msg.path !== path || msg.member !== 'Response') return;
        clearTimeout(timer);
        bus.off('signal', onSignal);
        resolve(msg.body);
      }
      bus.on('signal', onSignal);
    });
    await call(token);
    const [code, results] = await response;
    if (code !== 0) throw new Error(code === 1 ? 'cancelado' : 'recusado pelo portal');
    return results;
  }

  async function start() {
    bus = await connect();
    bus.on('close', () => { bus = null; session = null; starting = null; bound.clear(); });
    // Host (non-Flatpak) apps tell the portal who they are first; inside Flatpak the sandbox
    // already says it and this fails harmlessly.
    try { await portalCall('org.freedesktop.host.portal.Registry', 'Register', 'sa{sv}', [appId, {}]); } catch { /* flatpak or old portal */ }
    await bus.addMatch(`type='signal',interface='${SHORTCUTS}',member='Activated'`);
    bus.on('signal', (msg) => {
      if (msg.interface === SHORTCUTS && msg.member === 'Activated' && msg.body[0] === session) handlers.get(msg.body[1])?.();
    });
    const results = await request(token => portalCall(SHORTCUTS, 'CreateSession', 'a{sv}', [{
      handle_token: str(token),
      session_handle_token: str(`kscreen_session_${process.pid}`)
    }]));
    session = results.session_handle.value;
  }

  return {
    // Binds one shortcut (id, description, Electron-style preferred key). Resolves to
    // { ok: true, trigger } (trigger: the key the system reports, may be '') or
    // { ok: false, error }. Once per id: binding again would make KDE ask again.
    async bind({ id, description, accelerator, onActivated }) {
      handlers.set(id, onActivated);
      if (bound.has(id)) return bound.get(id);
      try {
        starting ??= start();
        await starting;
        const results = await request(token => portalCall(SHORTCUTS, 'BindShortcuts', 'oa(sa{sv})sa{sv}', [
          session,
          [[id, { description: str(description), preferred_trigger: str(toPortalTrigger(accelerator)) }]],
          '',
          { handle_token: str(token) }
        ]));
        const entry = (results.shortcuts?.value || []).find(([name]) => name === id);
        const res = { ok: true, trigger: entry?.[1]?.trigger_description?.value || '' };
        bound.set(id, res);
        return res;
      } catch (err) {
        starting = null;
        try { bus?.close(); } catch { /* gone */ }
        bus = null;
        return { ok: false, error: err.message };
      }
    },
    close() {
      try { bus?.close(); } catch { /* gone */ }
      bus = null;
      session = null;
      starting = null;
      bound.clear();
    }
  };
}

module.exports = { createPortalShortcuts, toPortalTrigger };
