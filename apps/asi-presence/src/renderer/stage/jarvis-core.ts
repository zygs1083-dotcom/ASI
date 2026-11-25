import * as THREE from 'three';

export const UNIFIED_PARTICLE_COUNT = 26_000;

export interface ParticleCloudData {
  count: number;
  positions: Float32Array;
  colors: Float32Array;
  sizes: Float32Array;
  regions: Float32Array;
  randoms: Float32Array;
}

/** Deterministic Mulberry32 PRNG for reproducible particle clouds & unit tests. */
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
 * Generates an Avengers J.A.R.V.I.S.-inspired pure particle neural sphere cloud:
 * Compact, sharply bounded spherical composition (radius <= 0.96) so the complete orb
 * floats cleanly inside both Stage and Floating windows without colliding with HUD decks:
 * - Region 0: Dense incandescent central energy core (r <= 0.26)
 * - Region 1: 28 intersecting 3D orbital neural trajectories across 3 concentric shells (r = 0.36..0.82)
 * - Region 2: 14 crisp synapse flare clusters on shell intersections (r = 0.32..0.76)
 * - Region 3: Volumetric inner neural plasma dust shell (r = 0.24..0.74)
 * - Region 4: Fine drifting outer orbital sparks (r = 0.80..0.96)
 */
export function generateJarvisCoreCloud(
  count = UNIFIED_PARTICLE_COUNT,
  palette?: { primary: THREE.Color; secondary: THREE.Color; accent: THREE.Color },
): ParticleCloudData {
  const rand = createSeededRandom(20261125);
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const regions = new Float32Array(count);
  const randoms = new Float32Array(count * 3);

  const primary = palette?.primary ?? new THREE.Color('#fff9ec');
  const secondary = palette?.secondary ?? new THREE.Color('#ffad2e');
  const accent = palette?.accent ?? new THREE.Color('#ea580c');
  const tmpColor = new THREE.Color();

  // Precompute 32 tilted orbital planes for woven Avengers J.A.R.V.I.S. neural arcs
  const orbitCount = 32;
  const orbits: { radius: number; basisU: THREE.Vector3; basisV: THREE.Vector3 }[] = [];
  for (let o = 0; o < orbitCount; o += 1) {
    const theta = rand() * Math.PI * 2;
    const phi = Math.acos(2 * rand() - 1);
    const normal = new THREE.Vector3(
      Math.sin(phi) * Math.cos(theta),
      Math.cos(phi),
      Math.sin(phi) * Math.sin(theta),
    ).normalize();
    const ref = Math.abs(normal.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    const basisU = new THREE.Vector3().crossVectors(normal, ref).normalize();
    const basisV = new THREE.Vector3().crossVectors(normal, basisU).normalize();
    const shell = o % 3;
    const radius = shell === 0 ? 0.34 + rand() * 0.13 : shell === 1 ? 0.52 + rand() * 0.14 : 0.71 + rand() * 0.13;
    orbits.push({ radius, basisU, basisV });
  }

  // Precompute 14 soft luminous synapse nodes on orbital shell intersections (bounded spread, zero overexposed blobs)
  const clusterCount = 14;
  const clusters: { center: THREE.Vector3; spread: number }[] = [];
  for (let c = 0; c < clusterCount; c += 1) {
    const theta = (c / clusterCount) * Math.PI * 2 + (rand() - 0.5) * 0.45;
    const phi = Math.acos(2 * ((c + 0.5) / clusterCount) - 1);
    const r = 0.35 + (c % 3) * 0.18 + rand() * 0.05;
    clusters.push({
      center: new THREE.Vector3(
        r * Math.sin(phi) * Math.cos(theta),
        r * Math.cos(phi),
        r * Math.sin(phi) * Math.sin(theta),
      ),
      spread: 0.055 + rand() * 0.04,
    });
  }

  const coreEnd = Math.floor(count * 0.1);
  const arcEnd = Math.floor(count * 0.68);
  const clusterEnd = Math.floor(count * 0.76);
  const shellEnd = Math.floor(count * 0.93);

  for (let i = 0; i < count; i += 1) {
    const i3 = i * 3;
    let x = 0;
    let y = 0;
    let z = 0;
    let region = 4;
    let size = 1.6;

    if (i < coreEnd) {
      // Region 0: Compact golden-white central energy heart (restrained density prevents white blowout)
      region = 0;
      const theta = rand() * Math.PI * 2;
      const phi = Math.acos(2 * rand() - 1);
      const r = rand() ** 1.9 * 0.25;
      x = r * Math.sin(phi) * Math.cos(theta);
      y = r * Math.cos(phi);
      z = r * Math.sin(phi) * Math.sin(theta);
      size = 1.3 + (1 - r / 0.25) * 1.4 + rand() * 0.6;
      tmpColor.copy(secondary).lerp(primary, 0.22 + (1 - r / 0.25) * 0.58);
    } else if (i < arcEnd) {
      // Region 1: Ultra-rich woven 3D neural trajectory arcs (58% of all particles!)
      region = 1;
      const orbit = orbits[i % orbitCount];
      const angle = rand() * Math.PI * 2;
      const jitterR = (rand() - 0.5) * 0.02;
      const jitterN = (rand() - 0.5) * 0.016;
      if (orbit) {
        const r = orbit.radius + jitterR;
        const ca = Math.cos(angle) * r;
        const sa = Math.sin(angle) * r;
        x = orbit.basisU.x * ca + orbit.basisV.x * sa + (rand() - 0.5) * jitterN;
        y = orbit.basisU.y * ca + orbit.basisV.y * sa + (rand() - 0.5) * jitterN;
        z = orbit.basisU.z * ca + orbit.basisV.z * sa + (rand() - 0.5) * jitterN;
      }
      const isSparkNode = rand() < 0.032;
      size = isSparkNode ? 2.4 + rand() * 0.9 : 1.15 + rand() * 0.9;
      tmpColor.copy(accent).lerp(secondary, 0.38 + rand() * 0.62);
      if (isSparkNode) tmpColor.lerp(primary, 0.6);
    } else if (i < clusterEnd) {
      // Region 2: Round 1:1 glowing synapse star-nodes (soft density, zero hard-edged white clouds)
      region = 2;
      const cl = clusters[i % clusterCount];
      const theta = rand() * Math.PI * 2;
      const phi = Math.acos(2 * rand() - 1);
      const d = rand() ** 1.65 * (cl?.spread ?? 0.07);
      x = (cl?.center.x ?? 0) + d * Math.sin(phi) * Math.cos(theta);
      y = (cl?.center.y ?? 0) + d * Math.cos(phi);
      z = (cl?.center.z ?? 0) + d * Math.sin(phi) * Math.sin(theta);
      const centerWeight = 1 - d / Math.max(0.01, cl?.spread ?? 0.07);
      size = 1.25 + centerWeight * 1.45 + rand() * 0.5;
      tmpColor.copy(accent).lerp(secondary, 0.45 + centerWeight * 0.55);
      tmpColor.lerp(primary, centerWeight * 0.48);
    } else if (i < shellEnd) {
      // Region 3: Spherical neural volume dust
      region = 3;
      const theta = rand() * Math.PI * 2;
      const phi = Math.acos(2 * rand() - 1);
      const r = 0.24 + rand() ** 0.85 * 0.52;
      x = r * Math.sin(phi) * Math.cos(theta);
      y = r * Math.cos(phi);
      z = r * Math.sin(phi) * Math.sin(theta);
      size = 1.1 + rand() * 1.05;
      tmpColor.copy(accent).lerp(secondary, rand());
    } else {
      // Region 4: Delicate outer orbital micro-sparks (tightly bounded r <= 0.94)
      region = 4;
      const theta = rand() * Math.PI * 2;
      const phi = Math.acos(2 * rand() - 1);
      const r = 0.78 + rand() * 0.16;
      x = r * Math.sin(phi) * Math.cos(theta);
      y = r * Math.cos(phi);
      z = r * Math.sin(phi) * Math.sin(theta);
      size = 1.0 + rand() * 0.95;
      tmpColor.copy(secondary).lerp(primary, rand() * 0.45);
    }

    positions[i3] = x;
    positions[i3 + 1] = y;
    positions[i3 + 2] = z;

    colors[i3] = tmpColor.r;
    colors[i3 + 1] = tmpColor.g;
    colors[i3 + 2] = tmpColor.b;

    sizes[i] = size;
    regions[i] = region;

    randoms[i3] = rand();
    randoms[i3 + 1] = rand();
    randoms[i3 + 2] = rand();
  }

  return { count, positions, colors, sizes, regions, randoms };
}

const NEURAL_ARC_VERTEX_SHADER = /* glsl */ `
  attribute float aArcPhase;
  attribute float aOrbitIndex;

  uniform float uTime;
  uniform float uAudioRms;
  uniform float uWorkEnergy;
  uniform float uQuietFactor;

  varying float vPhase;
  varying float vOrbit;
  varying float vPulse;

  void main() {
    float breathe = 1.0 + sin(uTime * 1.8 + aOrbitIndex * 0.7) * 0.02 + uAudioRms * 0.12 + uWorkEnergy * 0.06;
    vec3 p = position * breathe * mix(1.0, 0.86, uQuietFactor);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
    vPhase = aArcPhase;
    vOrbit = aOrbitIndex;
    float speed = 0.75 + uWorkEnergy * 1.5 + uAudioRms * 2.4;
    vPulse = 0.5 + 0.5 * sin(aArcPhase * 12.566 - uTime * speed * (1.0 + mod(aOrbitIndex, 3.0) * 0.35));
  }
`;

const NEURAL_ARC_FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uPrimaryColor;
  uniform vec3 uSecondaryColor;
  uniform vec3 uAccentColor;
  uniform float uOpacity;
  uniform float uAudioRms;
  uniform float uWorkEnergy;

  varying float vPhase;
  varying float vOrbit;
  varying float vPulse;

  void main() {
    float spark = pow(vPulse, 3.2);
    vec3 col = mix(uAccentColor, uSecondaryColor, 0.55 + spark * 0.35);
    col = mix(col, uPrimaryColor, spark * (0.55 + uAudioRms * 0.35 + uWorkEnergy * 0.2));
    float alpha = (0.28 + spark * (0.48 + uAudioRms * 0.25 + uWorkEnergy * 0.18)) * uOpacity;
    gl_FragColor = vec4(col, clamp(alpha, 0.0, 0.92));
  }
`;

const CORE_GLOW_VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const CORE_GLOW_FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uPrimaryColor;
  uniform vec3 uSecondaryColor;
  uniform vec3 uAccentColor;
  uniform float uTime;
  uniform float uAudioRms;
  uniform float uWorkEnergy;
  uniform float uOpacity;

  varying vec2 vUv;

  void main() {
    vec2 p = (vUv - vec2(0.5)) * 2.0;
    float r = length(p);
    if (r > 1.0) discard;

    float pulse = 1.0 + sin(uTime * 3.1) * 0.05 + uAudioRms * 0.24 + uWorkEnergy * 0.12;
    // Pinpoint incandescent white-gold star heart preserving rich amber-orange gradient rings around it
    float core = exp(-r * r * (46.0 / pulse));
    float midGlow = exp(-r * r * (9.5 / pulse)) * 0.52;
    float outerAura = pow(max(0.0, 1.0 - r), 2.8) * 0.24;

    float angle = atan(p.y, p.x);
    float swirl = 0.9 + 0.1 * sin(angle * 6.0 - uTime * (2.2 + uWorkEnergy * 3.0) + r * 10.0);

    vec3 col = mix(uAccentColor, uSecondaryColor, smoothstep(0.85, 0.18, r));
    col = mix(col, uPrimaryColor, smoothstep(0.24, 0.03, r));
    col = mix(col, vec3(1.0), core * 0.78);

    float alpha = (core * 0.88 + midGlow * swirl + outerAura) * uOpacity;
    gl_FragColor = vec4(col, clamp(alpha, 0.0, 0.92));
  }
`;

const CONTRAST_BACKDROP_FRAGMENT_SHADER = /* glsl */ `
  uniform float uOpacity;

  varying vec2 vUv;

  void main() {
    vec2 p = (vUv - vec2(0.5)) * 2.0;
    float r = length(p);
    if (r > 1.0) discard;

    // Clean deep cosmic midnight-navy radial orb (zero muddy brown tint!) so golden particles pop on white windows
    float coreDisc = smoothstep(1.0, 0.36, r);
    float gauss = exp(-r * r * 2.65);
    float alpha = clamp((gauss * 0.82 + coreDisc * 0.28) * smoothstep(1.0, 0.72, r), 0.0, 1.0) * uOpacity;
    vec3 col = mix(vec3(0.035, 0.055, 0.105), vec3(0.015, 0.025, 0.05), gauss);
    gl_FragColor = vec4(col, alpha);
  }
`;

/**
 * Companion 3D geometry for the J.A.R.V.I.S. pure-particle neural core:
 * - 32 crisp 3D geodesic neural light arcs across 3 concentric counter-rotating shells
 * - Compact incandescent volumetric central heart glow
 * - Clean midnight-navy radial contrast orb for crisp visibility over bright white desktop apps
 */
export class JarvisNeuralCoreRig {
  readonly root = new THREE.Group();
  private readonly innerArcGroup = new THREE.Group();
  private readonly outerArcGroup = new THREE.Group();
  private readonly arcMat: THREE.ShaderMaterial;
  private readonly arcGeometries: THREE.BufferGeometry[] = [];
  private readonly coreGlowMesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private readonly contrastBackdropMesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;

  constructor() {
    this.arcMat = new THREE.ShaderMaterial({
      vertexShader: NEURAL_ARC_VERTEX_SHADER,
      fragmentShader: NEURAL_ARC_FRAGMENT_SHADER,
      uniforms: {
        uTime: { value: 0 },
        uAudioRms: { value: 0 },
        uWorkEnergy: { value: 0 },
        uQuietFactor: { value: 0 },
        uPrimaryColor: { value: new THREE.Color('#fff9ec') },
        uSecondaryColor: { value: new THREE.Color('#ffad2e') },
        uAccentColor: { value: new THREE.Color('#ea580c') },
        uOpacity: { value: 1.0 },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    const rand = createSeededRandom(994127);
    const arcCount = 32;
    const segmentsPerArc = 76;

    for (let a = 0; a < arcCount; a += 1) {
      const theta = rand() * Math.PI * 2;
      const phi = Math.acos(2 * rand() - 1);
      const normal = new THREE.Vector3(
        Math.sin(phi) * Math.cos(theta),
        Math.cos(phi),
        Math.sin(phi) * Math.sin(theta),
      ).normalize();
      const ref = Math.abs(normal.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
      const u = new THREE.Vector3().crossVectors(normal, ref).normalize();
      const v = new THREE.Vector3().crossVectors(normal, u).normalize();

      const radius = a < 10 ? 0.36 + rand() * 0.14 : a < 22 ? 0.54 + rand() * 0.15 : 0.72 + rand() * 0.14;
      const wobbleAmp = 0.015 + rand() * 0.025;
      const wobbleFreq = 2 + Math.floor(rand() * 3);
      const phaseOffset = rand() * Math.PI * 2;

      const positions = new Float32Array((segmentsPerArc + 1) * 3);
      const phases = new Float32Array(segmentsPerArc + 1);
      const orbitIndices = new Float32Array(segmentsPerArc + 1);

      for (let s = 0; s <= segmentsPerArc; s += 1) {
        const t = s / segmentsPerArc;
        const ang = t * Math.PI * 2;
        const r = radius + Math.sin(ang * wobbleFreq + phaseOffset) * wobbleAmp;
        const nOff = Math.cos(ang * (wobbleFreq - 1) + phaseOffset) * wobbleAmp * 0.6;
        const ca = Math.cos(ang) * r;
        const sa = Math.sin(ang) * r;
        positions[s * 3] = u.x * ca + v.x * sa + normal.x * nOff;
        positions[s * 3 + 1] = u.y * ca + v.y * sa + normal.y * nOff;
        positions[s * 3 + 2] = u.z * ca + v.z * sa + normal.z * nOff;
        phases[s] = t;
        orbitIndices[s] = a;
      }

      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geo.setAttribute('aArcPhase', new THREE.BufferAttribute(phases, 1));
      geo.setAttribute('aOrbitIndex', new THREE.BufferAttribute(orbitIndices, 1));
      this.arcGeometries.push(geo);

      const line = new THREE.Line(geo, this.arcMat);
      if (a % 2 === 0) {
        this.innerArcGroup.add(line);
      } else {
        this.outerArcGroup.add(line);
      }
    }

    // Clean midnight-navy radial contrast orb behind the neural core (makes golden filaments pop over white windows)
    const backdropGeo = new THREE.PlaneGeometry(2.12, 2.12);
    const backdropMat = new THREE.ShaderMaterial({
      vertexShader: CORE_GLOW_VERTEX_SHADER,
      fragmentShader: CONTRAST_BACKDROP_FRAGMENT_SHADER,
      uniforms: {
        uOpacity: { value: 0.82 },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
    });
    this.contrastBackdropMesh = new THREE.Mesh(backdropGeo, backdropMat);
    this.contrastBackdropMesh.position.z = -0.65;
    this.contrastBackdropMesh.renderOrder = -2;

    // Compact incandescent inner energy core billboard
    const coreGeo = new THREE.PlaneGeometry(0.86, 0.86);
    const coreMat = new THREE.ShaderMaterial({
      vertexShader: CORE_GLOW_VERTEX_SHADER,
      fragmentShader: CORE_GLOW_FRAGMENT_SHADER,
      uniforms: {
        uPrimaryColor: { value: new THREE.Color('#fff9ec') },
        uSecondaryColor: { value: new THREE.Color('#ffad2e') },
        uAccentColor: { value: new THREE.Color('#ea580c') },
        uTime: { value: 0 },
        uAudioRms: { value: 0 },
        uWorkEnergy: { value: 0 },
        uOpacity: { value: 1.0 },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.coreGlowMesh = new THREE.Mesh(coreGeo, coreMat);
    this.coreGlowMesh.position.z = 0.02;
    this.coreGlowMesh.renderOrder = 1;

    this.root.add(this.contrastBackdropMesh, this.innerArcGroup, this.outerArcGroup, this.coreGlowMesh);
  }

  updateColors(primary: THREE.Color, secondary: THREE.Color, accent: THREE.Color): void {
    (this.arcMat.uniforms.uPrimaryColor as THREE.IUniform<THREE.Color>).value.copy(primary);
    (this.arcMat.uniforms.uSecondaryColor as THREE.IUniform<THREE.Color>).value.copy(secondary);
    (this.arcMat.uniforms.uAccentColor as THREE.IUniform<THREE.Color>).value.copy(accent);

    const cu = this.coreGlowMesh.material.uniforms;
    (cu.uPrimaryColor as THREE.IUniform<THREE.Color>).value.copy(primary);
    (cu.uSecondaryColor as THREE.IUniform<THREE.Color>).value.copy(secondary);
    (cu.uAccentColor as THREE.IUniform<THREE.Color>).value.copy(accent);
  }

  update(params: {
    elapsed: number;
    deltaSec: number;
    visibility: number;
    floatingRole: boolean;
    audioRms: number;
    workEnergy: number;
    quietFactor: number;
    gazeX: number;
    gazeY: number;
    ringSpeed: number;
  }): void {
    const vis = Math.max(0, Math.min(1, params.visibility));
    this.root.visible = vis > 0.005;
    if (!this.root.visible) return;

    const spinRate = params.ringSpeed * (0.28 + params.workEnergy * 0.68 + params.audioRms * 1.05);
    this.innerArcGroup.rotation.y += params.deltaSec * spinRate;
    this.innerArcGroup.rotation.x = Math.sin(params.elapsed * 0.45) * 0.22 - params.gazeY * 0.24;
    this.innerArcGroup.rotation.z = Math.cos(params.elapsed * 0.35) * 0.14 + params.gazeX * 0.2;

    this.outerArcGroup.rotation.y -= params.deltaSec * spinRate * 0.72;
    this.outerArcGroup.rotation.x = Math.cos(params.elapsed * 0.38) * 0.2 - params.gazeY * 0.18;
    this.outerArcGroup.rotation.z = Math.sin(params.elapsed * 0.42) * 0.16 + params.gazeX * 0.16;

    (this.arcMat.uniforms.uTime as THREE.IUniform<number>).value = params.elapsed;
    (this.arcMat.uniforms.uAudioRms as THREE.IUniform<number>).value = params.audioRms;
    (this.arcMat.uniforms.uWorkEnergy as THREE.IUniform<number>).value = params.workEnergy;
    (this.arcMat.uniforms.uQuietFactor as THREE.IUniform<number>).value = params.quietFactor;
    (this.arcMat.uniforms.uOpacity as THREE.IUniform<number>).value = vis;

    const cu = this.coreGlowMesh.material.uniforms;
    (cu.uTime as THREE.IUniform<number>).value = params.elapsed;
    (cu.uAudioRms as THREE.IUniform<number>).value = params.audioRms;
    (cu.uWorkEnergy as THREE.IUniform<number>).value = params.workEnergy;
    (cu.uOpacity as THREE.IUniform<number>).value =
      vis * ((params.floatingRole ? 0.76 : 0.88) + params.audioRms * 0.14);

    const coreScale = (1.0 + params.audioRms * 0.16 + params.workEnergy * 0.07) * (1.0 - params.quietFactor * 0.14);
    this.coreGlowMesh.scale.setScalar(coreScale);

    // Rich deep-navy backdrop in floating mode so sphere pops cleanly over pure white windows; subtle in dark stage
    const backdropBase = params.floatingRole ? 0.88 : 0.22;
    (this.contrastBackdropMesh.material.uniforms.uOpacity as THREE.IUniform<number>).value = vis * backdropBase;
  }

  dispose(): void {
    for (const g of this.arcGeometries) g.dispose();
    this.arcMat.dispose();
    this.coreGlowMesh.geometry.dispose();
    this.coreGlowMesh.material.dispose();
    this.contrastBackdropMesh.geometry.dispose();
    this.contrastBackdropMesh.material.dispose();
  }
}
