// Receives the clips of replay-e2e.html (POST /?name=x) and saves them as <dir>/<name>.mp4, so
// check-clip.sh can look at them. Local only: node tests/browser/clip-receiver.mjs <dir> [port]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve(process.argv[2] || '.');
const port = Number(process.argv[3]) || 8765;
fs.mkdirSync(dir, { recursive: true });

http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method !== 'POST') { res.end(); return; }
  const name = (new URL(req.url, 'http://local').searchParams.get('name') || 'clip').replace(/[^a-z0-9-]/gi, '');
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const file = path.join(dir, `${name}.mp4`);
    fs.writeFileSync(file, Buffer.concat(chunks));
    console.log('saved', file);
    res.end('ok');
  });
}).listen(port, '127.0.0.1', () => console.log(`clip receiver on 127.0.0.1:${port} -> ${dir}`));
