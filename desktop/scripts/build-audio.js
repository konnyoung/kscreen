'use strict';
// Compiles native/kscreen-audio.exe with the C# compiler that ships with Windows (.NET Framework 4).
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

if (process.platform !== 'win32') {
  console.log('kscreen-audio: só compila no Windows; pulando.');
  process.exit(0);
}
const csc = path.join(process.env.WINDIR || 'C:\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
if (!fs.existsSync(csc)) {
  console.error(`csc.exe não encontrado em ${csc} (.NET Framework 4 vem com o Windows 10/11).`);
  process.exit(1);
}
const dir = path.join(__dirname, '..', 'native');
execFileSync(csc, ['/nologo', '/optimize+', '/platform:x64', '/target:exe',
  `/out:${path.join(dir, 'kscreen-audio.exe')}`, path.join(dir, 'kscreen-audio.cs')], { stdio: 'inherit' });
console.log('kscreen-audio.exe compilado.');
