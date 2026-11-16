'use strict';
// Prototype benchmark: does a GPU-only capture + encode keep up while a game saturates the GPU?
//
//   gpu  = DXGI capture -> D3D11 texture -> AMF/NVENC encoder (never leaves the GPU, like Discord/OBS)
//   ram  = DXGI capture -> copy to RAM -> encoder (what Chromium does)
//
// Usage (game running, in front):  node scripts/gpu-bench.js [seconds=20] [monitor=0] [encoder=av1_amf]
// Needs ffmpeg with ddagrab (ffmpeg 6.1+) on PATH. Counts only NEW frames (dup_frames=0), so the
// FPS is what a viewer would actually see.
const { spawn, execFileSync } = require('node:child_process');
const path = require('node:path');
// Same GPU/CPU priority the app gives its processes while sharing (kscreen-audio --gpu-priority).
const helper = path.join(__dirname, '..', 'native', 'kscreen-audio.exe');
function boost(pid, realtime) {
  try { require('node:os').setPriority(pid, require('node:os').constants.priority.PRIORITY_ABOVE_NORMAL); } catch { /* ignore */ }
  try { execFileSync(helper, ['--gpu-priority', ...(realtime ? ['realtime'] : []), String(pid)], { windowsHide: true }); return true; } catch { return false; }
}

const seconds = Number(process.argv[2]) || 20;
const monitor = Number(process.argv[3]) || 0;
const encoder = process.argv[4] || 'av1_amf';

const grab = `ddagrab=output_idx=${monitor}:framerate=60:dup_frames=0`;
const encode = ['-c:v', encoder, '-b:v', '12M', ...(encoder.endsWith('_amf') ? ['-usage', 'ultralowlatency'] : [])];
const modes = {
  gpu: ['-f', 'lavfi', '-i', grab, ...encode],
  ram: ['-f', 'lavfi', '-i', grab, '-vf', 'hwdownload,format=bgra', ...encode]
};

function isAdmin() {
  try { execFileSync('net', ['session'], { stdio: 'ignore', windowsHide: true }); return true; } catch { return false; }
}

function run(name, args, boosted, realtime) {
  return new Promise((resolve) => {
    const full = ['-hide_banner', '-nostats', '-progress', 'pipe:1', ...args, '-t', String(seconds), '-f', 'null', '-'];
    const child = spawn('ffmpeg', full, { windowsHide: true });
    if (boosted && !boost(child.pid, realtime)) name += '(sem prioridade!)';
    let frames = 0, err = '';
    child.stdout.on('data', (d) => {
      const m = /frame=(\d+)/g; let x;
      while ((x = m.exec(String(d)))) frames = Number(x[1]);
    });
    child.stderr.on('data', (d) => { err += d; });
    child.on('exit', (code) => {
      if (code) console.log(`${name}: falhou\n${err.split('\n').slice(-6).join('\n')}`);
      else console.log(`${name.padEnd(15)} ${(frames / seconds).toFixed(1).padStart(5)} FPS  (${frames} quadros novos em ${seconds}s)`);
      resolve();
    });
  });
}

(async () => {
  console.log(`Monitor ${monitor}, ${encoder}, ${seconds}s por modo. Deixe o jogo rodando na frente.`);
  await run('gpu', modes.gpu);
  await run('ram', modes.ram);
  await run('gpu+prioridade', modes.gpu, true);
  await run('ram+prioridade', modes.ram, true);
  // REALTIME, like OBS run as admin: only works from an elevated terminal.
  if (isAdmin()) {
    await run('gpu+realtime', modes.gpu, true, true);
    await run('ram+realtime', modes.ram, true, true);
  } else {
    console.log('(abra o terminal como administrador para medir também a prioridade REALTIME)');
  }
})();
