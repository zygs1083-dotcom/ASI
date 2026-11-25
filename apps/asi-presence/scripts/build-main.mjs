import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(pkg, '../..');
const require = createRequire(import.meta.url);

await mkdir(join(pkg, 'dist/main'), { recursive: true });
await mkdir(join(pkg, 'dist/preload'), { recursive: true });

await Promise.all([
  build({
    entryPoints: [join(pkg, 'src/main/index.ts')],
    outfile: join(pkg, 'dist/main/index.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external: ['electron', 'ws', 'msedge-tts'],
    sourcemap: false,
  }),
  build({
    entryPoints: [join(pkg, 'src/preload/index.ts')],
    outfile: join(pkg, 'dist/preload/index.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
    sourcemap: false,
  }),
]);

// Copy Silero VAD v5 model + ONNX Runtime WASM assets locally into dist/renderer/vad/
// so Electron runs Silero VAD 100% locally without requiring external CDN fetches.
try {
  const vadDistDir = dirname(require.resolve('@ricky0123/vad-web'));
  const ortDistDir = dirname(require.resolve('onnxruntime-web', { paths: [vadDistDir, pkg] }));
  const targetVadDir = join(pkg, 'dist/renderer/vad');
  await mkdir(targetVadDir, { recursive: true });

  const copies = [
    [join(vadDistDir, 'silero_vad_v5.onnx'), join(targetVadDir, 'silero_vad_v5.onnx')],
    [join(vadDistDir, 'vad.worklet.bundle.min.js'), join(targetVadDir, 'vad.worklet.bundle.min.js')],
    [join(ortDistDir, 'ort-wasm-simd-threaded.mjs'), join(targetVadDir, 'ort-wasm-simd-threaded.mjs')],
    [join(ortDistDir, 'ort-wasm-simd-threaded.wasm'), join(targetVadDir, 'ort-wasm-simd-threaded.wasm')],
    [join(ortDistDir, 'ort-wasm-simd-threaded.jsep.mjs'), join(targetVadDir, 'ort-wasm-simd-threaded.jsep.mjs')],
    [join(ortDistDir, 'ort-wasm-simd-threaded.jsep.wasm'), join(targetVadDir, 'ort-wasm-simd-threaded.jsep.wasm')],
  ];

  for (const [src, dst] of copies) {
    if (existsSync(src)) {
      await copyFile(src, dst);
    }
  }
} catch {
  // Non-fatal: Adaptive WebAudio VAD fallback remains active if ONNX assets are absent
}

// On macOS, compile & stage native Apple Speech helper alongside dist/main/index.mjs if Swift CLT is available.
if (process.platform === 'darwin') {
  const buildScript = join(repoRoot, 'native/asi-speech-helper/scripts/build.sh');
  const dstBin = join(pkg, 'dist/main/asi-speech-helper');
  if (existsSync(buildScript)) {
    const targetArch = process.arch === 'x64' ? 'x86_64' : 'arm64';
    const compiled = spawnSync('bash', [buildScript, targetArch, dstBin], { stdio: 'inherit' });
    if (compiled.error || compiled.status !== 0) {
      const reason = compiled.error
        ? compiled.error.message
        : compiled.signal
          ? `signal ${compiled.signal}`
          : `exit ${compiled.status ?? 'unknown'}`;
      console.warn(
        `Warning: Could not build native macOS asi-speech-helper (${reason}; install Xcode CLT to enable macos-speech STT).`,
      );
    } else if (!existsSync(dstBin)) {
      console.warn(`Warning: asi-speech-helper build exited 0 but binary was not found at ${dstBin}.`);
    }
  }
}

console.log('Built apps/asi-presence main, preload, and local Silero VAD assets.');
