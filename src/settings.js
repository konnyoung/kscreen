// Settings window (Discord style): sections on the left, a search box that filters every
// option, and the content on the right. Opened by the gear on the home screen (user dock),
// the gear in the room's top bar, the "Configurações de voz" items in the dock menus, or
// Ctrl+, anywhere. Phones get the list first and slide into a section, like Discord mobile.
//
// It owns no preference of its own except what main.js hands over in `api`: every change goes
// through the same functions the dock menus use, so both always show the same state.

import { tr, translateTree } from './i18n.js';
import { openColorPicker, closeColorPicker } from './color-picker.js';
import './settings.css';

const ICONS = {
  account: '<path d="M12 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10zm0 2c-4.4 0-8 2.2-8 5v1a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-1c0-2.8-3.6-5-8-5z" fill="currentColor"/>',
  voice: '<path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.9V21h2v-3.1a7 7 0 0 0 6-6.9h-2z" fill="currentColor"/>',
  share: '<rect x="2" y="3" width="20" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 21h8M12 17v4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  sounds: '<path d="M18 16v-5a6 6 0 0 0-12 0v5l-2 2v1h16v-1l-2-2zM12 22a2.5 2.5 0 0 0 2.4-2h-4.8a2.5 2.5 0 0 0 2.4 2z" fill="currentColor"/>',
  call: '<path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z" fill="currentColor"/>',
  language: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3 12h18M12 3c2.5 2.6 3.7 5.6 3.7 9s-1.2 6.4-3.7 9c-2.5-2.6-3.7-5.6-3.7-9S9.5 5.6 12 3z" fill="none" stroke="currentColor" stroke-width="2"/>',
  keys: '<rect x="2" y="6" width="20" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>',
  advanced: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9l-3.8 3.8z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>'
};
const icon = (name, size = 18) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;
const SEARCH_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>';
const PLAY_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
const BACK_ICON = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 6 9 12 15 18"/></svg>';
const CHEVRON_DOWN = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>';
const CHECK = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="5 12.5 10 17.5 19 7"/></svg>';
const ROLLBACK_ICON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>';
const COLOR_RESET_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>';
const CLOSE_ICON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';

// Search ignores case and accents ("audio" finds "Áudio").
const fold = (s) => String(s || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
// Matches at the start of a word: "eco" finds "Cancelamento de eco", not "recolhida".
const hits = (text, q) => ` ${fold(text).replace(/[^a-z0-9]+/g, ' ')}`.includes(` ${q}`);

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) if (c != null && c !== false) el.append(c);
  return el;
}

export function initSettings(api) {
  const SECTIONS = [
    { id: 'account', label: 'Minha conta', icon: 'account', render: renderAccount },
    { group: 'Configurações do app' },
    { id: 'voice', label: 'Voz e vídeo', icon: 'voice', render: renderVoice },
    { id: 'share', label: 'Transmissão', icon: 'share', render: renderShare },
    { id: 'sounds', label: 'Sons', icon: 'sounds', render: renderSounds },
    { id: 'call', label: 'Chamada', icon: 'call', render: renderCall },
    { id: 'language', label: 'Idioma', icon: 'language', render: renderLanguage },
    { id: 'keys', label: 'Atalhos', icon: 'keys', render: renderKeys },
    { id: 'advanced', label: 'Avançado', icon: 'advanced', render: renderAdvanced }
  ];
  const pages = SECTIONS.filter(s => s.id);

  // ---- shell ------------------------------------------------------------------------------
  const searchInput = h('input', { type: 'search', class: 'set-search-input', placeholder: 'Buscar', 'aria-label': 'Buscar configurações', spellcheck: 'false', autocomplete: 'off' });
  const navUser = h('div', { class: 'set-nav-user' });
  const nav = h('nav', { class: 'set-nav', 'aria-label': 'Seções' });
  const title = h('h2', { class: 'set-title', id: 'settings-title' });
  const content = h('div', { class: 'set-content' });
  const empty = h('div', { class: 'set-empty hidden' });
  const scroller = h('div', { class: 'set-scroll' }, h('div', { class: 'set-page' }, title, content, empty));
  const closeBtn = h('button', { type: 'button', class: 'set-close', 'aria-label': 'Fechar configurações', html: `<span class="set-close-x">${CLOSE_ICON}</span><span class="set-close-key">ESC</span>` });
  const backBtn = h('button', { type: 'button', class: 'set-back', 'aria-label': 'Voltar', html: BACK_ICON });
  const mainEl = h('main', { class: 'set-main' }, h('div', { class: 'set-main-bar' }, backBtn, h('span', { class: 'set-main-bar-title' })), scroller, closeBtn);
  const shell = h('div', { class: 'set-shell', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'settings-title', tabindex: '-1' },
    h('aside', { class: 'set-side' },
      navUser,
      h('label', { class: 'set-search', html: SEARCH_ICON }, searchInput),
      nav),
    mainEl);
  const root = h('div', { class: 'set-backdrop hidden', id: 'settings-modal' }, shell);
  document.getElementById('app')?.append(root);

  for (const s of SECTIONS) {
    if (s.group) { nav.append(h('div', { class: 'set-nav-group' }, s.group)); continue; }
    nav.append(h('button', { type: 'button', class: 'set-nav-link', 'data-section': s.id, html: `${icon(s.icon)}<span>${s.label}</span>`, onclick: () => { clearSearch(); show(s.id, { slide: true }); } }));
    if (s.id === 'keys') nav.append(h('div', { class: 'set-nav-sep' }));
  }
  const logoutLink = h('button', { type: 'button', class: 'set-nav-link set-nav-danger', html: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg><span>Sair da conta</span>', onclick: () => askLogout() });
  nav.append(logoutLink, h('div', { class: 'set-nav-foot', 'data-no-tr': true }, 'kScreen'));

  let current = 'voice';
  let lastFocus = null;
  // Unsaved changes on the open page (Minha conta): leaving is blocked and the save bar shakes.
  let unsaved = null;
  function blockedByUnsaved() {
    if (!unsaved?.dirty()) return false;
    unsaved.warn();
    return true;
  }
  const cleanups = new Set(); // mic test, camera preview, listeners of the open page
  const openDropdowns = new Set();
  document.addEventListener('pointerdown', (e) => {
    for (const d of openDropdowns) if (!d.owns(e.target)) d.close();
  }, true);
  window.addEventListener('resize', () => { for (const d of openDropdowns) d.position(); });
  scroller.addEventListener('scroll', () => { for (const d of openDropdowns) d.position(); });

  function stopPage() {
    for (const fn of cleanups) { try { fn(); } catch { /* already gone */ } }
    cleanups.clear();
  }

  function paintNavUser() {
    const user = api.user();
    navUser.replaceChildren();
    if (!user) return;
    const name = h('span', { class: 'set-nav-user-name', 'data-no-tr': true }, user.displayName || user.username || tr('Usuário'));
    if (user.nameColor) name.style.color = user.nameColor;
    navUser.append(
      h('img', { class: 'set-nav-user-avatar', src: api.avatar(user), alt: '' }),
      h('span', { class: 'set-nav-user-text' }, name,
        h('button', { type: 'button', class: 'set-nav-user-edit', onclick: () => { clearSearch(); show('account', { slide: true }); } }, 'Ver perfil'))
    );
  }

  function show(id, { slide = false } = {}) {
    if (blockedByUnsaved()) return;
    const page = pages.find(p => p.id === id) || pages[0];
    current = page.id;
    stopPage();
    for (const link of nav.querySelectorAll('.set-nav-link[data-section]')) {
      const on = link.dataset.section === page.id && !searchInput.value.trim();
      link.classList.toggle('active', on);
      if (on) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
    }
    title.textContent = page.label;
    shell.querySelector('.set-main-bar-title').textContent = page.label;
    title.classList.remove('hidden');
    empty.classList.add('hidden');
    content.replaceChildren(sectionNode(page));
    scroller.scrollTop = 0;
    if (slide) shell.classList.add('show-page');
  }

  function sectionNode(page) {
    const box = h('section', { class: 'set-section', 'data-section': page.id });
    page.render(box);
    translateTree(box);
    return box;
  }

  // ---- search: every page rendered at once, rows that don't match are hidden -------------
  function runSearch() {
    const q = fold(searchInput.value.trim()).replace(/[^a-z0-9]+/g, ' ').trim();
    if (q && blockedByUnsaved()) { searchInput.value = ''; return; }
    if (!q) { show(current); return; }
    stopPage();
    for (const link of nav.querySelectorAll('.set-nav-link')) link.classList.remove('active');
    title.classList.add('hidden');
    const nodes = [];
    let found = 0;
    for (const page of pages) {
      const box = sectionNode(page);
      const pageHit = hits(tr(page.label), q) || hits(page.label, q);
      let any = false;
      for (const item of box.querySelectorAll('[data-search]')) {
        const match = pageHit || hits(item.dataset.search, q) || hits(item.textContent, q);
        item.classList.toggle('set-hidden', !match);
        if (match) any = true;
      }
      // A heading stays only if something under it is left.
      for (const block of box.querySelectorAll('.set-block')) {
        block.classList.toggle('set-hidden', !block.querySelector('[data-search]:not(.set-hidden)'));
      }
      if (!any) { stopPage(); continue; }
      found++;
      nodes.push(h('h3', { class: 'set-search-head', html: `${icon(page.icon, 16)}<span>${page.label}</span>`, onclick: () => { clearSearch(); show(page.id); } }), box);
    }
    content.replaceChildren(...nodes);
    empty.textContent = tr('Nada encontrado para “{q}”.').replace('{q}', searchInput.value.trim());
    empty.classList.toggle('hidden', found > 0);
    scroller.scrollTop = 0;
    shell.classList.add('show-page');
    shell.querySelector('.set-main-bar-title').textContent = tr('Resultados');
  }
  searchInput.addEventListener('input', runSearch);
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && searchInput.value) { e.preventDefault(); e.stopPropagation(); clearSearch(); show(current); }
  });
  function clearSearch() { searchInput.value = ''; }

  // ---- open / close -------------------------------------------------------------------------
  function open(section) {
    if (!api.user()) return;
    api.beforeOpen?.();
    lastFocus = document.activeElement;
    paintNavUser();
    clearSearch();
    shell.classList.remove('show-page');
    root.classList.remove('hidden');
    document.body.classList.add('settings-open');
    show(section || current, { slide: !!section });
    shell.focus({ preventScroll: true });
  }
  function close() {
    if (root.classList.contains('hidden')) return;
    if (blockedByUnsaved()) return;
    stopPage();
    root.classList.add('hidden');
    document.body.classList.remove('settings-open');
    lastFocus?.focus?.({ preventScroll: true });
  }
  const isOpen = () => !root.classList.contains('hidden');

  closeBtn.addEventListener('click', close);
  backBtn.addEventListener('click', () => { if (blockedByUnsaved()) return; clearSearch(); shell.classList.remove('show-page'); stopPage(); });
  root.addEventListener('pointerdown', (e) => { if (e.target === root) close(); });

  // Capture phase: Esc closes the window before the room's own Esc handlers see it, unless a
  // field inside (percentage pill, search) uses Esc itself, or a confirm dialog sits on top.
  window.addEventListener('keydown', (e) => {
    if (e.key === ',' && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
      if (!api.user()) return;
      e.preventDefault();
      if (isOpen()) close(); else open();
      return;
    }
    if (!isOpen() || e.key !== 'Escape') return;
    if (api.dialogOpen?.()) return;
    if (openDropdowns.size) { // Esc closes the open list first, not the window
      e.preventDefault();
      e.stopPropagation();
      for (const d of [...openDropdowns]) d.close(true);
      return;
    }
    if (document.querySelector('.color-picker-pop')) return;
    if (e.target.closest?.('.set-pill, .set-edit') || (e.target === searchInput && searchInput.value)) return;
    e.preventDefault();
    e.stopPropagation();
    close();
  }, true);

  // Keep Tab inside the window.
  shell.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const items = [...shell.querySelectorAll('button, input, select, [tabindex="0"]')].filter(el => !el.disabled && el.offsetParent !== null);
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === shell)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  // Devices plugged in / out while the voice page is open.
  navigator.mediaDevices?.addEventListener?.('devicechange', () => {
    if (isOpen() && current === 'voice' && !searchInput.value.trim()) show('voice');
  });

  // ---- building blocks ---------------------------------------------------------------------
  function block(heading, ...items) {
    return h('div', { class: 'set-block' }, heading ? h('h4', { class: 'set-block-title' }, heading) : null, ...items);
  }

  function note(text, kind = '') {
    return h('p', { class: `set-note ${kind}` }, text);
  }

  // On/off row: label + hint on the left, switch on the right.
  function switchItem(label, hint, checked, onChange, { disabled = false, search = '' } = {}) {
    const input = h('input', { type: 'checkbox', role: 'switch' });
    input.checked = !!checked;
    input.disabled = disabled;
    input.addEventListener('change', () => onChange(input.checked, input));
    return h('label', { class: `set-row set-switch${disabled ? ' disabled' : ''}`, 'data-search': `${label} ${hint} ${search}` },
      h('span', { class: 'set-row-text' }, h('span', { class: 'set-row-label' }, label), hint ? h('span', { class: 'set-row-hint' }, hint) : null),
      input, h('span', { class: 'k-switch', 'aria-hidden': 'true' }));
  }

  // Label above, control below (selects, sliders, segmented choices).
  function field(label, control, hint = '', search = '') {
    return h('div', { class: 'set-field', 'data-search': `${label} ${hint} ${search}` },
      h('div', { class: 'set-field-label' }, label),
      control,
      hint ? h('div', { class: 'set-row-hint' }, hint) : null);
  }

  // Dropdown with the web player's look and behaviour (Kennyy-Monochrome js/dropdown.js):
  // trigger + popover list with a check on the chosen item, arrows / Home / End / Enter / Esc and
  // type-ahead. The list sits in the top layer, so the settings window never clips it.
  let dropSeq = 0;
  function select(items, value, onChange, label) {
    let current = value;
    let opened = false;
    let active = -1;
    const id = `set-dd-${++dropSeq}`;
    const valueEl = h('span', { class: 'ui-dropdown-value' });
    const trigger = h('button', { type: 'button', class: 'ui-dropdown-trigger', role: 'combobox', 'aria-label': label, 'aria-haspopup': 'listbox', 'aria-expanded': 'false', 'aria-controls': id },
      valueEl, h('span', { class: 'ui-dropdown-arrow', html: CHEVRON_DOWN }));
    const list = h('span', { class: 'ui-dropdown-list', id, role: 'listbox', 'aria-label': label, tabindex: '0' });
    const menu = h('span', { class: 'ui-dropdown-menu', popover: 'manual' }, list);
    const hasPopover = typeof menu.showPopover === 'function';
    if (!hasPopover) menu.removeAttribute('popover');
    const wrap = h('span', { class: 'ui-dropdown' }, trigger, menu);

    const paintValue = () => {
      const item = items.find(it => it.id === current);
      valueEl.replaceChildren(h('span', { class: 'ui-dropdown-text' }, item ? item.label : ''));
    };
    const rows = items.map((it, i) => {
      const row = h('span', { class: 'ui-dropdown-option', role: 'option', id: `${id}-${i}` },
        h('span', { class: 'ui-dropdown-text' }, it.label), h('span', { class: 'ui-dropdown-check', html: CHECK }));
      row.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); choose(i); });
      row.addEventListener('pointermove', () => focusOption(i, false));
      list.append(row);
      return row;
    });
    const paintRows = () => rows.forEach((r, i) => r.setAttribute('aria-selected', String(items[i].id === current)));

    function focusOption(i, scroll = true) {
      active = Math.max(0, Math.min(i, rows.length - 1));
      rows.forEach((r, k) => r.classList.toggle('is-active', k === active));
      if (rows[active]) {
        list.setAttribute('aria-activedescendant', rows[active].id);
        if (scroll) rows[active].scrollIntoView({ block: 'nearest' });
      }
    }
    function position() {
      if (!opened) return;
      const rect = trigger.getBoundingClientRect();
      const vh = window.innerHeight;
      const vw = window.innerWidth;
      const below = vh - rect.bottom - 12;
      const above = rect.top - 12;
      const upward = below < 220 && above > below;
      const height = Math.min(320, Math.max(100, upward ? above : below));
      menu.style.width = 'max-content';
      menu.style.minWidth = `${Math.min(rect.width, vw - 24)}px`;
      menu.style.maxWidth = `${vw - 24}px`;
      menu.style.maxHeight = `${height}px`;
      const mw = menu.getBoundingClientRect().width || rect.width;
      const mh = Math.min(menu.scrollHeight, height);
      menu.style.left = `${Math.max(12, Math.min(rect.left, vw - mw - 12))}px`;
      menu.style.top = `${upward ? Math.max(12, rect.top - mh - 6) : rect.bottom + 6}px`;
    }
    function open() {
      if (opened || !rows.length) return;
      for (const other of openDropdowns) other.close();
      opened = true;
      openDropdowns.add(api_);
      paintRows();
      if (hasPopover) menu.showPopover(); else menu.classList.add('is-open');
      trigger.setAttribute('aria-expanded', 'true');
      position();
      focusOption(Math.max(0, items.findIndex(it => it.id === current)));
      list.focus({ preventScroll: true });
    }
    function close(restoreFocus = false) {
      if (!opened) return;
      opened = false;
      openDropdowns.delete(api_);
      if (hasPopover) { try { menu.hidePopover(); } catch { /* already gone */ } } else menu.classList.remove('is-open');
      trigger.setAttribute('aria-expanded', 'false');
      if (restoreFocus && trigger.isConnected) trigger.focus({ preventScroll: true });
    }
    function choose(i) {
      const it = items[i];
      if (!it) return;
      const changed = it.id !== current;
      current = it.id;
      paintValue();
      paintRows();
      close(true);
      if (changed) onChange(it.id);
    }
    const api_ = { close, position, owns: (el) => wrap.contains(el) };

    trigger.addEventListener('click', (e) => { e.preventDefault(); if (opened) close(); else open(); });
    trigger.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); open(); }
    });
    menu.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
      else if (e.key === 'Tab') close(true);
      else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
        e.preventDefault();
        focusOption(e.key === 'Home' ? 0 : e.key === 'End' ? rows.length - 1 : active + (e.key === 'ArrowDown' ? 1 : -1));
      } else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(active); }
      else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
        const i = items.findIndex(it => fold(it.label).startsWith(fold(e.key)));
        if (i >= 0) { e.preventDefault(); focusOption(i); }
      }
    });
    cleanups.add(() => close());
    paintValue();
    return wrap;
  }

  // Slider + typable percentage (same behaviour as the dock's voice menu).
  function slider(value, onChange, { max = 200, label = '', suffix = '%' } = {}) {
    const range = h('input', { type: 'range', min: '0', max: String(max), step: '1', class: 'device-slider set-range', 'aria-label': label });
    const pill = h('input', { type: 'text', class: 'device-volume-pill set-pill', inputmode: 'numeric', maxlength: '4', spellcheck: 'false', 'aria-label': `${label} em porcentagem` });
    const paint = (v) => {
      if (document.activeElement !== pill) pill.value = `${v}${suffix}`;
      range.style.setProperty('--fill', `${v * 100 / max}%`);
    };
    const set = (v, notify = true) => { range.value = v; paint(v); if (notify) onChange(v); };
    range.value = value;
    paint(value);
    range.addEventListener('input', () => { paint(Number(range.value)); onChange(Number(range.value)); });
    pill.addEventListener('focus', () => { pill.value = pill.value.replace(suffix, ''); pill.select(); });
    pill.addEventListener('blur', () => set(Math.max(0, Math.min(max, parseInt(pill.value.replace(/\D/g, ''), 10) || 0))));
    pill.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') pill.blur();
      if (e.key === 'Escape') { e.stopPropagation(); pill.value = `${range.value}`; pill.blur(); }
    });
    const box = h('div', { class: 'set-slider' }, range, pill);
    box.set = set;
    return box;
  }

  // Segmented choice (Discord's "pill" radio group).
  let segId = 0;
  function segmented(options, value, onChange, label) {
    const name = `set-seg-${++segId}`;
    const box = h('div', { class: 'set-seg', role: 'radiogroup', 'aria-label': label });
    for (const o of options) {
      const input = h('input', { type: 'radio', name, value: String(o.id) });
      input.checked = String(o.id) === String(value);
      input.addEventListener('change', () => { if (input.checked) onChange(o.id); });
      box.append(h('label', { title: o.title || null }, input, h('span', {}, o.label, o.detail ? h('small', {}, o.detail) : null)));
    }
    return box;
  }

  function button(label, onClick, kind = '') {
    return h('button', { type: 'button', class: `set-btn ${kind}`, onclick: onClick }, label);
  }

  // ---- Minha conta ---------------------------------------------------------------------------
  // Display name and profile colour can be changed by every account; the username and the photo
  // of Discord accounts come from Discord. Guests change their photo by clicking it.
  function renderAccount(box) {
    const user = api.user();
    if (!user) return;
    const DEFAULT_COLOR = '#e8365d';
    const nameOf = (u) => u.displayName || u.username || tr('Usuário');

    const name = h('div', { class: 'set-profile-name', 'data-no-tr': true });
    // Guests: the photo is a button ("Trocar foto" on hover). Discord: the Discord photo.
    const avatarImg = h('img', { class: 'set-profile-avatar', src: api.avatar(user), alt: '' });
    const avatarPick = user.guest
      ? h('button', { type: 'button', class: 'set-profile-avatar-pick', title: tr('Trocar foto'), 'aria-label': tr('Trocar foto') },
        avatarImg, h('span', { class: 'set-profile-avatar-hint' }, tr('Trocar foto')))
      : avatarImg;
    const chips = h('div', { class: 'set-profile-chips' },
      user.guest ? h('span', { class: 'set-chip' }, 'Convidado') : h('span', { class: 'set-chip is-discord', 'data-no-tr': true }, 'Discord'),
      user.admin ? h('span', { class: 'set-chip is-admin' }, 'Admin') : null);
    const card = h('div', { class: 'set-profile', 'data-search': 'perfil avatar foto nome banner' },
      h('div', { class: 'set-profile-banner' }),
      h('div', { class: 'set-profile-body' },
        avatarPick,
        h('div', { class: 'set-profile-text' }, name,
          user.guest ? null : h('div', { class: 'set-profile-user', 'data-no-tr': true }, `@${user.username || ''}`)),
        chips));
    // Name colour and banner follow the profile colour (live while the picker is open).
    const paintProfile = (u, color = u.nameColor) => {
      name.textContent = nameOf(u);
      name.style.color = color || '';
      card.style.setProperty('--profile-color', color || DEFAULT_COLOR);
    };
    paintProfile(user);

    const save = async (changes) => {
      try {
        const updated = await api.updateProfile(changes);
        paintNavUser();
        return updated;
      } catch (err) {
        api.toast(err?.message || tr('Não foi possível salvar. Tente de novo.'));
        return null;
      }
    };

    // Name and colour are a draft: nothing is saved until "Salvar" on the bar at the bottom
    // (Discord). Each field shows a rollback icon while it differs from what is saved.
    const saved = () => api.user();
    // photo (guests): undefined = unchanged, or the data URL of the new one.
    const draft = { name: nameOf(user), color: user.nameColor || null, photo: undefined };
    const cleanName = (v) => v.replace(/\s+/g, ' ').trim();
    const nameDirty = () => cleanName(draft.name) !== nameOf(saved());
    const colorDirty = () => (draft.color || null) !== (saved().nameColor || null);
    const photoDirty = () => draft.photo !== undefined;
    const dirty = () => nameDirty() || colorDirty() || photoDirty();
    const rollback = (label, onClick) => h('button', { type: 'button', class: 'set-rollback', title: tr(label), 'aria-label': tr(label), html: ROLLBACK_ICON, onclick: onClick });

    // Display name: always a field.
    const nameInput = h('input', { type: 'text', class: 'set-edit-input', maxlength: '32', spellcheck: 'false', autocomplete: 'off', 'aria-label': tr('Nome de exibição'), placeholder: user.guest ? '' : (user.discordName || user.username || '') });
    nameInput.value = draft.name;
    const nameError = h('div', { class: 'set-edit-error hidden', role: 'alert' });
    const nameUndo = rollback('Desfazer alteração', () => { draft.name = nameOf(saved()); nameInput.value = draft.name; refresh(); nameInput.focus(); });
    nameInput.addEventListener('input', () => { draft.name = nameInput.value; nameError.classList.add('hidden'); refresh(); });
    nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } });
    const nameRow = h('div', { class: 'set-info-row set-field-row', 'data-search': 'nome de exibição apelido nick editar' },
      h('div', {},
        h('div', { class: 'set-info-label' }, tr('Nome de exibição')),
        h('div', { class: 'set-field-line' }, nameInput, nameUndo),
        nameError,
        user.guest ? null : h('div', { class: 'set-row-hint' }, tr('Deixe vazio para usar o nome do Discord.'))));

    // Profile colour: the same swatch + hex bar as the guest login. Empty = Automática.
    const colorChip = h('button', { type: 'button', class: 'set-color-chip', 'aria-label': tr('Escolher cor do perfil') });
    const colorHex = h('input', { type: 'text', class: 'set-color-hex', maxlength: '7', spellcheck: 'false', autocomplete: 'off', 'aria-label': tr('Cor do perfil (hex)'), 'data-no-tr': true });
    colorHex.placeholder = `${tr('Automática')} (${DEFAULT_COLOR.toUpperCase()})`;
    // Back to the factory colour (Automática): goes into the draft like any other change.
    const colorAuto = h('button', { type: 'button', class: 'set-color-auto', title: tr('Usar a cor automática'), 'aria-label': tr('Usar a cor automática'), html: COLOR_RESET_ICON,
      onclick: () => { closeColorPicker(); draft.color = null; paintColor(true); refresh(); colorHex.focus(); } });
    const colorUndo = rollback('Desfazer alteração', () => { closeColorPicker(); draft.color = saved().nameColor || null; paintColor(true); refresh(); });
    colorChip.addEventListener('click', () => {
      let armed = false;
      openColorPicker({
        anchor: colorChip,
        value: draft.color || DEFAULT_COLOR,
        onInput: (hex) => {
          if (!armed) return; // the picker reports its starting value once
          draft.color = hex;
          paintColor(true);
          refresh();
        }
      });
      armed = true;
    });
    colorHex.addEventListener('input', () => {
      let raw = colorHex.value.trim();
      if (!raw) draft.color = null;
      else {
        if (!raw.startsWith('#')) raw = `#${raw}`;
        if (!/^#[0-9a-f]{6}$/i.test(raw)) return;
        draft.color = raw.toLowerCase();
      }
      paintColor(false);
      refresh();
    });
    colorHex.addEventListener('blur', () => paintColor(true));
    colorHex.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } });
    function paintColor(field) {
      colorChip.style.background = draft.color || DEFAULT_COLOR;
      colorChip.classList.toggle('is-auto', !draft.color);
      colorAuto.classList.toggle('hidden', !draft.color);
      if (field) colorHex.value = draft.color ? draft.color.toUpperCase() : '';
    }
    paintColor(true);
    const colorRow = h('div', { class: 'set-info-row set-field-row', 'data-search': 'cor do perfil banner nome cor editar' },
      h('div', {},
        h('div', { class: 'set-info-label' }, tr('Cor do perfil')),
        h('div', { class: 'set-field-line' }, h('div', { class: 'set-color-bar' }, colorChip, colorHex, colorAuto), colorUndo)));

    // Guest photo: kept in this browser and sent to the others straight through the call (like
    // the guest login); the server only signs its fingerprint.
    const photoInput = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', hidden: true });
    if (user.guest) {
      avatarPick.addEventListener('click', () => photoInput.click());
      avatarPick.after(photoInput);
    }
    photoInput.addEventListener('change', async () => {
      const file = photoInput.files[0];
      photoInput.value = '';
      if (!file) return;
      try {
        draft.photo = await api.preparePhoto(file);
      } catch (err) {
        api.toast(err?.message || tr('Não foi possível ler essa imagem. Tente outro formato.'));
      }
      refresh();
    });

    // "Não se esqueça de salvar suas alterações!" while something differs.
    const resetAll = h('button', { type: 'button', class: 'set-savebar-reset' }, tr('Redefinir'));
    const saveAll = h('button', { type: 'button', class: 'set-btn accent' }, tr('Salvar'));
    const bar = h('div', { class: 'set-savebar', role: 'status', 'aria-live': 'polite' },
      h('span', { class: 'set-savebar-text' }, tr('Não se esqueça de salvar suas alterações!')), resetAll, saveAll);
    resetAll.addEventListener('click', () => {
      closeColorPicker();
      draft.name = nameOf(saved());
      draft.color = saved().nameColor || null;
      draft.photo = undefined;
      nameInput.value = draft.name;
      nameError.classList.add('hidden');
      paintColor(true);
      refresh();
    });
    saveAll.addEventListener('click', () => commit());
    mainEl.append(bar);
    cleanups.add(() => { bar.remove(); unsaved = null; });
    unsaved = {
      dirty,
      warn() {
        bar.classList.remove('is-warning');
        void bar.offsetWidth; // restart the shake
        bar.classList.add('is-warning');
      }
    };

    function refresh() {
      paintProfile({ ...saved(), displayName: cleanName(draft.name) || nameOf(saved()) }, draft.color);
      nameUndo.classList.toggle('is-on', nameDirty());
      colorUndo.classList.toggle('is-on', colorDirty());
      const src = draft.photo || api.avatar(saved());
      if (avatarImg.getAttribute('src') !== src) avatarImg.src = src;
      const on = dirty();
      bar.classList.toggle('is-on', on);
      if (!on) bar.classList.remove('is-warning');
    }

    async function commit() {
      if (!dirty() || saveAll.disabled) return;
      const current = saved();
      const changes = {};
      if (nameDirty()) {
        const value = cleanName(draft.name);
        if (value.length < 2 && (current.guest || value)) {
          nameError.textContent = tr('O nome precisa ter pelo menos 2 caracteres.');
          nameError.classList.remove('hidden');
          nameInput.focus();
          return;
        }
        changes.displayName = value;
      }
      if (colorDirty()) changes.nameColor = draft.color || null;
      closeColorPicker();
      saveAll.disabled = true;
      if (draft.photo) {
        try {
          Object.assign(changes, await api.savePhoto(draft.photo));
        } catch {
          saveAll.disabled = false;
          api.toast(tr('Não foi possível salvar. Tente de novo.'));
          return;
        }
      }
      const updated = await save(changes);
      saveAll.disabled = false;
      if (!updated) return;
      draft.name = nameOf(updated);
      draft.color = updated.nameColor || null;
      draft.photo = undefined;
      nameInput.value = draft.name;
      paintColor(true);
      refresh();
    }
    refresh();

    const infoRow = (label, value, search = '') => h('div', { class: 'set-info-row', 'data-search': `${label} ${search}` },
      h('div', {}, h('div', { class: 'set-info-label' }, label), h('div', { class: 'set-info-value', 'data-no-tr': true }, value)));
    const info = h('div', { class: 'set-info' },
      nameRow,
      user.guest ? null : infoRow(tr('Nome de usuário'), user.username || '—', 'discord'),
      colorRow,
      infoRow(tr('Tipo de conta'), user.guest ? tr('Convidado (só neste navegador)') : 'Discord'));

    box.append(card, info,
      note(user.guest
        ? 'Dica: Você pode trocar sua foto de perfil clicando nela.'
        : 'Nome de usuário e foto vêm do seu Discord. O nome de exibição e a cor ficam salvos neste navegador.'),
      block('Sessão',
        h('div', { class: 'set-row', 'data-search': 'sair logout desconectar sessão' },
          h('span', { class: 'set-row-text' }, h('span', { class: 'set-row-label' }, 'Sair da conta'),
            h('span', { class: 'set-row-hint' }, api.inRoom() ? 'Você sai da chamada e volta para o login.' : 'Volta para a tela de login.')),
          button('Desconectar', askLogout, 'danger'))));
  }

  async function askLogout() {
    const ok = await api.confirm({ title: 'Sair da conta?', message: api.inRoom() ? 'Você sairá da chamada e da sua conta.' : 'Você voltará para a tela de login.', confirmLabel: 'Desconectar', danger: true });
    if (!ok) return;
    close();
    api.logout();
  }

  // ---- Voz e vídeo ----------------------------------------------------------------------------
  function renderVoice(box) {
    const v = api.voice;
    const prefs = v.prefs;
    const inputs = h('div', { class: 'set-grid2' });

    // Filled asynchronously (device names appear after a permission prompt).
    const fillDevices = async () => {
      const [mics, outs] = await Promise.all([v.listDevices('audioinput'), v.canPickOutput ? v.listDevices('audiooutput') : []]);
      const toItems = (list) => list.map(d => ({ id: d.id, label: d.id === 'default' ? `${tr('Padrão')} · ${tr(d.title)}` : (d.detail ? `${d.title} (${d.detail})` : d.title) }));
      const micSel = mics.length ? v.selectedId('audioinput', mics) : '';
      const nodes = [field('Dispositivo de entrada', mics.length
        ? select(toItems(mics), micSel, async (id) => { await v.pick('audioinput', id); if (micTest.running) micTest.restart(); }, 'Dispositivo de entrada')
        : h('div', { class: 'set-select-empty' }, 'Nenhum microfone encontrado'), '', 'microfone mic input')];
      if (v.canPickOutput) {
        nodes.push(field('Dispositivo de saída', select(toItems(outs), v.selectedId('audiooutput', outs), async (id) => { await v.pick('audiooutput', id); if (micTest.running) micTest.restart(); }, 'Dispositivo de saída'), '', 'alto-falante fone headset output'));
      }
      inputs.replaceChildren(...nodes);
    };
    fillDevices();
    // Without permission the browser hides names: one tap lists them all.
    const unlock = h('button', { type: 'button', class: 'set-link hidden' }, 'Mostrar nomes dos dispositivos');
    unlock.addEventListener('click', async () => { await v.ensureAccess('audioinput'); unlock.classList.add('hidden'); fillDevices(); });
    v.needsAccess('audioinput').then(need => unlock.classList.toggle('hidden', !need));

    const volumes = h('div', { class: 'set-grid2 set-gap-top' },
      field('Volume de entrada', slider(prefs.micVolume, (x) => { v.setMicVolume(x); micTest.handle?.setMicVolume(x); }, { label: 'Volume de entrada' }), '', 'microfone'),
      field('Volume de saída', slider(prefs.outVolume, (x) => { v.setOutVolume(x); micTest.handle?.setOutputVolume(x); }, { label: 'Volume de saída' }), 'Vale para a sala toda e para os sons.', 'alto-falante'));

    // Mic test (Discord's "Vamos verificar"): you hear yourself exactly as the others do, through
    // the same noise suppressor. The room goes quiet meanwhile (deafened) and comes back after.
    const meterFill = h('div', { class: 'set-meter-fill' });
    const meter = h('div', { class: 'set-meter', 'aria-hidden': 'true' }, meterFill);
    const testBtn = button('Teste do microfone', () => (micTest.running ? micTest.stop() : micTest.start()), 'accent');
    const idleHint = () => tr(api.inRoom()
      ? 'Você vai se ouvir como os outros te ouvem. O áudio da sala fica mudo durante o teste.'
      : 'Você vai se ouvir como os outros te ouvem. Use fones para não dar eco.');
    const testStatus = h('div', { class: 'set-row-hint' }, idleHint());
    let testRun = 0;
    const micTest = {
      running: false, handle: null, raf: 0,
      async start() {
        const run = ++testRun;
        testBtn.disabled = true;
        try {
          await v.testDeafen(true);
          const handle = await v.openMicTest();
          if (run !== testRun) { handle.close(); return; } // stopped while opening
          this.handle = handle;
          this.running = true;
          testBtn.textContent = tr('Parar teste');
          testStatus.textContent = tr(handle.suppressed ? 'Ouvindo seu microfone, com a supressão de ruído…' : 'Ouvindo seu microfone…');
          meter.classList.add('live');
          const buf = new Float32Array(handle.analyser.fftSize);
          const tick = () => {
            if (!this.running) return;
            handle.analyser.getFloatTimeDomainData(buf);
            let sum = 0;
            for (const x of buf) sum += x * x;
            const db = 20 * Math.log10(Math.sqrt(sum / buf.length) || 1e-8);
            const level = Math.max(0, Math.min(1, (db + 60) / 60));
            meterFill.style.width = `${Math.round(level * 100)}%`;
            meter.classList.toggle('hot', level > 0.92);
            this.raf = requestAnimationFrame(tick);
          };
          tick();
          cleanups.add(this.stopFn);
        } catch (err) {
          if (run !== testRun) return;
          this.stop();
          testStatus.textContent = tr(err?.name === 'NotAllowedError' ? 'Permissão do microfone negada.' : 'Não foi possível abrir o microfone.');
        } finally {
          if (run === testRun) testBtn.disabled = false;
        }
      },
      stop(keepDeafen = false) {
        testRun++;
        this.running = false;
        cancelAnimationFrame(this.raf);
        this.handle?.close();
        this.handle = null;
        if (!keepDeafen) v.testDeafen(false);
        meterFill.style.width = '0%';
        meter.classList.remove('live', 'hot');
        testBtn.disabled = false;
        testBtn.textContent = tr('Teste do microfone');
        testStatus.textContent = idleHint();
        cleanups.delete(this.stopFn);
      },
      async restart() { this.stop(true); await this.start(); }
    };
    micTest.stopFn = () => micTest.stop();

    const test = h('div', { class: 'set-field set-gap-top', 'data-search': 'teste do microfone verificar ouvir voz nível' },
      h('div', { class: 'set-mictest' }, testBtn, meter),
      testStatus);

    // Voice processing: same switches as the voice menu.
    const strength = field('Intensidade da supressão', slider(prefs.noiseStrength, (x) => { v.setProcessing({ noiseStrength: x }); micTest.handle?.setStrength(x); }, { max: 100, label: 'Intensidade da supressão' }), 'Mais alto corta mais ruído, mas pode abafar a voz.', 'ruído');
    strength.classList.toggle('set-hidden-soft', !prefs.noiseSuppression);
    const processing = block('Processamento de voz',
      switchItem('Supressão de ruído', 'Remove teclado, ventilador e barulho de fundo (RNNoise), e silencia as pausas entre as falas.', prefs.noiseSuppression, (on) => {
        v.setProcessing({ noiseSuppression: on });
        strength.classList.toggle('set-hidden-soft', !on);
        if (micTest.running) micTest.restart();
      }, { search: 'noise' }),
      strength,
      switchItem('Cancelamento de eco', 'Evita que os outros ouçam o próprio áudio voltando pelo seu microfone.', prefs.echoCancellation, (on) => {
        v.setProcessing({ echoCancellation: on });
        if (micTest.running) micTest.restart();
      }, { search: 'echo' }));

    // Camera: device + preview (uses the live camera when it is already on in the room).
    const camField = h('div');
    const video = h('video', { class: 'set-cam-video', autoplay: true, playsinline: true, muted: true });
    video.muted = true;
    const camPlaceholder = h('div', { class: 'set-cam-empty', html: '<svg width="40" height="40" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17 10.5V7a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3.5l4 4v-11l-4 4z"/></svg>' });
    const camBtn = button('Testar vídeo', () => (cam.stream ? cam.stop() : cam.start()), 'accent');
    const camStatus = h('div', { class: 'set-row-hint' });
    const camBox = h('div', { class: 'set-cam' }, video, camPlaceholder);
    const cam = {
      stream: null, own: false,
      async start() {
        camBtn.disabled = true;
        try {
          const live = v.cameraStream();
          if (live) { this.stream = live; this.own = false; }
          else {
            const id = prefs.cam && prefs.cam !== 'default' ? prefs.cam : null;
            this.stream = await navigator.mediaDevices.getUserMedia({ video: { ...(id ? { deviceId: { exact: id } } : {}), width: { ideal: 1280 }, height: { ideal: 720 } } });
            this.own = true;
          }
          video.srcObject = this.stream;
          video.play().catch(() => {});
          camBox.classList.add('live');
          camBtn.textContent = tr('Parar vídeo');
          camStatus.textContent = tr(this.own ? 'Só você vê esta prévia.' : 'Sua câmera já está ligada na sala.');
          cleanups.add(this.stopFn);
          fillCams();
        } catch (err) {
          this.stop();
          camStatus.textContent = tr(err?.name === 'NotAllowedError' ? 'Permissão da câmera negada.' : 'Não foi possível abrir a câmera.');
        } finally {
          camBtn.disabled = false;
        }
      },
      stop() {
        if (this.own) for (const t of this.stream?.getTracks() || []) t.stop();
        this.stream = null;
        this.own = false;
        video.srcObject = null;
        camBox.classList.remove('live');
        camBtn.textContent = tr('Testar vídeo');
        camStatus.textContent = '';
        cleanups.delete(this.stopFn);
      }
    };
    cam.stopFn = () => cam.stop();
    const camUnlock = h('button', { type: 'button', class: 'set-link hidden' }, 'Mostrar nomes das câmeras');
    camUnlock.addEventListener('click', async () => { await v.ensureAccess('videoinput'); camUnlock.classList.add('hidden'); fillCams(); });
    const fillCams = async () => {
      // Before the camera permission the browser lists nothing: the system default still works.
      const need = await v.needsAccess('videoinput');
      camUnlock.classList.toggle('hidden', !need);
      let cams = await v.listDevices('videoinput');
      if (!cams.length && need) cams = [{ id: 'default', title: tr('Câmera padrão'), detail: '' }];
      camField.replaceChildren(field('Câmera', cams.length
        ? select(cams.map(d => ({ id: d.id, label: d.detail ? `${d.title} (${d.detail})` : d.title })), v.selectedId('videoinput', cams), async (id) => {
          const wasOn = !!cam.stream;
          cam.stop();
          await v.pick('videoinput', id);
          if (wasOn) cam.start();
        }, 'Câmera')
        : h('div', { class: 'set-select-empty' }, 'Nenhuma câmera encontrada'), '', 'webcam'), camUnlock);
    };
    fillCams();
    const videoBlock = block('Vídeo',
      h('div', { class: 'set-field', 'data-search': 'câmera webcam vídeo prévia testar' }, camField, camBox, h('div', { class: 'set-mictest-foot' }, camStatus, camBtn)));

    box.append(block('', inputs, unlock, volumes, test), processing, videoBlock);
    if (v.noiseFallback()) processing.append(note('O supressor RNNoise não carregou neste navegador: está sendo usado o do próprio navegador.', 'warn'));
  }

  // ---- Transmissão ---------------------------------------------------------------------------
  function renderShare(box) {
    const s = api.share;
    const cur = s.get();
    const status = h('div', { class: 'set-live hidden' });
    const paintStatus = () => {
      const live = s.isLive();
      status.classList.toggle('hidden', !live);
      if (live) status.innerHTML = `<span class="set-live-dot"></span><span>${tr('Você está ao vivo. As mudanças valem na hora.')}</span>`;
    };
    paintStatus();
    const resolution = segmented(Object.entries(s.RESOLUTIONS).map(([id, p]) => ({ id, label: tr(p.label), title: p.width ? `${p.width}×${p.height}` : tr('Resolução original da tela') })), cur.resolution, (resolution) => s.set({ resolution }), 'Resolução');
    const fps = segmented(s.FPS.map(f => ({ id: f, label: `${f} FPS` })), cur.fps, (f) => s.set({ fps: Number(f) }), 'Taxa de quadros');
    const audio = segmented(Object.entries(s.AUDIO).map(([id, q]) => ({ id, label: tr(q.label), detail: q.detail })), cur.audioQuality, (audioQuality) => s.set({ audioQuality }), 'Qualidade do áudio');
    box.append(status,
      block('Qualidade da transmissão',
        field('Resolução', resolution, '“Fonte” mantém a resolução da tela ou janela compartilhada.', 'qualidade 1080p 720p 1440p'),
        field('Taxa de quadros', fps, '60 FPS para jogos e vídeos; 15 FPS economiza internet.', 'fps quadros'),
        note('Se a rede ou o processador não aguentarem, a resolução cai antes dos FPS, para a imagem não travar.')),
      block('Áudio da transmissão',
        field('Qualidade do áudio', audio, 'Sempre estéreo (Opus). 510 kbps é o máximo que o WebRTC permite.', 'som bitrate kbps estéreo'),
        s.isLive()
          ? switchItem('Compartilhar áudio da transmissão', s.hasAudio() ? 'Liga ou silencia o som do que você está transmitindo.' : 'Esta transmissão não tem áudio.', s.hasAudio() && s.audioEnabled(), (on) => s.setAudioEnabled(on), { disabled: !s.hasAudio() })
          : note('O áudio da transmissão pode ser ligado ou silenciado pelo menu da transmissão enquanto você estiver ao vivo.')));
    // Instant Replay exists only in the desktop app (api.replay.available() is false elsewhere).
    if (api.replay?.available()) box.append(replayBlock(api.replay, s.isLive()));
  }

  // Shown only when clips can't be encoded on the GPU: the problem and what to install for this
  // distro and GPU (built by the app from each distro's docs: platform/linux.js). With a GPU
  // encoder (or while it's still being checked) nothing is shown.
  function gpuBlock(r) {
    if (r.hwEncoder() !== false) return null;
    const guide = r.gpuGuide();
    const rows = [h('div', { class: 'set-row', 'data-search': 'placa vídeo gpu encoder vaapi driver processador' },
      h('span', { class: 'set-row-text' },
        h('span', { class: 'set-row-label' }, 'Gravando pelo processador'),
        h('span', { class: 'set-row-hint set-warn-text' }, 'Sem encoder de vídeo na placa: os clipes são gravados pelo processador, em até 720p a 30 FPS.')))];
    if (!guide) {
      rows.push(note('Atualize o driver da sua placa de vídeo para gravar pela placa.'));
      return h('div', {}, rows);
    }
    const detected = [guide.distro, guide.vendor && tr('placa {vendor}').replace('{vendor}', guide.vendor)].filter(Boolean).join(' · ');
    rows.push(note(tr('Detectado: {what}').replace('{what}', detected)));
    if (guide.note) rows.push(note(guide.note, guide.unsupported ? '' : 'warn'));
    if (guide.steps?.length) {
      rows.push(h('ol', { class: 'set-steps' }, guide.steps.map(step => h('li', { class: step.done ? 'done' : '' },
        h('span', {}, step.text),
        step.done ? h('span', { class: 'set-step-done' }, 'Já instalado') : null,
        step.cmd ? h('div', { class: 'set-cmd' },
          h('code', { class: 'set-code', 'data-no-tr': '' }, step.cmd),
          button('Copiar', () => navigator.clipboard?.writeText(step.cmd).catch(() => {}))) : null))));
    }
    if (guide.sources?.length) {
      rows.push(h('p', { class: 'set-note set-sources' }, tr('Fonte:'), ' ',
        guide.sources.map((s, i) => [i ? ' · ' : '', h('a', { href: s.url, target: '_blank', rel: 'noreferrer', 'data-no-tr': '' }, s.name)])));
    }
    return h('div', { class: 'set-gpu-guide' }, rows);
  }

  function replayBlock(r, live) {
    const cur = r.get();
    const items = [
      // The page redraws itself when the replay reports the change (main.js, replayChanged).
      switchItem('Instant Replay', 'Guarda os últimos segundos da sua transmissão na memória para salvar como clipe. Só funciona enquanto você transmite.', cur.enabled, (on) => r.set({ enabled: on }), { search: 'clipe clip replay gravar salvar' })
    ];
    if (cur.enabled) {
      items.push(
        field('Duração do clipe', segmented(r.durations().map(n => ({ id: n, label: `${n} s` })), cur.seconds, (seconds) => r.set({ seconds: Number(seconds) }), 'Duração do clipe'),
          'Quanto tempo para trás o clipe guarda.', 'segundos tempo'),
        field('Atalho para salvar', select(r.hotkeys().map(k => ({ id: k, label: k })), cur.hotkey, (hotkey) => r.set({ hotkey }), 'Atalho para salvar'),
          'Funciona mesmo com o jogo em primeiro plano, enquanto o Instant Replay estiver ativo. Nesse tempo a tecla não chega ao jogo.', 'tecla atalho hotkey'),
        switchItem('Gravar o microfone', 'Sua voz, como a sala ouve (com a supressão de ruído).', cur.mic !== false, (on) => r.set({ mic: on }), { search: 'voz microfone mic' }),
        switchItem('Gravar o microfone mesmo mutado', 'Sua voz vai para o clipe mesmo com o microfone mutado na sala. Só fica no seu computador: a sala continua sem ouvir nada. O microfone fica aberto enquanto você transmite.', cur.mic !== false && !!cur.micAlways, (on) => r.set({ micAlways: on }), { disabled: cur.mic === false, search: 'mudo mutado sempre voz' }),
        switchItem('Gravar as vozes da sala', 'As vozes de quem está na sala, como você ouve (com os volumes que você ajustou). Fica só no seu computador.', !!cur.voices, (on) => r.set({ voices: on }), { search: 'vozes sala chamada amigos call' }));
      if (r.pcAudioAvailable()) {
        items.push(switchItem('Gravar todo o som do PC', 'O clipe pega todo o som do PC, inclusive os apps que você excluiu da transmissão, mesmo se ela estiver sem áudio ou silenciada. As vozes da sala só entram pela opção acima.', !!cur.pcAudio, (on) => r.set({ pcAudio: on }), { search: 'som pc sistema áudio sempre' }));
      }
      items.push(field('Faixas de áudio', segmented([
        { id: 'mixed', label: 'Tudo junto', detail: 'uma faixa' },
        { id: 'separate', label: 'Separadas', detail: 'uma por fonte' }
      ], cur.micMode === 'separate' ? 'separate' : 'mixed', (micMode) => r.set({ micMode }), 'Faixas de áudio'),
      'Tudo junto: transmissão, microfone e vozes numa faixa só, que toca em qualquer player ou chat. Separadas: cada som numa faixa, para ajustar num editor de vídeo.', 'faixa trilha voz separada junto mistura canal'));
      const sc = r.shortcut();
      if (sc.bindLine) {
        // Hyprland: the key is bound in hyprland.conf, to the portal shortcut.
        items.push(h('div', { class: 'set-row', 'data-search': 'hyprland atalho tecla bind' },
          h('span', { class: 'set-row-text' },
            h('span', { class: 'set-row-label' }, 'Atalho no Hyprland'),
            h('span', { class: 'set-row-hint' }, tr('No Hyprland a tecla fica no {file}. Adicione esta linha (a tecla é a escolhida acima):').replace('{file}', sc.configFile || 'hyprland.conf')),
            h('code', { class: 'set-code', 'data-no-tr': '' }, sc.bindLine)),
          button('Copiar', () => navigator.clipboard?.writeText(sc.bindLine).catch(() => {}))));
      } else if (sc.via === 'portal') {
        const key = r.hotkeyTrigger();
        items.push(note(key
          ? tr('Atalho definido pelo sistema: {key}. Para trocar, use as configurações de atalhos do sistema (kScreen → Salvar clipe).').replace('{key}', key)
          : tr('No Wayland o sistema define a tecla (pode pedir confirmação quando o replay liga). Se não funcionar, crie um atalho do sistema com o comando: {cmd}').replace('{cmd}', r.saveClipCommand())));
      } else if (r.wayland()) {
        items.push(note(tr('No Wayland, quem libera atalhos globais é o sistema (pode pedir permissão). Se não funcionar, crie um atalho em Configurações do sistema → Teclado com o comando: {cmd}').replace('{cmd}', r.saveClipCommand())));
      } else if (live && r.active() && !r.hotkeyRegistered()) {
        items.push(note(tr('O atalho {key} está em uso por outro programa. Escolha outro.').replace('{key}', cur.hotkey), 'warn'));
      }
      const gpu = gpuBlock(r);
      if (gpu) items.push(gpu);
      if (r.aacMissing()) items.push(note('Sem o ffmpeg instalado, o áudio dos clipes sai em Opus, que alguns celulares e editores não tocam. Instale o ffmpeg para ele sair em AAC.', 'warn'));
      if (r.error()) items.push(note(r.error(), 'warn'));
      if (live && r.active()) items.push(note('Instant Replay ativo nesta transmissão.'));
    }
    items.push(h('div', { class: 'set-row', 'data-search': 'pasta clipes vídeos abrir' },
      h('span', { class: 'set-row-text' }, h('span', { class: 'set-row-label' }, 'Clipes salvos'),
        h('span', { class: 'set-row-hint' }, 'Ficam na pasta Vídeos, em kScreen.')),
      button('Abrir pasta', () => r.openFolder())));
    return block('Instant Replay', ...items);
  }

  // ---- Sons ------------------------------------------------------------------------------------
  function renderSounds(box) {
    const snd = api.sounds;
    const p = snd.prefs();
    const list = h('div', { class: 'set-sound-list' });
    const paintList = () => list.classList.toggle('set-disabled', !snd.prefs().enabled);
    for (const cue of snd.CUES) {
      const input = h('input', { type: 'checkbox', role: 'switch' });
      input.checked = cue.keys.every(k => !p.off.includes(k));
      input.addEventListener('change', () => snd.setCue(cue.keys, input.checked));
      const play = h('button', { type: 'button', class: 'set-play', title: 'Ouvir', 'aria-label': `${tr('Ouvir')}: ${tr(cue.label)}`, html: PLAY_ICON, onclick: () => snd.preview(cue.keys) });
      // The play button stays outside the <label>: inside, it would be the label's control and
      // a click on the text would play the sound instead of flipping the switch.
      list.append(h('div', { class: 'set-row set-sound-row', 'data-search': `${cue.label} ${cue.hint || ''} som` },
        play,
        h('label', { class: 'set-switch set-sound-label' },
          h('span', { class: 'set-row-text' }, h('span', { class: 'set-row-label' }, cue.label), cue.hint ? h('span', { class: 'set-row-hint' }, cue.hint) : null),
          input, h('span', { class: 'k-switch', 'aria-hidden': 'true' }))));
    }
    paintList();
    box.append(
      block('',
        switchItem('Sons da chamada', 'Avisos sonoros de quem entra, sai, transmite e muta.', p.enabled, (on) => { snd.set({ enabled: on }); paintList(); }, { search: 'efeitos notificação' }),
        field('Volume dos sons', slider(p.volume, (x) => snd.set({ volume: x }), { max: 100, label: 'Volume dos sons' }), 'Relativo ao volume de saída.', 'efeitos')),
      block('Quais sons tocar', list),
      h('p', { class: 'set-note set-credit', 'data-search': 'créditos gonaah efeitos sonoros' },
        h('span', {}, 'Efeitos sonoros criados por'), ' ',
        h('strong', { 'data-no-tr': true }, 'Gonaah'), ' ', h('span', { 'data-no-tr': true }, '(@gonaah)')));
  }

  // ---- Chamada ---------------------------------------------------------------------------------
  function renderCall(box) {
    const l = api.layout;
    box.append(
      block('Exibição',
        switchItem('Mostrar participantes sem vídeo', 'Cartões de quem não tem câmera nem transmissão aparecem na grade.', l.showNoVideo(), (on) => l.setShowNoVideo(on), { search: 'avatar cartão grade' }),
        switchItem('Esconder a faixa de participantes', 'No modo destaque, a fileira de pessoas embaixo da tela fica recolhida.', l.stripCollapsed(), (on) => l.setStripCollapsed(on), { search: 'destaque faixa membros' })),
      block('Volumes individuais',
        h('div', { class: 'set-row', 'data-search': 'volume pessoa individual redefinir resetar silenciados' },
          h('span', { class: 'set-row-text' }, h('span', { class: 'set-row-label' }, 'Redefinir volumes por pessoa'),
            h('span', { class: 'set-row-hint' }, tr('{n} pessoa(s) com volume ou silêncio próprio.').replace('{n}', l.customVolumes()))),
          button('Redefinir', async () => {
            const ok = await api.confirm({ title: 'Redefinir volumes?', message: 'Todo mundo volta para 100% e sem silêncio.', confirmLabel: 'Redefinir' });
            if (!ok) return;
            l.resetVolumes();
            api.toast('Volumes redefinidos.');
            show('call');
          }))));
  }

  // ---- Idioma ------------------------------------------------------------------------------
  function renderLanguage(box) {
    const lg = api.language;
    const opts = [
      { id: 'auto', label: 'Automático', detail: lg.systemLabel() },
      { id: 'pt', label: 'Português (Brasil)', detail: 'Português' },
      { id: 'en', label: 'English', detail: 'Inglês' }
    ];
    const list = h('div', { class: 'set-radio-list', role: 'radiogroup', 'aria-label': 'Idioma' });
    for (const o of opts) {
      const input = h('input', { type: 'radio', name: 'set-lang', value: o.id });
      input.checked = lg.choice() === o.id;
      input.addEventListener('change', async () => {
        if (!input.checked) return;
        const changes = lg.effective(o.id) !== lg.current();
        lg.set(o.id);
        if (!changes) return;
        const ok = await api.confirm({ title: 'Recarregar agora?', message: api.inRoom() ? 'O idioma muda depois de recarregar. Você volta para a mesma sala.' : 'O idioma muda depois de recarregar a página.', confirmLabel: 'Recarregar' });
        if (ok) location.reload();
      });
      list.append(h('label', { class: 'set-radio', 'data-search': `${o.label} ${o.detail} idioma language` },
        input, h('span', { class: 'set-radio-ring', 'aria-hidden': 'true' }),
        h('span', { class: 'set-row-text' }, h('span', { class: 'set-row-label', 'data-no-tr': o.id !== 'auto' ? true : null }, o.label), h('span', { class: 'set-row-hint' }, o.detail))));
    }
    box.append(block('Idioma do kScreen', list), note('Mensagens do chat e nomes nunca são traduzidos.'));
  }

  // ---- Atalhos -----------------------------------------------------------------------------
  function renderKeys(box) {
    const keys = [
      [['Ctrl', ','], 'Abrir ou fechar as configurações'],
      [['Esc'], 'Fechar menus e janelas'],
      [['Enter'], 'Enviar mensagem no chat'],
      [['Shift', 'Enter'], 'Nova linha no chat'],
      [['↑'], 'Editar sua última mensagem (chat vazio)'],
      [['Ctrl', 'V'], 'Colar imagem no chat'],
      [['Clique'], 'Pôr uma pessoa ou transmissão em destaque'],
      [['Clique direito'], 'Volume e opções de uma pessoa ou transmissão']
    ];
    if (api.user()?.admin) keys.push([['Ctrl', 'Shift', 'D'], 'Painel admin (dentro de uma sala)']);
    const list = h('div', { class: 'set-keys' });
    for (const [combo, what] of keys) {
      list.append(h('div', { class: 'set-key-row', 'data-search': `${combo.join(' ')} ${what} atalho tecla` },
        h('span', {}, what),
        h('span', { class: 'set-key-combo' }, combo.map((k, i) => [i ? h('span', { class: 'set-key-plus' }, '+') : null, h('kbd', {}, k)]))));
    }
    box.append(block('Teclado e mouse', list));
  }

  // ---- Avançado ----------------------------------------------------------------------------
  function renderAdvanced(box) {
    const a = api.advanced;
    const items = [];
    if (a.relayOptionShown()) {
      items.push(block('Conexão',
        switchItem('Forçar conexão via relay', 'Nunca conecta direto com as outras pessoas: tudo passa pelo servidor de mídia. Vale na hora.', a.forceRelay(), (on) => a.setForceRelay(on))));
    }
    items.push(block('Restaurar',
      h('div', { class: 'set-row', 'data-search': 'restaurar padrão resetar redefinir tudo' },
        h('span', { class: 'set-row-text' }, h('span', { class: 'set-row-label' }, 'Restaurar configurações padrão'),
          h('span', { class: 'set-row-hint' }, 'Dispositivos, volumes, processamento de voz, qualidade da transmissão, sons e exibição voltam ao padrão.')),
        button('Restaurar', async () => {
          const ok = await api.confirm({ title: 'Restaurar tudo?', message: 'Todas as configurações deste navegador voltam ao padrão. Volumes por pessoa e o idioma não mudam.', confirmLabel: 'Restaurar', danger: true });
          if (!ok) return;
          await a.resetAll();
          api.toast('Configurações restauradas.');
          show('advanced');
        }, 'danger'))));
    box.append(...items, note('As configurações ficam salvas neste navegador.'));
  }

  // Redraws a section if it is the one on screen.
  function refresh(section) {
    if (!isOpen() || current !== section || searchInput.value) return;
    // Same page drawn again (state changed): stay where the user was reading.
    const top = scroller.scrollTop;
    show(section);
    scroller.scrollTop = top;
  }

  return { open, close, isOpen, refresh };
}
