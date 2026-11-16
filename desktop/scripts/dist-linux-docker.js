'use strict';
// Builds the Linux packages (AppImage + Flatpak) inside Docker, from Windows or any OS.
// The project is copied into the container, so the host's node_modules stay untouched.
// Output: release/kscreen-<version>-x86_64.AppImage and release/kscreen-<version>-x86_64.flatpak
//
// flatpak-builder needs to create its own sandboxes, so the container runs --privileged, and the
// first build downloads the Freedesktop runtime/SDK and the Electron base app from Flathub
// (cached in the kscreen-flatpak volume for the next builds).
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const out = path.join(root, 'release');
const image = process.env.KSCREEN_BUILDER_IMAGE || 'electronuserland/builder:20';

const script = [
  'set -e',
  'command -v flatpak-builder >/dev/null || (apt-get update -qq && apt-get install -y -qq flatpak flatpak-builder >/dev/null)',
  'flatpak remote-add --user --if-not-exists flathub https://dl.flathub.org/repo/flathub.flatpakrepo',
  'mkdir -p /work && cd /src && tar --exclude=./node_modules --exclude=./release -cf - . | (cd /work && tar -xf -)',
  'cd /work && npm ci --no-audit --no-fund',
  'npx electron-builder --linux AppImage flatpak --publish never',
  'cp release/*.AppImage release/*.flatpak /out/',
  'chmod a+rw /out/*'
].join(' && ');

execFileSync('docker', [
  'run', '--rm', '--privileged',
  '-v', `${root}:/src:ro`,
  '-v', `${out}:/out`,
  '-v', 'kscreen-flatpak:/root/.local/share/flatpak',
  '-e', 'ELECTRON_CACHE=/root/.cache/electron',
  '-e', 'ELECTRON_BUILDER_CACHE=/root/.cache/electron-builder',
  image, '/bin/bash', '-c', script
], { stdio: 'inherit' });
console.log(`Pacotes Linux em ${out}`);
