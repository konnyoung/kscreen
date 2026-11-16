// Guest profile photos never touch the server: the photo lives on the guest's own PC
// (localStorage) and the session only carries "p2p:<sha256>:<size>". Everyone else pulls the
// bytes from the room over the WebRTC "files" channel (direct, or through the media server), the same
// content-addressed transport the chat images use, and the hash is checked on arrival.
// Never through the server relay: if nobody connected has the photo, the default avatar shows.

import { sha256Hex } from './p2p-files.js';
import { SPINNER_IMG } from './spinner.js';

const LOCAL_KEY = 'kscreen_guest_avatar';
const P2P_RE = /^p2p:([0-9a-f]{64}):(\d{1,7})$/;

let files = null;
let onLoaded = () => {};
const pending = new Set();

export function parseP2PAvatar(url) {
  const m = P2P_RE.exec(String(url || ''));
  return m ? { hash: m[1], size: Number(m[2]) } : null;
}

export function initP2PAvatars(p2pFiles, onChange) {
  files = p2pFiles;
  onLoaded = onChange || (() => {});
  // A new connection opened: retry photos nobody had yet.
  const prev = files.onPeerReady;
  files.onPeerReady = (...args) => { prev?.(...args); retryMissing(); };
  pinLocalAvatar();
}

// The object URL of a P2P photo; the loading spinner while it's on its way (download starts
// here); null when nobody in the room had it (the caller shows the default avatar).
export function resolveP2PAvatar(url) {
  const info = parseP2PAvatar(url);
  if (!info || !files) return null;
  const local = files.url(info.hash);
  if (local) return local;
  // Default avatar only once every connection is open and still nobody had it; while someone
  // is still connecting (the photo may come from them) it keeps loading.
  const peers = files.engine.peers.size;
  const allOpen = files.openPeers().length >= peers; // alone in the room counts as "all open"
  if (missing.has(info.hash) && !pending.has(info.hash) && allOpen) return null;
  request(info);
  return SPINNER_IMG;
}

export const isSpinnerAvatar = (url) => url === SPINNER_IMG;

const missing = new Map(); // hash -> info

function request(info) {
  if (pending.has(info.hash)) return;
  pending.add(info.hash);
  files.fetch(info.hash, { size: info.size, type: 'image/webp', noRelay: true })
    .then((blob) => {
      if (blob) missing.delete(info.hash); else missing.set(info.hash, info);
    })
    .catch(() => missing.set(info.hash, info))
    .finally(() => { pending.delete(info.hash); onLoaded(); });
}

function retryMissing() {
  for (const info of missing.values()) request(info);
}

function dataUrlToBlob(dataUrl) {
  const [head, b64] = dataUrl.split(',');
  const type = /data:([^;]+)/.exec(head)?.[1] || 'image/webp';
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

// Keeps the guest's photo on this PC and returns its "p2p:" reference (or null).
export async function saveLocalAvatar(dataUrl) {
  if (!dataUrl) {
    try { localStorage.removeItem(LOCAL_KEY); } catch { /* private mode */ }
    return null;
  }
  const blob = dataUrlToBlob(dataUrl);
  const hash = await sha256Hex(blob);
  try { localStorage.setItem(LOCAL_KEY, dataUrl); } catch { /* private mode: lasts this tab */ }
  files?.pin(hash, blob);
  return { hash, size: blob.size };
}

// Seeds our own photo so the room can download it from us (survives leaving rooms).
export function pinLocalAvatar() {
  let dataUrl = null;
  try { dataUrl = localStorage.getItem(LOCAL_KEY); } catch { /* private mode */ }
  if (!dataUrl || !files) return;
  const blob = dataUrlToBlob(dataUrl);
  sha256Hex(blob).then((hash) => { files.pin(hash, blob); onLoaded(); }).catch(() => {});
}
