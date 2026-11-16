'use strict';
// Discord-style capture picker: Aplicativos / Tela Inteira, big live thumbnails, and a settings
// gear with the stream mode (resolution, FPS, PC audio). The result goes back to the site.

const RESOLUTIONS = [['480', '480p'], ['720', '720p'], ['1080', '1080p'], ['1440', '1440p'], ['source', 'Fonte']];
const FPS = [15, 30, 60];
// Stereo Opus bitrates (same keys as the site)
const AUDIO_QUALITIES = [['standard', 'Normal', '128 kbps'], ['high', 'Alta', '256 kbps'], ['max', 'Máxima', '510 kbps']];
const PRESETS = {
  games: { name: 'Jogos', resolution: '1080', fps: 60 },
  max: { name: 'Qualidade máxima', resolution: 'source', fps: 60 }
};

const $ = (id) => document.getElementById(id);
const grid = $('grid');
const shareBtn = $('share');
const tabs = [...document.querySelectorAll('[role="tab"]')];
const menus = { main: $('menu'), res: $('menu-res'), fps: $('menu-fps'), aq: $('menu-aq'), apps: $('menu-apps') };
const SUBMENUS = ['res', 'fps', 'aq', 'apps'];

let sources = [];
let tab = 'window';
let selected = null;
let refreshTimer = 0;
const state = { resolution: '1080', fps: 60, audioQuality: 'max', audio: true, audioAvailable: true, appExclusion: true, exclude: [] };
let systemPicker = false;
let appNames = new Map(); // exe -> display name

// --- settings -------------------------------------------------------------

function presetOf({ resolution, fps }) {
  return Object.keys(PRESETS).find(k => PRESETS[k].resolution === resolution && PRESETS[k].fps === fps) || 'custom';
}

function renderSettings() {
  const preset = presetOf(state);
  $('mode-name').textContent = preset === 'custom' ? 'Personalizada' : PRESETS[preset].name;
  const label = RESOLUTIONS.find(([k]) => k === state.resolution)[1];
  const parts = [label, `${state.fps}fps`];
  if (state.audioAvailable) {
    if (!state.audio) parts.push('sem som');
    else if (!state.exclude.length) parts.push('com som do PC');
    else {
      const names = state.exclude.map(e => appNames.get(e.toLowerCase()) || e);
      parts.push(`som do PC sem ${names.length > 2 ? `${names.slice(0, 2).join(', ')} +${names.length - 2}` : names.join(' e ')}`);
    }
    if (state.audio) parts.push(AUDIO_QUALITIES.find(([k]) => k === state.audioQuality)[2]);
  }
  $('mode-detail').replaceChildren(...parts.map(p => Object.assign(document.createElement('i'), { textContent: p })));
  for (const el of menus.main.querySelectorAll('[data-preset]')) el.classList.toggle('on', el.dataset.preset === preset);
  for (const el of menus.res.querySelectorAll('.item')) el.classList.toggle('on', el.dataset.value === state.resolution);
  for (const el of menus.fps.querySelectorAll('.item')) el.classList.toggle('on', Number(el.dataset.value) === state.fps);
  for (const el of menus.aq.querySelectorAll('.item')) el.classList.toggle('on', el.dataset.value === state.audioQuality);
  $('open-aq').hidden = !state.audioAvailable;
  $('open-aq').classList.toggle('disabled', !state.audio);
  const audio = $('audio-item');
  audio.classList.toggle('on', state.audio && state.audioAvailable);
  audio.setAttribute('aria-checked', String(state.audio && state.audioAvailable));
  audio.classList.toggle('disabled', !state.audioAvailable);
  audio.hidden = !state.audioAvailable;
  $('open-apps').hidden = !state.audioAvailable || !state.appExclusion;
  $('open-apps').classList.toggle('disabled', !state.audio);
  for (const el of menus.apps.querySelectorAll('.item')) el.classList.toggle('on', isExcluded(el.dataset.exe));
}

function isExcluded(exe) {
  return state.exclude.some(e => e.toLowerCase() === String(exe).toLowerCase());
}

async function loadApps() {
  menus.apps.replaceChildren(Object.assign(document.createElement('div'), { className: 'menu-title', textContent: 'Excluir áudio de apps' }));
  let apps = [];
  try { apps = await window.picker.apps(); } catch { /* none */ }
  appNames = new Map(apps.map(a => [a.exe.toLowerCase(), a.name]));
  if (!apps.length) {
    menus.apps.append(Object.assign(document.createElement('div'), { className: 'apps-empty', textContent: 'Nenhum app com áudio aberto' }));
  }
  for (const app of apps) {
    const item = document.createElement('button');
    item.className = 'item';
    item.dataset.exe = app.exe;
    item.setAttribute('role', 'menuitemcheckbox');
    item.title = `${app.exe}.exe`;
    const name = Object.assign(document.createElement('span'), { className: 'name', textContent: app.name });
    item.append(name, Object.assign(document.createElement('span'), { className: 'check' }));
    item.addEventListener('click', () => {
      state.exclude = isExcluded(app.exe) ? state.exclude.filter(e => e.toLowerCase() !== app.exe.toLowerCase()) : [...state.exclude, app.exe];
      renderSettings();
    });
    menus.apps.append(item);
  }
  renderSettings();
  placeSub('apps');
}

function buildSubmenu(menu, title, entries, onPick) {
  const head = document.createElement('div');
  head.className = 'menu-title';
  head.textContent = title;
  menu.append(head);
  for (const [value, label] of entries) {
    const item = document.createElement('button');
    item.className = 'item';
    item.dataset.value = value;
    item.setAttribute('role', 'menuitemradio');
    item.innerHTML = '<span class="grow"></span><span class="radio"></span>';
    item.firstChild.textContent = label;
    item.addEventListener('click', () => { onPick(value); renderSettings(); });
    menu.append(item);
  }
}

function placeSub(which) {
  // Line the submenu up with its row.
  const row = $(`open-${which}`).getBoundingClientRect();
  const footer = document.querySelector('footer').getBoundingClientRect();
  menus[which].style.bottom = `${Math.max(6, footer.bottom - row.bottom - 6)}px`;
}

function openSub(which) {
  if ((which === 'apps' || which === 'aq') && !state.audio) which = null;
  for (const key of SUBMENUS) {
    const open = key === which;
    const wasHidden = menus[key].hidden;
    menus[key].hidden = !open;
    $(`open-${key}`).setAttribute('aria-expanded', String(open));
    if (open && key === 'apps' && wasHidden) loadApps();
  }
  if (which) placeSub(which);
}

function toggleMenu(open = menus.main.hidden) {
  menus.main.hidden = !open;
  $('settings').setAttribute('aria-expanded', String(open));
  if (!open) openSub(null);
}

buildSubmenu(menus.res, 'Resolução da tela', RESOLUTIONS, (v) => { state.resolution = v; });
buildSubmenu(menus.fps, 'Taxa de quadros', FPS.map(f => [String(f), `${f} FPS`]), (v) => { state.fps = Number(v); });
buildSubmenu(menus.aq, 'Áudio estéreo', AUDIO_QUALITIES.map(([k, name, rate]) => [k, `${name} · ${rate}`]), (v) => { state.audioQuality = v; });

for (const el of menus.main.querySelectorAll('[data-preset]')) {
  el.addEventListener('click', () => {
    const p = PRESETS[el.dataset.preset];
    if (p) Object.assign(state, { resolution: p.resolution, fps: p.fps });
    else openSub('res');
    renderSettings();
  });
}
$('open-res').addEventListener('click', () => openSub(menus.res.hidden ? 'res' : null));
$('open-fps').addEventListener('click', () => openSub(menus.fps.hidden ? 'fps' : null));
$('open-aq').addEventListener('click', () => openSub(menus.aq.hidden ? 'aq' : null));
$('open-aq').addEventListener('pointerenter', () => openSub('aq'));
$('open-apps').addEventListener('click', () => openSub(menus.apps.hidden ? 'apps' : null));
$('open-apps').addEventListener('pointerenter', () => openSub('apps'));
$('open-res').addEventListener('pointerenter', () => openSub('res'));
$('open-fps').addEventListener('pointerenter', () => openSub('fps'));
for (const el of menus.main.querySelectorAll('[data-preset], #audio-item')) el.addEventListener('pointerenter', () => openSub(null));
$('audio-item').addEventListener('click', () => {
  if (!state.audioAvailable) return;
  state.audio = !state.audio;
  renderSettings();
});
$('settings').addEventListener('click', () => toggleMenu());
document.addEventListener('pointerdown', (e) => {
  if (menus.main.hidden) return;
  if (![...Object.values(menus), $('settings')].some(m => m.contains(e.target))) toggleMenu(false);
});

// --- sources --------------------------------------------------------------

function share() {
  if (systemPicker) selected = 'system';
  if (!selected) return;
  window.picker.choose({ id: selected, audio: state.audio && state.audioAvailable, resolution: state.resolution, fps: state.fps, audioQuality: state.audioQuality, audioExclude: state.exclude });
}

function select(id) {
  selected = id;
  for (const el of grid.children) if (el.dataset) el.setAttribute('aria-pressed', String(el.dataset.id === id));
  shareBtn.disabled = !selected;
}

function setTab(next) {
  tab = next;
  for (const t of tabs) t.setAttribute('aria-selected', String(t.dataset.tab === tab));
  grid.replaceChildren();
  render();
  if (!sources.some(s => s.id === selected && s.type === tab)) {
    const first = sources.find(s => s.type === tab);
    select(first ? first.id : null);
  }
}

function card(source) {
  const el = document.createElement('button');
  el.className = 'source';
  el.dataset.id = source.id;
  el.setAttribute('aria-pressed', String(source.id === selected));
  el.title = source.name;

  const thumb = document.createElement('div');
  thumb.className = 'thumb';
  if (source.thumbnail) thumb.style.backgroundImage = `url("${source.thumbnail}")`;
  else {
    thumb.classList.add('empty');
    thumb.textContent = 'Sem prévia';
  }

  const label = document.createElement('div');
  label.className = 'label';
  if (source.icon) {
    const icon = document.createElement('img');
    icon.src = source.icon;
    icon.alt = '';
    label.append(icon);
  } else if (source.type === 'window') {
    label.append(Object.assign(document.createElement('i'), { className: 'ph' }));
  }
  const name = document.createElement('span');
  name.textContent = source.name;
  label.append(name);
  if (source.detail) {
    const detail = document.createElement('small');
    detail.textContent = source.primary ? `${source.detail} · principal` : source.detail;
    label.append(detail);
  }

  el.append(thumb, label);
  el.addEventListener('click', () => select(source.id));
  el.addEventListener('dblclick', () => { select(source.id); share(); });
  return el;
}

function render() {
  const list = sources.filter(s => s.type === tab);
  $('count-screen').textContent = String(sources.filter(s => s.type === 'screen').length || '');
  $('count-window').textContent = String(sources.filter(s => s.type === 'window').length || '');
  if (!list.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-msg';
    empty.textContent = tab === 'screen' ? 'Nenhuma tela encontrada.' : 'Nenhum aplicativo aberto para compartilhar.';
    grid.replaceChildren(empty);
    return;
  }
  // Update in place so focus and scroll survive the periodic refresh.
  const existing = new Map([...grid.children].filter(el => el.dataset?.id).map(el => [el.dataset.id, el]));
  grid.replaceChildren(...list.map(s => {
    const old = existing.get(s.id);
    if (!old) return card(s);
    if (s.thumbnail) old.querySelector('.thumb').style.backgroundImage = `url("${s.thumbnail}")`;
    return old;
  }));
}

async function refresh() {
  clearTimeout(refreshTimer);
  try {
    sources = await window.picker.sources();
  } catch {
    sources = [];
  }
  // First load: no apps open -> show the screens tab instead of an empty page.
  if (!selected && tab === 'window' && !sources.some(s => s.type === 'window')) setTab('screen');
  render();
  if (selected && !sources.some(s => s.id === selected)) select(null);
  if (!selected) {
    const first = sources.find(s => s.type === tab);
    if (first) select(first.id);
  }
  refreshTimer = setTimeout(refresh, 2500);
}

tabs.forEach(t => t.addEventListener('click', () => setTab(t.dataset.tab)));
shareBtn.addEventListener('click', share);
$('cancel').addEventListener('click', () => window.picker.cancel());
$('close').addEventListener('click', () => window.picker.cancel());

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!menus.main.hidden) toggleMenu(false);
    else window.picker.cancel();
  } else if (e.key === 'Enter' && menus.main.hidden) {
    e.preventDefault();
    share();
  } else if (e.key === 'Tab' && e.ctrlKey) {
    e.preventDefault();
    setTab(tab === 'screen' ? 'window' : 'screen');
  }
});

(async () => {
  const init = await window.picker.init();
  if (!init) return;
  Object.assign(state, {
    resolution: init.settings?.resolution || '1080',
    fps: init.settings?.fps || 60,
    audioQuality: init.settings?.audioQuality || 'max',
    audio: !!init.audio,
    // PC audio only exists on Windows, and only if the page asked for audio at all.
    audioAvailable: !!(init.systemAudio && init.audioRequested),
    appExclusion: !!init.appExclusion,
    exclude: Array.isArray(init.audioExclude) ? init.audioExclude : []
  });
  systemPicker = !!init.systemPicker;
  if (!RESOLUTIONS.some(([k]) => k === state.resolution)) state.resolution = '1080';
  if (!FPS.includes(state.fps)) state.fps = 60;
  if (!AUDIO_QUALITIES.some(([k]) => k === state.audioQuality)) state.audioQuality = 'max';
  renderSettings();
  if (systemPicker) {
    document.body.classList.add('system-picker');
    shareBtn.disabled = false;
    shareBtn.lastChild.textContent = ' Escolher tela';
    return;
  }
  refresh();
})();
