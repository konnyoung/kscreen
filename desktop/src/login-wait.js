'use strict';
const error = new URLSearchParams(location.search).get('error');
const messages = {
  denied: 'A autorização foi cancelada no Discord.',
  no_code: 'A autorização foi cancelada no Discord.',
  auth_state: 'O login expirou ou foi aberto em outra aba. Tente de novo.',
  timeout: 'O tempo para entrar acabou.',
  server: 'Não foi possível preparar o login neste computador.'
};

if (error) {
  document.getElementById('box').classList.add('error');
  document.getElementById('title').textContent = 'Não deu para entrar';
  document.getElementById('text').textContent = messages[error] || 'O login não foi concluído.';
  document.getElementById('reopen-label').textContent = 'Entrar com Discord';
}

document.getElementById('reopen').addEventListener('click', () => window.kscreenDesktop.login.reopen());
document.getElementById('cancel').addEventListener('click', () => window.kscreenDesktop.login.cancel());
