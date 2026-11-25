import { PRESENCE_EMOTIONS, VISUAL_THEMES } from '@asi/presence-protocol';
import { describe, expect, it } from 'vitest';
import { PrivacyGate } from '../src/main/privacy-gate.ts';
import { resolveThemeColors } from '../src/renderer/stage/themes.ts';
import { XueerHumanoidRig } from '../src/renderer/stage/xueer-humanoid-rig.ts';
import { generateXueerParticleFaceData, XUEER_PARTICLE_COUNT } from '../src/renderer/stage/xueer-particle-face.ts';
import { deriveVisionOverlayStatus } from '../src/renderer/vision/vision-controller.ts';

describe('雪儿 3D Stage Geometry, Themes & Privacy Guardrails', () => {
  it('generates 12,000 finite deterministic particle points spanning face, eyes, mouth, snowy canine ears, rings, and snowlight', () => {
    const data = generateXueerParticleFaceData(XUEER_PARTICLE_COUNT);
    expect(data.count).toBe(XUEER_PARTICLE_COUNT);
    expect(data.positions.length).toBe(XUEER_PARTICLE_COUNT * 3);

    const regionCounts = new Map<number, number>();
    for (let i = 0; i < data.count; i += 1) {
      const r = data.regions[i] ?? -1;
      regionCounts.set(r, (regionCounts.get(r) ?? 0) + 1);
      expect(Number.isFinite(data.positions[i * 3])).toBe(true);
      expect(Number.isFinite(data.positions[i * 3 + 1])).toBe(true);
      expect(Number.isFinite(data.positions[i * 3 + 2])).toBe(true);
    }

    // All 6 anatomical/holographic particle regions must be populated
    for (const regionId of [0, 1, 2, 3, 4, 5]) {
      expect(regionCounts.get(regionId) ?? 0).toBeGreaterThan(500);
    }
  });

  it('samples finite morph target points from the built-in 3D 雪儿 cyber humanoid rig', () => {
    const rig = new XueerHumanoidRig();
    const pts = rig.sampleSurfacePoints(4096);
    expect(pts.length).toBe(4096 * 3);

    let nonZero = 0;
    for (let i = 0; i < pts.length; i += 1) {
      const v = pts[i] ?? 0;
      expect(Number.isFinite(v)).toBe(true);
      if (Math.abs(v) > 0.01) nonZero += 1;
    }
    expect(nonZero).toBeGreaterThan(pts.length * 0.7);
    rig.dispose();
  });

  it('resolves valid RGB colors across all themes and emotions', () => {
    for (const theme of VISUAL_THEMES) {
      for (const emotion of PRESENCE_EMOTIONS) {
        const { primary, secondary, accent } = resolveThemeColors(theme, emotion);
        expect(Number.isFinite(primary.r + primary.g + primary.b)).toBe(true);
        expect(Number.isFinite(secondary.r + secondary.g + secondary.b)).toBe(true);
        expect(Number.isFinite(accent.r + accent.g + accent.b)).toBe(true);
      }
    }
  });

  it('keeps screen vision & camera strictly OFF by default and enforces physical kill switch', async () => {
    const gate = new PrivacyGate();
    const initial = gate.getState();
    expect(initial.microphoneEnabled).toBe(false);
    expect(initial.screenVisionEnabled).toBe(false);
    expect(initial.cameraEnabled).toBe(false);
    expect(initial.physicalKillSwitch).toBe(false);

    // Screen capture refused while OFF
    let captureCalls = 0;
    const refused = await gate.captureScreenFrameInMemory({
      capturePrimaryPngBuffer: async () => {
        captureCalls += 1;
        return Buffer.from('fake-png');
      },
    });
    expect(refused).toBeNull();
    expect(captureCalls).toBe(0);

    // Explicitly toggle screen ON -> capture succeeds strictly in memory and resets activeCapture.screen
    gate.update({ screenVisionEnabled: true, microphoneEnabled: true });
    const captured = await gate.captureScreenFrameInMemory({
      capturePrimaryPngBuffer: async () => {
        captureCalls += 1;
        expect(gate.getState().activeCapture.screen).toBe(true);
        return Buffer.from('png-bytes');
      },
    });
    expect(captured).toBe(`data:image/png;base64,${Buffer.from('png-bytes').toString('base64')}`);
    expect(gate.getState().activeCapture.screen).toBe(false);

    // Engage physical kill switch -> immediately turns everything off and blocks re-enabling
    const killed = gate.setPhysicalKillSwitch(true);
    expect(killed.physicalKillSwitch).toBe(true);
    expect(killed.microphoneEnabled).toBe(false);
    expect(killed.screenVisionEnabled).toBe(false);
    expect(killed.cameraEnabled).toBe(false);

    gate.update({ screenVisionEnabled: true, microphoneEnabled: true, cameraEnabled: true });
    expect(gate.canCaptureMic()).toBe(false);
    expect(gate.canCaptureScreen()).toBe(false);
    expect(gate.canCaptureCamera()).toBe(false);

    const overlay = deriveVisionOverlayStatus(gate.getState(), { top: 0, left: 0, bottom: 1, right: 1 });
    expect(overlay.breathingLedActive).toBe(false);
    expect(overlay.activeFocusBox).toBeNull();
  });
});
