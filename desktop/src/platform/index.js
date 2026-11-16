'use strict';
// Everything that differs between operating systems lives in one module per platform.
// Interface:
//   capture.systemPicker      true when only the OS may pick the screen/window (Wayland)
//   chromiumFeatures          extra Chromium features to enable (optional)
//   chromiumSwitches          extra Chromium switches, [[name, value?], ...] (optional)
//   audio.supported()         Promise<boolean>: echo-free PC audio available
//   audio.fallbackLoopback    use Electron's plain 'loopback' when unsupported
//   audio.listApps(selfPid)   Promise<[{ exe, name }]>: apps with sound, minus kScreen
//   audio.start({ selfPid, exclude }) -> { stdout (PCM s16le 48k stereo), stop(), onExit(cb) }
//   game                      Windows only: fullscreen windows captured via their monitor
const none = {
  name: process.platform,
  capture: { systemPicker: false },
  audio: {
    supported: () => Promise.resolve(false),
    fallbackLoopback: false,
    listApps: () => Promise.resolve([]),
    start: () => null
  },
  game: null
};

module.exports = process.platform === 'win32' ? require('./win')
  : process.platform === 'linux' ? require('./linux')
    : none;
