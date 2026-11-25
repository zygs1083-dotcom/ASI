import type { VisemeFrame } from '@asi/presence-protocol';
import * as THREE from 'three';
import { HOLOGRAM_SURFACE_FRAGMENT_SHADER, HOLOGRAM_SURFACE_VERTEX_SHADER } from './particles.glsl.ts';

interface HologramShaderUniforms {
  [uniform: string]: THREE.IUniform<unknown>;
  uBaseColor: { value: THREE.Color };
  uRimColor: { value: THREE.Color };
  uAccentColor: { value: THREE.Color };
  uTime: { value: number };
  uHologramIntensity: { value: number };
  uScanlineDensity: { value: number };
  uAudioPulse: { value: number };
  uDissolve: { value: number };
  uBaseOpacity: { value: number };
}

function createHologramMaterial(
  baseHex: string,
  rimHex: string,
  accentHex: string,
  baseOpacity = 0.84,
): THREE.ShaderMaterial {
  const uniforms: HologramShaderUniforms = {
    uBaseColor: { value: new THREE.Color(baseHex) },
    uRimColor: { value: new THREE.Color(rimHex) },
    uAccentColor: { value: new THREE.Color(accentHex) },
    uTime: { value: 0 },
    uHologramIntensity: { value: 0.72 },
    uScanlineDensity: { value: 0.48 },
    uAudioPulse: { value: 0 },
    uDissolve: { value: 0 },
    uBaseOpacity: { value: baseOpacity },
  };
  return new THREE.ShaderMaterial({
    vertexShader: HOLOGRAM_SURFACE_VERTEX_SHADER,
    fragmentShader: HOLOGRAM_SURFACE_FRAGMENT_SHADER,
    uniforms,
    transparent: true,
    side: THREE.DoubleSide,
  });
}

/**
 * Built-in CC0/MIT procedural 3D futuristic snow-white cyber holographic humanoid for 雪儿.
 * Features pearlescent snow-white armor silhouette, luminous tracking eyes with blinking,
 * TalkingHead acoustic lip emitter, translucent snow-white cyber canine ear fins on a halo band,
 * pulsing snow-crystal heart core, and orbiting holographic telemetry rings.
 */
export class XueerHumanoidRig {
  readonly root = new THREE.Group();
  private readonly upperBody = new THREE.Group();
  private readonly headGroup = new THREE.Group();
  private readonly leftEarPivot = new THREE.Group();
  private readonly rightEarPivot = new THREE.Group();
  private readonly leftEyeGroup = new THREE.Group();
  private readonly rightEyeGroup = new THREE.Group();
  private readonly mouthMesh: THREE.Mesh;
  private readonly heartCore: THREE.Mesh;
  private readonly leftArm = new THREE.Group();
  private readonly rightArm = new THREE.Group();
  private readonly haloRing: THREE.Mesh;
  private readonly shoulderRing: THREE.Mesh;
  private readonly shaderMaterials: THREE.ShaderMaterial[] = [];
  private readonly meshesForSampling: THREE.Mesh[] = [];
  private readonly eyeGlowMat: THREE.MeshBasicMaterial;
  private readonly mouthGlowMat: THREE.MeshBasicMaterial;
  private readonly heartGlowMat: THREE.MeshBasicMaterial;
  private readonly ringGlowMat: THREE.MeshBasicMaterial;

  constructor() {
    const snowPearlMat = createHologramMaterial('#eff9ff', '#5ce1ff', '#38bdf8', 0.88);
    const frostGlassMat = createHologramMaterial('#d9f3ff', '#7dd3fc', '#bae6fd', 0.56);
    const earCrystalMat = createHologramMaterial('#ffffff', '#67e8f9', '#e0f2fe', 0.76);
    this.shaderMaterials.push(snowPearlMat, frostGlassMat, earCrystalMat);

    this.eyeGlowMat = new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.96 });
    this.mouthGlowMat = new THREE.MeshBasicMaterial({ color: '#7dd3fc', transparent: true, opacity: 0.92 });
    this.heartGlowMat = new THREE.MeshBasicMaterial({ color: '#e0f7ff', transparent: true, opacity: 0.95 });
    this.ringGlowMat = new THREE.MeshBasicMaterial({
      color: '#5ce1ff',
      transparent: true,
      opacity: 0.55,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

    this.root.add(this.upperBody);
    this.upperBody.position.set(0, -0.22, 0);

    // 1. Torso & sculpted futuristic snow-white cyber collar
    const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.17, 0.66, 28), snowPearlMat);
    torso.position.set(0, -0.02, 0);
    this.upperBody.add(torso);
    this.meshesForSampling.push(torso);

    const chestPlate = new THREE.Mesh(new THREE.SphereGeometry(0.26, 28, 20), frostGlassMat);
    chestPlate.scale.set(1.06, 0.85, 0.72);
    chestPlate.position.set(0, 0.14, 0.04);
    this.upperBody.add(chestPlate);
    this.meshesForSampling.push(chestPlate);

    const collar = new THREE.Mesh(new THREE.TorusGeometry(0.18, 0.032, 16, 40), snowPearlMat);
    collar.rotation.x = Math.PI * 0.47;
    collar.position.set(0, 0.32, 0.01);
    this.upperBody.add(collar);
    this.meshesForSampling.push(collar);

    // Lower holographic skirt/energy taper
    const lowerAura = new THREE.Mesh(new THREE.ConeGeometry(0.32, 0.55, 32, 1, true), frostGlassMat);
    lowerAura.position.set(0, -0.62, 0);
    this.upperBody.add(lowerAura);
    this.meshesForSampling.push(lowerAura);

    // Snow-crystal heart reactor core
    this.heartCore = new THREE.Mesh(new THREE.OctahedronGeometry(0.075, 0), this.heartGlowMat);
    this.heartCore.position.set(0, 0.14, 0.21);
    this.upperBody.add(this.heartCore);

    // 2. Neck & Head Assembly
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.068, 0.082, 0.18, 20), snowPearlMat);
    neck.position.set(0, 0.41, 0);
    this.upperBody.add(neck);
    this.meshesForSampling.push(neck);

    this.headGroup.position.set(0, 0.67, 0.01);
    this.upperBody.add(this.headGroup);

    const cranium = new THREE.Mesh(new THREE.SphereGeometry(0.24, 32, 26), snowPearlMat);
    cranium.scale.set(0.94, 1.08, 0.96);
    this.headGroup.add(cranium);
    this.meshesForSampling.push(cranium);

    // Sleek cyber hair/visor crown framing the face
    const crownVisor = new THREE.Mesh(
      new THREE.SphereGeometry(0.248, 28, 18, 0, Math.PI * 2, 0, Math.PI * 0.58),
      frostGlassMat,
    );
    crownVisor.position.set(0, 0.03, -0.02);
    this.headGroup.add(crownVisor);
    this.meshesForSampling.push(crownVisor);

    // Luminous expressive eyes
    const buildEye = (group: THREE.Group, xPos: number) => {
      group.position.set(xPos, 0.02, 0.215);
      const iris = new THREE.Mesh(new THREE.SphereGeometry(0.034, 18, 14), this.eyeGlowMat);
      iris.scale.set(1.15, 0.92, 0.45);
      group.add(iris);

      const eyeRing = new THREE.Mesh(new THREE.TorusGeometry(0.045, 0.006, 10, 24), this.ringGlowMat);
      eyeRing.position.z = 0.008;
      group.add(eyeRing);
      this.headGroup.add(group);
    };
    buildEye(this.leftEyeGroup, -0.086);
    buildEye(this.rightEyeGroup, 0.086);

    // Acoustic lip-sync holographic mouth emitter
    this.mouthMesh = new THREE.Mesh(new THREE.CapsuleGeometry(0.012, 0.065, 8, 16), this.mouthGlowMat);
    this.mouthMesh.rotation.z = Math.PI / 2;
    this.mouthMesh.position.set(0, -0.105, 0.215);
    this.headGroup.add(this.mouthMesh);

    // Signature Snow-White Holographic Canine Ear Fins mounted on a crystalline halo headband
    this.haloRing = new THREE.Mesh(new THREE.TorusGeometry(0.26, 0.008, 12, 48), this.ringGlowMat);
    this.haloRing.rotation.x = Math.PI * 0.42;
    this.haloRing.position.set(0, 0.14, -0.02);
    this.headGroup.add(this.haloRing);

    const buildEarFin = (pivot: THREE.Group, side: -1 | 1) => {
      pivot.position.set(side * 0.155, 0.21, -0.01);
      pivot.rotation.z = -side * 0.22;

      const outerEar = new THREE.Mesh(new THREE.ConeGeometry(0.075, 0.26, 4), earCrystalMat);
      outerEar.scale.set(0.85, 1.0, 0.45);
      outerEar.position.set(0, 0.12, 0);
      pivot.add(outerEar);
      this.meshesForSampling.push(outerEar);

      const innerEar = new THREE.Mesh(new THREE.ConeGeometry(0.042, 0.18, 4), this.ringGlowMat);
      innerEar.scale.set(0.8, 1.0, 0.35);
      innerEar.position.set(0, 0.105, 0.018);
      pivot.add(innerEar);

      this.headGroup.add(pivot);
    };
    buildEarFin(this.leftEarPivot, -1);
    buildEarFin(this.rightEarPivot, 1);

    // 3. Articulated hovering futuristic arms
    const buildArm = (armGroup: THREE.Group, side: -1 | 1) => {
      armGroup.position.set(side * 0.32, 0.22, 0);
      const shoulder = new THREE.Mesh(new THREE.SphereGeometry(0.068, 18, 14), snowPearlMat);
      armGroup.add(shoulder);
      this.meshesForSampling.push(shoulder);

      const upper = new THREE.Mesh(new THREE.CapsuleGeometry(0.044, 0.24, 10, 16), snowPearlMat);
      upper.position.set(side * 0.03, -0.17, 0.01);
      upper.rotation.z = side * 0.12;
      armGroup.add(upper);
      this.meshesForSampling.push(upper);

      const forearm = new THREE.Mesh(new THREE.CapsuleGeometry(0.036, 0.22, 10, 16), frostGlassMat);
      forearm.position.set(side * 0.06, -0.42, 0.06);
      forearm.rotation.x = -0.22;
      armGroup.add(forearm);
      this.meshesForSampling.push(forearm);

      this.upperBody.add(armGroup);
    };
    buildArm(this.leftArm, -1);
    buildArm(this.rightArm, 1);

    // 4. Orbiting J.A.R.V.I.S. holographic telemetry halo around shoulders
    this.shoulderRing = new THREE.Mesh(new THREE.TorusGeometry(0.62, 0.008, 12, 64), this.ringGlowMat);
    this.shoulderRing.rotation.x = Math.PI * 0.44;
    this.shoulderRing.position.set(0, 0.12, -0.05);
    this.upperBody.add(this.shoulderRing);
  }

  sampleSurfacePoints(count: number): Float32Array {
    this.root.updateMatrixWorld(true);
    const out = new Float32Array(count * 3);
    const allVerts: THREE.Vector3[] = [];
    const tmp = new THREE.Vector3();

    for (const mesh of this.meshesForSampling) {
      const posAttr = mesh.geometry.getAttribute('position');
      if (!posAttr) continue;
      for (let i = 0; i < posAttr.count; i += 1) {
        tmp.fromBufferAttribute(posAttr, i).applyMatrix4(mesh.matrixWorld);
        allVerts.push(tmp.clone());
      }
    }

    if (allVerts.length === 0) return out;

    for (let i = 0; i < count; i += 1) {
      const src = allVerts[(i * 7919) % allVerts.length];
      if (!src) continue;
      const jitter = ((i % 13) - 6) * 0.0025;
      out[i * 3] = src.x + jitter;
      out[i * 3 + 1] = src.y + jitter;
      out[i * 3 + 2] = src.z + jitter;
    }
    return out;
  }

  updateColors(primary: THREE.Color, secondary: THREE.Color, accent: THREE.Color): void {
    for (const mat of this.shaderMaterials) {
      const u = mat.uniforms as HologramShaderUniforms;
      u.uBaseColor.value.copy(primary);
      u.uRimColor.value.copy(secondary);
      u.uAccentColor.value.copy(accent);
    }
    this.eyeGlowMat.color.copy(primary).lerp(new THREE.Color('#ffffff'), 0.45);
    this.mouthGlowMat.color.copy(secondary);
    this.heartGlowMat.color.copy(primary).lerp(secondary, 0.35);
    this.ringGlowMat.color.copy(accent);
  }

  update(params: {
    time: number;
    viseme: VisemeFrame;
    gazeX: number;
    gazeY: number;
    blink: number;
    earPerk: number;
    smile: number;
    hologramIntensity: number;
    scanlineDensity: number;
    dissolve: number;
    quietFactor: number;
  }): void {
    const {
      time,
      viseme,
      gazeX,
      gazeY,
      blink,
      earPerk,
      smile,
      hologramIntensity,
      scanlineDensity,
      dissolve,
      quietFactor,
    } = params;

    const breathe = Math.sin(time * 1.9);
    this.upperBody.position.y = -0.22 + breathe * 0.022;
    this.upperBody.scale.setScalar(1.0 - quietFactor * 0.14);

    // Head tracking & lively conversational micro-nods
    this.headGroup.rotation.y = gazeX * 0.32 + Math.sin(time * 0.7) * 0.04;
    this.headGroup.rotation.x = -gazeY * 0.2 + viseme.rms * 0.08 + breathe * 0.02;
    this.headGroup.rotation.z = Math.sin(time * 0.9) * 0.03 + smile * 0.04 * Math.sin(time * 1.6);

    // Blink & smiling eyes
    const eyeScaleY = Math.max(0.08, 1.0 - blink * 0.92) * (1.0 - smile * 0.18);
    this.leftEyeGroup.scale.set(1.0 + smile * 0.1, eyeScaleY, 1.0);
    this.rightEyeGroup.scale.set(1.0 + smile * 0.1, eyeScaleY, 1.0);

    // 60fps TalkingHead viseme acoustic lip-sync
    const open = viseme.vowels.aa * 1.15 + viseme.vowels.oh * 0.85 + viseme.vowels.ou * 0.6 + viseme.rms * 0.7;
    const wide = 0.85 + viseme.vowels.ee * 0.45 + viseme.vowels.ih * 0.3 - viseme.vowels.ou * 0.35 + smile * 0.25;
    this.mouthMesh.scale.set(Math.max(0.4, 1.0 + open * 1.65), Math.max(0.55, wide), 1.0);
    this.mouthGlowMat.opacity = 0.62 + Math.min(0.38, viseme.rms * 0.9);

    // Snow-white canine ear fins perk & gentle attentive twitch
    const baseTilt = 0.42 - earPerk * 0.36;
    const twitch = Math.sin(time * 2.5) * 0.04 + viseme.highBand * 0.12;
    this.leftEarPivot.rotation.z = baseTilt + twitch;
    this.rightEarPivot.rotation.z = -baseTilt - twitch * 0.9;
    this.leftEarPivot.rotation.x = (earPerk - 0.5) * 0.18;
    this.rightEarPivot.rotation.x = (earPerk - 0.5) * 0.18;

    // Snow-crystal heart pulse
    const heartPulse = 1.0 + breathe * 0.06 + viseme.rms * 0.38;
    this.heartCore.scale.setScalar(heartPulse);
    this.heartCore.rotation.y = time * 1.1;

    // Gentle floating arms & orbital rings
    this.leftArm.rotation.z = 0.08 + breathe * 0.03 + viseme.rms * 0.08;
    this.rightArm.rotation.z = -0.08 - breathe * 0.03 - viseme.rms * 0.08;
    this.leftArm.rotation.x = -0.06 + viseme.midBand * 0.14;
    this.rightArm.rotation.x = -0.06 + viseme.midBand * 0.14;

    this.haloRing.rotation.z = time * 0.45;
    this.shoulderRing.rotation.z = -time * (0.52 + viseme.rms * 0.8);
    this.shoulderRing.scale.setScalar(1.0 + viseme.lowBand * 0.12);

    for (const mat of this.shaderMaterials) {
      const u = mat.uniforms as HologramShaderUniforms;
      u.uTime.value = time;
      u.uHologramIntensity.value = hologramIntensity;
      u.uScanlineDensity.value = scanlineDensity;
      u.uAudioPulse.value = viseme.rms;
      u.uDissolve.value = dissolve;
    }

    const visOpacity = Math.max(0, 1.0 - dissolve * 1.45);
    this.eyeGlowMat.opacity = 0.95 * visOpacity;
    this.heartGlowMat.opacity = 0.95 * visOpacity;
    this.ringGlowMat.opacity = (0.52 + viseme.rms * 0.3) * visOpacity;
  }

  dispose(): void {
    this.root.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
      }
    });
    for (const mat of this.shaderMaterials) {
      mat.dispose();
    }
    this.eyeGlowMat.dispose();
    this.mouthGlowMat.dispose();
    this.heartGlowMat.dispose();
    this.ringGlowMat.dispose();
  }
}
