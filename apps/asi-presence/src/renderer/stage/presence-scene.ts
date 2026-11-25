import {
  type AvatarForm,
  createSilentVisemeFrame,
  type PresenceActivity,
  type PresenceEmotion,
  type VisemeFrame,
  type VisualTheme,
} from '@asi/presence-protocol';
import * as THREE from 'three';
import {
  generateJarvisCoreCloud,
  JarvisNeuralCoreRig,
  type ParticleCloudData,
  UNIFIED_PARTICLE_COUNT,
} from './jarvis-core.ts';
import { LivingAvatarPlane } from './living-avatar-plane.ts';
import { EMOTION_MODULATIONS, resolveThemeColors } from './themes.ts';
import { UnifiedParticleField } from './unified-particle-field.ts';
import { VrmAvatarController } from './vrm-avatar.ts';

export interface SceneRenderState {
  form: AvatarForm;
  particleMode: boolean;
  theme: VisualTheme;
  emotion: PresenceEmotion;
  activity: PresenceActivity;
  workEnergy: number;
  hologramIntensity: number;
  scanlineDensity: number;
  particleGlow: number;
  quietDefer: boolean;
}

/**
 * Unified 60fps Three.js engine powering 雪儿's 3 visual forms + independent Particle Mode:
 * 1. `jarvis-core`: Avengers J.A.R.V.I.S. pure particle neural sphere + 32 3D neural arcs + dark cosmic halo.
 * 2. `chibi`:       Living Q版雪儿 (768x1120 zero-jitter blink/lip-sync/breath/ear+tail sway) ↔ 26k stratified particle sculpture.
 * 3. `realistic`:   Living 真人雪儿 (640x1200 zero-jitter blink/lip-sync/breath/ear+tail sway) ↔ 26k stratified particle sculpture.
 * Plus optional drag-and-drop `@pixiv/three-vrm` 3D avatar support with particle morph.
 */
export class PresenceSceneEngine {
  private readonly container: HTMLElement;
  private readonly role: 'floating' | 'stage';
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly jarvisRig: JarvisNeuralCoreRig;
  private readonly particleField: UnifiedParticleField;
  private readonly chibiAvatar: LivingAvatarPlane;
  private readonly realisticAvatar: LivingAvatarPlane;
  private readonly vrmAvatar: VrmAvatarController;
  private readonly keyLight: THREE.DirectionalLight;
  private readonly rimLight: THREE.PointLight;
  private readonly ambientLight: THREE.AmbientLight;

  private jarvisCloud: ParticleCloudData;
  private vrmCloud: ParticleCloudData | null = null;
  private activeCloudKey = 'jarvis-core';

  private state: SceneRenderState;
  private viseme: VisemeFrame = createSilentVisemeFrame();
  private entityDissolve: number; // 0 = crystal-clear living entity, 1 = pure dancing particles
  private hasSyncedInitialState = false;
  private targetGazeX = 0;
  private targetGazeY = 0;
  private currentGazeX = 0;
  private currentGazeY = 0;
  private currentEarPerk = 0.56;
  private currentQuiet = 0;
  private currentWorkEnergy = 0;
  private nextBlinkAt = 2.4;
  private blinkTimer = 0;
  private elapsed = 0;
  private lastFrameMs = 0;
  private rafId: number | null = null;
  private disposed = false;

  constructor(container: HTMLElement, role: 'floating' | 'stage') {
    this.container = container;
    this.role = role;
    this.scene = new THREE.Scene();

    this.state = {
      form: role === 'floating' ? 'jarvis-core' : 'chibi',
      particleMode: role === 'floating',
      theme: role === 'floating' ? 'jarvis-amber' : 'snow-cyan',
      emotion: 'calm',
      activity: 'idle',
      workEnergy: 0,
      hologramIntensity: 0.72,
      scanlineDensity: 0.48,
      particleGlow: 1.0,
      quietDefer: false,
    };
    this.entityDissolve = role === 'floating' ? 1 : 0;

    const width = Math.max(1, container.clientWidth);
    const height = Math.max(1, container.clientHeight);
    // Framed with generous margin above bottom HUD deck (Stage) and between status pill & dock (Floating)
    this.camera = new THREE.PerspectiveCamera(role === 'floating' ? 36 : 34, width / height, 0.1, 40);
    this.camera.position.set(0, role === 'floating' ? -0.1 : -0.11, role === 'floating' ? 4.05 : 4.25);

    this.renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(width, height);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);

    this.ambientLight = new THREE.AmbientLight('#e8f4ff', 0.9);
    this.keyLight = new THREE.DirectionalLight('#ffffff', 1.35);
    this.keyLight.position.set(1.8, 2.6, 3.2);
    this.rimLight = new THREE.PointLight('#5ce1ff', 2.4, 9);
    this.rimLight.position.set(-1.6, 1.4, -1.2);
    this.scene.add(this.ambientLight, this.keyLight, this.rimLight);

    const initColors = resolveThemeColors(this.state.theme, this.state.emotion);
    this.jarvisCloud = generateJarvisCoreCloud(UNIFIED_PARTICLE_COUNT, initColors);
    this.jarvisRig = new JarvisNeuralCoreRig();
    this.particleField = new UnifiedParticleField(UNIFIED_PARTICLE_COUNT);
    this.particleField.transitionTo(this.jarvisCloud, true, true);

    this.chibiAvatar = new LivingAvatarPlane('chibi', (cloud) => {
      if (this.state.form === 'chibi' && !this.vrmAvatar.isLoaded) {
        // Snap immediately when in entity mode or first hydration so zero stray vortex appears over solid artwork
        this.particleField.transitionTo(cloud, false, !this.state.particleMode);
        this.activeCloudKey = 'chibi';
      }
    });
    this.realisticAvatar = new LivingAvatarPlane('realistic', (cloud) => {
      if (this.state.form === 'realistic' && !this.vrmAvatar.isLoaded) {
        this.particleField.transitionTo(cloud, false, !this.state.particleMode);
        this.activeCloudKey = 'realistic';
      }
    });
    this.vrmAvatar = new VrmAvatarController();

    this.scene.add(this.jarvisRig.root);
    this.scene.add(this.chibiAvatar.root);
    this.scene.add(this.realisticAvatar.root);
    this.scene.add(this.vrmAvatar.root);
    this.scene.add(this.particleField.points);

    this.applyThemeAndEmotionColors();
    this.syncTargetCloud(true);

    this.lastFrameMs = performance.now();
    this.loop(this.lastFrameMs);
  }

  setState(patch: Partial<SceneRenderState>): void {
    const prevTheme = this.state.theme;
    const prevEmotion = this.state.emotion;
    const prevForm = this.state.form;
    const prevParticleMode = this.state.particleMode;

    this.state = { ...this.state, ...patch };
    const wantPureParticles = this.state.form === 'jarvis-core' || this.state.particleMode;

    if (prevTheme !== this.state.theme || prevEmotion !== this.state.emotion) {
      this.applyThemeAndEmotionColors();
    }

    if (!this.hasSyncedInitialState) {
      this.hasSyncedInitialState = true;
      this.entityDissolve = wantPureParticles ? 1 : 0;
      this.syncTargetCloud(true);
      return;
    }

    if (prevForm !== this.state.form || prevParticleMode !== this.state.particleMode) {
      // Only play dramatic 3D particle vortex when morphing INTO or BETWEEN active particle states;
      // switching straight to crisp Entity mode snaps cloud cleanly so no orange/snow haze lingers over 雪儿.
      const animateVortex = wantPureParticles && (prevForm === 'jarvis-core' || prevParticleMode);
      if (!wantPureParticles && prevForm !== this.state.form) {
        this.entityDissolve = 0;
      }
      this.syncTargetCloud(!animateVortex);
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
    const pts = this.vrmAvatar.sampleSurfacePoints(UNIFIED_PARTICLE_COUNT);
    const colors = new Float32Array(UNIFIED_PARTICLE_COUNT * 3);
    const sizes = new Float32Array(UNIFIED_PARTICLE_COUNT);
    const regions = new Float32Array(UNIFIED_PARTICLE_COUNT);
    const randoms = new Float32Array(UNIFIED_PARTICLE_COUNT * 3);
    const { primary, secondary } = resolveThemeColors(this.state.theme, this.state.emotion);
    const tmp = new THREE.Color();
    for (let i = 0; i < UNIFIED_PARTICLE_COUNT; i += 1) {
      const m = (i * 0.6180339) % 1;
      tmp.copy(secondary).lerp(primary, m);
      colors[i * 3] = tmp.r;
      colors[i * 3 + 1] = tmp.g;
      colors[i * 3 + 2] = tmp.b;
      sizes[i] = 2.0 + (i % 4) * 0.3;
      regions[i] = 0;
      randoms[i * 3] = m;
      randoms[i * 3 + 1] = (i * 0.381966) % 1;
      randoms[i * 3 + 2] = (i * 0.754877) % 1;
    }
    this.vrmCloud = { count: UNIFIED_PARTICLE_COUNT, positions: pts, colors, sizes, regions, randoms };
    this.syncTargetCloud(!this.state.particleMode);
  }

  resetBuiltInHumanoid(): void {
    this.vrmAvatar.unload();
    this.vrmCloud = null;
    this.syncTargetCloud(!this.state.particleMode);
  }

  resize(): void {
    if (this.disposed) return;
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
    this.particleField.uniforms.uPixelRatio.value = Math.min(window.devicePixelRatio || 1, 2);
  }

  /** Hit-test helper for transparent floating companion click-through. */
  isPointInsideAvatarRadius(clientX: number, clientY: number): boolean {
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const nx = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ny = ((clientY - rect.top) / rect.height) * 2 - 1;
    if (this.state.form === 'jarvis-core') {
      const radius = this.state.quietDefer ? 0.52 : 0.66;
      return nx * nx + ny * ny <= radius * radius;
    }
    return (nx * nx) / (0.62 * 0.62) + (ny * ny) / (0.84 * 0.84) <= 1.0;
  }

  private resolveTargetCloud(): { key: string; cloud: ParticleCloudData; isCore: boolean } {
    if (this.state.form === 'jarvis-core') {
      return { key: 'jarvis-core', cloud: this.jarvisCloud, isCore: true };
    }
    if (this.vrmAvatar.isLoaded && this.vrmCloud) {
      return { key: 'vrm', cloud: this.vrmCloud, isCore: false };
    }
    if (this.state.form === 'realistic') {
      const realCloud = this.realisticAvatar.getParticleCloud();
      if (realCloud) return { key: 'realistic', cloud: realCloud, isCore: false };
    }
    if (this.state.form === 'chibi') {
      const chibiCloud = this.chibiAvatar.getParticleCloud();
      if (chibiCloud) return { key: 'chibi', cloud: chibiCloud, isCore: false };
    }
    return { key: 'jarvis-core', cloud: this.jarvisCloud, isCore: true };
  }

  private syncTargetCloud(immediate: boolean): void {
    const next = this.resolveTargetCloud();
    if (next.key !== this.activeCloudKey || immediate) {
      this.activeCloudKey = next.key;
      this.particleField.transitionTo(next.cloud, next.isCore, immediate);
    }
  }

  private applyThemeAndEmotionColors(): void {
    const colors = resolveThemeColors(this.state.theme, this.state.emotion);
    this.jarvisCloud = generateJarvisCoreCloud(UNIFIED_PARTICLE_COUNT, colors);
    this.jarvisRig.updateColors(colors.primary, colors.secondary, colors.accent);
    this.chibiAvatar.updateColors(colors.secondary, colors.accent);
    this.realisticAvatar.updateColors(colors.secondary, colors.accent);
    this.particleField.uniforms.uPrimaryColor.value.copy(colors.primary);
    this.particleField.uniforms.uSecondaryColor.value.copy(colors.secondary);
    this.rimLight.color.copy(colors.secondary);

    if (this.activeCloudKey === 'jarvis-core') {
      this.particleField.recolorTarget(this.jarvisCloud);
    }
  }

  private loop = (nowMs: number): void => {
    if (this.disposed) return;
    this.rafId = requestAnimationFrame(this.loop);

    const rawDeltaSec = Math.max(0.001, (nowMs - this.lastFrameMs) / 1000);
    const deltaSec = Math.min(0.05, rawDeltaSec);
    // Allow transitions to settle cleanly in wall-clock time even on software WebGL (e.g. headless QA)
    const transitionDeltaSec = Math.min(0.35, rawDeltaSec);
    this.lastFrameMs = nowMs;

    const mod = EMOTION_MODULATIONS[this.state.emotion];
    this.elapsed += deltaSec * mod.breatheSpeed;

    // Derive combined work/conversation liveliness energy
    const activityEnergy =
      this.state.activity === 'thinking'
        ? 0.78
        : this.state.activity === 'delegating'
          ? 0.92
          : this.state.activity === 'listening'
            ? 0.44
            : this.state.activity === 'speaking'
              ? 0.52
              : 0.08;
    const targetWork = Math.max(activityEnergy, Math.min(1, this.state.workEnergy));
    this.currentWorkEnergy += (targetWork - this.currentWorkEnergy) * Math.min(1, deltaSec * 4.5);

    const isCore = this.state.form === 'jarvis-core';
    const wantPureParticles = isCore || this.state.particleMode;
    const targetDissolve = wantPureParticles ? 1 : 0;
    const dissolveRate = 2.6;
    if (this.entityDissolve < targetDissolve) {
      this.entityDissolve = Math.min(targetDissolve, this.entityDissolve + transitionDeltaSec * dissolveRate);
    } else if (this.entityDissolve > targetDissolve) {
      this.entityDissolve = Math.max(targetDissolve, this.entityDissolve - transitionDeltaSec * dissolveRate);
    }

    const morphProgress = this.particleField.stepMorph(transitionDeltaSec);
    const morphBurst = Math.sin(morphProgress * Math.PI);

    // Smooth gaze, ear perk, and quiet-mode interpolation
    const lerp = Math.min(1, deltaSec * 6.5);
    this.currentGazeX += (this.targetGazeX - this.currentGazeX) * lerp;
    this.currentGazeY += (this.targetGazeY - this.currentGazeY) * lerp;

    const listeningBoost = this.state.activity === 'listening' ? 0.28 : 0;
    const targetEar = Math.min(1, mod.earPerkTarget + listeningBoost);
    this.currentEarPerk += (targetEar - this.currentEarPerk) * lerp;

    const targetQuiet = this.state.quietDefer ? 1 : 0;
    this.currentQuiet += (targetQuiet - this.currentQuiet) * Math.min(1, deltaSec * 3.0);

    // Natural smooth blink (~every 2.6–5.2s)
    this.nextBlinkAt -= deltaSec;
    let blinkWeight = 0;
    if (this.nextBlinkAt <= 0) {
      this.blinkTimer += deltaSec;
      const blinkDur = 0.17;
      if (this.blinkTimer < blinkDur) {
        blinkWeight = Math.sin((this.blinkTimer / blinkDur) * Math.PI);
      } else {
        this.blinkTimer = 0;
        this.nextBlinkAt = 2.6 + (Math.sin(this.elapsed * 7.3) + 1) * 0.5 * 2.8;
      }
    }

    // Speech mouth envelope (TalkingHead viseme vowels + WebAudio RMS)
    const rawSpeechMouth = Math.min(
      1,
      this.viseme.vowels.aa * 0.95 +
        this.viseme.vowels.oh * 0.72 +
        this.viseme.vowels.ee * 0.55 +
        this.viseme.rms * 0.65,
    );
    const mouthOpen = this.viseme.speaking ? Math.min(1, Math.max(0.18, rawSpeechMouth * 1.25)) : 0;
    const tailWag =
      this.state.emotion === 'joyful' || this.state.emotion === 'affectionate'
        ? 0.92
        : this.viseme.speaking
          ? 0.65
          : this.state.activity === 'listening'
            ? 0.55
            : 0.22;

    // 1. Update J.A.R.V.I.S. neural arc web + radiant core (visible ONLY in jarvis-core)
    const coreVisibility = isCore ? 1 - morphBurst * 0.2 : 0;
    this.jarvisRig.update({
      elapsed: this.elapsed,
      deltaSec,
      visibility: coreVisibility,
      floatingRole: this.role === 'floating',
      audioRms: this.viseme.rms,
      workEnergy: this.currentWorkEnergy,
      quietFactor: this.currentQuiet,
      gazeX: this.currentGazeX,
      gazeY: this.currentGazeY,
      ringSpeed: mod.ringSpeed,
    });

    // 2. Update Unified 26k Particle Field (strictly invisible in crisp Entity mode!)
    const pu = this.particleField.uniforms;
    pu.uTime.value = this.elapsed;
    pu.uAudioRms.value = this.viseme.rms;
    pu.uLowBand.value = this.viseme.lowBand;
    pu.uMidBand.value = this.viseme.midBand;
    pu.uHighBand.value = this.viseme.highBand;
    pu.uWorkEnergy.value = this.currentWorkEnergy;
    pu.uQuietFactor.value = this.currentQuiet;
    pu.uParticleGlow.value = this.state.particleGlow;
    pu.uScanlineDensity.value = this.state.scanlineDensity;
    pu.uGaze.value.set(this.currentGazeX, this.currentGazeY);

    const particleOpacity = isCore
      ? 0.96
      : wantPureParticles
        ? Math.max(this.entityDissolve, morphBurst * 0.88)
        : this.entityDissolve;
    pu.uOpacity.value = particleOpacity;
    this.particleField.points.visible = particleOpacity > 0.02;

    // 3. Update Living 2.5D Portrait Planes (Q版雪儿 / 真人雪儿) & optional custom VRM
    const useVrm = !isCore && this.vrmAvatar.isLoaded;
    const showChibi = !isCore && !useVrm && this.state.form === 'chibi';
    const showRealistic = !isCore && !useVrm && this.state.form === 'realistic';
    // Crisp holographic scan-beam core beneath the 42k lattice particles so portrait Particle Mode stays ultra-clear
    const particleGhostVeil = wantPureParticles && !isCore ? 0.56 * this.entityDissolve : 0;

    this.chibiAvatar.update({
      elapsed: this.elapsed,
      visibility: showChibi ? 1.0 : 0,
      dissolve: showChibi ? this.entityDissolve : 1,
      ghostVeil: showChibi ? particleGhostVeil : 0,
      blink: blinkWeight,
      mouthOpen,
      earPerk: this.currentEarPerk,
      tailWag,
      audioRms: this.viseme.rms,
      workEnergy: this.currentWorkEnergy,
      gazeX: this.currentGazeX,
      gazeY: this.currentGazeY,
      quietFactor: this.currentQuiet,
    });

    this.realisticAvatar.update({
      elapsed: this.elapsed,
      visibility: showRealistic ? 1.0 : 0,
      dissolve: showRealistic ? this.entityDissolve : 1,
      ghostVeil: showRealistic ? particleGhostVeil : 0,
      blink: blinkWeight,
      mouthOpen,
      earPerk: this.currentEarPerk,
      tailWag,
      audioRms: this.viseme.rms,
      workEnergy: this.currentWorkEnergy,
      gazeX: this.currentGazeX,
      gazeY: this.currentGazeY,
      quietFactor: this.currentQuiet,
    });

    this.vrmAvatar.root.visible = useVrm && this.entityDissolve < 0.95;
    if (this.vrmAvatar.root.visible) {
      this.vrmAvatar.update({
        deltaSec,
        time: this.elapsed,
        viseme: this.viseme,
        blink: blinkWeight,
        gazeX: this.currentGazeX,
        gazeY: this.currentGazeY,
        emotion: this.state.emotion,
        dissolve: this.entityDissolve,
      });
    }

    this.renderer.render(this.scene, this.camera);
    this.container.dataset.form = this.state.form;
    this.container.dataset.particleMode = String(this.state.particleMode);
    this.container.dataset.dissolve = this.entityDissolve.toFixed(2);
    this.container.dataset.chibiLoaded = String(this.chibiAvatar.isLoaded);
    this.container.dataset.chibiVisible = String(this.chibiAvatar.root.visible);
    this.container.dataset.realisticLoaded = String(this.realisticAvatar.isLoaded);
  };

  dispose(): void {
    this.disposed = true;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.jarvisRig.dispose();
    this.particleField.dispose();
    this.chibiAvatar.dispose();
    this.realisticAvatar.dispose();
    this.vrmAvatar.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
