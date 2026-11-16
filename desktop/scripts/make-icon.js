'use strict';
// Renders the app icon and installer artwork from the site's brand (pink "k" in K2D on the dark
// background) using Electron itself.  Run: npm run icon   (needs internet for the K2D font)
// Outputs build/icon.png, build/icon.ico, build/installerSidebar.bmp, build/installerHeaderIcon.ico
const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const OUT = path.join(__dirname, '..', 'build');
const FONT = "<link href='https://fonts.googleapis.com/css2?family=K2D:wght@700;800&family=Inter:wght@400;600&display=block' rel='stylesheet'>";

const ICON_HTML = (size) => `<!doctype html><html><head>${FONT}<style>
  html,body{margin:0;background:transparent;overflow:hidden}
  .tile{width:${size}px;height:${size}px;border-radius:${size * 0.22}px;background:#0b0c0e;
    display:grid;place-items:center;box-sizing:border-box;border:${Math.max(1, size * 0.012)}px solid #26272e}
  .k{font-family:'K2D';font-weight:800;color:#f53f5f;font-size:${size * 0.78}px;line-height:1;
    transform:translateY(-${size * 0.045}px);letter-spacing:0}
</style></head><body><div class="tile"><span class="k">k</span></div></body></html>`;

const SIDEBAR_HTML = `<!doctype html><html><head>${FONT}<style>
  html,body{margin:0;width:164px;height:314px;overflow:hidden;background:#0b0c0e;color:#f2f2f5}
  .wrap{height:100%;display:flex;flex-direction:column;justify-content:space-between;padding:26px 18px;box-sizing:border-box;
    background:linear-gradient(180deg,#0b0c0e 0%,#121316 100%)}
  .logo{font-family:'K2D';font-weight:700;font-size:34px;letter-spacing:-1px;line-height:1}
  .logo span{color:#f53f5f}
  p{font-family:'Inter';font-size:11px;line-height:1.5;color:#9a9ba5;margin:12px 0 0}
  .bar{height:3px;width:36px;background:#f53f5f;border-radius:3px}
</style></head><body><div class="wrap"><div><div class="logo"><span>k</span>Screen</div>
<p>Compartilhe a tela com os amigos, direto e em alta qualidade.</p></div><div class="bar"></div></div></body></html>`;

// One offscreen window for every render (creating/destroying several makes later loads fail).
let canvas = null;
async function render(html, width, height) {
  canvas ??= new BrowserWindow({
    width: 1024, height: 1024, show: false, frame: false, transparent: true, useContentSize: true,
    webPreferences: { offscreen: true }
  });
  const file = path.join(app.getPath('temp'), `kscreen-icon-${process.pid}.html`);
  fs.writeFileSync(file, html);
  await canvas.loadFile(file);
  fs.rmSync(file, { force: true });
  await canvas.webContents.executeJavaScript('document.fonts.ready.then(() => document.fonts.size)');
  await new Promise(r => setTimeout(r, 400));
  const image = await canvas.webContents.capturePage({ x: 0, y: 0, width, height });
  return image.resize({ width, height, quality: 'best' });
}

// ICO with PNG-compressed entries (supported since Windows Vista).
function writeIco(file, images) {
  const pngs = images.map(img => img.toPNG());
  const header = Buffer.alloc(6 + 16 * pngs.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  let offset = header.length;
  pngs.forEach((png, i) => {
    const { width, height } = images[i].getSize();
    const e = 6 + i * 16;
    header.writeUInt8(width >= 256 ? 0 : width, e);
    header.writeUInt8(height >= 256 ? 0 : height, e + 1);
    header.writeUInt8(0, e + 2);
    header.writeUInt8(0, e + 3);
    header.writeUInt16LE(1, e + 4);
    header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(png.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += png.length;
  });
  fs.writeFileSync(file, Buffer.concat([header, ...pngs]));
}

// 24-bit BMP (NSIS only takes BMP for the installer sidebar).
function writeBmp(file, image) {
  const { width, height } = image.getSize();
  const bgra = image.toBitmap();
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const data = Buffer.alloc(rowSize * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const src = (y * width + x) * 4;
      const dst = (height - 1 - y) * rowSize + x * 3;
      data[dst] = bgra[src];
      data[dst + 1] = bgra[src + 1];
      data[dst + 2] = bgra[src + 2];
    }
  }
  const header = Buffer.alloc(54);
  header.write('BM', 0);
  header.writeUInt32LE(54 + data.length, 2);
  header.writeUInt32LE(54, 10);
  header.writeUInt32LE(40, 14);
  header.writeInt32LE(width, 18);
  header.writeInt32LE(height, 22);
  header.writeUInt16LE(1, 26);
  header.writeUInt16LE(24, 28);
  header.writeUInt32LE(data.length, 34);
  header.writeInt32LE(2835, 38);
  header.writeInt32LE(2835, 42);
  fs.writeFileSync(file, Buffer.concat([header, data]));
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const big = await render(ICON_HTML(1024), 1024, 1024);
  fs.writeFileSync(path.join(OUT, 'icon.png'), big.resize({ width: 512, height: 512, quality: 'best' }).toPNG());
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  // Small sizes are rendered natively (crisper than downscaling the 1024 one).
  const icons = [];
  for (const s of sizes) icons.push(s >= 64 ? big.resize({ width: s, height: s, quality: 'best' }) : await render(ICON_HTML(s), s, s));
  writeIco(path.join(OUT, 'icon.ico'), icons);
  writeIco(path.join(OUT, 'installerHeaderIcon.ico'), icons);
  writeBmp(path.join(OUT, 'installerSidebar.bmp'), await render(SIDEBAR_HTML, 164, 314));
  console.log('ícones gerados em', OUT);
  app.quit();
});
