'use strict';
const $ = (id) => document.getElementById(id);
const tb = window.titlebar;

$('minimize').addEventListener('click', () => tb.minimize());
$('maximize').addEventListener('click', () => tb.toggleMaximize());
$('close').addEventListener('click', () => tb.close());

tb.onState(({ maximized, focused }) => {
  $('maximize').querySelector('.max').classList.toggle('hidden', maximized);
  $('maximize').querySelector('.restore').classList.toggle('hidden', !maximized);
  $('maximize').title = maximized ? 'Restaurar' : 'Maximizar';
  document.body.classList.toggle('blurred', !focused);
});
