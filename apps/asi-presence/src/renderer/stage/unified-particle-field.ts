import * as THREE from 'three';
import { generateJarvisCoreCloud, type ParticleCloudData, UNIFIED_PARTICLE_COUNT } from './jarvis-core.ts';

const UNIFIED_PARTICLE_VERTEX_SHADER = /* glsl */ `
  attribute vec3 aTargetPos;
  attribute vec3 aColor;
  attribute vec3 aTargetColor;
  attribute float aSize;
  attribute float aTargetSize;
  attribute float aRegion;
  attribute float aTargetRegion;
  attribute vec3 aRandom;

  uniform float uTime;
  uniform float uMorph;
  uniform float uTargetIsCore;
  uniform float uAudioRms;
  uniform float uLowBand;
  uniform float uMidBand;
  uniform float uHighBand;
  uniform float uWorkEnergy;
  uniform float uQuietFactor;
  uniform float uPixelRatio;
  uniform float uParticleGlow;
  uniform vec2 uGaze;

  varying vec3 vColor;
  varying float vEnergy;
  varying float vMorphBurst;
  varying float vIsSpark;
  varying float vIsSynapse;
  varying float vCoreBlend;
  varying float vRand;

  mat2 rot2(float a) {
    float c = cos(a);
    float s = sin(a);
    return mat2(c, -s, s, c);
  }

  void main() {
    float burst = sin(uMorph * 3.14159265);
    float eased = uMorph * uMorph * (3.0 - 2.0 * uMorph);

    vec3 pos = mix(position, aTargetPos, eased);
    vec3 col = mix(aColor, aTargetColor, eased);
    float ptSize = mix(aSize, aTargetSize, eased);
    float reg = mix(aRegion, aTargetRegion, step(0.5, eased));

    float liveDrive = clamp(uAudioRms * 1.45 + uWorkEnergy * 0.9, 0.0, 2.0);

    if (uTargetIsCore > 0.5) {
      // Avengers J.A.R.V.I.S. pure particle core: multi-shell orbital spin + acoustic & work surge
      float spinSpeed = (0.22 + aRandom.y * 0.3 + uWorkEnergy * 0.72 + uAudioRms * 1.25) * (aRandom.z > 0.5 ? 1.0 : -1.0);
      if (reg > 0.5 && reg < 1.5) {
        // Orbital neural arcs spin briskly
        pos.xz = rot2(uTime * spinSpeed * 0.72) * pos.xz;
        pos.xy = rot2(uTime * spinSpeed * 0.24) * pos.xy;
      } else if (reg > 1.5 && reg < 2.5) {
        // Synapse flare clusters counter-orbit cohesively as a rigid spherical shell (zero vertical shear!)
        pos.xz = rot2(-uTime * (0.16 + uWorkEnergy * 0.4 + uAudioRms * 0.65)) * pos.xz;
        pos.yz = rot2(uTime * 0.09) * pos.yz;
      } else if (reg > 3.5) {
        // Outer sparks drift & shimmer tightly within sphere boundary
        pos.xz = rot2(uTime * spinSpeed * 0.4) * pos.xz;
        pos.y += sin(uTime * 1.8 + aRandom.x * 6.2831) * (0.03 + uAudioRms * 0.08);
      } else {
        // Central core & inner volume pulse radially with sound & work
        pos.xz = rot2(uTime * 0.15 * (aRandom.z > 0.5 ? 1.0 : -1.0)) * pos.xz;
      }

      // Dynamic acoustic & work-activity radial pulse
      float wave = sin(length(pos) * 11.0 - uTime * (4.5 + uWorkEnergy * 5.0 + uAudioRms * 8.0) + aRandom.x * 6.2831);
      float leap = 1.0 + uAudioRms * (0.16 + aRandom.y * 0.14) + uWorkEnergy * 0.07 + wave * (0.015 + uMidBand * 0.065 + uWorkEnergy * 0.032);
      pos *= leap;

      // Subtle 3D tilt following gaze
      pos.xz = rot2(uGaze.x * 0.24) * pos.xz;
      pos.yz = rot2(-uGaze.y * 0.16) * pos.yz;
    } else {
      // Portrait Particle Form (Q版雪儿 / 真人雪儿): crystal-clear silhouette + lively acoustic/work shimmer!
      float breathe = sin(uTime * 1.85 + aRandom.x * 0.8) * 0.01;
      pos.y += breathe;

      if (reg > 3.5) {
        // Sparse ambient stardust particles dance gracefully around the portrait
        pos.y += sin(uTime * (1.6 + uWorkEnergy * 2.2) + aRandom.x * 6.2831) * (0.055 + uAudioRms * 0.12);
        pos.x += cos(uTime * (1.2 + uAudioRms * 2.4) + aRandom.y * 6.2831) * (0.04 + uWorkEnergy * 0.07);
      } else {
        // Holographic acoustic ripple & work-activity shimmer across portrait particles
        float scanWave = sin(pos.y * 8.5 - uTime * (4.0 + uWorkEnergy * 5.5 + uAudioRms * 6.0) + aRandom.x * 2.4);
        float zDance = scanWave * (0.01 + uAudioRms * 0.065 + uWorkEnergy * 0.038);
        float xyShimmer = cos(uTime * (3.2 + uHighBand * 8.0) + aRandom.y * 6.2831) * (0.0012 + uAudioRms * 0.009 + uWorkEnergy * 0.005);
        // Keep face region (reg == 1) extra crisp so eyes & smile stay unmistakably clear
        float clarity = reg > 0.5 && reg < 1.5 ? 0.35 : 1.0;
        pos.z += zDance * clarity;
        pos.x += xyShimmer * clarity;
        pos.y += sin(uTime * 4.5 + pos.x * 8.0) * (uMidBand * 0.014 + uWorkEnergy * 0.006) * clarity;
      }

      pos.xz = rot2(uGaze.x * 0.14) * pos.xz;
      pos.yz = rot2(-uGaze.y * 0.06) * pos.yz;
    }

    // Graceful bounded vortex swirl during active morphs (never floods the whole viewport!)
    if (burst > 0.001) {
      float swirlAngle = burst * (2.6 + aRandom.y * 2.8) * (aRandom.z > 0.5 ? 1.0 : -1.0);
      vec3 dir = normalize(vec3(
        cos(aRandom.x * 6.2831 + swirlAngle),
        (aRandom.y - 0.5) * 1.1,
        sin(aRandom.x * 6.2831 + swirlAngle)
      ));
      pos += dir * burst * (0.24 + aRandom.z * 0.32);
    }

    pos *= mix(1.0, 0.86, uQuietFactor);

    vec4 mvPos = modelViewMatrix * vec4(pos, 1.0);
    gl_Position = projectionMatrix * mvPos;

    float sizeBoost = 1.0 + burst * 0.35 + uAudioRms * (0.24 + aRandom.z * 0.16) + uWorkEnergy * 0.12;
    float maxPx = (uTargetIsCore > 0.5 ? 4.8 : 4.2) * uPixelRatio;
    gl_PointSize = clamp(ptSize * uParticleGlow * sizeBoost * uPixelRatio * (3.2 / max(1.0, -mvPos.z)), 1.3 * uPixelRatio, maxPx);

    vColor = col;
    vEnergy = liveDrive;
    vMorphBurst = burst;
    vIsSpark = step(3.5, reg);
    vIsSynapse = step(1.5, reg) * (1.0 - step(2.5, reg));
    vCoreBlend = uTargetIsCore;
    vRand = aRandom.x;
  }
`;

const UNIFIED_PARTICLE_FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uPrimaryColor;
  uniform vec3 uSecondaryColor;
  uniform float uTime;
  uniform float uOpacity;
  uniform float uScanlineDensity;
  uniform float uAudioRms;
  uniform float uWorkEnergy;

  varying vec3 vColor;
  varying float vEnergy;
  varying float vMorphBurst;
  varying float vIsSpark;
  varying float vIsSynapse;
  varying float vCoreBlend;
  varying float vRand;

  void main() {
    vec2 uv = gl_PointCoord - vec2(0.5);
    float dist = length(uv);
    if (dist > 0.5) discard;

    // Smooth circular Gaussian dot (guaranteed round 1:1, zero square edges or hard-cut white clouds!)
    float circleEdge = smoothstep(0.5, 0.14, dist);
    float gaussian = exp(-dist * dist * 16.0);
    float softHalo = exp(-dist * dist * 5.8) * circleEdge;

    // Gentle symmetric 1:1 star glint strictly on J.A.R.V.I.S. synapse nodes
    float glintMask = vCoreBlend * vIsSynapse * smoothstep(0.46, 0.1, dist);
    float microGlint = glintMask * (
      exp(-abs(uv.x) * 20.0) * exp(-abs(uv.y) * 7.5) +
      exp(-abs(uv.y) * 20.0) * exp(-abs(uv.x) * 7.5)
    );

    vec3 col = vColor;
    float energyFlash = clamp(vMorphBurst * 0.3 + vEnergy * (vCoreBlend > 0.5 ? 0.22 : 0.14), 0.0, 0.55);
    col = mix(col, mix(uPrimaryColor, vec3(1.0), 0.35), energyFlash * (0.25 + softHalo * 0.45));
    col += uSecondaryColor * microGlint * (0.28 + uAudioRms * 0.4 + uWorkEnergy * 0.2);

    float twinkle = 0.86 + 0.14 * sin(uTime * (3.8 + uWorkEnergy * 4.5) + vRand * 18.84);
    float scan = 0.92 + 0.08 * sin(gl_FragCoord.y * (0.2 + uScanlineDensity * 0.45) - uTime * 4.0);

    float baseAlpha = vCoreBlend > 0.5
      ? (gaussian * 0.44 + softHalo * 0.22 + microGlint * 0.18)
      : (circleEdge * 0.78 + gaussian * 0.3);

    if (vIsSpark > 0.5) {
      baseAlpha *= 0.52;
    }

    float alpha = baseAlpha * twinkle * scan * uOpacity;
    gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0));
  }
`;

/**
 * Unified 26,000-particle GPU morph field shared across:
 * - Avengers J.A.R.V.I.S. pure neural core (`jarvis-core`)
 * - Q版雪儿 full-color dancing particle form (`chibi` + `particleMode`)
 * - 真人雪儿 full-color dancing particle form (`realistic` + `particleMode`)
 * - Custom `.vrm` 3D avatar particle form
 */
export class UnifiedParticleField {
  readonly points: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
  readonly count: number;
  readonly uniforms: {
    uTime: { value: number };
    uMorph: { value: number };
    uTargetIsCore: { value: number };
    uAudioRms: { value: number };
    uLowBand: { value: number };
    uMidBand: { value: number };
    uHighBand: { value: number };
    uWorkEnergy: { value: number };
    uQuietFactor: { value: number };
    uPixelRatio: { value: number };
    uParticleGlow: { value: number };
    uGaze: { value: THREE.Vector2 };
    uPrimaryColor: { value: THREE.Color };
    uSecondaryColor: { value: THREE.Color };
    uOpacity: { value: number };
    uScanlineDensity: { value: number };
  };
  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.ShaderMaterial;
  private currentCloud: ParticleCloudData;
  private targetCloud: ParticleCloudData;
  private morphProgress = 1;

  constructor(count = UNIFIED_PARTICLE_COUNT) {
    this.count = count;
    const initial = generateJarvisCoreCloud(count);
    this.currentCloud = initial;
    this.targetCloud = initial;

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(initial.positions), 3));
    this.geometry.setAttribute('aTargetPos', new THREE.BufferAttribute(new Float32Array(initial.positions), 3));
    this.geometry.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(initial.colors), 3));
    this.geometry.setAttribute('aTargetColor', new THREE.BufferAttribute(new Float32Array(initial.colors), 3));
    this.geometry.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(initial.sizes), 1));
    this.geometry.setAttribute('aTargetSize', new THREE.BufferAttribute(new Float32Array(initial.sizes), 1));
    this.geometry.setAttribute('aRegion', new THREE.BufferAttribute(new Float32Array(initial.regions), 1));
    this.geometry.setAttribute('aTargetRegion', new THREE.BufferAttribute(new Float32Array(initial.regions), 1));
    this.geometry.setAttribute('aRandom', new THREE.BufferAttribute(new Float32Array(initial.randoms), 3));

    this.uniforms = {
      uTime: { value: 0 },
      uMorph: { value: 1 },
      uTargetIsCore: { value: 1 },
      uAudioRms: { value: 0 },
      uLowBand: { value: 0 },
      uMidBand: { value: 0 },
      uHighBand: { value: 0 },
      uWorkEnergy: { value: 0 },
      uQuietFactor: { value: 0 },
      uPixelRatio: { value: typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, 2) : 1 },
      uParticleGlow: { value: 1.0 },
      uGaze: { value: new THREE.Vector2(0, 0) },
      uPrimaryColor: { value: new THREE.Color('#fff9ec') },
      uSecondaryColor: { value: new THREE.Color('#ffad2e') },
      uOpacity: { value: 0.96 },
      uScanlineDensity: { value: 0.48 },
    };

    this.material = new THREE.ShaderMaterial({
      vertexShader: UNIFIED_PARTICLE_VERTEX_SHADER,
      fragmentShader: UNIFIED_PARTICLE_FRAGMENT_SHADER,
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 2;
  }

  /**
   * Smoothly morphs all 26k particles from their current state to `nextCloud`.
   * Switches blending cleanly: Additive for incandescent J.A.R.V.I.S. core,
   * NormalBlending for portrait particle sculptures so true colors stay crisp on any background.
   */
  transitionTo(nextCloud: ParticleCloudData, isCore: boolean, immediate = false): void {
    const posFrom = this.geometry.getAttribute('position') as THREE.BufferAttribute;
    const posTo = this.geometry.getAttribute('aTargetPos') as THREE.BufferAttribute;
    const colFrom = this.geometry.getAttribute('aColor') as THREE.BufferAttribute;
    const colTo = this.geometry.getAttribute('aTargetColor') as THREE.BufferAttribute;
    const sizeFrom = this.geometry.getAttribute('aSize') as THREE.BufferAttribute;
    const sizeTo = this.geometry.getAttribute('aTargetSize') as THREE.BufferAttribute;
    const regFrom = this.geometry.getAttribute('aRegion') as THREE.BufferAttribute;
    const regTo = this.geometry.getAttribute('aTargetRegion') as THREE.BufferAttribute;

    const t = this.morphProgress * this.morphProgress * (3 - 2 * this.morphProgress);
    const pFromArr = posFrom.array as Float32Array;
    const pToArr = posTo.array as Float32Array;
    const cFromArr = colFrom.array as Float32Array;
    const cToArr = colTo.array as Float32Array;
    const sFromArr = sizeFrom.array as Float32Array;
    const sToArr = sizeTo.array as Float32Array;
    const rFromArr = regFrom.array as Float32Array;
    const rToArr = regTo.array as Float32Array;

    if (!immediate) {
      for (let i = 0; i < pFromArr.length; i += 1) {
        pFromArr[i] = (pFromArr[i] ?? 0) + ((pToArr[i] ?? 0) - (pFromArr[i] ?? 0)) * t;
        cFromArr[i] = (cFromArr[i] ?? 0) + ((cToArr[i] ?? 0) - (cFromArr[i] ?? 0)) * t;
      }
      for (let i = 0; i < sFromArr.length; i += 1) {
        sFromArr[i] = (sFromArr[i] ?? 2) + ((sToArr[i] ?? 2) - (sFromArr[i] ?? 2)) * t;
        rFromArr[i] = t > 0.5 ? (rToArr[i] ?? 0) : (rFromArr[i] ?? 0);
      }
    }

    pToArr.set(nextCloud.positions.subarray(0, pToArr.length));
    cToArr.set(nextCloud.colors.subarray(0, cToArr.length));
    sToArr.set(nextCloud.sizes.subarray(0, sToArr.length));
    rToArr.set(nextCloud.regions.subarray(0, rToArr.length));

    if (immediate) {
      pFromArr.set(pToArr);
      cFromArr.set(cToArr);
      sFromArr.set(sToArr);
      rFromArr.set(rToArr);
      this.morphProgress = 1;
    } else {
      this.morphProgress = 0;
    }

    posFrom.needsUpdate = true;
    posTo.needsUpdate = true;
    colFrom.needsUpdate = true;
    colTo.needsUpdate = true;
    sizeFrom.needsUpdate = true;
    sizeTo.needsUpdate = true;
    regFrom.needsUpdate = true;
    regTo.needsUpdate = true;

    this.currentCloud = this.targetCloud;
    this.targetCloud = nextCloud;
    this.uniforms.uTargetIsCore.value = isCore ? 1 : 0;
    this.uniforms.uMorph.value = this.morphProgress;

    const desiredBlending = isCore ? THREE.AdditiveBlending : THREE.NormalBlending;
    if (this.material.blending !== desiredBlending) {
      this.material.blending = desiredBlending;
      this.material.needsUpdate = true;
    }
  }

  /** Re-tints J.A.R.V.I.S. core colors when theme changes while staying on core. */
  recolorTarget(nextCloud: ParticleCloudData): void {
    const colFrom = this.geometry.getAttribute('aColor') as THREE.BufferAttribute;
    const colTo = this.geometry.getAttribute('aTargetColor') as THREE.BufferAttribute;
    (colFrom.array as Float32Array).set(nextCloud.colors.subarray(0, colFrom.array.length));
    (colTo.array as Float32Array).set(nextCloud.colors.subarray(0, colTo.array.length));
    colFrom.needsUpdate = true;
    colTo.needsUpdate = true;
  }

  getCurrentCloud(): ParticleCloudData {
    return this.currentCloud;
  }

  stepMorph(deltaSec: number): number {
    if (this.morphProgress < 1) {
      this.morphProgress = Math.min(1, this.morphProgress + deltaSec * 1.75);
      this.uniforms.uMorph.value = this.morphProgress;
    }
    return this.morphProgress;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
