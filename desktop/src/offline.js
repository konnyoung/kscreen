'use strict';
// Shown when the site can't be reached. Retries with backoff and as soon as the network returns.
const params = new URLSearchParams(location.search);
const target = params.get('url') || '';
document.getElementById('detail').textContent = `${params.get('server') || ''} · ${params.get('error') || ''}`;

const attempt = Number(sessionStorage.getItem('kscreen_retry') || '0');
let seconds = Math.min(60, 5 * 2 ** Math.min(attempt, 4));
const countdown = document.getElementById('countdown');

function retry() {
  sessionStorage.setItem('kscreen_retry', String(attempt + 1));
  // The main process only accepts the configured server here.
  location.replace(target);
}

document.getElementById('retry').addEventListener('click', retry);
window.addEventListener('online', retry);

const tick = setInterval(() => {
  seconds--;
  countdown.textContent = `Nova tentativa em ${seconds}s`;
  if (seconds <= 0) {
    clearInterval(tick);
    retry();
  }
}, 1000);
countdown.textContent = `Nova tentativa em ${seconds}s`;
