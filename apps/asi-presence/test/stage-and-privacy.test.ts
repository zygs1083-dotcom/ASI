import { normalizeAvatarForm, PRESENCE_EMOTIONS, VISUAL_THEMES } from '@asi/presence-protocol';
import { describe, expect, it } from 'vitest';
import { PrivacyGate } from '../src/main/privacy-gate.ts';
import { createSnowPawTrayPngBuffer } from '../src/main/tray-icon.ts';
import { generateJarvisCoreCloud, UNIFIED_PARTICLE_COUNT } from '../src/renderer/stage/jarvis-core.ts';
import { resolveThemeColors } from '../src/renderer/stage/themes.ts';
import { deriveVisionOverlayStatus } from '../src/renderer/vision/vision-controller.ts';

describe('雪儿 Core, Tray Icon, Themes & Privacy Guardrails', () => {
  it('generates 42,000 finite deterministic neural core particles across all 5 shells', () => {
    const data = generateJarvisCoreCloud(UNIFIED_PARTICLE_COUNT);
    expect(data.count).toBe(UNIFIED_PARTICLE_COUNT);
    expect(data.positions.length).toBe(UNIFIED_PARTICLE_COUNT * 3);
    expect(data.colors.length).toBe(UNIFIED_PARTICLE_COUNT * 3);

    const regionCounts = new Map<number, number>();
    for (let i = 0; i < data.count; i += 1) {
      const r = data.regions[i] ?? -1;
      regionCounts.set(r, (regionCounts.get(r) ?? 0) + 1);
      expect(Number.isFinite(data.positions[i * 3])).toBe(true);
      expect(Number.isFinite(data.positions[i * 3 + 1])).toBe(true);
      expect(Number.isFinite(data.positions[i * 3 + 2])).toBe(true);
      expect(Number.isFinite(data.colors[i * 3])).toBe(true);
    }

    // All 5 J.A.R.V.I.S. neural regions (core, arcs, synapse clusters, inner volume, outer embers) must be populated
    for (const regionId of [0, 1, 2, 3, 4]) {
      expect(regionCounts.get(regionId) ?? 0).toBeGreaterThan(1500);
    }
  });

  it('produces a valid non-empty 36x36 @2x Retina RGBA PNG buffer for macOS Menu Bar tray template icon', () => {
    const png = createSnowPawTrayPngBuffer(36);
    // PNG magic signature
    expect(png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
    // IHDR chunk width/height = 36x36, bitDepth = 8, colorType = 6 (RGBA)
    expect(png.subarray(12, 16).toString('ascii')).toBe('IHDR');
    expect(png.readUInt32BE(16)).toBe(36);
    expect(png.readUInt32BE(20)).toBe(36);
    expect(png[24]).toBe(8);
    expect(png[25]).toBe(6);
    expect(png.byteLength).toBeGreaterThan(300);
  });

  it('normalizes legacy avatar forms seamlessly to the new jarvis-core / chibi / realistic trio', () => {
    expect(normalizeAvatarForm('particle-face')).toBe('jarvis-core');
    expect(normalizeAvatarForm('humanoid-3d')).toBe('chibi');
    expect(normalizeAvatarForm('jarvis-core')).toBe('jarvis-core');
    expect(normalizeAvatarForm('chibi')).toBe('chibi');
    expect(normalizeAvatarForm('realistic')).toBe('realistic');
    expect(normalizeAvatarForm('unknown-form', 'realistic')).toBe('realistic');
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

    let captureCalls = 0;
    const refused = await gate.captureScreenFrameInMemory({
      capturePrimaryPngBuffer: async () => {
        captureCalls += 1;
        return Buffer.from('fake-png');
      },
    });
    expect(refused).toBeNull();
    expect(captureCalls).toBe(0);

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
