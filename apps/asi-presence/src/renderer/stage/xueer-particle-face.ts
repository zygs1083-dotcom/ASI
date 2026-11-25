import * as THREE from 'three';
import { PARTICLE_FRAGMENT_SHADER, PARTICLE_VERTEX_SHADER } from './particles.glsl.ts';

export const XUEER_PARTICLE_COUNT = 12_000;

export interface ParticleFaceDataset {
  count: number;
  positions: Float32Array;
  targets: Float32Array;
  randoms: Float32Array;
  regions: Float32Array;
  sizes: Float32Array;
}

/** Deterministic PRNG (Mulberry32) for clean, reproducible particle sculpting and unit tests. */
function createSeededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Generates the sculptural 12,000-particle dataset for 雪儿's J.A.R.V.I.S. Holographic
 * Virtual Face + Snowy Canine Acoustic Ear Crests + Orbital Telemetry Rings + Snowlight Stardust.
 */
export function generateXueerParticleFaceData(count = XUEER_PARTICLE_COUNT): ParticleFaceDataset {
  const rand = createSeededRandom(20261125);
  const positions = new Float32Array(count * 3);
  const targets = new Float32Array(count * 3);
  const randoms = new Float32Array(count * 3);
  const regions = new Float32Array(count);
  const sizes = new Float32Array(count);

  const faceQuota = Math.floor(count * 0.42);
  const eyeQuota = Math.floor(count * 0.11);
  const mouthQuota = Math.floor(count * 0.08);
  const earQuota = Math.floor(count * 0.14);
  const ringQuota = Math.floor(count * 0.17);

  for (let i = 0; i < count; i += 1) {
    const i3 = i * 3;
    let x = 0;
    let y = 0;
    let z = 0;
    let region = 5;
    let size = 3.2;

    if (i < faceQuota) {
      // Region 0: Sculpted futuristic ethereal virtual face topography
      region = 0;
      const u = (rand() - 0.5) * Math.PI * 1.18; // azimuth across front face
      const v = (rand() - 0.5) * Math.PI * 0.88; // elevation from chin to crown
      const rx = 0.52 * (1.0 - Math.max(0, -v) * 0.24); // gentle tapered chin
      const ry = 0.66;
      const rz = 0.42;

      x = Math.sin(u) * Math.cos(v) * rx;
      y = Math.sin(v) * ry;
      z = Math.cos(u) * Math.cos(v) * rz;

      // Subtle cheekbones & nose bridge sculpting
      const noseFactor = Math.exp(-((x * x) / 0.008) - ((y - 0.02) * (y - 0.02)) / 0.045);
      const browRidge = Math.exp(-((y - 0.27) * (y - 0.27)) / 0.006) * Math.exp(-(x * x) / 0.16);
      z += noseFactor * 0.085 + browRidge * 0.032;

      // Subtle wireframe meridian preference for J.A.R.V.I.S. holographic clarity
      if (rand() < 0.28) {
        const snapY = Math.round(y * 14) / 14;
        y = y * 0.35 + snapY * 0.65;
      }
      size = 2.4 + rand() * 1.8;
    } else if (i < faceQuota + eyeQuota) {
      // Region 1: Twin expressive holographic iris/eye rings
      region = 1;
      const idx = i - faceQuota;
      const side = idx % 2 === 0 ? -1 : 1;
      const angle = rand() * Math.PI * 2;
      const isCore = rand() < 0.32;
      const radX = isCore ? rand() * 0.042 : 0.055 + rand() * 0.045;
      const radY = isCore ? rand() * 0.048 : 0.042 + rand() * 0.032;
      x = side * 0.21 + Math.cos(angle) * radX;
      y = 0.14 + Math.sin(angle) * radY;
      z = 0.39 + (1.0 - radX * 4.0) * 0.04;
      size = isCore ? 4.0 + rand() * 1.6 : 2.8 + rand() * 1.4;
    } else if (i < faceQuota + eyeQuota + mouthQuota) {
      // Region 2: Acoustic holographic lip/mouth wave arc
      region = 2;
      const t = (rand() - 0.5) * 2.0; // -1..1 across mouth width
      const strand = (rand() - 0.5) * 2.0;
      const width = 0.175;
      x = t * width;
      const lipEnvelope = Math.max(0.0, 1.0 - t * t);
      y = -0.22 + strand * 0.022 * lipEnvelope + Math.cos(t * Math.PI) * 0.012;
      z = 0.39 + lipEnvelope * 0.04;
      size = 3.1 + rand() * 1.5;
    } else if (i < faceQuota + eyeQuota + mouthQuota + earQuota) {
      // Region 3: Snow-white holographic puppy-ear acoustic crests (graceful sci-fi canine ear silhouette)
      region = 3;
      const idx = i - (faceQuota + eyeQuota + mouthQuota);
      const side = idx % 2 === 0 ? -1 : 1;
      // Parametric curved leaf/ear triangle crowning temples
      const h = rand() ** 0.78; // 0 = base, 1 = tip
      const u = (rand() - 0.5) * 2.0; // width across ear
      const isEdge = rand() < 0.42;
      const edgeU = isEdge ? (u < 0 ? -1 : 1) * (0.85 + rand() * 0.15) : u;
      const widthAtH = (1.0 - h) * 0.19 * Math.sin(Math.min(1, h * 1.15 + 0.15) * Math.PI * 0.75);
      const curveOut = h * h * 0.13;
      const earLen = 0.46;

      x = side * (0.31 + curveOut) + edgeU * widthAtH;
      y = 0.49 + h * earLen;
      z = 0.05 - h * 0.08 + (1.0 - Math.abs(edgeU)) * 0.05;
      size = isEdge ? 3.5 + rand() * 1.5 : 2.2 + rand() * 1.3;
    } else if (i < faceQuota + eyeQuota + mouthQuota + earQuota + ringQuota) {
      // Region 4: Three J.A.R.V.I.S. orbital telemetry gyroscope rings
      region = 4;
      const ringIdx = i % 3;
      const angle = rand() * Math.PI * 2;
      const radius = ringIdx === 0 ? 0.96 : ringIdx === 1 ? 1.14 : 1.32;
      const jitter = (rand() - 0.5) * 0.032;
      const rx = (radius + jitter) * Math.cos(angle);
      const ry = (radius + jitter) * Math.sin(angle);
      const rz = (rand() - 0.5) * 0.04;

      if (ringIdx === 0) {
        x = rx;
        y = ry * 0.85;
        z = rz - 0.15;
      } else if (ringIdx === 1) {
        x = rx * 0.88;
        y = rz + ry * 0.42;
        z = ry * 0.78 - 0.1;
      } else {
        x = rx * 0.76 - ry * 0.35;
        y = ry * 0.65;
        z = rx * 0.55 + rz - 0.18;
      }
      size = 2.0 + rand() * 1.6;
    } else {
      // Region 5: Drifting ambient snowlight stardust
      region = 5;
      const theta = rand() * Math.PI * 2;
      const r = 0.95 + rand() * 0.95;
      x = Math.cos(theta) * r;
      y = (rand() - 0.5) * 2.6;
      z = Math.sin(theta) * r - 0.25;
      size = 1.8 + rand() * 2.2;
    }

    positions[i3] = x;
    positions[i3 + 1] = y;
    positions[i3 + 2] = z;

    // Initial morph target defaults to a graceful standing humanoid column until bound to rig/VRM
    targets[i3] = x * 0.85;
    targets[i3 + 1] = y * 0.85;
    targets[i3 + 2] = z * 0.85;

    randoms[i3] = rand();
    randoms[i3 + 1] = rand();
    randoms[i3 + 2] = rand();
    regions[i] = region;
    sizes[i] = size;
  }

  return { count, positions, targets, randoms, regions, sizes };
}

export class XueerParticleFace {
  readonly points: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
  readonly count: number;
  readonly uniforms: {
    uTime: { value: number };
    uMorph: { value: number };
    uAudioRms: { value: number };
    uLowBand: { value: number };
    uMidBand: { value: number };
    uHighBand: { value: number };
    uMouthOpen: { value: number };
    uMouthWide: { value: number };
    uBlink: { value: number };
    uSmile: { value: number };
    uEarPerk: { value: number };
    uGaze: { value: THREE.Vector2 };
    uQuietFactor: { value: number };
    uPixelRatio: { value: number };
    uParticleGlow: { value: number };
    uPrimaryColor: { value: THREE.Color };
    uSecondaryColor: { value: THREE.Color };
    uAccentColor: { value: THREE.Color };
    uOpacity: { value: number };
    uScanlineDensity: { value: number };
  };
  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.ShaderMaterial;

  constructor(count = XUEER_PARTICLE_COUNT) {
    this.count = count;
    const data = generateXueerParticleFaceData(count);

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
    this.geometry.setAttribute('aTarget', new THREE.BufferAttribute(data.targets, 3));
    this.geometry.setAttribute('aRandom', new THREE.BufferAttribute(data.randoms, 3));
    this.geometry.setAttribute('aRegion', new THREE.BufferAttribute(data.regions, 1));
    this.geometry.setAttribute('aSize', new THREE.BufferAttribute(data.sizes, 1));

    this.uniforms = {
      uTime: { value: 0 },
      uMorph: { value: 0 },
      uAudioRms: { value: 0 },
      uLowBand: { value: 0 },
      uMidBand: { value: 0 },
      uHighBand: { value: 0 },
      uMouthOpen: { value: 0 },
      uMouthWide: { value: 0.4 },
      uBlink: { value: 0 },
      uSmile: { value: 0.3 },
      uEarPerk: { value: 0.6 },
      uGaze: { value: new THREE.Vector2(0, 0) },
      uQuietFactor: { value: 0 },
      uPixelRatio: { value: typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, 2) : 1 },
      uParticleGlow: { value: 1.0 },
      uPrimaryColor: { value: new THREE.Color('#f4fbff') },
      uSecondaryColor: { value: new THREE.Color('#5ce1ff') },
      uAccentColor: { value: new THREE.Color('#38bdf8') },
      uOpacity: { value: 0.96 },
      uScanlineDensity: { value: 0.48 },
    };

    this.material = new THREE.ShaderMaterial({
      vertexShader: PARTICLE_VERTEX_SHADER,
      fragmentShader: PARTICLE_FRAGMENT_SHADER,
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
  }

  setMorphTargets(targetPositions: Float32Array): void {
    const attr = this.geometry.getAttribute('aTarget') as THREE.BufferAttribute;
    const dst = attr.array as Float32Array;
    const len = Math.min(dst.length, targetPositions.length);
    for (let i = 0; i < len; i += 1) {
      dst[i] = targetPositions[i] ?? 0;
    }
    attr.needsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
