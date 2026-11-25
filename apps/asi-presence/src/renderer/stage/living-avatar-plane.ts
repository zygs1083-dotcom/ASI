import * as THREE from 'three';
import { type ParticleCloudData, UNIFIED_PARTICLE_COUNT } from './jarvis-core.ts';

export type LivingAvatarVariant = 'chibi' | 'realistic';

interface LandmarkRegions {
  /** Normalized top-origin coords [u1, u2, v1, v2] */
  leftEar: [number, number, number, number];
  leftEarPivot: [number, number];
  rightEar: [number, number, number, number];
  rightEarPivot: [number, number];
  tail: [number, number, number, number];
  tailPivot: [number, number];
  faceBox: [number, number, number, number];
  planeHeight: number;
  aspect: number;
  /** Linear-space studio fill exposure & shadow lift so realistic & chibi portraits glow vividly on dark stages */
  exposure: number;
  shadowLift: number;
}

/**
 * Exact QA-verified landmark boxes on our padded transparent RGBA PNGs:
 * - chibi:     768 x 1120 (aspect 0.6857)
 * - realistic: 640 x 1200 (aspect 0.5333)
 */
const AVATAR_SPECS: Record<LivingAvatarVariant, LandmarkRegions> = {
  chibi: {
    leftEar: [0.25, 0.43, 0.04, 0.21],
    leftEarPivot: [0.39, 0.195],
    rightEar: [0.63, 0.87, 0.04, 0.21],
    rightEarPivot: [0.66, 0.195],
    tail: [0.06, 0.26, 0.45, 0.7],
    tailPivot: [0.24, 0.62],
    faceBox: [0.26, 0.78, 0.2, 0.47],
    planeHeight: 1.88,
    aspect: 768 / 1120,
    exposure: 1.05,
    shadowLift: 0.03,
  },
  realistic: {
    leftEar: [0.4, 0.495, 0.03, 0.115],
    leftEarPivot: [0.47, 0.105],
    rightEar: [0.565, 0.66, 0.03, 0.115],
    rightEarPivot: [0.585, 0.105],
    tail: [0.17, 0.355, 0.36, 0.52],
    tailPivot: [0.34, 0.47],
    faceBox: [0.36, 0.66, 0.075, 0.225],
    planeHeight: 1.92,
    aspect: 640 / 1200,
    exposure: 1.24,
    shadowLift: 0.16,
  },
};

const LIVING_AVATAR_VERTEX_SHADER = /* glsl */ `
  uniform float uTime;
  uniform float uBreathe;
  uniform float uEarPerk;
  uniform float uTailWag;
  uniform float uAudioRms;
  uniform vec4 uLeftEarBox;
  uniform vec2 uLeftEarPivot;
  uniform vec4 uRightEarBox;
  uniform vec2 uRightEarPivot;
  uniform vec4 uTailBox;
  uniform vec2 uTailPivot;

  varying vec2 vUv;

  float boxMask(vec2 p, vec4 box, float feather) {
    float mx = smoothstep(box.x - feather, box.x + feather, p.x) * (1.0 - smoothstep(box.y - feather, box.y + feather, p.x));
    float my = smoothstep(box.z - feather, box.z + feather, p.y) * (1.0 - smoothstep(box.w - feather, box.w + feather, p.y));
    return mx * my;
  }

  vec2 rotateAround(vec2 p, vec2 pivot, float angle) {
    vec2 rel = p - pivot;
    float c = cos(angle);
    float s = sin(angle);
    return pivot + vec2(rel.x * c - rel.y * s, rel.x * s + rel.y * c);
  }

  void main() {
    vUv = uv;
    vec2 pTop = vec2(uv.x, 1.0 - uv.y);
    vec3 pos = position;

    // 1. Subtle natural chest/torso breathing rise (anchored cleanly at shoes)
    float bodyWeight = smoothstep(0.08, 0.72, uv.y);
    pos.y += sin(uTime * 1.85) * 0.01 * bodyWeight * uBreathe;
    pos.x *= 1.0 + sin(uTime * 1.85) * 0.005 * smoothstep(0.25, 0.65, uv.y) * (1.0 - smoothstep(0.65, 0.92, uv.y));

    // 2. Snow-white puppy ear subtle perk & joyful listening flutter
    float wLeftEar = boxMask(pTop, uLeftEarBox, 0.025);
    float wRightEar = boxMask(pTop, uRightEarBox, 0.025);
    if (wLeftEar > 0.001) {
      float earAngle = ((uEarPerk - 0.5) * 0.12 + sin(uTime * 2.7 + 0.5) * 0.028 + uAudioRms * 0.05) * wLeftEar;
      vec2 nextTop = rotateAround(pTop, uLeftEarPivot, earAngle);
      pos.x += (nextTop.x - pTop.x) * 1.2;
      pos.y -= (nextTop.y - pTop.y) * 1.45;
    }
    if (wRightEar > 0.001) {
      float earAngle = -((uEarPerk - 0.5) * 0.12 + sin(uTime * 2.7 + 1.8) * 0.028 + uAudioRms * 0.05) * wRightEar;
      vec2 nextTop = rotateAround(pTop, uRightEarPivot, earAngle);
      pos.x += (nextTop.x - pTop.x) * 1.2;
      pos.y -= (nextTop.y - pTop.y) * 1.45;
    }

    // 3. Fluffy snow-white puppy tail gentle wag behind her dress
    float wTail = boxMask(pTop, uTailBox, 0.028);
    if (wTail > 0.001) {
      float tailDist = clamp(length(pTop - uTailPivot) * 4.2, 0.0, 1.0);
      float wagAngle = sin(uTime * (2.9 + uTailWag * 3.8)) * (0.085 + uTailWag * 0.14) * wTail * tailDist;
      vec2 nextTop = rotateAround(pTop, uTailPivot, wagAngle);
      pos.x += (nextTop.x - pTop.x) * 1.35;
      pos.y -= (nextTop.y - pTop.y) * 1.55;
    }

    // Slight forward depth curve for subtle 2.5D volume
    pos.z += (1.0 - abs(uv.x - 0.5) * 2.0) * 0.05;

    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
  }
`;

const LIVING_AVATAR_FRAGMENT_SHADER = /* glsl */ `
  uniform sampler2D uTexIdle;
  uniform sampler2D uTexBlink;
  uniform sampler2D uTexTalk;
  uniform float uBlink;
  uniform float uMouthOpen;
  uniform float uDissolve;
  uniform float uGhostVeil;
  uniform float uExposure;
  uniform float uShadowLift;
  uniform float uOpacity;
  uniform float uTime;
  uniform float uAudioRms;
  uniform float uWorkEnergy;
  uniform vec3 uRimColor;
  uniform vec3 uAccentColor;

  varying vec2 vUv;

  void main() {
    vec4 baseSample = texture2D(uTexIdle, vUv);
    if (baseSample.a < 0.02) discard;

    vec4 blinkSample = texture2D(uTexBlink, vUv);
    vec4 talkSample = texture2D(uTexTalk, vUv);

    // Zero-jitter smooth micro-expression blending (textures are linear-decoded from SRGB8_ALPHA8)
    vec3 col = mix(baseSample.rgb, blinkSample.rgb, clamp(uBlink, 0.0, 1.0));
    col = mix(col, talkSample.rgb, clamp(uMouthOpen, 0.0, 1.0));

    // Studio key-light exposure & soft-knee shadow lift so 真人雪儿 & Q版雪儿 look bright, radiant & never murky
    col = mix(col, pow(max(col, vec3(0.0)), vec3(0.82)), uShadowLift);
    col *= uExposure;

    // Gentle luminous silhouette rim accent when speaking or working
    float edgeSoftness = smoothstep(0.95, 0.18, baseSample.a);
    float activityGlow = (0.14 + uAudioRms * 0.45 + uWorkEnergy * 0.3);
    col += mix(uRimColor, uAccentColor, 0.4) * edgeSoftness * activityGlow * 0.35;

    // Smooth silky energy-sweep transition between Entity <-> Particle Mode (zero blocky mosaic)
    float sweep = smoothstep(uDissolve * 1.25 - 0.25, uDissolve * 1.25 + 0.08, vUv.y);
    float entityAlpha = mix(1.0, sweep, smoothstep(0.0, 0.12, uDissolve)) * (1.0 - smoothstep(0.88, 1.0, uDissolve));
    float sweepLine = exp(-pow((vUv.y - uDissolve) * 14.0, 2.0)) * sin(clamp(uDissolve, 0.0, 1.0) * 3.14159265);
    col = mix(col, mix(uRimColor, vec3(1.0), 0.5), sweepLine * 0.65);

    // Razor-sharp holographic projection core behind the 42k lattice particles in Particle Mode:
    // Fine sci-fi scan-beam + crisp micro-dot holographic energy matrix so facial features stay 100% crisp!
    float holoScan = 0.84 + 0.16 * sin(vUv.y * 320.0 - uTime * 3.8);
    float holoWave = 0.92 + 0.08 * sin(vUv.y * 28.0 - uTime * (2.6 + uWorkEnergy * 3.5 + uAudioRms * 5.0));
    float ghostAlpha = uGhostVeil * holoScan * holoWave;
    vec3 ghostCol = col * (1.08 + uAudioRms * 0.16) + uRimColor * (edgeSoftness * 0.22 + 0.03);

    float combinedAlpha = max(entityAlpha, ghostAlpha);
    if (combinedAlpha < 0.005) discard;

    vec3 outCol = mix(ghostCol, col, clamp(entityAlpha / max(0.001, combinedAlpha), 0.0, 1.0));
    gl_FragColor = vec4(clamp(outCol, 0.0, 1.5), baseSample.a * combinedAlpha * uOpacity);

    // Essential linear -> sRGB output encoding so SRGB textures render at true bright photographic luminosity!
    #include <colorspace_fragment>
  }
`;

function loadRgbaImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load avatar image: ${url}`));
    img.src = url;
  });
}

function createCrispTexture(img: HTMLImageElement): THREE.Texture {
  const tex = new THREE.Texture(img);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Samples `count` (42,000) razor-sharp hexagonal-lattice holographic particles directly from a transparent portrait PNG:
 * - Structured regular hexagonal micro-grid across the full body (eliminates noisy gray salt-and-pepper static!)
 * - 2x denser zero-jitter lattice specifically on the facial box (eyes, lashes, smile, bangs stay crystal sharp!)
 * - Luminous silhouette & Sobel contour sparkle pass
 * - Only 2.5% delicate ambient stardust embers drifting cleanly off the edges
 */
export function samplePortraitParticlesFromImage(
  img: HTMLImageElement,
  variant: LivingAvatarVariant,
  count = UNIFIED_PARTICLE_COUNT,
): ParticleCloudData {
  const spec = AVATAR_SPECS[variant];
  const maxDim = 540;
  const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
  const w = Math.max(16, Math.round(img.width * scale));
  const h = Math.max(16, Math.round(img.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    throw new Error('2D canvas unavailable for portrait particle sampling');
  }
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  const rgba = ctx.getImageData(0, 0, w, h).data;

  const [faceU1, faceU2, faceV1, faceV2] = spec.faceBox;
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const regions = new Float32Array(count);
  const randoms = new Float32Array(count * 3);

  interface SamplePixel {
    u: number;
    vTop: number;
    r: number;
    g: number;
    b: number;
    reg: number;
  }

  // Count opaque area first so we pick exact crisp hexagonal grid spacing
  let opaqueCount = 0;
  let faceOpaqueCount = 0;
  for (let py = 0; py < h; py += 1) {
    const vTop = py / h;
    for (let px = 0; px < w; px += 1) {
      const a = rgba[(py * w + px) * 4 + 3] ?? 0;
      if (a < 80) continue;
      opaqueCount += 1;
      const u = px / w;
      if (u >= faceU1 && u <= faceU2 && vTop >= faceV1 && vTop <= faceV2) {
        faceOpaqueCount += 1;
      }
    }
  }

  if (opaqueCount === 0) {
    return { count, positions, colors, sizes, regions, randoms };
  }

  const lumAt = (px: number, py: number): number => {
    const idx = (py * w + px) * 4;
    return ((rgba[idx] ?? 0) * 0.299 + (rgba[idx + 1] ?? 0) * 0.587 + (rgba[idx + 2] ?? 0) * 0.114) / 255;
  };

  const makePixel = (px: number, py: number, forceReg?: number): SamplePixel | null => {
    const x = Math.max(0, Math.min(w - 1, Math.round(px)));
    const y = Math.max(0, Math.min(h - 1, Math.round(py)));
    const idx = (y * w + x) * 4;
    if ((rgba[idx + 3] ?? 0) < 80) return null;
    const u = x / w;
    const vTop = y / h;
    const r = (rgba[idx] ?? 0) / 255;
    const g = (rgba[idx + 1] ?? 0) / 255;
    const b = (rgba[idx + 2] ?? 0) / 255;

    let reg = forceReg ?? 0;
    if (forceReg === undefined) {
      const inFace = u >= faceU1 && u <= faceU2 && vTop >= faceV1 && vTop <= faceV2;
      const inTail = u >= spec.tail[0] && u <= spec.tail[1] && vTop >= spec.tail[2] && vTop <= spec.tail[3];
      const inEar =
        (u >= spec.leftEar[0] && u <= spec.leftEar[1] && vTop >= spec.leftEar[2] && vTop <= spec.leftEar[3]) ||
        (u >= spec.rightEar[0] && u <= spec.rightEar[1] && vTop >= spec.rightEar[2] && vTop <= spec.rightEar[3]);
      reg = inFace ? 1 : inEar || inTail ? 2 : 0;
    }
    return { u, vTop, r, g, b, reg };
  };

  // Budget allocation (out of 42,000):
  // - 74% crisp structured hexagonal body lattice
  // - 15% ultra-dense zero-jitter facial micro-lattice (makes eyes, lashes, nose & smile razor clear!)
  // -  8.5% crisp silhouette & Sobel contrast contour highlights
  // -  2.5% delicate floating stardust embers around the silhouette
  const bodyBudget = Math.floor(count * 0.74);
  const faceBudget = Math.floor(count * 0.15);
  const contourBudget = Math.floor(count * 0.085);

  const bodyStep = Math.max(1, Math.sqrt(opaqueCount / Math.max(1, bodyBudget)));
  const bodySamples: SamplePixel[] = [];
  for (let row = 0; row * bodyStep < h; row += 1) {
    const py = row * bodyStep;
    const xOff = (row % 2) * (bodyStep * 0.5);
    for (let px = xOff; px < w; px += bodyStep) {
      const sp = makePixel(px, py);
      if (sp) bodySamples.push(sp);
    }
  }

  // Ultra-fine face lattice (zero random speckle jitter!)
  const faceStep = Math.max(1, Math.sqrt(Math.max(1, faceOpaqueCount) / Math.max(1, faceBudget)));
  const faceSamples: SamplePixel[] = [];
  const fMinY = Math.floor(faceV1 * h);
  const fMaxY = Math.ceil(faceV2 * h);
  const fMinX = Math.floor(faceU1 * w);
  const fMaxX = Math.ceil(faceU2 * w);
  for (let row = 0; fMinY + row * faceStep <= fMaxY; row += 1) {
    const py = fMinY + row * faceStep;
    const xOff = (row % 2) * (faceStep * 0.5);
    for (let px = fMinX + xOff; px <= fMaxX; px += faceStep) {
      const sp = makePixel(px, py, 1);
      if (sp) faceSamples.push(sp);
    }
  }

  // Crisp silhouette & high-contrast feature contour pass (eyes, bow, lace, ear outline, hair strands)
  const contourSamples: SamplePixel[] = [];
  for (let py = 1; py < h - 1; py += 1) {
    for (let px = 1; px < w - 1; px += 1) {
      const idx = (py * w + px) * 4;
      if ((rgba[idx + 3] ?? 0) < 80) continue;
      const aL = rgba[(py * w + (px - 1)) * 4 + 3] ?? 0;
      const aR = rgba[(py * w + (px + 1)) * 4 + 3] ?? 0;
      const aU = rgba[((py - 1) * w + px) * 4 + 3] ?? 0;
      const aD = rgba[((py + 1) * w + px) * 4 + 3] ?? 0;
      const isSilhouette = aL < 80 || aR < 80 || aU < 80 || aD < 80;
      const grad = Math.abs(lumAt(px + 1, py) - lumAt(px - 1, py)) + Math.abs(lumAt(px, py + 1) - lumAt(px, py - 1));
      if (isSilhouette || grad > 0.16) {
        const sp = makePixel(px, py, isSilhouette ? 3 : undefined);
        if (sp) contourSamples.push(sp);
      }
    }
  }

  const planeH = spec.planeHeight;
  const planeW = planeH * spec.aspect;
  let seed = variant === 'chibi' ? 7712345 : 8823456;
  const rand = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const colorLift = variant === 'realistic' ? 1.18 : 1.09;
  const writePixelParticle = (i: number, px: SamplePixel, mode: 'body' | 'face' | 'contour') => {
    const i3 = i * 3;
    // Zero jitter on face/contour so features stay photographically sharp in particle form!
    const jitter = mode === 'body' ? 0.0012 : 0.0;
    const worldX = (px.u - 0.5) * planeW + (jitter > 0 ? (rand() - 0.5) * jitter : 0);
    const worldY = (0.5 - px.vTop) * planeH + (jitter > 0 ? (rand() - 0.5) * jitter : 0);

    const lum = px.r * 0.299 + px.g * 0.587 + px.b * 0.114;
    const centerCurve = Math.max(0, 1 - Math.abs(px.u - 0.5) * 2.05);
    const worldZ =
      centerCurve * 0.11 + (lum - 0.5) * 0.04 + (px.reg === 1 ? 0.05 : 0) + (mode === 'contour' ? 0.015 : 0);

    positions[i3] = worldX;
    positions[i3 + 1] = worldY;
    positions[i3 + 2] = worldZ;

    // Vivid luminous sRGB color preservation with gentle studio lift (never murky gray!)
    const shadowBoost = variant === 'realistic' && lum < 0.45 ? 1.12 : 1.0;
    const gain = colorLift * shadowBoost;
    colors[i3] = Math.min(1, px.r * gain + (lum > 0.2 ? 0.03 : 0.01));
    colors[i3 + 1] = Math.min(1, px.g * gain + (lum > 0.2 ? 0.03 : 0.01));
    colors[i3 + 2] = Math.min(1, px.b * gain + (lum > 0.2 ? 0.04 : 0.015));

    sizes[i] = mode === 'face' ? 1.85 + rand() * 0.35 : mode === 'contour' ? 2.15 + rand() * 0.55 : 2.25 + rand() * 0.5;
    regions[i] = px.reg;
    randoms[i3] = rand();
    randoms[i3 + 1] = rand();
    randoms[i3 + 2] = rand();
  };

  let cursor = 0;
  const fillFrom = (pool: SamplePixel[], budget: number, mode: 'body' | 'face' | 'contour') => {
    if (pool.length === 0) return;
    const stride = pool.length / Math.max(1, budget);
    for (let k = 0; k < budget && cursor < count; k += 1) {
      const idx = Math.min(pool.length - 1, Math.floor(k * stride));
      const px = pool[idx] ?? pool[0];
      if (px) {
        writePixelParticle(cursor, px, mode);
        cursor += 1;
      }
    }
  };

  fillFrom(bodySamples, bodyBudget, 'body');
  fillFrom(faceSamples.length > 0 ? faceSamples : bodySamples, faceBudget, 'face');
  fillFrom(contourSamples.length > 0 ? contourSamples : bodySamples, contourBudget, 'contour');

  // Remaining ~2.5%: delicate glowing holographic embers orbiting cleanly around the portrait outline
  for (let i = cursor; i < count; i += 1) {
    const i3 = i * 3;
    const ang = rand() * Math.PI * 2;
    const rad = 0.7 + rand() * 0.36;
    positions[i3] = Math.cos(ang) * rad * (planeW * 0.72);
    positions[i3 + 1] = (rand() - 0.5) * planeH * 1.02;
    positions[i3 + 2] = Math.sin(ang) * 0.26 - 0.1;

    colors[i3] = 0.86;
    colors[i3 + 1] = 0.96;
    colors[i3 + 2] = 1.0;

    sizes[i] = 1.35 + rand() * 1.1;
    regions[i] = 4;
    randoms[i3] = rand();
    randoms[i3 + 1] = rand();
    randoms[i3 + 2] = rand();
  }

  return { count, positions, colors, sizes, regions, randoms };
}

/**
 * 2.5D living holographic portrait plane for both Q版雪儿 (`chibi`) and 真人雪儿 (`realistic`).
 * Renders true sRGB studio-lit transparent artwork with zero-jitter blinking, speech lip-sync,
 * breathing, subtle white-ear & snow-tail vertex sway, cursor 2.5D tilt, and holographic projection veil.
 */
export class LivingAvatarPlane {
  readonly root = new THREE.Group();
  readonly variant: LivingAvatarVariant;
  private readonly mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private readonly textures: THREE.Texture[] = [];
  private loaded = false;
  private particleCloud: ParticleCloudData | null = null;
  private onCloudReady?: (cloud: ParticleCloudData) => void;

  constructor(variant: LivingAvatarVariant, onCloudReady?: (cloud: ParticleCloudData) => void) {
    this.variant = variant;
    this.onCloudReady = onCloudReady;
    const spec = AVATAR_SPECS[variant];
    const planeW = spec.planeHeight * spec.aspect;
    const geo = new THREE.PlaneGeometry(planeW, spec.planeHeight, 48, 72);

    const placeholder = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
    placeholder.needsUpdate = true;
    this.textures.push(placeholder);

    const mat = new THREE.ShaderMaterial({
      vertexShader: LIVING_AVATAR_VERTEX_SHADER,
      fragmentShader: LIVING_AVATAR_FRAGMENT_SHADER,
      uniforms: {
        uTexIdle: { value: placeholder },
        uTexBlink: { value: placeholder },
        uTexTalk: { value: placeholder },
        uTime: { value: 0 },
        uBreathe: { value: 1.0 },
        uEarPerk: { value: 0.55 },
        uTailWag: { value: 0.35 },
        uBlink: { value: 0 },
        uMouthOpen: { value: 0 },
        uDissolve: { value: 0 },
        uGhostVeil: { value: 0 },
        uExposure: { value: spec.exposure },
        uShadowLift: { value: spec.shadowLift },
        uOpacity: { value: 1.0 },
        uAudioRms: { value: 0 },
        uWorkEnergy: { value: 0 },
        uRimColor: { value: new THREE.Color('#5ce1ff') },
        uAccentColor: { value: new THREE.Color('#38bdf8') },
        uLeftEarBox: { value: new THREE.Vector4(...spec.leftEar) },
        uLeftEarPivot: { value: new THREE.Vector2(...spec.leftEarPivot) },
        uRightEarBox: { value: new THREE.Vector4(...spec.rightEar) },
        uRightEarPivot: { value: new THREE.Vector2(...spec.rightEarPivot) },
        uTailBox: { value: new THREE.Vector4(...spec.tail) },
        uTailPivot: { value: new THREE.Vector2(...spec.tailPivot) },
      },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.renderOrder = 0;
    this.root.add(this.mesh);
    this.root.visible = false;

    void this.loadAssets();
  }

  get isLoaded(): boolean {
    return this.loaded;
  }

  getParticleCloud(): ParticleCloudData | null {
    return this.particleCloud;
  }

  private async loadAssets(): Promise<void> {
    if (typeof window === 'undefined' || typeof Image === 'undefined') return;
    const prefix = `./avatars/xueer-${this.variant}`;
    try {
      // Stage 1: Load idle portrait first so 雪儿 renders crisply on frame 1 without delay
      const idleImg = await loadRgbaImage(`${prefix}-idle.png`);
      const texIdle = createCrispTexture(idleImg);
      this.textures.push(texIdle);

      const u = this.mesh.material.uniforms;
      (u.uTexIdle as THREE.IUniform<THREE.Texture>).value = texIdle;
      (u.uTexBlink as THREE.IUniform<THREE.Texture>).value = texIdle;
      (u.uTexTalk as THREE.IUniform<THREE.Texture>).value = texIdle;
      this.mesh.material.uniformsNeedUpdate = true;
      this.loaded = true;

      // Stage 2: Load blink & talk micro-expression sheets asynchronously
      const [blinkImg, talkImg] = await Promise.all([
        loadRgbaImage(`${prefix}-blink.png`),
        loadRgbaImage(`${prefix}-talk.png`),
      ]);
      const texBlink = createCrispTexture(blinkImg);
      const texTalk = createCrispTexture(talkImg);
      this.textures.push(texBlink, texTalk);
      (u.uTexBlink as THREE.IUniform<THREE.Texture>).value = texBlink;
      (u.uTexTalk as THREE.IUniform<THREE.Texture>).value = texTalk;
      this.mesh.material.uniformsNeedUpdate = true;

      // Stage 3: Sample 42k structured hexagonal portrait particles off the initial paint tick
      setTimeout(() => {
        try {
          this.particleCloud = samplePortraitParticlesFromImage(idleImg, this.variant, UNIFIED_PARTICLE_COUNT);
          this.onCloudReady?.(this.particleCloud);
        } catch {
          // Graceful fallback if disposed before sampling
        }
      }, 30);
    } catch {
      // Keep unloaded gracefully in non-browser/test environments
    }
  }

  updateColors(rim: THREE.Color, accent: THREE.Color): void {
    const u = this.mesh.material.uniforms;
    (u.uRimColor as THREE.IUniform<THREE.Color>).value.copy(rim);
    (u.uAccentColor as THREE.IUniform<THREE.Color>).value.copy(accent);
  }

  update(params: {
    elapsed: number;
    visibility: number;
    dissolve: number;
    ghostVeil: number;
    blink: number;
    mouthOpen: number;
    earPerk: number;
    tailWag: number;
    audioRms: number;
    workEnergy: number;
    gazeX: number;
    gazeY: number;
    quietFactor: number;
  }): void {
    const vis = Math.max(0, Math.min(1, params.visibility));
    const showAny = this.loaded && vis > 0.01 && (params.dissolve < 0.99 || params.ghostVeil > 0.01);
    this.root.visible = showAny;
    if (!this.root.visible) return;

    const u = this.mesh.material.uniforms;
    (u.uTime as THREE.IUniform<number>).value = params.elapsed;
    (u.uBlink as THREE.IUniform<number>).value = params.blink;
    (u.uMouthOpen as THREE.IUniform<number>).value = params.mouthOpen;
    (u.uEarPerk as THREE.IUniform<number>).value = params.earPerk;
    (u.uTailWag as THREE.IUniform<number>).value = params.tailWag;
    (u.uDissolve as THREE.IUniform<number>).value = params.dissolve;
    (u.uGhostVeil as THREE.IUniform<number>).value = params.ghostVeil;
    (u.uOpacity as THREE.IUniform<number>).value = vis;
    (u.uAudioRms as THREE.IUniform<number>).value = params.audioRms;
    (u.uWorkEnergy as THREE.IUniform<number>).value = params.workEnergy;

    // Gentle 2.5D head/body parallax following user cursor + quiet-mode scale-down
    this.root.rotation.y = params.gazeX * 0.13 + Math.sin(params.elapsed * 0.65) * 0.022;
    this.root.rotation.x = -params.gazeY * 0.055;
    this.root.position.y = Math.sin(params.elapsed * 1.4) * 0.016;
    this.root.scale.setScalar(1.0 - params.quietFactor * 0.14);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    for (const tex of this.textures) tex.dispose();
  }
}
