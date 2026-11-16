// iOS-style activity indicator, same as the Kennyy web player (.io-spinner in its styles.css):
// 12 tapered spokes fading in sequence. Every loading state in kScreen uses it.

export function spinnerHtml(variant = '') {
  const cls = variant ? `io-spinner ${variant}` : 'io-spinner';
  return `<span class="${cls}" aria-hidden="true">${'<i></i>'.repeat(12)}</span>`;
}

// Same spinner as an image (for <img> avatars still loading): animated SVG on a dark disc.
function spinnerSvg(color = '#e8365d', disc = '#1b1c21') {
  let spokes = '';
  for (let i = 0; i < 12; i++) {
    const delay = -(11 - i) / 12;
    spokes += `<rect x="48.2" y="30" width="3.6" height="10.8" rx="1.8" fill="${color}" transform="rotate(${i * 30} 50 50)">`
      + `<animate attributeName="opacity" values="1;0.12" dur="1s" begin="${delay.toFixed(4)}s" repeatCount="indefinite"/></rect>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="50" fill="${disc}"/>${spokes}</svg>`;
}

export const SPINNER_IMG = `data:image/svg+xml,${encodeURIComponent(spinnerSvg())}`;
