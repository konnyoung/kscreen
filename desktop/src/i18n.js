'use strict';
// kScreen desktop language: follows the system language (no switcher yet).
// pt / pt-BR / pt-PT -> Portuguese (the text written in the pages and code), anything else -> English.
//
// Loaded two ways:
//  - in the app's own pages (<script src="i18n.js">): translates the page and keeps translating
//    whatever the page writes later (MutationObserver), before it paints;
//  - in the main process (require('./i18n')): tr() for the few texts made there.
// Same engine as the site's src/i18n.js: keys are the Portuguese text, {name} parts match values.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.kI18n = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const EN = {
    // Picker
    'Compartilhar tela': 'Share screen',
    'Aplicativos': 'Applications',
    'Tela Inteira': 'Entire Screen',
    'Cancelar (Esc)': 'Cancel (Esc)',
    'Cancelar': 'Cancel',
    'A tela ou janela é escolhida na janela do sistema.': 'The screen or window is picked in the system dialog.',
    'Qualidade da transmissão': 'Stream quality',
    'Ao vivo': 'Go Live',
    'Modo de transmissão': 'Stream mode',
    'Jogos': 'Games',
    'Qualidade máxima': 'Max quality',
    'Personalizada': 'Custom',
    'Resolução da tela': 'Screen resolution',
    'Taxa de quadros': 'Frame rate',
    'Compartilhar o som do PC': 'Share PC audio',
    'Qualidade do áudio': 'Audio quality',
    'Excluir áudio de apps': 'Exclude app audio',
    'Áudio estéreo': 'Stereo audio',
    'Fonte': 'Source',
    'Fonte · {fps}': 'Source · {fps}',
    'Alta · {rate}': 'High · {rate}',
    'Máxima · {rate}': 'Max · {rate}',
    'sem som': 'no audio',
    'com som do PC': 'with PC audio',
    'som do PC sem {apps}': 'PC audio without {apps}',
    'som do PC sem {a} e {b}': 'PC audio without {a} and {b}',
    'Nenhum app com áudio aberto': 'No app is playing audio',
    'Sem prévia': 'No preview',
    '{detail} · principal': '{detail} · primary',
    'Nenhuma tela encontrada.': 'No screen found.',
    'Nenhum aplicativo aberto para compartilhar.': 'No open app to share.',
    'Escolher tela': 'Choose screen',
    'Tela inteira': 'Entire screen',
    'Tela {n}': 'Screen {n}',

    // Signing in through the browser
    'Continue no navegador': 'Continue in your browser',
    'Confira seu navegador. Autorize o kScreen e volte aqui :)': 'Check your browser. Authorize kScreen and come back here :)',
    'Abrir o navegador de novo': 'Open the browser again',
    'Não deu para entrar': 'Couldn’t sign in',
    'O login não foi concluído.': 'The sign-in didn’t finish.',
    'Entrar com Discord': 'Sign in with Discord',
    'A autorização foi cancelada no Discord.': 'The authorization was cancelled on Discord.',
    'O login expirou ou foi aberto em outra aba. Tente de novo.': 'The sign-in expired or was opened in another tab. Try again.',
    'O tempo para entrar acabou.': 'The time to sign in ran out.',
    'Não foi possível preparar o login neste computador.': 'Couldn’t prepare the sign-in on this computer.',
    'Login concluído!': 'Signed in!',
    'Pode fechar esta aba e voltar ao app.': 'You can close this tab and go back to the app.',
    'Volte ao app e tente entrar de novo.': 'Go back to the app and try signing in again.',

    // Offline
    'Não foi possível conectar': 'Couldn’t connect',
    'Confira sua internet. O kScreen tenta de novo sozinho.': 'Check your internet. kScreen will try again on its own.',
    'Tentar agora': 'Try now',
    'Nova tentativa em {s}s': 'Trying again in {s}s',

    // Title bar
    'Minimizar': 'Minimize',
    'Maximizar': 'Maximize',
    'Restaurar': 'Restore',
    'Fechar': 'Close'
  };

  function detect() {
    let code = '';
    try {
      // Main process: the app locale, which is the system language and is also what the
      // pages see as navigator.language (so main and pages always agree).
      const { app } = require('electron');
      code = app.getLocale();
    } catch {
      code = (typeof navigator !== 'undefined' && (navigator.languages?.[0] || navigator.language)) || '';
    }
    return String(code || '').toLowerCase().startsWith('pt') ? 'pt' : 'en';
  }

  let lang = null;
  const getLang = () => (lang ??= detect());

  const exact = new Map();
  const patterns = [];
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const [pt, en] of Object.entries(EN)) {
    if (!/\{\w+\}/.test(pt)) { exact.set(pt, en); continue; }
    const names = [];
    const source = pt.split(/(\{\w+\})/).map((part) => {
      const m = part.match(/^\{(\w+)\}$/);
      if (!m) return escapeRe(part);
      names.push(m[1]);
      return '(.+?)';
    }).join('');
    patterns.push({ re: new RegExp(`^${source}$`), names, en });
  }
  patterns.sort((a, b) => b.re.source.length - a.re.source.length);

  function translateCore(text) {
    const hit = exact.get(text);
    if (hit !== undefined) return hit;
    for (const p of patterns) {
      const m = text.match(p.re);
      if (!m) continue;
      const values = {};
      p.names.forEach((name, i) => { values[name] = exact.get(m[i + 1]) ?? m[i + 1]; });
      return p.en.replace(/\{(\w+)\}/g, (_, name) => values[name] ?? '');
    }
    return null;
  }

  function tr(text) {
    if (getLang() === 'pt' || typeof text !== 'string') return text;
    const trimmed = text.trim();
    if (!trimmed || !/[A-Za-zÀ-ú]/.test(trimmed)) return text;
    const out = translateCore(trimmed);
    return out == null ? text : text.replace(trimmed, out);
  }

  // --- pages ---
  const ATTRS = ['title', 'aria-label', 'placeholder', 'alt'];
  function translateAttrs(el) {
    for (const name of ATTRS) {
      const value = el.getAttribute(name);
      if (!value) continue;
      const next = tr(value);
      if (next !== value) el.setAttribute(name, next);
    }
  }
  function translateNode(node) {
    if (node.nodeType === 3) {
      const next = tr(node.nodeValue);
      if (next !== node.nodeValue) node.nodeValue = next;
      return;
    }
    if (node.nodeType !== 1) return;
    translateAttrs(node);
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.nodeType === 3) {
        const next = tr(n.nodeValue);
        if (next !== n.nodeValue) n.nodeValue = next;
      } else translateAttrs(n);
    }
  }
  function startTranslating() {
    document.documentElement.lang = getLang() === 'pt' ? 'pt-BR' : 'en';
    if (getLang() === 'pt') return;
    document.title = tr(document.title);
    translateNode(document.body);
    new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'characterData') translateNode(r.target);
        else if (r.type === 'attributes') translateAttrs(r.target);
        else for (const n of r.addedNodes) translateNode(n);
      }
    }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  }

  if (typeof document !== 'undefined' && typeof module === 'undefined') {
    if (document.body) startTranslating();
    else document.addEventListener('DOMContentLoaded', startTranslating);
  }

  return { tr, lang: getLang, startTranslating };
});
