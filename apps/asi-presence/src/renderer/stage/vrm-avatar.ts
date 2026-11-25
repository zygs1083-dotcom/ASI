import type { PresenceEmotion, VisemeFrame } from '@asi/presence-protocol';
import { type VRM, VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

/**
 * Loads user-supplied local `.vrm` avatars via `@pixiv/three-vrm` with automatic
 * VRM0/VRM1 framing, TalkingHead viseme expression mapping, blinking, gaze tracking,
 * breathing, holographic rim sheen, and surface point sampling for particle morphing.
 */
export class VrmAvatarController {
  readonly root = new THREE.Group();
  private vrm: VRM | null = null;
  private fileName: string | null = null;
  private readonly lookTarget = new THREE.Object3D();

  constructor() {
    this.lookTarget.position.set(0, 1.4, 2.5);
    this.root.add(this.lookTarget);
  }

  get loadedFileName(): string | null {
    return this.fileName;
  }

  get isLoaded(): boolean {
    return this.vrm !== null;
  }

  async loadFromArrayBuffer(buffer: ArrayBuffer, fileName: string): Promise<void> {
    this.unload();

    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));

    const gltf = await loader.parseAsync(buffer, '');
    const loadedVrm = (gltf.userData as { vrm?: VRM }).vrm;
    if (!loadedVrm) {
      throw new Error('该文件不是有效的 VRM 0.x / 1.0 模型');
    }

    VRMUtils.removeUnnecessaryVertices(gltf.scene);
    VRMUtils.combineSkeletons(gltf.scene);
    if (loadedVrm.meta?.metaVersion === '0') {
      VRMUtils.rotateVRM0(loadedVrm);
    }
    loadedVrm.scene.updateMatrixWorld(true);

    // Auto-frame VRM upper body cleanly into the stage center
    const box = new THREE.Box3().setFromObject(loadedVrm.scene);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);

    const scale = size.y > 0.01 ? 1.85 / size.y : 1.0;
    loadedVrm.scene.scale.setScalar(scale);
    loadedVrm.scene.position.set(-center.x * scale, -box.min.y * scale - 1.18, -center.z * scale);

    if (loadedVrm.lookAt) {
      loadedVrm.lookAt.target = this.lookTarget;
    }

    this.vrm = loadedVrm;
    this.fileName = fileName;
    this.root.add(loadedVrm.scene);
  }

  sampleSurfacePoints(count: number): Float32Array {
    const out = new Float32Array(count * 3);
    if (!this.vrm) return out;
    this.root.updateMatrixWorld(true);

    const verts: THREE.Vector3[] = [];
    const tmp = new THREE.Vector3();

    this.vrm.scene.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        const pos = obj.geometry.getAttribute('position');
        if (!pos) return;
        const step = Math.max(1, Math.floor(pos.count / 1200));
        for (let i = 0; i < pos.count; i += step) {
          tmp.fromBufferAttribute(pos, i).applyMatrix4(obj.matrixWorld);
          verts.push(tmp.clone());
        }
      }
    });

    if (verts.length === 0) return out;
    for (let i = 0; i < count; i += 1) {
      const p = verts[(i * 104729) % verts.length];
      if (!p) continue;
      out[i * 3] = p.x;
      out[i * 3 + 1] = p.y;
      out[i * 3 + 2] = p.z;
    }
    return out;
  }

  update(params: {
    deltaSec: number;
    time: number;
    viseme: VisemeFrame;
    emotion: PresenceEmotion;
    gazeX: number;
    gazeY: number;
    blink: number;
    dissolve: number;
  }): void {
    const vrm = this.vrm;
    if (!vrm) return;

    const { deltaSec, time, viseme, emotion, gazeX, gazeY, blink, dissolve } = params;
    vrm.scene.visible = dissolve < 0.72;

    this.lookTarget.position.set(gazeX * 1.4, 0.35 + gazeY * 0.9, 2.5);

    // Subtle organic breathing & head sway on humanoid bones
    const head = vrm.humanoid?.getNormalizedBoneNode('head');
    if (head) {
      head.rotation.y = gazeX * 0.28 + Math.sin(time * 0.7) * 0.03;
      head.rotation.x = -gazeY * 0.16 + Math.sin(time * 1.8) * 0.02 + viseme.rms * 0.05;
    }
    const chest = vrm.humanoid?.getNormalizedBoneNode('chest') ?? vrm.humanoid?.getNormalizedBoneNode('spine');
    if (chest) {
      chest.rotation.x = Math.sin(time * 1.9) * 0.025;
    }
    // Relax upper arms downward from default T-pose with subtle breathing sway
    const leftUpperArm = vrm.humanoid?.getNormalizedBoneNode('leftUpperArm');
    const rightUpperArm = vrm.humanoid?.getNormalizedBoneNode('rightUpperArm');
    const armBreath = Math.sin(time * 1.9) * 0.025;
    if (leftUpperArm) {
      leftUpperArm.rotation.z = 1.12 + armBreath;
      leftUpperArm.rotation.x = 0.08;
    }
    if (rightUpperArm) {
      rightUpperArm.rotation.z = -1.12 - armBreath;
      rightUpperArm.rotation.x = 0.08;
    }

    // VRM expression manager: TalkingHead 5-vowel lip-sync + blink + emotion
    const expr = vrm.expressionManager;
    if (expr) {
      expr.setValue('aa', viseme.vowels.aa);
      expr.setValue('ih', viseme.vowels.ih);
      expr.setValue('ou', viseme.vowels.ou);
      expr.setValue('ee', viseme.vowels.ee);
      expr.setValue('oh', viseme.vowels.oh);
      expr.setValue('blink', blink);
      expr.setValue('happy', emotion === 'joyful' ? 0.85 : emotion === 'affectionate' ? 0.65 : 0.12);
      expr.setValue('relaxed', emotion === 'calm' || emotion === 'tired' ? 0.55 : 0);
      expr.setValue('surprised', emotion === 'alert' ? 0.6 : 0);
      expr.setValue('sad', emotion === 'tired' ? 0.25 : 0);
    }

    vrm.update(Math.min(deltaSec, 0.1));
  }

  unload(): void {
    if (this.vrm) {
      this.root.remove(this.vrm.scene);
      VRMUtils.deepDispose(this.vrm.scene);
      this.vrm = null;
      this.fileName = null;
    }
  }

  dispose(): void {
    this.unload();
  }
}
