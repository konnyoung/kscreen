'use strict';
// Counts the UNIQUE frames per second in recordings (duplicates dropped by ffmpeg's mpdecimate),
// to compare capture methods: OBS records at a fixed 60 FPS and repeats the last frame when the
// capture has nothing new, so the file's own FPS says nothing.
//
// Usage: node scripts/count-frames.js <video> [video...]
const { spawnSync } = require('node:child_process');

function count(file, filter) {
  const args = ['-hide_banner', '-nostats', '-progress', 'pipe:1', '-i', file, ...(filter ? ['-vf', filter] : []), '-an', '-f', 'null', '-'];
  const out = String(spawnSync('ffmpeg', args, { encoding: 'utf8', maxBuffer: 1 << 26 }).stdout || '');
  const frames = Number([...out.matchAll(/frame=(\d+)/g)].pop()?.[1] || 0);
  const us = Number([...out.matchAll(/out_time_us=(\d+)/g)].pop()?.[1] || 0);
  return { frames, seconds: us / 1e6 };
}

for (const file of process.argv.slice(2)) {
  const all = count(file);
  const unique = count(file, 'mpdecimate');
  const secs = all.seconds || 1;
  console.log(`${file}\n  ${(unique.frames / secs).toFixed(1)} FPS únicos (${unique.frames} de ${all.frames} quadros em ${secs.toFixed(1)}s)`);
}
