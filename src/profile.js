// Basic user profile (Discord style): a small card with the banner in the person's profile
// colour, photo, display name, @username (Discord accounts only) and a badge. Opened by clicking
// a name or photo anywhere (card name tags, chat, mentions, viewers, home dock) or from the
// card's right-click menu. One at a time; closes on outside click, Esc, resize or scroll.
//
// It knows nothing about rooms: main.js resolves who the person is and passes `info`:
// { name, username, guest, admin, avatarUrl, nameColor, self, call: { device, micMuted,
//   deafened, streaming } | null, onEdit }

import { tr } from './i18n.js';
import './profile.css';

const DEFAULT_COLOR = '#e8365d';
const DEVICE_TEXT = { desktop: 'No computador (app)', browser: 'No navegador', mobile: 'No celular' };

let current = null; // { root, anchor, cleanup }

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function isProfileOpen() {
  return !!current;
}

export function closeProfile({ restoreFocus = false } = {}) {
  if (!current) return;
  const { root, cleanup, anchor } = current;
  current = null;
  cleanup();
  root.classList.add('closing');
  setTimeout(() => root.remove(), 120);
  if (restoreFocus && anchor?.isConnected && typeof anchor.focus === 'function') anchor.focus({ preventScroll: true });
}

// `at`: the element that was clicked, or a point { x, y } (right-click menu).
export function openProfile(info, at) {
  const sameAnchor = current && at && current.anchor === at;
  closeProfile();
  if (sameAnchor) return; // second click on the same name closes it

  const color = info.nameColor || DEFAULT_COLOR;
  const chips = [];
  if (info.guest) chips.push(`<span class="kp-chip">${esc(tr('Convidado'))}</span>`);
  else chips.push('<span class="kp-chip is-discord" data-no-tr>Discord</span>');
  if (info.admin) chips.push(`<span class="kp-chip is-admin">${esc(tr('Admin'))}</span>`);

  let call = '';
  if (info.call) {
    const bits = [tr(DEVICE_TEXT[info.call.device] || 'Na chamada')];
    if (info.call.streaming) bits.push(tr('transmitindo'));
    if (info.call.deafened) bits.push(tr('áudio desligado'));
    else if (info.call.micMuted) bits.push(tr('microfone desligado'));
    call = `<div class="kp-section">
        <div class="kp-section-title">${esc(tr('Na chamada'))}</div>
        <div class="kp-section-text">${esc(bits.join(' · '))}</div>
      </div>`;
  }

  const root = document.createElement('div');
  root.className = 'kp-profile';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', tr('Perfil de {name}').replace('{name}', info.name || ''));
  root.tabIndex = -1;
  root.style.setProperty('--profile-color', color);
  root.innerHTML = `
    <div class="kp-banner"></div>
    <img class="kp-avatar" src="${esc(info.avatarUrl || '/avatar.png')}" alt="" />
    <div class="kp-body">
      <div class="kp-name" data-no-tr style="${info.nameColor ? `color:${esc(info.nameColor)}` : ''}">${esc(info.name || tr('Usuário'))}${info.self ? `<span class="kp-you">${esc(tr('(Você)'))}</span>` : ''}</div>
      ${info.username && !info.guest ? `<div class="kp-user" data-no-tr>@${esc(info.username)}</div>` : ''}
      <div class="kp-chips">${chips.join('')}</div>
      ${call}
      ${info.self && info.onEdit ? `<button type="button" class="kp-btn" data-edit>${esc(tr('Editar perfil'))}</button>` : ''}
    </div>`;
  document.body.append(root);
  root.querySelector('[data-edit]')?.addEventListener('click', () => { closeProfile(); info.onEdit(); });
  root.querySelector('.kp-avatar').addEventListener('error', (e) => { e.target.src = '/avatar.png'; }, { once: true });

  place(root, at);

  const anchorEl = at instanceof Element ? at : null;
  const onDown = (e) => {
    if (root.contains(e.target)) return;
    // A click on the same anchor toggles (handled by openProfile); elsewhere closes.
    if (anchorEl && anchorEl.contains(e.target)) return;
    closeProfile();
  };
  const onKey = (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    closeProfile({ restoreFocus: true });
  };
  const onScroll = (e) => { if (!root.contains(e.target)) closeProfile(); };
  const onResize = () => closeProfile();
  document.addEventListener('pointerdown', onDown, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', onResize);
  current = {
    root,
    anchor: anchorEl,
    cleanup: () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    }
  };
  root.focus({ preventScroll: true });
}

// Beside the clicked element (right, or left when there's no room), top-aligned and kept on
// screen; at the pointer for a menu.
function place(root, at) {
  const w = root.offsetWidth;
  const h = root.offsetHeight;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let x;
  let y;
  if (at instanceof Element) {
    const r = at.getBoundingClientRect();
    if (vw < 520) { // phones: centred under / over the name
      x = (vw - w) / 2;
      y = r.bottom + 8 + h <= vh - 8 ? r.bottom + 8 : r.top - 8 - h;
    } else {
      x = r.right + 10;
      if (x + w > vw - 8) x = r.left - 10 - w;
      if (x < 8) x = Math.min(r.left, vw - w - 8);
      y = r.top;
    }
  } else {
    x = (at?.x ?? vw / 2) + 4;
    y = (at?.y ?? vh / 2) + 4;
    if (x + w > vw - 8) x = (at?.x ?? vw) - w - 4;
  }
  x = Math.max(8, Math.min(x, vw - w - 8));
  y = Math.max(8, Math.min(y, vh - h - 8));
  root.style.left = `${Math.round(x)}px`;
  root.style.top = `${Math.round(y)}px`;
}
