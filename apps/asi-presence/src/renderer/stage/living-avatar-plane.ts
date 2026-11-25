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
  faceBandV: [number, number];
  planeHeight: number;
  aspect: number;
}

/**
 * Exact QA-verified landmark boxes on our padded transparent RGBA PNGs:
 * - chibi:     768 x 1120 (aspect 0.6857)
 * - realistic: 640 x 1200 (aspect 0.5333)
 * Heights sized so head-to-shoes remain cleanly framed above bottom HUD decks in both Stage & Floating windows.
 */
const AVATAR_SPECS: Record<LivingAvatarVariant, LandmarkRegions> = {
  chibi: {
    leftEar: [0.25, 0.43, 0.04, 0.21],
    leftEarPivot: [0.39, 0.195],
    rightEar: [0.63, 0.87, 0.04, 0.21],
    rightEarPivot: [0.66, 0.195],
    tail: [0.06, 0.26, 0.45, 0.7],
    tailPivot: [0.24, 0.62],
    faceBandV: [0.22, 0.46],
    planeHeight: 1.88,
    aspect: 768 / 1120,
  },
  realistic: {
    leftEar: [0.4, 0.495, 0.03, 0.115],
    leftEarPivot: [0.47, 0.105],
    rightEar: [0.565, 0.66, 0.03, 0.115],
    rightEarPivot: [0.585, 0.105],
    tail: [0.17, 0.355, 0.36, 0.52],
    tailPivot: [0.34, 0.47],
    faceBandV: [0.08, 0.22],
    planeHeight: 1.92,
    aspect: 640 / 1200,
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
    // Convert Three.js bottom-origin UV to top-origin (u, vTop) to match landmark coordinates
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

    // Zero-jitter smooth micro-expression blending (base pixels outside eyes/mouth are bit-identical)
    vec3 col = mix(baseSample.rgb, blinkSample.rgb, clamp(uBlink, 0.0, 1.0));
    col = mix(col, talkSample.rgb, clamp(uMouthOpen, 0.0, 1.0));

    // Soft futuristic luminous rim along silhouette edge when speaking or working
    float edgeSoftness = smoothstep(0.95, 0.18, baseSample.a);
    float activityGlow = (0.1 + uAudioRms * 0.45 + uWorkEnergy * 0.3);
    col += mix(uRimColor, uAccentColor, 0.4) * edgeSoftness * activityGlow * 0.42;

    // Smooth silky energy-sweep fade between Entity <-> Particle Mode (ZERO blocky pixel mosaic!)
    float sweep = smoothstep(uDissolve * 1.25 - 0.25, uDissolve * 1.25 + 0.08, vUv.y);
    float entityAlpha = mix(1.0, sweep, smoothstep(0.0, 0.12, uDissolve)) * (1.0 - smoothstep(0.88, 1.0, uDissolve));
    float sweepLine = exp(-pow((vUv.y - uDissolve) * 14.0, 2.0)) * sin(clamp(uDissolve, 0.0, 1.0) * 3.14159265);
    col = mix(col, mix(uRimColor, vec3(1.0), 0.5), sweepLine * 0.72);

    // Optional delicate holographic scanline veil behind the 26k particles in Particle Mode for sharp facial depth
    float scanline = 0.78 + 0.22 * sin(vUv.y * 260.0 - uTime * 3.5);
    float ghostAlpha = uGhostVeil * scanline;
    vec3 ghostTint = mix(col, mix(col, uRimColor, 0.24), clamp(uGhostVeil * 3.5, 0.0, 0.35));

    float combinedAlpha = max(entityAlpha, ghostAlpha);
    if (combinedAlpha < 0.005) discard;

    vec3 outCol = mix(ghostTint, col, clamp(entityAlpha / max(0.001, combinedAlpha), 0.0, 1.0));
    gl_FragColor = vec4(outCol, baseSample.a * combinedAlpha * uOpacity);
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
 * Samples `count` crisp, evenly-stratified RGB+3D particles directly from a transparent portrait PNG:
 * - ~86% stratified fine lattice across opaque pixels (eliminates Poisson clumps & noise holes!)
 * - ~11% high-contrast feature & edge emphasis (eyes, lashes, smile, blue bow, lace, ear outlines)
 * - ~3% delicate ambient stardust framing the silhouette
 */
export function samplePortraitParticlesFromImage(
  img: HTMLImageElement,
  variant: LivingAvatarVariant,
  count = UNIFIED_PARTICLE_COUNT,
): ParticleCloudData {
  const spec = AVATAR_SPECS[variant];
  const maxDim = 480;
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

  const [faceV1, faceV2] = spec.faceBandV;
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const regions = new Float32Array(count);
  const randoms = new Float32Array(count * 3);

  const lumAt = (px: number, py: number): number => {
    const idx = (py * w + px) * 4;
    return ((rgba[idx] ?? 0) * 0.299 + (rgba[idx + 1] ?? 0) * 0.587 + (rgba[idx + 2] ?? 0) * 0.114) / 255;
  };

  interface SamplePixel {
    u: number;
    vTop: number;
    r: number;
    g: number;
    b: number;
    reg: number;
    contrast: number;
  }

  const allPixels: SamplePixel[] = [];
  const featurePixels: SamplePixel[] = [];

  for (let py = 0; py < h; py += 1) {
    const vTop = py / h;
    for (let px = 0; px < w; px += 1) {
      const idx = (py * w + px) * 4;
      const a = rgba[idx + 3] ?? 0;
      if (a < 64) continue;

      const u = px / w;
      const r = (rgba[idx] ?? 0) / 255;
      const g = (rgba[idx + 1] ?? 0) / 255;
      const b = (rgba[idx + 2] ?? 0) / 255;

      let isEdge = false;
      let contrast = 0;
      if (px > 0 && px < w - 1 && py > 0 && py < h - 1) {
        const aL = rgba[(py * w + (px - 1)) * 4 + 3] ?? 0;
        const aR = rgba[(py * w + (px + 1)) * 4 + 3] ?? 0;
        const aU = rgba[((py - 1) * w + px) * 4 + 3] ?? 0;
        const aD = rgba[((py + 1) * w + px) * 4 + 3] ?? 0;
        if (aL < 64 || aR < 64 || aU < 64 || aD < 64) {
          isEdge = true;
        }
        const gx = Math.abs(lumAt(px + 1, py) - lumAt(px - 1, py));
        const gy = Math.abs(lumAt(px, py + 1) - lumAt(px, py - 1));
        contrast = gx + gy;
      }

      const inFace = vTop >= faceV1 && vTop <= faceV2 && u >= 0.28 && u <= 0.76;
      const inTail = u >= spec.tail[0] && u <= spec.tail[1] && vTop >= spec.tail[2] && vTop <= spec.tail[3];
      const inEar =
        (u >= spec.leftEar[0] && u <= spec.leftEar[1] && vTop >= spec.leftEar[2] && vTop <= spec.leftEar[3]) ||
        (u >= spec.rightEar[0] && u <= spec.rightEar[1] && vTop >= spec.rightEar[2] && vTop <= spec.rightEar[3]);

      const reg = inFace ? 1 : inEar || inTail ? 2 : isEdge ? 3 : 0;
      const item: SamplePixel = { u, vTop, r, g, b, reg, contrast };
      allPixels.push(item);

      // Eyes, eyebrows, mouth, blue bow, hair lines, and silhouette edges get extra crisp detail particles
      if (inFace || isEdge || contrast > 0.14) {
        featurePixels.push(item);
      }
    }
  }

  if (allPixels.length === 0) {
    return { count, positions, colors, sizes, regions, randoms };
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

  const latticeBudget = Math.floor(count * 0.85);
  const featureBudget = Math.floor(count * 0.12);
  const bodyEnd = latticeBudget + featureBudget;

  const writePixelParticle = (i: number, px: SamplePixel, isDetailPass: boolean) => {
    const i3 = i * 3;
    const jitter = isDetailPass ? 0.0016 : 0.0032;
    const worldX = (px.u - 0.5) * planeW + (rand() - 0.5) * jitter;
    const worldY = (0.5 - px.vTop) * planeH + (rand() - 0.5) * jitter;

    const lum = px.r * 0.299 + px.g * 0.587 + px.b * 0.114;
    const centerCurve = Math.max(0, 1 - Math.abs(px.u - 0.5) * 2.1);
    const worldZ = centerCurve * 0.11 + (lum - 0.5) * 0.045 + (px.reg === 1 ? 0.045 : 0) + (rand() - 0.5) * 0.008;

    positions[i3] = worldX;
    positions[i3 + 1] = worldY;
    positions[i3 + 2] = worldZ;

    // Preserve authentic artwork colors (slight vibrancy lift without washing out dark eyes/blue ribbon)
    const boost = lum < 0.32 ? 1.0 : 1.06;
    colors[i3] = Math.min(1, px.r * boost + (lum > 0.35 ? 0.02 : 0));
    colors[i3 + 1] = Math.min(1, px.g * boost + (lum > 0.35 ? 0.02 : 0));
    colors[i3 + 2] = Math.min(1, px.b * boost + (lum > 0.35 ? 0.03 : 0));

    // Fine delicate micro-particles (never chunky mosaic blobs!)
    sizes[i] = isDetailPass
      ? 1.55 + rand() * 0.55
      : px.reg === 1
        ? 1.65 + rand() * 0.55
        : px.reg === 3
          ? 2.05 + rand() * 0.65
          : 1.95 + rand() * 0.7;
    regions[i] = px.reg;
    randoms[i3] = rand();
    randoms[i3 + 1] = rand();
    randoms[i3 + 2] = rand();
  };

  // Pass 1: Evenly stratified sweep across all foreground pixels (eliminates gaps & clumpy noise)
  const stride = allPixels.length / Math.max(1, latticeBudget);
  for (let i = 0; i < latticeBudget; i += 1) {
    const idx = Math.min(allPixels.length - 1, Math.floor((i + rand() * 0.85) * stride));
    const px = allPixels[idx] ?? allPixels[0];
    if (px) writePixelParticle(i, px, false);
  }

  // Pass 2: High-resolution detail pass for eyes, smile, lace, ribbon & edges
  const featSource = featurePixels.length > 0 ? featurePixels : allPixels;
  const featStride = featSource.length / Math.max(1, featureBudget);
  for (let j = 0; j < featureBudget; j += 1) {
    const idx = Math.min(featSource.length - 1, Math.floor((j + rand() * 0.85) * featStride));
    const px = featSource[idx] ?? featSource[0];
    if (px) writePixelParticle(latticeBudget + j, px, true);
  }

  // Pass 3: Sparse delicate holographic stardust halo around the portrait (3% only, never clutters!)
  for (let i = bodyEnd; i < count; i += 1) {
    const i3 = i * 3;
    const ang = rand() * Math.PI * 2;
    const rad = 0.68 + rand() * 0.38;
    positions[i3] = Math.cos(ang) * rad * (planeW * 0.68);
    positions[i3 + 1] = (rand() - 0.5) * planeH * 1.02;
    positions[i3 + 2] = Math.sin(ang) * 0.28 - 0.12;

    colors[i3] = 0.84;
    colors[i3 + 1] = 0.95;
    colors[i3 + 2] = 1.0;

    sizes[i] = 1.25 + rand() * 1.1;
    regions[i] = 4;
    randoms[i3] = rand();
    randoms[i3 + 1] = rand();
    randoms[i3 + 2] = rand();
  }

  return { count, positions, colors, sizes, regions, randoms };
}

/**
 * 2.5D living holographic portrait plane for both Q版雪儿 (`chibi`) and 真人雪儿 (`realistic`).
 * Renders the exact high-res transparent artwork with zero-jitter blinking, speech lip-sync,
 * breathing, subtle white-ear & snow-tail vertex sway, cursor 2.5D tilt, and silky transition.
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
      // Stage 1: Load idle portrait first so 雪儿 renders crisply on the very first frame without delay!
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

      // Stage 3: Sample 26k stratified portrait particles off the initial paint tick
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
