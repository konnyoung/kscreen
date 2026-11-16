// Percentage tooltip for every range slider (Discord style): shown while dragging and while the
// pointer is over the thumb. Above the thumb for horizontal sliders, to its right for vertical ones.
// A slider can change the unit with data-tip-suffix, or opt out with data-no-tip.

const THUMB = 16;
let tip = null;
let active = null;     // slider being dragged
let hovered = null;    // slider whose thumb is under the pointer

function ensureTip() {
  if (tip) return tip;
  tip = document.createElement('div');
  tip.className = 'slider-tip';
  tip.setAttribute('aria-hidden', 'true');
  document.body.appendChild(tip);
  return tip;
}

const isRange = (el) => el instanceof HTMLInputElement && el.type === 'range' && !el.hasAttribute('data-no-tip');
const isVertical = (el) => {
  const cs = getComputedStyle(el);
  return cs.writingMode.startsWith('vertical') || el.getBoundingClientRect().height > el.getBoundingClientRect().width * 2;
};

function frac(el) {
  const min = Number(el.min || 0), max = Number(el.max || 100);
  return max > min ? (Number(el.value) - min) / (max - min) : 0;
}

// Thumb centre in viewport coordinates.
function thumbPos(el) {
  const r = el.getBoundingClientRect();
  const f = frac(el);
  if (isVertical(el)) {
    const rtl = getComputedStyle(el).direction === 'rtl';
    const span = r.height - THUMB;
    const y = rtl ? r.bottom - THUMB / 2 - f * span : r.top + THUMB / 2 + f * span;
    return { x: r.left + r.width / 2, y, vertical: true };
  }
  return { x: r.left + THUMB / 2 + f * (r.width - THUMB), y: r.top + r.height / 2, vertical: false };
}

function show(el) {
  const t = ensureTip();
  const p = thumbPos(el);
  t.textContent = `${Math.round(Number(el.value))}${el.dataset.tipSuffix ?? '%'}`;
  t.classList.toggle('vertical', p.vertical);
  t.style.left = `${p.x}px`;
  t.style.top = `${p.y}px`;
  t.classList.add('show');
}

function hide() { if (tip) tip.classList.remove('show'); }

function refresh() {
  const el = active || hovered;
  if (el && el.isConnected && el.offsetParent !== null) show(el); else hide();
}

function overThumb(el, x, y) {
  const p = thumbPos(el);
  return Math.abs(p.x - x) <= THUMB / 2 + 4 && Math.abs(p.y - y) <= THUMB / 2 + 4;
}

export function initSliderTips() {
  document.addEventListener('pointerdown', (e) => {
    if (!isRange(e.target)) return;
    active = e.target;
    // The value updates after this event: paint on the next frame.
    requestAnimationFrame(refresh);
  }, true);
  const end = () => { if (active) { active = null; refresh(); } };
  document.addEventListener('pointerup', end, true);
  document.addEventListener('pointercancel', end, true);
  document.addEventListener('pointermove', (e) => {
    const el = e.target;
    hovered = isRange(el) && overThumb(el, e.clientX, e.clientY) ? el : null;
    refresh();
  }, true);
  document.addEventListener('input', (e) => {
    if (!isRange(e.target)) return;
    // Snap to whole numbers (step 1) whatever the markup says.
    if (e.target.step === 'any' || !Number.isInteger(Number(e.target.step || 1))) e.target.step = '1';
    if (active === e.target || hovered === e.target || document.activeElement === e.target) show(e.target);
  }, true);
  document.addEventListener('focusout', (e) => { if (e.target === active) active = null; refresh(); }, true);
  window.addEventListener('scroll', () => { if (!active) hide(); }, true);
}
