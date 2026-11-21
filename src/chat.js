// Room text chat panel (Discord-like). Talks to server/chat.js:
//   history  -> latest page on open, older pages on scroll up
//   events   -> long poll for everything that changed since the last version
//   send/edit/delete/react/typing/upload
// Message text is rendered from escaped HTML with a small Discord-flavoured markdown.
import { parseP2PAvatar, resolveP2PAvatar } from './p2p-avatars.js';
import { spinnerHtml } from './spinner.js';
import { sha256Hex } from './p2p-files.js';
import { tr } from './i18n.js';
import { watchEmojis } from './twemoji.js';
import './chat.css';

const API = '/api/room/chat';
const GROUP_MS = 7 * 60 * 1000;
// A long run of messages from one person shows their name and photo again (like Discord).
const GROUP_MAX = 8;
const MAX_CONTENT = 2000;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const P2P_MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_ATTACHMENTS = 10;
const RECENT_KEY = 'kss_chat_recent_emoji';
const OPEN_KEY = 'kss_chat_open';
const WIDTH_KEY = 'kss_chat_width';
const NAME_COLORS = ['#e8365d', '#f0b232', '#23a55a', '#4d7cfe', '#c37bf5', '#1abc9c', '#ff7a45', '#eb459e', '#57f287', '#5dadec'];
const IMAGE_URL_RE = /^https:\/\/[^\s]+?\.(?:gif|png|jpe?g|webp)(?:\?[^\s]*)?$/i;
const MEDIA_HOST_RE = /^https:\/\/(?:media\d*\.giphy\.com|i\.giphy\.com|media\.tenor\.com|i\.imgur\.com)\//i;
const EMOJI_GROUPS = [
  { id: 'recent', icon: '🕒', label: 'Usados recentemente' },
  { id: 0, icon: '😀', label: 'Carinhas e emoções' },
  { id: 1, icon: '👋', label: 'Pessoas' },
  { id: 3, icon: '🐱', label: 'Animais e natureza' },
  { id: 4, icon: '🍔', label: 'Comidas e bebidas' },
  { id: 5, icon: '✈️', label: 'Viagens e lugares' },
  { id: 6, icon: '⚽', label: 'Atividades' },
  { id: 7, icon: '💡', label: 'Objetos' },
  { id: 8, icon: '❤️', label: 'Símbolos' },
  { id: 9, icon: '🏁', label: 'Bandeiras' }
];
const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮'];

const ICONS = {
  chat: '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2.8c-5.3 0-9.6 3.9-9.6 8.6 0 2.4 1.1 4.6 2.9 6.2l-.9 3.4c-.1.5.4.9.8.6l3.6-2c1 .3 2.1.5 3.2.5 5.3 0 9.6-3.9 9.6-8.6S17.3 2.8 12 2.8z"/></svg>',
  close: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  plus: '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm5 11h-4v4h-2v-4H7v-2h4V7h2v4h4v2z"/></svg>',
  emoji: '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM8.5 8a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zm7 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zM12 18c-2.6 0-4.8-1.6-5.6-4h11.2c-.8 2.4-3 4-5.6 4z"/></svg>',
  gif: '<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5zm5.6 4.2c-1.7 0-2.9 1.2-2.9 2.8s1.2 2.8 2.9 2.8c.9 0 1.6-.3 2.1-.8V11.6H8.5v1h1.1v.9c-.3.2-.6.3-1 .3-1 0-1.7-.8-1.7-1.8s.7-1.8 1.7-1.8c.5 0 1 .2 1.3.5l.7-.8a3 3 0 0 0-2-.7zm3.6.1v5.4h1.2V9.3h-1.2zm2.3 0v5.4h1.2v-2.1h2.2v-1h-2.2v-1.2h2.5v-1.1h-3.7z"/></svg>',
  reply: '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M10 8.3V4L3 11l7 7v-4.4c5 0 8.5 1.6 11 5.1-1-5-4-10-11-10.4z"/></svg>',
  edit: '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3 17.2V21h3.8L17.8 9.9l-3.7-3.7L3 17.2zM20.7 7a1 1 0 0 0 0-1.4l-2.3-2.3a1 1 0 0 0-1.4 0l-1.8 1.8 3.7 3.7L20.7 7z"/></svg>',
  trash: '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M15 3.5 14 2.5h-4l-1 1H5.5v2h13v-2H15zM6.5 7v12a2 2 0 0 0 2 2h7a2 2 0 0 0 2-2V7h-11z"/></svg>',
  react: '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 1 0 10 10h-2a8 8 0 1 1-8-8V2zm-3.5 6a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm7 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zM7 14c.8 2 2.7 3.5 5 3.5s4.2-1.5 5-3.5H7zM19 1v3h-3v2h3v3h2V6h3V4h-3V1h-2z"/></svg>',
  copy: '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11v14z"/></svg>',
  play: '<svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>',
  down: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"></polyline></svg>',
  send: '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M2.5 20.6 22 12 2.5 3.4l-.01 6.7L16 12 2.49 13.9z"/></svg>',
  file: '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zM8.5 13.5l2.5 3 3.5-4.5 4.5 6H5l3.5-4.5z"/></svg>'
};

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function storageGet(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}
function storageSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
}

function nameColor(id, custom) {
  if (/^#[0-9a-f]{6}$/i.test(custom || '')) return custom;
  let h = 0;
  for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return NAME_COLORS[h % NAME_COLORS.length];
}

function safeAvatar(url) {
  if (parseP2PAvatar(url)) return resolveP2PAvatar(url) || '/avatar.png';
  return /^(https:\/\/cdn\.discordapp\.com\/|\/avatars\/[1-8]\.jpg$)/.test(url || '') ? url : '/avatar.png';
}

const pad = (n) => String(n).padStart(2, '0');
const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

function stamp(ts) {
  const d = new Date(ts);
  const now = new Date();
  if (sameDay(d, now)) return hhmm(d);
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (sameDay(d, y)) return tr(`Ontem às ${hhmm(d)}`);
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${hhmm(d)}`;
}

function fullStamp(ts) {
  const d = new Date(ts);
  try {
    return d.toLocaleString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch {
    return d.toString();
  }
}

function dayLabel(ts) {
  try {
    return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
  } catch {
    return new Date(ts).toDateString();
  }
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function isMediaUrl(url) {
  return IMAGE_URL_RE.test(url) || MEDIA_HOST_RE.test(url);
}

// Emoji-only messages (up to 27, like Discord) are shown big.
function isEmojiOnly(text) {
  const stripped = text.replace(/\s+/g, '');
  if (!stripped || stripped.length > 200) return false;
  if (!/^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|\p{Regional_Indicator}|‍|️|⃣)+$/u.test(stripped)) return false;
  const seg = typeof Intl.Segmenter === 'function' ? [...new Intl.Segmenter().segment(stripped)].length : stripped.length / 2;
  return seg <= 27;
}

// Discord-flavoured markdown on escaped text. Code is cut out first so nothing inside it is formatted.
function formatContent(text, { mentionName, myId }) {
  const slots = [];
  const keep = (html) => `\u0000${slots.push(html) - 1}\u0000`;
  let s = String(text);
  s = s.replace(/```(?:([\w+-]{1,20})\n)?([\s\S]*?)```/g, (_, _lang, code) => keep(`<pre class="cm-codeblock"><code>${esc(code.replace(/^\n|\n$/g, ''))}</code><button type="button" class="cm-copy" data-copy-code title="${esc(tr('Copiar'))}" aria-label="${esc(tr('Copiar código'))}">${ICONS.copy}</button></pre>`));
  s = s.replace(/`([^`\n]+)`/g, (_, code) => keep(`<code class="cm-code">${esc(code)}</code>`));
  s = esc(s);
  // Mentions: <@discordId> (escaped as &lt;@id&gt;)
  s = s.replace(/&lt;@(\d{5,25})&gt;/g, (_, uid) => keep(`<span class="cm-mention${uid === myId ? ' me' : ''}" data-profile="${uid}">@${esc(mentionName(uid))}</span>`));
  s = s.replace(/(^|\s)@(everyone|here)\b/g, (_, pre, w) => `${pre}${keep(`<span class="cm-mention">@${w}</span>`)}`);
  // Links (http/https only). Trailing punctuation stays outside, like Discord.
  s = s.replace(/https?:\/\/[^\s<]+[^\s<.,:;!?)\]'"]/g, (url) => keep(`<a class="cm-link" href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`));
  s = s.replace(/\*\*\*([^*\n][\s\S]*?)\*\*\*/g, '<strong><em>$1</em></strong>');
  s = s.replace(/\*\*([^*\n][\s\S]*?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_\n][\s\S]*?)__/g, '<u>$1</u>');
  s = s.replace(/(^|[^*\w])\*([^*\s](?:[^*\n]*[^*\s])?)\*(?!\*)/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^_\w])_([^_\s](?:[^_\n]*[^_\s])?)_(?![_\w])/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~\n][\s\S]*?)~~/g, '<s>$1</s>');
  s = s.replace(/\|\|([\s\S]+?)\|\|/g, '<span class="cm-spoiler" tabindex="0">$1</span>');
  // Headings and quotes work per line.
  s = s.split('\n').map((line) => {
    let m;
    if ((m = /^(#{1,3}) (.+)$/.exec(line))) return `<span class="cm-h${m[1].length}">${m[2]}</span>`;
    if ((m = /^-# (.+)$/.exec(line))) return `<span class="cm-sub">${m[1]}</span>`;
    if ((m = /^&gt; ?(.*)$/.exec(line))) return `<span class="cm-quote">${m[1] || '&#8203;'}</span>`;
    if ((m = /^\s*[-*] (.+)$/.exec(line))) return `<span class="cm-li">${m[1]}</span>`;
    return line;
  }).join('\n');
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => slots[Number(i)]);
  return s;
}

// --------------------------------------------------------------------------
// Emoji data (loaded on first use: ~550 KB, its own chunk)
// --------------------------------------------------------------------------

let emojiPromise = null;
let EMOJIS = [];
const EMOJI_BY_CODE = new Map();
const EMOJI_BY_CHAR = new Map();

function loadEmojis() {
  emojiPromise ??= Promise.all([
    import('emojibase-data/pt/compact.json'),
    import('emojibase-data/en/shortcodes/github.json')
  ]).then(([{ default: list }, { default: codes }]) => {
    EMOJIS = list
      .filter(e => e.group != null && e.group !== 2)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .map((e) => {
        const names = [].concat(codes[e.hexcode] || []);
        return {
          u: e.unicode,
          name: names[0] || e.label.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_|_$/g, ''),
          names,
          label: e.label,
          search: `${names.join(' ')} ${e.label} ${(e.tags || []).join(' ')}`.toLowerCase(),
          group: e.group
        };
      });
    for (const e of EMOJIS) {
      EMOJI_BY_CHAR.set(e.u, e);
      for (const n of e.names) EMOJI_BY_CODE.set(n, e.u);
      if (!EMOJI_BY_CODE.has(e.name)) EMOJI_BY_CODE.set(e.name, e.u);
    }
    return EMOJIS;
  }).catch((err) => {
    emojiPromise = null;
    throw err;
  });
  return emojiPromise;
}


function searchEmojis(query, limit = 200) {
  const q = query.toLowerCase().trim();
  if (!q) return [];
  const exact = [];
  const starts = [];
  const contains = [];
  for (const e of EMOJIS) {
    if (e.names.includes(q)) exact.push(e);
    else if (e.names.some(n => n.startsWith(q)) || e.label.toLowerCase().startsWith(q)) starts.push(e);
    else if (e.search.includes(q)) contains.push(e);
    if (starts.length >= limit) break;
  }
  return exact.concat(starts, contains).slice(0, limit);
}

function replaceShortcodes(text) {
  if (!EMOJI_BY_CODE.size) return text;
  // Not inside code spans/blocks.
  return text.split(/(```[\s\S]*?```|`[^`\n]*`)/).map((part, i) => (i % 2
    ? part
    : part.replace(/:([a-z0-9_+-]{1,40}):/gi, (m, code) => EMOJI_BY_CODE.get(code.toLowerCase()) || m))).join('');
}

// --------------------------------------------------------------------------
// Chat
// --------------------------------------------------------------------------

export class RoomChat {
  constructor({ context, me, members, files = null, onUnreadChange = () => {}, onNewMessage = () => {}, onProfile = null, toast = () => {}, confirm = async () => true }) {
    this.context = context; // () => { roomId, peerId } | null
    this.files = files; // P2PFiles (src/p2p-files.js): images travel between the people in the room
    // Someone new connected: images nobody had a moment ago may be available now.
    if (files) {
      files.relay = (hash, type) => this.relayFetch(hash, type);
      let timer = 0;
      files.onPeerReady = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          let changed = false;
          for (const m of this.messages) {
            for (const att of m.attachments || []) {
              if (att.p2p && att._missing) { delete att._missing; m.version = (m.version || 0) + 0.001; changed = true; }
            }
          }
          if (changed) this.render({ stick: this.atBottom() });
        }, 300);
      };
    }
    this.me = me; // () => { id, displayName, avatarUrl }
    this.members = members; // () => [{ userId, name, avatarUrl }]
    this.onUnreadChange = onUnreadChange;
    this.onNewMessage = onNewMessage;
    this.onProfile = onProfile; // (userId, anchorEl, author) => open their profile
    this.toast = toast;
    this.confirm = confirm;

    this.roomId = null;
    this.session = 0;
    this.version = 0;
    this.epoch = null;
    this.messages = []; // sorted by createdAt
    this.byId = new Map();
    this.rendered = new Map(); // id -> { key, el }
    this.hasMore = false;
    this.loadingOlder = false;
    this.unread = 0;
    this.mentioned = false;
    this.replyTo = null;
    this.editingId = null;
    this.pending = []; // { file, url, width, height }
    this.typing = [];
    this.typingSentAt = 0;
    this.knownNames = new Map(); // userId -> name
    this.isOpen = false;
    this.pickerMode = null; // 'emoji' | 'gif' | 'react'
    this.reactTarget = null;
    this.autocomplete = null;
    this.gifCache = new Map();

    this.build();
  }

  // ---------------------------------------------------------------- DOM

  build() {
    const panel = document.createElement('aside');
    panel.className = 'chat-panel';
    panel.id = 'chat-panel';
    panel.setAttribute('aria-label', 'Chat da sala');
    panel.innerHTML = `
      <div class="chat-resizer" role="separator" aria-orientation="vertical" title="Arraste para ajustar a largura"></div>
      <header class="chat-head">
        <span class="chat-head-icon">${ICONS.chat}</span>
        <span class="chat-head-title" data-no-tr></span>
        <button type="button" class="chat-icon-btn chat-close" title="Fechar chat" aria-label="Fechar chat">${ICONS.close}</button>
      </header>
      <div class="chat-scroller">
        <div class="chat-list" data-no-tr></div>
      </div>
      <button type="button" class="chat-jump hidden"><span>Novas mensagens</span>${ICONS.down}</button>
      <div class="chat-bottom">
        <div class="chat-autocomplete hidden" role="listbox"></div>
        <div class="chat-reply-bar hidden">
          <span class="chat-reply-text"></span>
          <button type="button" class="chat-icon-btn chat-reply-cancel" title="Cancelar resposta" aria-label="Cancelar resposta">${ICONS.close}</button>
        </div>
        <div class="chat-composer">
          <div class="chat-uploads hidden"></div>
          <div class="chat-input-row">
            <button type="button" class="chat-icon-btn chat-attach" title="Enviar imagem" aria-label="Enviar imagem">${ICONS.plus}</button>
            <input type="file" class="chat-file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden />
            <textarea class="chat-input" rows="1" maxlength="${MAX_CONTENT + 200}" spellcheck="true"></textarea>
            <div class="chat-input-actions">
              <button type="button" class="chat-icon-btn chat-gif-btn" title="GIFs" aria-label="GIFs">${ICONS.gif}</button>
              <button type="button" class="chat-icon-btn chat-emoji-btn" title="Emojis" aria-label="Emojis">${ICONS.emoji}</button>
              <button type="button" class="chat-icon-btn chat-send-btn" title="Enviar" aria-label="Enviar" disabled>${ICONS.send}</button>
            </div>
          </div>
        </div>
        <div class="chat-meta">
          <span class="chat-typing" data-no-tr></span>
          <span class="chat-counter hidden"></span>
        </div>
      </div>
      <div class="chat-picker hidden" role="dialog" aria-label="Emojis e GIFs">
        <div class="chat-picker-tabs">
          <button type="button" class="chat-picker-tab" data-tab="gif">GIFs</button>
          <button type="button" class="chat-picker-tab" data-tab="emoji">Emojis</button>
        </div>
        <input type="search" class="chat-picker-search" />
        <div class="chat-picker-body">
          <nav class="chat-picker-cats"></nav>
          <div class="chat-picker-grid"></div>
        </div>
        <div class="chat-picker-foot" data-no-tr></div>
      </div>
      <div class="chat-drop hidden"><div class="chat-drop-card">${ICONS.file}<strong>Solte para enviar</strong><span>PNG, JPG, GIF ou WebP até 8 MB</span></div></div>
    `;
    document.body.appendChild(panel);

    const lightbox = document.createElement('div');
    lightbox.className = 'chat-lightbox hidden';
    lightbox.innerHTML = '<img alt="" /><a class="chat-lightbox-open" target="_blank" rel="noopener noreferrer"></a>';
    document.body.appendChild(lightbox);

    // Right-click menu on chat images and on the lightbox, same look as the other menus.
    const imageMenu = document.createElement('div');
    imageMenu.className = 'discord-context-menu chat-image-menu hidden';
    imageMenu.setAttribute('role', 'menu');
    imageMenu.setAttribute('aria-label', tr('Opções da imagem'));
    imageMenu.innerHTML = `
      <button type="button" class="ctx-item" data-img-action="copy" role="menuitem">${esc(tr('Copiar imagem'))}</button>
      <button type="button" class="ctx-item" data-img-action="save" role="menuitem">${esc(tr('Salvar imagem'))}</button>
      <div class="ctx-separator" data-img-external></div>
      <button type="button" class="ctx-item" data-img-action="copy-link" data-img-external role="menuitem">${esc(tr('Copiar link'))}</button>
      <button type="button" class="ctx-item" data-img-action="open" data-img-external role="menuitem">${esc(tr('Abrir no navegador'))}</button>`;
    document.body.appendChild(imageMenu);
    watchEmojis(panel);

    const q = (sel) => panel.querySelector(sel);
    this.el = {
      panel, lightbox, imageMenu,
      title: q('.chat-head-title'),
      scroller: q('.chat-scroller'),
      list: q('.chat-list'),
      jump: q('.chat-jump'),
      auto: q('.chat-autocomplete'),
      replyBar: q('.chat-reply-bar'),
      replyText: q('.chat-reply-text'),
      uploads: q('.chat-uploads'),
      input: q('.chat-input'),
      file: q('.chat-file'),
      send: q('.chat-send-btn'),
      typing: q('.chat-typing'),
      counter: q('.chat-counter'),
      picker: q('.chat-picker'),
      pickerSearch: q('.chat-picker-search'),
      pickerCats: q('.chat-picker-cats'),
      pickerGrid: q('.chat-picker-grid'),
      pickerFoot: q('.chat-picker-foot'),
      drop: q('.chat-drop')
    };
    this.bind();
  }

  bind() {
    const { el } = this;
    el.panel.querySelector('.chat-close').addEventListener('click', () => this.close());
    this.bindResize(el.panel.querySelector('.chat-resizer'));
    el.panel.querySelector('.chat-attach').addEventListener('click', () => el.file.click());
    el.file.addEventListener('change', () => {
      this.addFiles([...el.file.files]);
      el.file.value = '';
    });
    el.panel.querySelector('.chat-reply-cancel').addEventListener('click', () => this.setReply(null));
    el.panel.querySelector('.chat-emoji-btn').addEventListener('click', (e) => { e.stopPropagation(); this.togglePicker('emoji'); });
    el.panel.querySelector('.chat-gif-btn').addEventListener('click', (e) => { e.stopPropagation(); this.togglePicker('gif'); });
    el.jump.addEventListener('click', () => this.scrollToBottom(true));
    el.send.addEventListener('click', () => {
      this.send();
      el.input.focus();
    });

    el.input.addEventListener('keydown', (e) => this.onInputKey(e));
    el.input.addEventListener('input', () => this.onInput());
    // The window or the chat changes width: the text re-wraps, so its height (and the caret's
    // place in view) has to follow, or the lines slide out of the composer.
    if ('ResizeObserver' in window) {
      let lastWidth = 0;
      new ResizeObserver(([entry]) => {
        const width = Math.round(entry.contentRect.width);
        if (width === lastWidth) return;
        lastWidth = width;
        if (el.input.value) this.autosize(el.input, { keepCaret: true });
      }).observe(el.input.parentElement);
    }
    el.input.addEventListener('paste', (e) => {
      const files = [...(e.clipboardData?.files || [])].filter(f => f.type.startsWith('image/'));
      if (files.length) {
        e.preventDefault();
        this.addFiles(files);
      }
    });

    el.scroller.addEventListener('scroll', () => {
      if (el.scroller.scrollTop < 200) this.loadOlder();
      if (this.atBottom()) el.jump.classList.add('hidden');
      this.markRead();
    }, { passive: true });

    el.list.addEventListener('click', (e) => this.onListClick(e));
    el.list.addEventListener('keydown', (e) => {
      if (e.target.classList?.contains('cm-spoiler') && (e.key === 'Enter' || e.key === ' ')) e.target.classList.add('revealed');
    });

    // Drag & drop images anywhere on the panel.
    let depth = 0;
    const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
    el.panel.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; depth++; el.drop.classList.remove('hidden'); });
    el.panel.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; el.drop.classList.add('hidden'); } });
    el.panel.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
    el.panel.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      el.drop.classList.add('hidden');
      this.addFiles([...e.dataTransfer.files]);
    });

    // Picker
    el.picker.addEventListener('click', (e) => e.stopPropagation());
    el.picker.querySelectorAll('.chat-picker-tab').forEach(b => b.addEventListener('click', () => this.openPicker(b.dataset.tab)));
    let searchTimer = null;
    el.pickerSearch.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => this.renderPicker(), this.pickerMode === 'gif' ? 350 : 60);
    });
    el.pickerSearch.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); this.closePicker(); el.input.focus(); }
      if (e.key === 'Enter') {
        e.preventDefault();
        // GIFs are only sent with a click; Enter picks the first emoji.
        if (this.pickerMode !== 'gif') el.pickerGrid.querySelector('[data-emoji]')?.click();
      }
    });
    el.pickerGrid.addEventListener('click', (e) => {
      const em = e.target.closest('[data-emoji]');
      const gif = e.target.closest('[data-gif]');
      if (em) this.pickEmoji(em.dataset.emoji, e.shiftKey);
      else if (gif) this.sendGif(gif.dataset.gif);
    });
    el.pickerGrid.addEventListener('mouseover', (e) => {
      const em = e.target.closest('[data-emoji]');
      if (!em) return;
      const info = EMOJI_BY_CHAR.get(em.dataset.emoji);
      el.pickerFoot.innerHTML = info ? `<span class="chat-picker-foot-emoji">${info.u}</span><span>:${esc(info.name)}:</span>` : '';
    });
    el.pickerCats.addEventListener('click', (e) => {
      const b = e.target.closest('[data-cat]');
      if (!b) return;
      el.pickerGrid.querySelector(`[data-section="${b.dataset.cat}"]`)?.scrollIntoView({ block: 'start' });
    });
    document.addEventListener('click', () => this.closePicker());

    // Autocomplete
    el.auto.addEventListener('mousedown', (e) => {
      const item = e.target.closest('[data-index]');
      if (!item) return;
      e.preventDefault();
      this.applyAutocomplete(Number(item.dataset.index));
    });

    // Lightbox
    // Click the image to zoom in (around the clicked point), drag to move it, click again to zoom out.
    const lbImg = el.lightbox.querySelector('img');
    const lb = { scale: 1, x: 0, y: 0, drag: null, moved: false };
    const paintLb = () => {
      lbImg.style.transform = lb.scale === 1 ? '' : `translate(${lb.x}px, ${lb.y}px) scale(${lb.scale})`;
      el.lightbox.classList.toggle('zoomed', lb.scale > 1);
    };
    this.resetLightboxZoom = () => { Object.assign(lb, { scale: 1, x: 0, y: 0, drag: null }); paintLb(); };
    lbImg.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      lb.moved = false;
      lb.drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, x: lb.x, y: lb.y };
      lbImg.setPointerCapture(e.pointerId);
    });
    lbImg.addEventListener('pointermove', (e) => {
      if (!lb.drag || e.pointerId !== lb.drag.id) return;
      const dx = e.clientX - lb.drag.sx;
      const dy = e.clientY - lb.drag.sy;
      if (Math.abs(dx) + Math.abs(dy) > 4) lb.moved = true;
      if (lb.scale > 1 && lb.moved) {
        lb.x = lb.drag.x + dx;
        lb.y = lb.drag.y + dy;
        paintLb();
      }
    });
    const lbEnd = (e) => { if (lb.drag && e.pointerId === lb.drag.id) lb.drag = null; };
    lbImg.addEventListener('pointerup', lbEnd);
    lbImg.addEventListener('pointercancel', lbEnd);
    lbImg.addEventListener('click', (e) => {
      e.stopPropagation();
      if (lb.moved) return;
      if (lb.scale > 1) { this.resetLightboxZoom(); return; }
      const r = lbImg.getBoundingClientRect();
      // Natural size when the picture was shrunk to fit, otherwise twice as big.
      const next = Math.min(8, Math.max(2, (lbImg.naturalWidth || 0) / r.width));
      const px = e.clientX - r.left;
      const py = e.clientY - r.top;
      // transform-origin is the image's top-left: keep the clicked point under the cursor.
      lb.scale = next;
      lb.x = px - px * next;
      lb.y = py - py * next;
      paintLb();
    });
    el.lightbox.addEventListener('click', (e) => {
      if (e.target.tagName !== 'A') { el.lightbox.classList.add('hidden'); this.resetLightboxZoom(); }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (!el.lightbox.classList.contains('hidden')) { el.lightbox.classList.add('hidden'); this.resetLightboxZoom(); }
      else if (this.pickerMode) this.closePicker();
    });
    window.addEventListener('focus', () => this.markRead());
    this.bindImageMenu();
  }

  bindImageMenu() {
    const { el } = this;
    const menu = el.imageMenu;
    el.list.addEventListener('contextmenu', (e) => {
      const item = e.target.closest('.chat-media-item');
      if (!item || item.classList.contains('loading') || !item.dataset.full) return;
      this.openImageMenu(e, item.dataset.full, item.querySelector('img')?.alt || '');
    });
    const lbImg = el.lightbox.querySelector('img');
    lbImg.addEventListener('contextmenu', (e) => {
      if (lbImg.src) this.openImageMenu(e, lbImg.getAttribute('src'), lbImg.alt || '');
    });
    // Right-clicking the dark area around the picture shows nothing (no browser menu either).
    el.lightbox.addEventListener('contextmenu', (e) => { if (e.target !== lbImg) e.preventDefault(); });
    menu.addEventListener('contextmenu', (e) => e.preventDefault());
    menu.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-img-action]');
      if (!btn) return;
      const { src, name } = this.imageMenuTarget || {};
      this.closeImageMenu();
      if (!src) return;
      const action = btn.dataset.imgAction;
      if (action === 'copy') this.copyImage(src);
      else if (action === 'save') this.saveImage(src, name);
      else if (action === 'copy-link') {
        navigator.clipboard?.writeText(src).then(() => this.toast('Link copiado.')).catch(() => this.toast('Não foi possível copiar.'));
      } else if (action === 'open') window.open(src, '_blank', 'noopener,noreferrer');
    });
    // A click outside only closes the menu: it must not also close the lightbox behind it.
    let swallowClick = false;
    document.addEventListener('pointerdown', (e) => {
      if (!this.imageMenuOpen() || menu.contains(e.target)) return;
      this.closeImageMenu();
      if (e.button === 0) {
        swallowClick = true;
        setTimeout(() => { swallowClick = false; }, 500);
      }
    }, true);
    document.addEventListener('click', (e) => {
      if (!swallowClick) return;
      swallowClick = false;
      e.stopPropagation();
      e.preventDefault();
    }, true);
    window.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !this.imageMenuOpen()) return;
      e.stopImmediatePropagation();
      this.closeImageMenu();
    }, true);
    window.addEventListener('blur', () => this.closeImageMenu());
    window.addEventListener('resize', () => this.closeImageMenu());
    el.scroller.addEventListener('scroll', () => this.closeImageMenu(), { passive: true });
  }

  imageMenuOpen() {
    const menu = this.el.imageMenu;
    return !menu.classList.contains('hidden') && !menu.classList.contains('fading-out');
  }

  openImageMenu(e, src, name) {
    e.preventDefault();
    e.stopPropagation();
    const menu = this.el.imageMenu;
    const abs = new URL(src, location.href).href;
    // Room uploads need the session cookie and blob: URLs only live in this tab: no link for them.
    const external = /^https?:/i.test(abs) && !new URL(abs).pathname.startsWith(`${API}/file/`);
    this.imageMenuTarget = { src: abs, name };
    menu.querySelectorAll('[data-img-external]').forEach(n => n.classList.toggle('hidden', !external));
    menu.classList.remove('fading-out', 'hidden');
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(e.clientX, window.innerWidth - rect.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(e.clientY, window.innerHeight - rect.height - 8))}px`;
  }

  closeImageMenu() {
    if (!this.imageMenuOpen()) return;
    const menu = this.el.imageMenu;
    menu.classList.add('fading-out');
    const done = () => {
      if (!menu.classList.contains('fading-out')) return; // reopened meanwhile
      menu.classList.remove('fading-out');
      menu.classList.add('hidden');
    };
    menu.addEventListener('animationend', done, { once: true });
    setTimeout(done, 220);
  }

  async imageBlob(src) {
    const res = await fetch(src, { credentials: 'same-origin', referrerPolicy: 'no-referrer' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.blob();
  }

  // The clipboard only takes PNG: other formats are redrawn (a GIF copies its first frame,
  // like Discord). The promise goes straight into ClipboardItem to keep the click's permission.
  async copyImage(src) {
    if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
      this.toast('Seu navegador não permite copiar imagens.');
      return;
    }
    const png = this.imageBlob(src).then(async (blob) => {
      if (blob.type === 'image/png') return blob;
      const bmp = await createImageBitmap(blob);
      const canvas = document.createElement('canvas');
      canvas.width = bmp.width;
      canvas.height = bmp.height;
      canvas.getContext('2d').drawImage(bmp, 0, 0);
      bmp.close?.();
      return new Promise((resolve, reject) => canvas.toBlob(b => (b ? resolve(b) : reject(new Error('toBlob'))), 'image/png'));
    });
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
      this.toast('Imagem copiada.');
    } catch {
      this.toast('Não foi possível copiar a imagem.');
    }
  }

  async saveImage(src, name) {
    try {
      const blob = await this.imageBlob(src);
      const ext = (blob.type.split('/')[1] || 'png').replace('jpeg', 'jpg').replace(/\+.*$/, '');
      let file = String(name || '').trim();
      if (!file) {
        try { file = decodeURIComponent(new URL(src).pathname.split('/').pop() || ''); } catch { file = ''; }
      }
      file = file.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 120);
      if (!/\.[a-z0-9]{2,5}$/i.test(file)) file = `${file || 'imagem'}.${ext}`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = file;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch {
      // The site does not let the page read the image: open it so the browser can save it.
      if (/^https?:/i.test(src)) window.open(src, '_blank', 'noopener,noreferrer');
      else this.toast('Não foi possível salvar a imagem.');
    }
  }

  // Drag the left edge to resize (width remembered per viewer); double-click resets it.
  bindResize(handle) {
    const clamp = (w) => Math.round(Math.max(300, Math.min(w, 760, window.innerWidth - 360)));
    const apply = (w) => {
      if (w) document.documentElement.style.setProperty('--chat-w', `${clamp(w)}px`);
      else document.documentElement.style.removeProperty('--chat-w');
    };
    apply(storageGet(WIDTH_KEY, 0));
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      document.body.classList.add('chat-resizing');
      const move = (ev) => apply(window.innerWidth - ev.clientX);
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
        document.body.classList.remove('chat-resizing');
        storageSet(WIDTH_KEY, this.el.panel.getBoundingClientRect().width);
        window.dispatchEvent(new Event('resize'));
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
    });
    handle.addEventListener('dblclick', () => {
      apply(0);
      storageSet(WIDTH_KEY, 0);
      window.dispatchEvent(new Event('resize'));
    });
  }

  // ---------------------------------------------------------------- open / room

  get open() { return this.isOpen; }

  toggle() { this.isOpen ? this.close() : this.show(); }

  show() {
    this.isOpen = true;
    document.body.classList.add('chat-open');
    document.getElementById('chat-bubbles')?.replaceChildren();
    storageSet(OPEN_KEY, true);
    loadEmojis().catch(() => {});
    requestAnimationFrame(() => {
      this.scrollToBottom();
      if (matchMedia('(pointer: fine)').matches) this.el.input.focus();
    });
    this.markRead();
  }

  close() {
    this.isOpen = false;
    document.body.classList.remove('chat-open');
    storageSet(OPEN_KEY, false);
    this.closePicker();
  }

  setRoom(roomId) {
    if (roomId === this.roomId) return;
    this.session++;
    this.roomId = roomId;
    this.version = 0;
    this.messages = [];
    this.byId.clear();
    this.rendered.clear();
    this.el.list.innerHTML = '';
    this.hasMore = false;
    this.setReply(null);
    this.editingId = null;
    this.clearPending();
    this.typing = [];
    this.renderTyping();
    this.unread = 0;
    this.mentioned = false;
    this.onUnreadChange(0, false);
    this.el.input.value = '';
    this.autosize();
    if (!roomId) {
      this.close();
      return;
    }
    this.el.title.textContent = roomId;
    this.el.input.placeholder = tr(`Conversar em ${roomId}`);
    if (storageGet(OPEN_KEY, false) && matchMedia('(min-width: 900px)').matches) this.show();
    this.start(this.session);
  }

  async start(session) {
    // History first (the latest page), then the long poll from that version on.
    for (let attempt = 0; this.session === session; attempt++) {
      try {
        const data = await this.get('history', { limit: 50 });
        if (this.session !== session) return;
        this.version = data.version;
        this.epoch = data.epoch || null;
        this.hasMore = data.hasMore;
        this.apply(data.messages, { initial: true });
        break;
      } catch {
        await sleep(Math.min(5000, 800 * (attempt + 1)));
      }
    }
    let failures = 0;
    while (this.session === session) {
      try {
        const data = await this.get('events', { since: this.version });
        if (this.session !== session) return;
        if (data.epoch && this.epoch && data.epoch !== this.epoch) {
          // The server restarted (empty memory): new versions start over, and we give it back
          // the history we have so the call keeps it.
          this.version = 0;
          this.restoreHistory(session);
        }
        if (data.epoch) this.epoch = data.epoch;
        this.version = data.version;
        this.apply(data.messages);
        this.typing = data.typing || [];
        this.renderTyping();
        if (data.wants?.length) this.serveWants(data.wants);
        failures = 0;
      } catch {
        failures++;
        await sleep(Math.min(8000, 700 * failures));
      }
    }
  }

  // Sends our signed messages back after a server restart, in small batches (the server keeps
  // only the ones whose signature checks out and ignores ids it already has).
  async restoreHistory(session) {
    const list = this.messages.filter(m => m.sig && !m.deleted && !String(m.id).startsWith('tmp-'));
    for (let i = 0; i < list.length && this.session === session; i += 25) {
      // Only what the server sent: client-side marks (_missing, _loading, pending, localUrl...)
      // would break the signature.
      const clean = (obj) => Object.fromEntries(Object.entries(obj).filter(([k]) => !k.startsWith('_') && !['localUrl', 'pending', 'failed'].includes(k)));
      const batch = list.slice(i, i + 25).map((m) => ({ ...clean(m), attachments: (m.attachments || []).map(clean) }));
      await this.post('restore', { messages: batch }).catch(() => {});
    }
  }

  async get(route, params) {
    const ctx = this.context();
    if (!ctx) throw new Error('no room');
    const qs = new URLSearchParams({ roomId: ctx.roomId, peerId: ctx.peerId, ...params });
    const res = await fetch(`${API}/${route}?${qs}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async post(route, body) {
    const ctx = this.context();
    if (!ctx) throw new Error(tr('Você não está em uma sala.'));
    const res = await fetch(`${API}/${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomId: ctx.roomId, peerId: ctx.peerId, ...body })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  fileUrl(att) {
    return `${API}/file/${encodeURIComponent(this.roomId)}/${encodeURIComponent(att.id)}`;
  }

  // ---------------------------------------------------------------- state

  apply(list, { initial = false, older = false } = {}) {
    if (!list?.length) {
      if (initial) this.render({ stick: true });
      return;
    }
    const myId = this.me()?.id;
    const wasBottom = this.atBottom();
    let fresh = 0;
    const freshList = [];
    let mention = false;
    const newestBefore = this.messages.length ? this.messages[this.messages.length - 1].createdAt : 0;

    for (const m of list) {
      if (m.author) this.knownNames.set(m.author.id, m.author.name);
      // Our optimistic copy is replaced by the real one.
      if (m.nonce) {
        const tmp = this.byId.get(`tmp-${m.nonce}`);
        if (tmp) this.remove(tmp.id);
      }
      if (m.deleted) {
        if (this.byId.has(m.id)) this.remove(m.id);
        continue;
      }
      const existing = this.byId.get(m.id);
      if (existing) {
        Object.assign(existing, m);
        continue;
      }
      // An update to something older than what we loaded is not interesting.
      if (!initial && !older && this.messages.length && m.createdAt < this.messages[0].createdAt) continue;
      this.insert(m);
      if (!initial && !older && m.createdAt > newestBefore && m.author.id !== myId) {
        fresh++;
        freshList.push(m);
        if (this.mentionsMe(m)) mention = true;
      }
    }

    if (older) {
      const before = this.el.scroller.scrollHeight;
      const top = this.el.scroller.scrollTop;
      this.render();
      this.el.scroller.scrollTop = top + (this.el.scroller.scrollHeight - before);
      return;
    }
    this.render({ stick: initial || wasBottom });
    if (!this.isOpen) for (const m of freshList.slice(-3)) this.showBubble(m);
    if (fresh) {
      const visible = this.isOpen && document.hasFocus() && this.atBottom();
      if (!visible) {
        this.unread += fresh;
        this.mentioned ||= mention;
        this.onUnreadChange(this.unread, this.mentioned);
        if (this.isOpen && !this.atBottom()) this.el.jump.classList.remove('hidden');
      }
      this.onNewMessage({ mention, visible });
    }
  }

  insert(m) {
    this.byId.set(m.id, m);
    let i = this.messages.length;
    while (i > 0 && this.messages[i - 1].createdAt > m.createdAt) i--;
    this.messages.splice(i, 0, m);
  }

  remove(msgId) {
    const m = this.byId.get(msgId);
    if (!m) return;
    this.byId.delete(msgId);
    this.messages = this.messages.filter(x => x !== m);
    this.rendered.get(msgId)?.el.remove();
    this.rendered.delete(msgId);
    if (this.editingId === msgId) this.editingId = null;
    if (this.replyTo?.id === msgId) this.setReply(null);
  }

  mentionsMe(m) {
    const myId = this.me()?.id;
    if (!myId) return false;
    return m.content.includes(`<@${myId}>`) || /(^|\s)@(everyone|here)\b/.test(m.content) || m.replyTo?.author?.id === myId;
  }

  markRead() {
    if (!this.isOpen || !document.hasFocus() || !this.atBottom()) return;
    if (!this.unread && !this.mentioned) return;
    this.unread = 0;
    this.mentioned = false;
    this.onUnreadChange(0, false);
  }

  async loadOlder() {
    if (!this.hasMore || this.loadingOlder || !this.messages.length) return;
    const session = this.session;
    this.loadingOlder = true;
    try {
      const first = this.messages.find(m => !m.pending);
      const data = await this.get('history', { before: first.id, limit: 50 });
      if (this.session !== session) return;
      this.hasMore = data.hasMore;
      this.apply(data.messages, { older: true });
    } catch { /* try again on the next scroll */ } finally {
      this.loadingOlder = false;
    }
  }

  // ---------------------------------------------------------------- render

  atBottom() {
    const s = this.el.scroller;
    return s.scrollHeight - s.scrollTop - s.clientHeight < 60;
  }

  scrollToBottom(smooth = false) {
    const s = this.el.scroller;
    s.scrollTo({ top: s.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    this.el.jump.classList.add('hidden');
  }

  memberName(userId) {
    const me = this.me();
    if (me?.id === userId) return me.displayName || me.username;
    const m = this.members().find(x => x.userId === userId);
    return m?.name || this.knownNames.get(userId) || tr('usuário-desconhecido');
  }

  render({ stick = false } = {}) {
    const { list, scroller } = this.el;
    // Measured first: building the fragment below takes the elements out of the list.
    const top = scroller.scrollTop;
    const bottom = this.atBottom();
    const frag = document.createDocumentFragment();
    if (!this.hasMore) {
      const welcome = this.welcomeEl ??= this.buildWelcome();
      frag.appendChild(welcome);
    } else {
      this.welcomeEl?.remove();
    }
    let prev = null;
    let groupStart = 0;
    let groupCount = 0;
    const keep = new Set();
    for (const m of this.messages) {
      const newDay = !prev || !sameDay(new Date(prev.createdAt), new Date(m.createdAt));
      if (newDay) {
        const div = document.createElement('div');
        div.className = 'chat-day';
        div.innerHTML = `<span>${esc(dayLabel(m.createdAt))}</span>`;
        frag.appendChild(div);
      }
      const head = newDay || !prev || prev.author.id !== m.author.id || m.createdAt - prev.createdAt > GROUP_MS || !!m.replyTo
        || m.createdAt - groupStart > GROUP_MS || groupCount >= GROUP_MAX;
      if (head) { groupStart = m.createdAt; groupCount = 0; }
      groupCount++;
      const editing = this.editingId === m.id;
      const key = `${m.version}|${head}|${editing}|${m.pending ? 1 : 0}|${m.failed ? 1 : 0}|${m.embeds?.length || 0}|${this.roomId}`;
      let entry = this.rendered.get(m.id);
      if (!entry || entry.key !== key) {
        const el = this.buildMessage(m, head, editing);
        entry?.el.replaceWith(el);
        entry = { key, el };
        this.rendered.set(m.id, entry);
      }
      keep.add(m.id);
      frag.appendChild(entry.el);
      prev = m;
    }
    for (const [msgId, entry] of this.rendered) {
      if (!keep.has(msgId)) {
        entry.el.remove();
        this.rendered.delete(msgId);
      }
    }
    // Keep a focused edit box alive across re-renders.
    const active = document.activeElement;
    list.replaceChildren(frag);
    if (active && list.contains(active)) active.focus({ preventScroll: true });
    // Rebuilding the list must not move what the reader is looking at (reactions, edits...).
    if (stick || bottom) this.scrollToBottom();
    else scroller.scrollTop = top;
  }

  buildWelcome() {
    const div = document.createElement('div');
    div.className = 'chat-welcome';
    div.innerHTML = `
      <div class="chat-welcome-icon">${ICONS.chat}</div>
      <h3>${esc(tr('Boas-vindas ao chat da sala!'))}</h3>
      <p>${esc(tr('As mensagens ficam aqui enquanto a sala existir. Quando todos saírem, o chat é apagado.'))}</p>`;
    return div;
  }

  buildMessage(m, head, editing) {
    const myId = this.me()?.id;
    const mine = m.author.id === myId;
    const el = document.createElement('div');
    el.className = 'chat-msg';
    el.dataset.id = m.id;
    if (head) el.classList.add('head');
    if (m.pending) el.classList.add('pending');
    if (m.failed) el.classList.add('failed');
    if (this.mentionsMe(m) && !mine) el.classList.add('mentioned');

    let html = '';
    if (m.replyTo) {
      const r = m.replyTo;
      const snippet = r.content ? formatContent(r.content.replace(/\n/g, ' '), { mentionName: id => this.memberName(id), myId }) : `<em>${esc(tr(r.hasAttachments ? 'Clique para ver o anexo' : 'Mensagem original apagada'))}</em>`;
      html += `<div class="chat-reply-ref" data-jump="${esc(r.id)}">
        <img src="${esc(safeAvatar(r.author?.avatarUrl))}" alt="" />
        <span class="chat-reply-name" style="color:${nameColor(r.author?.id, r.author?.nameColor)}">${esc(r.author?.name || '')}</span>
        <span class="chat-reply-snippet">${snippet}</span>
      </div>`;
    }
    if (head) {
      html += `<img class="chat-avatar" data-profile="${esc(m.author.id)}" src="${esc(safeAvatar(m.author.avatarUrl))}" alt="" loading="lazy" />
        <div class="chat-msg-head"><span class="chat-name" data-profile="${esc(m.author.id)}" style="color:${nameColor(m.author.id, m.author.nameColor)}">${esc(m.author.name)}</span><time title="${esc(fullStamp(m.createdAt))}">${esc(stamp(m.createdAt))}</time></div>`;
    } else {
      html += `<time class="chat-side-time" title="${esc(fullStamp(m.createdAt))}">${esc(hhmm(new Date(m.createdAt)))}</time>`;
    }

    const content = m.content || '';
    const onlyMedia = !editing && isMediaUrl(content.trim()) && !/\s/.test(content.trim());
    // A message that is only a GIF page link (Tenor, GIPHY) shows just the GIF, like Discord.
    const onlyGifLink = !editing && !onlyMedia && (m.embeds || []).some(e => e.type === 'image' && e.gif && e.url === content.trim());
    if (editing) {
      html += `<div class="chat-edit">
        <textarea class="chat-edit-input" rows="1" maxlength="${MAX_CONTENT + 200}">${esc(content)}</textarea>
        <div class="chat-edit-hint">${esc(tr('Esc para'))} <a data-action="edit-cancel">${esc(tr('cancelar'))}</a> • ${esc(tr('Enter para'))} <a data-action="edit-save">${esc(tr('salvar'))}</a></div>
      </div>`;
    } else if (content && !onlyMedia && !onlyGifLink) {
      const jumbo = isEmojiOnly(content) ? ' jumbo' : '';
      html += `<div class="chat-content${jumbo}">${formatContent(content, { mentionName: id => this.memberName(id), myId })}${m.editedAt ? `<span class="chat-edited" title="${esc(fullStamp(m.editedAt))}">${esc(tr('(editado)'))}</span>` : ''}</div>`;
    }
    if (m.failed) html += `<div class="chat-failed">${esc(tr('Não foi possível enviar.'))} <a data-action="retry">${esc(tr('Tentar de novo'))}</a> · <a data-action="discard">${esc(tr('Descartar'))}</a></div>`;

    // Media: uploaded files, a message that is only an image/GIF link, YouTube previews.
    const media = [];
    const expired = (m.attachments || []).filter(a => a.expired);
    const missing = [];
    for (const a of m.attachments || []) {
      if (a.expired) continue;
      if (a.p2p) {
        const url = this.files?.url(a.hash);
        if (url) {
          media.push({ src: url, width: a.width, height: a.height, name: a.name, full: url });
        } else if (a._missing) {
          missing.push(a);
        } else {
          media.push({ loading: true, width: a.width, height: a.height, name: a.name });
          this.loadP2P(m, a);
        }
        continue;
      }
      const src = a.localUrl || this.fileUrl(a);
      media.push({ src, width: a.width, height: a.height, name: a.name, full: a.localUrl ? null : src });
    }
    if (onlyMedia) media.push({ src: content.trim(), full: content.trim(), external: true });
    if (media.length) {
      html += `<div class="chat-media count-${Math.min(media.length, 4)}">${media.map((x) => {
        const ratio = x.width && x.height ? `aspect-ratio:${x.width}/${x.height};` : '';
        const single = media.length === 1 && x.width && x.height ? `width:${Math.min(400, x.width, Math.round(300 * x.width / x.height))}px;` : '';
        if (x.loading) return `<div class="chat-media-item loading" style="${single}${ratio || 'aspect-ratio:16/9;'}" title="${esc(tr('Recebendo a imagem de quem está na sala...'))}">${spinnerHtml('media-spinner')}</div>`;
        return `<button type="button" class="chat-media-item" data-full="${esc(x.full || x.src)}" style="${single}${media.length === 1 ? ratio : ''}"><img src="${esc(x.src)}" alt="${esc(x.name || '')}" loading="lazy" ${x.external ? 'referrerpolicy="no-referrer"' : ''} onerror="this.parentNode.classList.add('broken')" /></button>`;
      }).join('')}</div>`;
    }
    if (missing.length) {
      html += `<button type="button" class="chat-expired chat-missing" data-action="refetch">${ICONS.file}<span>${esc(tr(missing.length === 1
        ? 'Imagem indisponível: ninguém conectado na sala tem uma cópia. Clique para tentar de novo.'
        : `${missing.length} imagens indisponíveis: ninguém conectado na sala tem uma cópia. Clique para tentar de novo.`))}</span></button>`;
    }
    if (expired.length) {
      html += `<div class="chat-expired">${ICONS.file}<span>${esc(tr(expired.length === 1
        ? 'Imagem removida para liberar espaço na sala.'
        : `${expired.length} imagens removidas para liberar espaço na sala.`))}</span></div>`;
    }
    const safeHttp = (u) => (/^https?:\/\//i.test(u || '') ? u : '');
    for (const e of m.embeds || []) {
      if (e.type === 'image') {
        if (onlyMedia || !safeHttp(e.image)) continue;
        const w = Number(e.width) || 0;
        const h = Number(e.height) || 0;
        const size = w > 0 && h > 0 ? `width:${Math.min(400, w, Math.round(300 * w / h))}px;aspect-ratio:${w}/${h};` : '';
        html += `<div class="chat-media count-1"><button type="button" class="chat-media-item" data-full="${esc(e.image)}" style="max-width:min(400px, 100%);${size}"><img src="${esc(e.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.parentNode.classList.add('broken')" /></button></div>`;
        continue;
      }
      if (e.type === 'link') {
        const img = safeHttp(e.image);
        const color = /^#[0-9a-f]{3,6}$/i.test(e.color || '') ? e.color : '#1e1f24';
        html += `<div class="chat-embed chat-embed-link${img && !e.large ? ' has-thumb' : ''}" style="--embed-color:${color}">
          <div class="chat-embed-body">
            ${e.site ? `<div class="chat-embed-provider">${esc(e.site)}</div>` : ''}
            ${e.title ? `<a class="chat-embed-title" href="${esc(e.url)}" target="_blank" rel="noopener noreferrer">${esc(e.title)}</a>` : ''}
            ${e.description ? `<div class="chat-embed-desc">${esc(e.description)}</div>` : ''}
          </div>
          ${img ? `<button type="button" class="chat-embed-img chat-media-item${e.large ? ' large' : ''}" data-full="${esc(img)}"><img src="${esc(img)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.parentNode.remove()" /></button>` : ''}
        </div>`;
        continue;
      }
      if (e.type !== 'youtube') continue;
      html += `<div class="chat-embed" style="--embed-color:#ff0000">
        <div class="chat-embed-provider">YouTube</div>
        ${e.author ? `<a class="chat-embed-author" ${e.authorUrl ? `href="${esc(e.authorUrl)}" target="_blank" rel="noopener noreferrer"` : ''}>${esc(e.author)}</a>` : ''}
        <a class="chat-embed-title" href="${esc(e.url)}" target="_blank" rel="noopener noreferrer">${esc(e.title)}</a>
        <div class="chat-embed-video" data-video="${esc(e.videoId)}">
          <img src="https://i.ytimg.com/vi/${esc(e.videoId)}/hqdefault.jpg" alt="" loading="lazy" referrerpolicy="no-referrer" />
          <span class="chat-embed-play">${ICONS.play}</span>
        </div>
      </div>`;
    }
    if (m.reactions?.length) {
      html += `<div class="chat-reactions">${m.reactions.map((r) => {
        const me = r.users.some(u => u.id === myId);
        const who = r.users.map(u => u.name).slice(0, 10).join(', ') + (r.users.length > 10 ? ` +${r.users.length - 10}` : '');
        return `<button type="button" class="chat-reaction${me ? ' me' : ''}" data-react="${esc(r.emoji)}" title="${esc(who)}"><span class="chat-reaction-emoji">${esc(r.emoji)}</span><span>${r.users.length}</span></button>`;
      }).join('')}<button type="button" class="chat-reaction add" data-action="react" title="${esc(tr('Adicionar reação'))}">${ICONS.react}</button></div>`;
    }
    if (!m.pending && !editing) {
      html += `<div class="chat-tools">
        ${QUICK_REACTIONS.map(e => `<button type="button" data-react="${e}" title="${e}">${e}</button>`).join('')}
        <button type="button" data-action="react" title="${esc(tr('Adicionar reação'))}">${ICONS.react}</button>
        <button type="button" data-action="reply" title="${esc(tr('Responder'))}">${ICONS.reply}</button>
        ${mine ? `<button type="button" data-action="edit" title="${esc(tr('Editar'))}">${ICONS.edit}</button>` : ''}
        ${m.content ? `<button type="button" data-action="copy" title="${esc(tr('Copiar texto'))}">${ICONS.copy}</button>` : ''}
        ${mine ? `<button type="button" class="danger" data-action="delete" title="${esc(tr('Apagar mensagem'))}">${ICONS.trash}</button>` : ''}
      </div>`;
    }
    el.innerHTML = html;

    if (editing) {
      const ta = el.querySelector('.chat-edit-input');
      requestAnimationFrame(() => {
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
        this.autosize(ta);
      });
      ta.addEventListener('input', () => this.autosize(ta));
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.stopEdit(); }
        else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.saveEdit(m, ta.value); }
      });
    }
    return el;
  }

  onListClick(e) {
    const msgEl = e.target.closest('.chat-msg');
    const m = msgEl && this.byId.get(msgEl.dataset.id);
    const spoiler = e.target.closest('.cm-spoiler');
    if (spoiler) { spoiler.classList.add('revealed'); return; }
    const mediaItem = e.target.closest('.chat-media-item');
    if (mediaItem) { this.openLightbox(mediaItem.dataset.full, mediaItem.querySelector('img')?.alt || ''); return; }
    const video = e.target.closest('.chat-embed-video');
    if (video && !video.querySelector('iframe')) {
      const iframe = document.createElement('iframe');
      iframe.src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(video.dataset.video)}?autoplay=1`;
      iframe.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
      iframe.allowFullscreen = true;
      iframe.referrerPolicy = 'strict-origin-when-cross-origin';
      video.replaceChildren(iframe);
      return;
    }
    const copyCode = e.target.closest('[data-copy-code]');
    if (copyCode) {
      e.stopPropagation();
      const code = copyCode.parentElement.querySelector('code')?.textContent || '';
      navigator.clipboard?.writeText(code).then(() => {
        copyCode.classList.add('done');
        copyCode.title = tr('Copiado!');
        clearTimeout(copyCode._t);
        copyCode._t = setTimeout(() => { copyCode.classList.remove('done'); copyCode.title = tr('Copiar'); }, 1500);
      }).catch(() => this.toast('Não foi possível copiar.'));
      return;
    }
    const profile = e.target.closest('[data-profile]');
    if (profile && this.onProfile) {
      e.stopPropagation();
      const uid = profile.dataset.profile;
      const author = m && (m.author.id === uid ? m.author : m.replyTo?.author?.id === uid ? m.replyTo.author : null);
      this.onProfile(uid, profile, author || { id: uid, name: this.memberName(uid) });
      return;
    }
    const jump = e.target.closest('[data-jump]');
    if (jump) { this.jumpTo(jump.dataset.jump); return; }
    if (!m) return;
    const reactBtn = e.target.closest('[data-react]');
    if (reactBtn) { this.react(m, reactBtn.dataset.react); return; }
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (!action) return;
    e.stopPropagation();
    if (action === 'reply') this.setReply(m);
    else if (action === 'edit') this.startEdit(m.id);
    else if (action === 'edit-cancel') this.stopEdit();
    else if (action === 'edit-save') this.saveEdit(m, msgEl.querySelector('.chat-edit-input').value);
    else if (action === 'delete') this.deleteMessage(m, e.shiftKey);
    else if (action === 'copy') navigator.clipboard?.writeText(m.content).then(() => this.toast('Texto copiado.')).catch(() => {});
    else if (action === 'react') this.openPicker('react', m);
    else if (action === 'retry') this.retry(m);
    else if (action === 'refetch') {
      for (const a of m.attachments || []) if (a.p2p) delete a._missing;
      m.version = (m.version || 0) + 0.001;
      this.render();
    }
    else if (action === 'discard') { this.remove(m.id); this.render(); }
  }

  jumpTo(msgId) {
    const entry = this.rendered.get(msgId);
    if (!entry) {
      this.toast('A mensagem original não está carregada.');
      return;
    }
    entry.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    entry.el.classList.remove('flash');
    void entry.el.offsetWidth;
    entry.el.classList.add('flash');
  }

  openLightbox(src, name = '') {
    const { lightbox } = this.el;
    lightbox.querySelector('img').alt = name;
    this.resetLightboxZoom?.();
    lightbox.querySelector('img').src = src;
    const link = lightbox.querySelector('a');
    link.href = src;
    // Room uploads need the session cookie (an outside browser has none): save them instead.
    const own = src.startsWith(`${API}/file/`) || src.startsWith('blob:');
    if (own) link.setAttribute('download', '');
    else link.removeAttribute('download');
    link.textContent = tr(own ? 'Salvar imagem' : 'Abrir no navegador');
    lightbox.classList.remove('hidden');
  }

  // Chat closed: a short-lived bubble with the message pointing at the sender's avatar
  // (MESSAGE > PHOTO), under the chat button. Clicking it opens the chat.
  showBubble(m) {
    let stack = document.getElementById('chat-bubbles');
    if (!stack) {
      stack = document.createElement('div');
      stack.id = 'chat-bubbles';
      stack.className = 'chat-bubbles';
      document.body.appendChild(stack);
      watchEmojis(stack);
    }
    const myId = this.me()?.id;
    const text = (m.content || '').trim();
    const body = text
      ? formatContent(text, { mentionName: id => this.memberName(id), myId })
      : `<em>${esc(tr(m.attachments?.length ? 'Enviou uma imagem' : 'Nova mensagem'))}</em>`;
    const item = document.createElement('button');
    item.type = 'button';
    item.className = `chat-bubble${this.mentionsMe(m) ? ' mention' : ''}`;
    item.setAttribute('data-no-tr', '');
    item.innerHTML = `<div class="chat-bubble-msg"><div class="chat-bubble-name">${esc(m.author?.name || '')}</div><div class="chat-bubble-text">${body}</div></div>
      <img class="chat-bubble-avatar" src="${esc(safeAvatar(m.author?.avatarUrl))}" alt="" />`;
    item.addEventListener('click', () => this.show());
    stack.appendChild(item);
    while (stack.children.length > 3) stack.firstElementChild.remove();
    const ttl = Math.min(9000, 4000 + text.length * 40);
    let timer = setTimeout(() => leave(), ttl);
    const leave = () => { item.classList.add('leaving'); setTimeout(() => item.remove(), 200); };
    item.addEventListener('pointerenter', () => clearTimeout(timer));
    item.addEventListener('pointerleave', () => { timer = setTimeout(leave, 2500); });
  }

  renderTyping() {
    const names = this.typing.map(t => t.name);
    let text = '';
    if (names.length === 1) text = tr(`${names[0]} está digitando...`);
    else if (names.length === 2) text = tr(`${names[0]} e ${names[1]} estão digitando...`);
    else if (names.length > 2) text = tr('Várias pessoas estão digitando...');
    this.el.typing.innerHTML = text ? `<span class="chat-typing-dots"><i></i><i></i><i></i></span><span>${esc(text)}</span>` : '';
  }

  // ---------------------------------------------------------------- composer

  autosize(ta = this.el.input, { keepCaret = false } = {}) {
    if (ta === this.el.input) this.updateSendButton();
    ta.style.height = 'auto';
    if (!ta.value) {
      // The placeholder doesn't count: one line.
      ta.style.height = '';
      ta.style.overflowY = 'hidden';
      if (ta === this.el.input) ta.parentElement.classList.remove('is-stacked');
      return;
    }
    if (ta !== this.el.input) {
      ta.style.height = `${Math.min(ta.scrollHeight, 260)}px`;
      ta.style.overflowY = ta.scrollHeight > 260 ? 'auto' : 'hidden';
      return;
    }
    // The composer row scrolls, not the textarea: it takes its full height and the row keeps
    // the caret in view (typing at the end stays at the bottom).
    const row = ta.parentElement;
    const keep = row.scrollTop;
    ta.style.height = `${ta.scrollHeight}px`;
    // A long message (3+ lines) stacks GIF / emoji / send in a column so the text gets the
    // width; it goes back to a row only under 2 lines (no flip-flop as the width changes).
    const stacked = row.classList.contains('is-stacked');
    const want = stacked ? ta.scrollHeight > 70 : ta.scrollHeight >= 80;
    if (want !== stacked) {
      row.classList.toggle('is-stacked', want);
      ta.style.height = 'auto';
      ta.style.height = `${ta.scrollHeight}px`;
    }
    ta.style.overflowY = 'hidden';
    row.scrollTop = keep;
    if (ta.selectionEnd === ta.value.length) row.scrollTop = row.scrollHeight;
    else if (keepCaret && document.activeElement === ta) this.revealCaret(ta, row);
  }

  // Scrolls the composer row so the caret's line is inside it (mirror of the text up to it).
  revealCaret(ta, row) {
    const mirror = document.createElement('div');
    const cs = getComputedStyle(ta);
    for (const prop of ['font', 'lineHeight', 'letterSpacing', 'padding', 'border', 'boxSizing', 'whiteSpace', 'overflowWrap', 'wordBreak', 'tabSize']) mirror.style[prop] = cs[prop];
    Object.assign(mirror.style, { position: 'absolute', visibility: 'hidden', width: `${ta.clientWidth}px`, whiteSpace: 'pre-wrap', overflowWrap: 'break-word' });
    mirror.textContent = ta.value.slice(0, ta.selectionEnd);
    mirror.append(document.createElement('span'));
    document.body.append(mirror);
    const caretY = mirror.scrollHeight;
    mirror.remove();
    const lineH = parseFloat(cs.lineHeight) || 20;
    const taTop = ta.getBoundingClientRect().top - row.getBoundingClientRect().top + row.scrollTop;
    const top = taTop + caretY - lineH - 4;
    const bottom = taTop + caretY + 4;
    if (top < row.scrollTop) row.scrollTop = top;
    else if (bottom > row.scrollTop + row.clientHeight) row.scrollTop = bottom - row.clientHeight;
  }

  onInput() {
    const { input, counter } = this.el;
    this.autosize();
    const left = MAX_CONTENT - input.value.length;
    counter.classList.toggle('hidden', left > 200);
    counter.classList.toggle('over', left < 0);
    counter.textContent = String(left);
    this.updateAutocomplete();
    if (input.value.trim() && Date.now() - this.typingSentAt > 6000) {
      this.typingSentAt = Date.now();
      this.post('typing', {}).catch(() => {});
    }
  }

  onInputKey(e) {
    if (this.autocomplete) {
      const { items } = this.autocomplete;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const n = items.length;
        this.autocomplete.index = (this.autocomplete.index + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
        this.renderAutocomplete();
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        this.applyAutocomplete(this.autocomplete.index);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        this.hideAutocomplete();
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      this.send();
    } else if (e.key === 'Escape') {
      if (this.replyTo) this.setReply(null);
      else if (this.pending.length) this.clearPending();
    } else if (e.key === 'ArrowUp' && !this.el.input.value) {
      const myId = this.me()?.id;
      const last = [...this.messages].reverse().find(m => m.author.id === myId && !m.pending);
      if (last) {
        e.preventDefault();
        this.startEdit(last.id);
      }
    }
  }

  setReply(m) {
    this.replyTo = m ? { id: m.id, name: m.author.name } : null;
    this.el.replyBar.classList.toggle('hidden', !m);
    if (m) {
      this.el.replyText.innerHTML = `${esc(tr('Respondendo a'))} <strong>${esc(m.author.name)}</strong>`;
      this.el.input.focus();
    }
  }

  // Mentions are typed as @Name and sent as <@id>.
  encodeMentions(text) {
    const people = this.mentionables();
    people.sort((a, b) => b.name.length - a.name.length);
    for (const p of people) {
      const re = new RegExp(`(^|\\s)@${p.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[\\s.,!?:;])`, 'g');
      text = text.replace(re, `$1<@${p.userId}>`);
    }
    return text;
  }

  mentionables() {
    const seen = new Map();
    const me = this.me();
    for (const m of this.members()) if (m.userId && m.userId !== me?.id) seen.set(m.userId, { userId: m.userId, name: m.name, avatarUrl: m.avatarUrl });
    for (const [userId, name] of this.knownNames) if (!seen.has(userId) && userId !== me?.id) seen.set(userId, { userId, name });
    return [...seen.values()];
  }

  async send() {
    const { input } = this.el;
    const raw = input.value;
    const content = this.encodeMentions(replaceShortcodes(raw.trim()));
    if (!content && !this.pending.length) return;
    if (content.length > MAX_CONTENT) {
      this.toast(`A mensagem passou de ${MAX_CONTENT} caracteres.`);
      return;
    }
    const files = this.pending.slice();
    const replyTo = this.replyTo?.id || null;
    input.value = '';
    this.autosize();
    this.onInput();
    this.setReply(null);
    this.clearPending({ keepUrls: true });
    this.typingSentAt = 0;
    this.closePicker();

    const me = this.me();
    const nonce = Math.random().toString(36).slice(2);
    const replyMsg = replyTo && this.byId.get(replyTo);
    const tmp = {
      id: `tmp-${nonce}`,
      nonce,
      pending: true,
      author: { id: me?.id, name: me?.displayName || me?.username || '', avatarUrl: me?.avatarUrl, nameColor: me?.nameColor || null },
      content,
      attachments: files.map(f => ({ localUrl: f.url, width: f.width, height: f.height, name: f.file.name })),
      embeds: [],
      reactions: [],
      replyTo: replyMsg ? { id: replyMsg.id, author: replyMsg.author, content: replyMsg.content.slice(0, 200), hasAttachments: !!replyMsg.attachments.length } : null,
      createdAt: Math.max(Date.now(), (this.messages.at(-1)?.createdAt || 0) + 1),
      version: 0,
      _send: { content, files, replyTo }
    };
    this.insert(tmp);
    this.render({ stick: true });
    await this.deliver(tmp);
  }

  async deliver(tmp) {
    const { content, files, replyTo } = tmp._send;
    try {
      const ids = [];
      for (const f of files) {
        if (this.files) {
          // P2P: the server only gets the description; the bytes stay here and go to whoever asks.
          f.hash ??= await sha256Hex(f.file);
          this.files.put(f.hash, f.file);
          ids.push({ hash: f.hash, type: f.file.type, size: f.file.size, name: f.file.name || 'imagem', width: f.width, height: f.height });
        } else {
          ids.push(f.uploadedId ??= await this.upload(f));
        }
      }
      const { message } = await this.post('send', { content, attachments: ids, replyTo, nonce: tmp.nonce });
      for (const f of files) URL.revokeObjectURL(f.url);
      this.apply([message]);
    } catch (err) {
      if (!this.byId.has(tmp.id)) return;
      tmp.pending = false;
      tmp.failed = true;
      this.render();
      this.toast(err.message || 'Não foi possível enviar a mensagem.');
    }
  }

  retry(m) {
    m.failed = false;
    m.pending = true;
    this.render();
    this.deliver(m);
  }

  // Relay fallback: nobody could deliver the image over WebRTC (no direct route, no TURN), so ask
  // whoever has it to pass it through the server, and wait up to ~40 s for it.
  async relayFetch(hash, type) {
    const ctx = this.context();
    if (!ctx) return null;
    const qs = () => new URLSearchParams({ roomId: ctx.roomId, peerId: ctx.peerId, hash });
    const deadline = Date.now() + 40000;
    let asked = false;
    while (Date.now() < deadline && this.context()?.roomId === ctx.roomId) {
      const res = await fetch(`${API}/relay-file?${qs()}`, { cache: 'no-store' }).catch(() => null);
      if (res?.ok) return new Blob([await res.arrayBuffer()], { type: type || res.headers.get('content-type') || '' });
      if (!asked || Date.now() % 10000 < 1600) {
        asked = true;
        const want = await this.post('relay-want', { hash }).catch(() => null);
        if (want?.ready) continue;
      }
      await sleep(1500);
    }
    return null;
  }

  // Someone can't get an image over WebRTC: if we have it, hand it to the server's relay once.
  serveWants(hashes) {
    this.relayed ??= new Map();
    const ctx = this.context();
    if (!ctx || !this.files) return;
    for (const hash of hashes) {
      const blob = this.files.store.get(hash);
      const last = this.relayed.get(hash) || 0;
      if (!blob || Date.now() - last < 60000) continue;
      this.relayed.set(hash, Date.now());
      // A small random delay so several holders don't all upload the same file.
      setTimeout(() => {
        const qs = new URLSearchParams({ roomId: ctx.roomId, peerId: ctx.peerId, hash });
        fetch(`${API}/relay-put?${qs}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: blob }).catch(() => {});
      }, Math.random() * 800);
    }
  }

  // Fetches a P2P image from the people in the room (the sender first) and shows it.
  loadP2P(m, a) {
    if (!this.files || a._loading) return;
    a._loading = true;
    this.files.fetch(a.hash, { size: a.size, type: a.type, preferPeer: a.fromPeer }).then((blob) => {
      a._loading = false;
      if (!blob) a._missing = true;
      const live = this.byId.get(m.id);
      if (!live) return;
      // The message object may have been replaced by a newer copy from the server.
      for (const b of live.attachments || []) if (b.hash === a.hash) { b._missing = a._missing; }
      const keepBottom = this.atBottom();
      live.version = (live.version || 0) + 0.001;
      this.render({ stick: keepBottom });
    });
  }

  async upload(f) {
    const ctx = this.context();
    if (!ctx) throw new Error(tr('Você não está em uma sala.'));
    const qs = new URLSearchParams({ roomId: ctx.roomId, peerId: ctx.peerId, name: f.file.name || 'imagem', w: f.width || '', h: f.height || '' });
    const res = await fetch(`${API}/upload?${qs}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: f.file });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || tr('Falha ao enviar a imagem.'));
    return data.id;
  }

  async addFiles(files) {
    for (const file of files) {
      if (this.pending.length >= MAX_ATTACHMENTS) {
        this.toast(`No máximo ${MAX_ATTACHMENTS} imagens por mensagem.`);
        break;
      }
      if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) {
        this.toast('Envie imagens PNG, JPG, GIF ou WebP.');
        continue;
      }
      const limit = this.files ? P2P_MAX_FILE_BYTES : MAX_FILE_BYTES;
      if (file.size > limit) {
        this.toast(`"${file.name}" passa de ${limit / 1024 / 1024} MB.`);
        continue;
      }
      const url = URL.createObjectURL(file);
      const dims = await new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
        img.onerror = () => resolve({});
        img.src = url;
      });
      this.pending.push({ file, url, ...dims });
    }
    this.renderPending();
    if (!this.isOpen) this.show();
    this.el.input.focus();
  }

  updateSendButton() {
    this.el.send.disabled = !this.el.input.value.trim() && !this.pending.length;
  }

  renderPending() {
    this.updateSendButton();
    const { uploads } = this.el;
    uploads.classList.toggle('hidden', !this.pending.length);
    uploads.innerHTML = this.pending.map((f, i) => `
      <div class="chat-upload">
        <img src="${esc(f.url)}" alt="" />
        <span class="chat-upload-name" data-no-tr>${esc(f.file.name || 'imagem')}</span>
        <span class="chat-upload-size">${esc(formatBytes(f.file.size))}</span>
        <button type="button" data-remove="${i}" title="${esc(tr('Remover'))}" aria-label="${esc(tr('Remover'))}">${ICONS.trash}</button>
      </div>`).join('');
    uploads.querySelectorAll('[data-remove]').forEach(b => b.addEventListener('click', () => {
      const [f] = this.pending.splice(Number(b.dataset.remove), 1);
      if (f) URL.revokeObjectURL(f.url);
      this.renderPending();
    }));
  }

  clearPending({ keepUrls = false } = {}) {
    if (!keepUrls) for (const f of this.pending) URL.revokeObjectURL(f.url);
    this.pending = [];
    this.renderPending();
  }

  startEdit(msgId) {
    this.editingId = msgId;
    this.render();
    this.rendered.get(msgId)?.el.scrollIntoView({ block: 'nearest' });
  }

  stopEdit() {
    this.editingId = null;
    this.render();
    this.el.input.focus();
  }

  async saveEdit(m, value) {
    const content = this.encodeMentions(replaceShortcodes(value.trim()));
    if (!content && !m.attachments.length) {
      this.stopEdit();
      this.deleteMessage(m);
      return;
    }
    if (content === m.content) {
      this.stopEdit();
      return;
    }
    try {
      const { message } = await this.post('edit', { id: m.id, content });
      this.editingId = null;
      this.apply([message]);
      this.render();
      this.el.input.focus();
    } catch (err) {
      this.toast(err.message);
    }
  }

  async deleteMessage(m, skipConfirm = false) {
    if (!skipConfirm) {
      const ok = await this.confirm({
        title: 'Apagar mensagem',
        message: 'Tem certeza de que deseja apagar esta mensagem? (Segure Shift ao clicar para pular esta confirmação.)',
        confirmLabel: 'Apagar',
        danger: true
      });
      if (!ok) return;
    }
    try {
      await this.post('delete', { id: m.id });
      this.remove(m.id);
      this.render();
    } catch (err) {
      this.toast(err.message);
    }
  }

  async react(m, emoji) {
    if (m.pending) return;
    pushRecent(emoji);
    const myId = this.me()?.id;
    // Optimistic toggle; the server's version replaces it a moment later.
    const me = this.me();
    let r = m.reactions.find(x => x.emoji === emoji);
    const had = r?.users.some(u => u.id === myId);
    if (had) {
      r.users = r.users.filter(u => u.id !== myId);
      if (!r.users.length) m.reactions = m.reactions.filter(x => x !== r);
    } else {
      if (!r) m.reactions.push(r = { emoji, users: [] });
      r.users.push({ id: myId, name: me?.displayName || '' });
    }
    m.version = (m.version || 0) + 0.001;
    this.render();
    try {
      await this.post('react', { id: m.id, emoji, on: !had });
    } catch (err) {
      this.toast(err.message);
    }
  }

  // ---------------------------------------------------------------- autocomplete (:emoji: and @mentions)

  updateAutocomplete() {
    const { input } = this.el;
    const before = input.value.slice(0, input.selectionStart);
    let m = /(^|\s)@([^\s@]{0,32})$/.exec(before);
    if (m) {
      const q = m[2].toLowerCase();
      const items = this.mentionables()
        .filter(p => p.name.toLowerCase().includes(q))
        .slice(0, 8)
        .map(p => ({ kind: 'mention', label: p.name, avatar: p.avatarUrl, insert: `@${p.name} ` }));
      if ('everyone'.startsWith(q)) items.push({ kind: 'mention', label: '@everyone', insert: '@everyone ', everyone: true, hint: tr('Notifica todos que estão nesta sala.') });
      return this.showAutocomplete(items, before.length - m[2].length - 1, tr(`Resultados de opções para @${m[2]}`));
    }
    m = /(^|\s):([\p{L}\p{N}_+-]{2,32})$/u.exec(before);
    if (m && EMOJIS.length) {
      const items = searchEmojis(m[2], 9).map(e => ({ kind: 'emoji', label: `:${e.name}:`, emoji: e.u, insert: `${e.u} ` }));
      return this.showAutocomplete(items, before.length - m[2].length - 1, tr(`Emojis que combinam com :${m[2]}`));
    }
    if (/(^|\s):[\p{L}\p{N}_]{2,}$/u.test(before)) loadEmojis().then(() => this.updateAutocomplete()).catch(() => {});
    this.hideAutocomplete();
  }

  showAutocomplete(items, start, title) {
    if (!items.length) return this.hideAutocomplete();
    this.autocomplete = { items, start, index: 0, title };
    this.renderAutocomplete();
  }

  renderAutocomplete() {
    const { auto } = this.el;
    const { items, index, title } = this.autocomplete;
    auto.classList.remove('hidden');
    auto.innerHTML = `<div class="chat-auto-title">${esc(title)}</div>` + items.map((it, i) => `
      <div class="chat-auto-item${i === index ? ' active' : ''}${it.everyone ? ' everyone' : ''}" data-index="${i}" role="option">
        ${it.kind === 'emoji' ? `<span class="chat-auto-emoji">${it.emoji}</span>` : it.everyone ? '' : `<img src="${esc(safeAvatar(it.avatar))}" alt="" />`}
        <span class="chat-auto-label" data-no-tr>${esc(it.label)}</span>
        ${it.hint ? `<span class="chat-auto-hint">${esc(it.hint)}</span>` : ''}
      </div>`).join('');
  }

  applyAutocomplete(i) {
    const ac = this.autocomplete;
    const item = ac?.items[i];
    if (!item) return;
    const { input } = this.el;
    const end = input.selectionStart;
    input.value = input.value.slice(0, ac.start) + item.insert + input.value.slice(end);
    const pos = ac.start + item.insert.length;
    input.setSelectionRange(pos, pos);
    if (item.kind === 'emoji') pushRecent(item.emoji);
    this.hideAutocomplete();
    this.autosize();
    input.focus();
  }

  hideAutocomplete() {
    this.autocomplete = null;
    this.el.auto.classList.add('hidden');
  }

  // ---------------------------------------------------------------- picker (emojis, GIFs, reactions)

  togglePicker(tab) {
    if (this.pickerMode === tab) this.closePicker();
    else this.openPicker(tab);
  }

  openPicker(tab, reactTarget = null) {
    const { picker, pickerSearch } = this.el;
    if (tab !== 'react' && this.pickerMode === 'react' && !reactTarget) reactTarget = null;
    this.pickerMode = tab;
    this.reactTarget = tab === 'react' ? reactTarget : null;
    picker.classList.remove('hidden');
    picker.classList.toggle('react-mode', tab === 'react');
    picker.querySelectorAll('.chat-picker-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === (tab === 'gif' ? 'gif' : 'emoji')));
    pickerSearch.value = '';
    pickerSearch.placeholder = tr(tab === 'gif' ? 'Pesquisar no GIPHY' : 'Encontre o emoji perfeito');
    this.renderPicker();
    requestAnimationFrame(() => pickerSearch.focus());
  }

  closePicker() {
    if (!this.pickerMode) return;
    this.pickerMode = null;
    this.reactTarget = null;
    this.el.picker.classList.add('hidden');
  }

  async renderPicker() {
    const mode = this.pickerMode;
    if (!mode) return;
    const { pickerGrid, pickerCats, pickerFoot, pickerSearch } = this.el;
    const query = pickerSearch.value.trim();
    if (mode === 'gif') {
      pickerCats.innerHTML = '';
      pickerFoot.innerHTML = '';
      pickerGrid.className = 'chat-picker-grid gifs';
      pickerGrid.innerHTML = `<div class="chat-picker-note" aria-label="${esc(tr('Carregando...'))}">${spinnerHtml('picker-spinner')}</div>`;
      const gifs = await this.fetchGifs(query);
      if (this.pickerMode !== 'gif' || pickerSearch.value.trim() !== query) return;
      if (gifs.error) {
        pickerGrid.innerHTML = `<div class="chat-picker-note">${esc(tr(gifs.error))}<br><small>${esc(tr('Você ainda pode colar o link de um GIF ou enviar um arquivo .gif.'))}</small></div>`;
        return;
      }
      if (!gifs.length) {
        pickerGrid.innerHTML = `<div class="chat-picker-note">${esc(tr('Nenhum GIF encontrado.'))}</div>`;
        return;
      }
      const cols = [[], []];
      const heights = [0, 0];
      for (const g of gifs) {
        const c = heights[0] <= heights[1] ? 0 : 1;
        cols[c].push(g);
        heights[c] += g.height / g.width;
      }
      pickerGrid.innerHTML = cols.map(col => `<div class="chat-gif-col">${col.map(g => `<button type="button" class="chat-gif" data-gif="${esc(g.url)}" title="${esc(g.title)}" style="aspect-ratio:${g.width}/${g.height}"><img src="${esc(g.preview)}" alt="${esc(g.title)}" loading="lazy" referrerpolicy="no-referrer" /></button>`).join('')}</div>`).join('');
      pickerFoot.innerHTML = '<span class="chat-picker-credit">Powered by GIPHY</span>';
      return;
    }

    pickerGrid.className = 'chat-picker-grid emojis';
    if (!EMOJIS.length) {
      pickerGrid.innerHTML = `<div class="chat-picker-note" aria-label="${esc(tr('Carregando...'))}">${spinnerHtml('picker-spinner')}</div>`;
      try {
        await loadEmojis();
      } catch {
        pickerGrid.innerHTML = `<div class="chat-picker-note">${esc(tr('Não foi possível carregar os emojis.'))}</div>`;
        return;
      }
      if (this.pickerMode !== mode) return;
    }
    const cell = (u) => `<button type="button" class="chat-emoji" data-emoji="${esc(u)}">${u}</button>`;
    if (query) {
      pickerCats.innerHTML = '';
      const found = searchEmojis(query);
      pickerGrid.innerHTML = found.length
        ? `<div class="chat-emoji-section"><div class="chat-emoji-cells">${found.map(e => cell(e.u)).join('')}</div></div>`
        : `<div class="chat-picker-note">${esc(tr('Nenhum emoji encontrado.'))}</div>`;
      return;
    }
    const recent = storageGet(RECENT_KEY, []).filter(u => EMOJI_BY_CHAR.has(u));
    const sections = EMOJI_GROUPS.map((g) => {
      const list = g.id === 'recent' ? recent : EMOJIS.filter(e => e.group === g.id).map(e => e.u);
      return list.length ? { ...g, list } : null;
    }).filter(Boolean);
    pickerCats.innerHTML = sections.map(s => `<button type="button" data-cat="${s.id}" title="${esc(tr(s.label))}">${s.icon}</button>`).join('');
    pickerGrid.innerHTML = sections.map(s => `
      <div class="chat-emoji-section" data-section="${s.id}">
        <div class="chat-emoji-title">${esc(tr(s.label))}</div>
        <div class="chat-emoji-cells">${s.list.map(cell).join('')}</div>
      </div>`).join('');
    pickerGrid.scrollTop = 0;
  }

  async fetchGifs(query) {
    const key = query.toLowerCase();
    if (this.gifCache.has(key)) return this.gifCache.get(key);
    try {
      const res = await fetch(`${API}/gifs?q=${encodeURIComponent(query)}`, { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return { error: data.error || 'Não foi possível buscar GIFs agora.' };
      const list = data.gifs || [];
      this.gifCache.set(key, list);
      if (this.gifCache.size > 40) this.gifCache.delete(this.gifCache.keys().next().value);
      return list;
    } catch {
      return { error: 'Não foi possível buscar GIFs agora.' };
    }
  }

  pickEmoji(u, keepOpen) {
    if (this.pickerMode === 'react') {
      const target = this.reactTarget;
      if (!keepOpen) this.closePicker();
      if (target) this.react(target, u);
      return;
    }
    pushRecent(u);
    const { input } = this.el;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;
    input.value = input.value.slice(0, start) + u + input.value.slice(end);
    const pos = start + u.length;
    input.setSelectionRange(pos, pos);
    this.autosize();
    if (!keepOpen) {
      this.closePicker();
      input.focus();
    }
  }

  async sendGif(url) {
    this.closePicker();
    const prev = this.el.input.value;
    this.el.input.value = url;
    const pending = this.pending;
    this.pending = [];
    await this.send();
    // Whatever was being typed stays in the box.
    this.pending = pending;
    this.renderPending();
    this.el.input.value = prev;
    this.autosize();
    this.el.input.focus();
  }
}

function pushRecent(u) {
  const list = storageGet(RECENT_KEY, []).filter(x => x !== u);
  list.unshift(u);
  storageSet(RECENT_KEY, list.slice(0, 32));
}

// Rewrites the panel open state for the unread badge on the dock.
export function chatBadge(button, count, mention) {
  if (!button) return;
  let badge = button.querySelector('.chat-badge');
  if (!count) {
    badge?.remove();
    return;
  }
  if (!badge) {
    badge = document.createElement('span');
    badge.className = 'chat-badge';
    button.appendChild(badge);
  }
  badge.classList.toggle('mention', !!mention);
  badge.textContent = count > 99 ? '99+' : String(count);
}
