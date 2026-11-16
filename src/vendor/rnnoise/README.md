# RNNoise (noise suppression)

`rnnoise-0.2.wasm` is the RNNoise 0.2 model (Xiph.Org, BSD-3-Clause) compiled to WebAssembly by
Jitsi, taken from the npm package `@jitsi/rnnoise-wasm@0.2.1` (Apache-2.0, see
`LICENSE-jitsi-rnnoise-wasm.txt`). It is the binary inlined as base64 in that package's
`dist/rnnoise-sync.js`, saved as a plain file so the browser can cache it and only download it
when someone turns noise suppression on.

Used by `src/noise-worklet.js`. Exports (minified by Emscripten): `c` memory, `d` constructors,
`e` malloc, `f` free, `g` rnnoise_init, `h` rnnoise_create, `i` rnnoise_destroy,
`j` rnnoise_process_frame. Imports: `a.a` emscripten_resize_heap, `a.b` emscripten_memcpy_big.

To refresh it: install the package and extract the base64 after `base64,` in
`dist/rnnoise-sync.js`.
