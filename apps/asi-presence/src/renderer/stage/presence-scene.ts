import {
  type AvatarForm,
  createSilentVisemeFrame,
  type PresenceActivity,
  type PresenceEmotion,
  type VisemeFrame,
  type VisualTheme,
} from '@asi/presence-protocol';
import * as THREE from 'three';
import { EMOTION_MODULATIONS, resolveThemeColors } from './themes.ts';
import { VrmAvatarController } from './vrm-avatar.ts';
import { XueerHumanoidRig } from './xueer-humanoid-rig.ts';
import { XueerParticleFace } from './xueer-particle-face.ts';

export interface SceneRenderState {
  form: AvatarForm;
  theme: VisualTheme;
  emotion: PresenceEmotion;
  activity: PresenceActivity;
  hologramIntensity: number;
  scanlineDensity: number;
  particleGlow: number;
  quietDefer: boolean;
}

/**
 * Unified 60fps Three.js rendering engine powering BOTH forms of 雪儿:
 * - Form A (`particle-face`): J.A.R.V.I.S. 12k-particle snow-cyan holographic virtual face + canine ear crests.
 * - Form B (`humanoid-3d`): Built-in procedural 3D cyber holographic humanoid OR drag-and-drop `@pixiv/three-vrm`.
 * Supports smooth GPU particle disassemble/reassemble morphing between both forms in either window.
 */
export class PresenceSceneEngine {
  private readonly container: HTMLElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly particleFace: XueerParticleFace;
  private readonly humanoidRig: XueerHumanoidRig;
  private readonly vrmAvatar: VrmAvatarController;
  private readonly keyLight: THREE.DirectionalLight;
  private readonly rimLight: THREE.PointLight;
  private readonly ambientLight: THREE.AmbientLight;

  private state: SceneRenderState = {
    form: 'particle-face',
    theme: 'snow-cyan',
    emotion: 'calm',
    activity: 'idle',
    hologramIntensity: 0.72,
    scanlineDensity: 0.48,
    particleGlow: 1.0,
    quietDefer: false,
  };

  private viseme: VisemeFrame = createSilentVisemeFrame();
  private morphValue = 0; // 0 = particle-face, 1 = humanoid-3d
  private morphTarget = 0;
  private targetGazeX = 0;
  private targetGazeY = 0;
  private currentGazeX = 0;
  private currentGazeY = 0;
  private currentEarPerk = 0.56;
  private currentSmile = 0.28;
  private currentQuiet = 0;
  private nextBlinkAt = 2.6;
  private blinkTimer = 0;
  private elapsed = 0;
  private lastFrameMs = 0;
  private rafId: number | null = null;
  private disposed = false;

  constructor(container: HTMLElement, role: 'floating' | 'stage') {
    this.container = container;
    this.scene = new THREE.Scene();

    const width = Math.max(1, container.clientWidth);
    const height = Math.max(1, container.clientHeight);
    this.camera = new THREE.PerspectiveCamera(role === 'floating' ? 38 : 34, width / height, 0.1, 40);
    this.camera.position.set(0, 0.08, role === 'floating' ? 3.25 : 3.05);

    this.renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(width, height);
    this.renderer.setClearColor(0x000000, 0);
    container.appendChild(this.renderer.domElement);

    this.ambientLight = new THREE.AmbientLight('#dff4ff', 0.85);
    this.keyLight = new THREE.DirectionalLight('#ffffff', 1.35);
    this.keyLight.position.set(1.8, 2.6, 3.2);
    this.rimLight = new THREE.PointLight('#5ce1ff', 2.4, 9);
    this.rimLight.position.set(-1.6, 1.4, -1.2);
    this.scene.add(this.ambientLight, this.keyLight, this.rimLight);

    this.particleFace = new XueerParticleFace();
    this.humanoidRig = new XueerHumanoidRig();
    this.vrmAvatar = new VrmAvatarController();

    this.scene.add(this.particleFace.points);
    this.scene.add(this.humanoidRig.root);
    this.scene.add(this.vrmAvatar.root);

    // Bind morph targets to the procedural humanoid rig immediately
    this.particleFace.setMorphTargets(this.humanoidRig.sampleSurfacePoints(this.particleFace.count));
    this.applyThemeAndEmotionColors();

    this.lastFrameMs = performance.now();
    this.loop(this.lastFrameMs);
  }

  setState(patch: Partial<SceneRenderState>): void {
    const prevTheme = this.state.theme;
    const prevEmotion = this.state.emotion;
    this.state = { ...this.state, ...patch };
    this.morphTarget = this.state.form === 'humanoid-3d' ? 1 : 0;
    if (prevTheme !== this.state.theme || prevEmotion !== this.state.emotion) {
      this.applyThemeAndEmotionColors();
    }
  }

  setVisemeFrame(frame: VisemeFrame): void {
    this.viseme = frame;
  }

  setPointerNormalized(nx: number, ny: number): void {
    this.targetGazeX = Math.max(-1, Math.min(1, nx));
    this.targetGazeY = Math.max(-1, Math.min(1, ny));
  }

  async loadVrmFile(buffer: ArrayBuffer, fileName: string): Promise<void> {
    await this.vrmAvatar.loadFromArrayBuffer(buffer, fileName);
    this.particleFace.setMorphTargets(this.vrmAvatar.sampleSurfacePoints(this.particleFace.count));
    this.morphTarget = 1;
    this.state.form = 'humanoid-3d';
  }

  resetBuiltInHumanoid(): void {
    this.vrmAvatar.unload();
    this.particleFace.setMorphTargets(this.humanoidRig.sampleSurfacePoints(this.particleFace.count));
  }

  resize(): void {
    if (this.disposed) return;
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
    this.particleFace.uniforms.uPixelRatio.value = Math.min(window.devicePixelRatio || 1, 2);
  }

  /**
   * Hit-test helper for transparent floating companion click-through:
   * returns true if pointer sits inside 雪儿's holographic core/avatar silhouette.
   */
  isPointInsideAvatarRadius(clientX: number, clientY: number): boolean {
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const nx = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ny = ((clientY - rect.top) / rect.height) * 2 - 1;
    const radius = this.state.quietDefer ? 0.52 : 0.66;
    return nx * nx + ny * ny <= radius * radius;
  }

  private applyThemeAndEmotionColors(): void {
    const { primary, secondary, accent } = resolveThemeColors(this.state.theme, this.state.emotion);
    this.particleFace.uniforms.uPrimaryColor.value.copy(primary);
    this.particleFace.uniforms.uSecondaryColor.value.copy(secondary);
    this.particleFace.uniforms.uAccentColor.value.copy(accent);
    this.humanoidRig.updateColors(primary, secondary, accent);
    this.rimLight.color.copy(secondary);
  }

  private loop = (nowMs: number): void => {
    if (this.disposed) return;
    this.rafId = requestAnimationFrame(this.loop);

    const deltaSec = Math.min(0.05, Math.max(0.001, (nowMs - this.lastFrameMs) / 1000));
    this.lastFrameMs = nowMs;

    const mod = EMOTION_MODULATIONS[this.state.emotion];
    this.elapsed += deltaSec * mod.breatheSpeed;

    // Smooth morph progress (~1.1s full particle disassemble & reassemble)
    const morphRate = 0.92;
    if (this.morphValue < this.morphTarget) {
      this.morphValue = Math.min(this.morphTarget, this.morphValue + deltaSec * morphRate);
    } else if (this.morphValue > this.morphTarget) {
      this.morphValue = Math.max(this.morphTarget, this.morphValue - deltaSec * morphRate);
    }

    // Smooth gaze, ear perk, smile, quiet mode interpolation
    const lerp = Math.min(1, deltaSec * 6.5);
    this.currentGazeX += (this.targetGazeX - this.currentGazeX) * lerp;
    this.currentGazeY += (this.targetGazeY - this.currentGazeY) * lerp;

    const listeningBoost = this.state.activity === 'listening' ? 0.25 : 0;
    const speakingBoost = this.state.activity === 'speaking' ? 0.12 : 0;
    const targetEar = Math.min(1, mod.earPerkTarget + listeningBoost + speakingBoost);
    this.currentEarPerk += (targetEar - this.currentEarPerk) * Math.min(1, deltaSec * 4.5);
    this.currentSmile += (mod.smileAmount - this.currentSmile) * Math.min(1, deltaSec * 4.0);
    this.currentQuiet += ((this.state.quietDefer ? 1 : 0) - this.currentQuiet) * Math.min(1, deltaSec * 3.0);

    // Organic blink scheduler (every 2.8–5.4 seconds)
    this.blinkTimer += deltaSec;
    let blink = 0;
    if (this.blinkTimer >= this.nextBlinkAt) {
      const phase = (this.blinkTimer - this.nextBlinkAt) / 0.16;
      if (phase >= 1) {
        this.blinkTimer = 0;
        this.nextBlinkAt = 2.8 + (Math.sin(nowMs * 0.0013) * 0.5 + 0.5) * 2.6;
      } else {
        blink = Math.sin(phase * Math.PI);
      }
    }

    // Update particle shader uniforms
    const pu = this.particleFace.uniforms;
    pu.uTime.value = this.elapsed;
    pu.uMorph.value = this.morphValue;
    pu.uAudioRms.value = this.viseme.rms;
    pu.uLowBand.value = this.viseme.lowBand;
    pu.uMidBand.value = this.viseme.midBand;
    pu.uHighBand.value = this.viseme.highBand;
    pu.uMouthOpen.value = Math.min(
      1,
      this.viseme.vowels.aa * 1.1 + this.viseme.vowels.oh * 0.8 + this.viseme.rms * 0.65,
    );
    pu.uMouthWide.value = Math.max(
      0,
      Math.min(1, 0.45 + this.viseme.vowels.ee * 0.5 + this.viseme.vowels.ih * 0.35 - this.viseme.vowels.ou * 0.4),
    );
    pu.uBlink.value = blink;
    pu.uSmile.value = this.currentSmile;
    pu.uEarPerk.value = this.currentEarPerk;
    pu.uGaze.value.set(this.currentGazeX, this.currentGazeY);
    pu.uQuietFactor.value = this.currentQuiet;
    pu.uParticleGlow.value = this.state.particleGlow;
    pu.uScanlineDensity.value = this.state.scanlineDensity;

    // During morph, particles stay bright and fade gently into an ambient halo when Form B solidifies
    const particleAmbientInHumanoid = 0.24;
    const solidReveal = Math.max(0, (this.morphValue - 0.55) / 0.45);
    pu.uOpacity.value = 0.96 * (1.0 - solidReveal * (1.0 - particleAmbientInHumanoid));

    const dissolve = 1.0 - solidReveal;
    const usingVrm = this.vrmAvatar.isLoaded;

    this.humanoidRig.root.visible = !usingVrm && solidReveal > 0.02;
    if (!usingVrm && solidReveal > 0.02) {
      this.humanoidRig.update({
        time: this.elapsed,
        viseme: this.viseme,
        gazeX: this.currentGazeX,
        gazeY: this.currentGazeY,
        blink,
        earPerk: this.currentEarPerk,
        smile: this.currentSmile,
        hologramIntensity: this.state.hologramIntensity,
        scanlineDensity: this.state.scanlineDensity,
        dissolve,
        quietFactor: this.currentQuiet,
      });
    }

    this.vrmAvatar.root.visible = usingVrm && solidReveal > 0.02;
    if (usingVrm) {
      this.vrmAvatar.update({
        deltaSec,
        time: this.elapsed,
        viseme: this.viseme,
        emotion: this.state.emotion,
        gazeX: this.currentGazeX,
        gazeY: this.currentGazeY,
        blink,
        dissolve,
      });
    }

    this.renderer.render(this.scene, this.camera);
  };

  dispose(): void {
    this.disposed = true;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.particleFace.dispose();
    this.humanoidRig.dispose();
    this.vrmAvatar.dispose();
    this.renderer.dispose();
    if (this.renderer.domElement.parentNode === this.container) {
      this.container.removeChild(this.renderer.domElement);
    }
  }
}
