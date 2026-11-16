// Discord's emoji look: every emoji in the chat is drawn with Twemoji (the open-source set Discord
// uses), the same on every system, instead of the OS font. Text stays text for copying (alt).
import twemoji from '@twemoji/api';

const BASE = 'https://cdn.jsdelivr.net/gh/jdecked/twemoji@17.0.3/assets/';
const OPTIONS = {
  base: BASE,
  folder: 'svg',
  ext: '.svg',
  className: 'emoji',
  attributes: () => ({ loading: 'lazy', draggable: 'false' })
};

export function emojify(node) {
  if (node) twemoji.parse(node, OPTIONS);
}

// Keeps a subtree converted as it changes (messages, reactions, picker, bubbles).
export function watchEmojis(root) {
  if (!root) return;
  emojify(root);
  let queued = new Set();
  let scheduled = false;
  new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'characterData') queued.add(r.target.parentNode);
      for (const n of r.addedNodes) {
        if (n.nodeType === 1 && !n.matches('img.emoji')) queued.add(n);
        else if (n.nodeType === 3) queued.add(n.parentNode);
      }
    }
    if (scheduled || !queued.size) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      const list = queued;
      queued = new Set();
      for (const n of list) {
        // Never inside the text box or editable fields.
        if (n?.isConnected && !n.closest('textarea, input, [contenteditable]')) emojify(n);
      }
    });
  }).observe(root, { childList: true, subtree: true, characterData: true });
}
