import { createDefaultPrivacyState, type PrivacyState } from '@asi/presence-protocol';

export interface ScreenCaptureProvider {
  capturePrimaryPngBuffer(): Promise<Buffer | null>;
}

/**
 * Main-process hardware & sensor privacy gate.
 * Enforces:
 * - Screen vision and camera are strictly OFF by default.
 * - Physical kill switch immediately disables all capture channels.
 * - Captured frames live strictly in memory (never written to disk).
 */
export class PrivacyGate {
  private state: PrivacyState = createDefaultPrivacyState();
  private readonly listeners = new Set<(state: PrivacyState) => void>();

  getState(): PrivacyState {
    return {
      ...this.state,
      activeCapture: { ...this.state.activeCapture },
    };
  }

  subscribe(listener: (state: PrivacyState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    const snap = this.getState();
    for (const listener of this.listeners) {
      listener(snap);
    }
  }

  update(
    patch: Partial<Pick<PrivacyState, 'microphoneEnabled' | 'screenVisionEnabled' | 'cameraEnabled'>>,
  ): PrivacyState {
    if (this.state.physicalKillSwitch) {
      // Cannot re-enable sensors while physical kill switch is engaged
      return this.getState();
    }
    this.state = {
      ...this.state,
      ...(patch.microphoneEnabled !== undefined ? { microphoneEnabled: patch.microphoneEnabled } : {}),
      ...(patch.screenVisionEnabled !== undefined ? { screenVisionEnabled: patch.screenVisionEnabled } : {}),
      ...(patch.cameraEnabled !== undefined ? { cameraEnabled: patch.cameraEnabled } : {}),
      activeCapture: {
        mic: patch.microphoneEnabled !== undefined ? patch.microphoneEnabled : this.state.activeCapture.mic,
        screen: patch.screenVisionEnabled === false ? false : this.state.activeCapture.screen,
        camera: patch.cameraEnabled === false ? false : this.state.activeCapture.camera,
      },
    };
    this.emit();
    return this.getState();
  }

  setPhysicalKillSwitch(active: boolean): PrivacyState {
    if (active) {
      this.state = {
        microphoneEnabled: false,
        screenVisionEnabled: false,
        cameraEnabled: false,
        physicalKillSwitch: true,
        activeCapture: { mic: false, screen: false, camera: false },
      };
    } else {
      this.state = {
        ...this.state,
        physicalKillSwitch: false,
      };
    }
    this.emit();
    return this.getState();
  }

  canCaptureMic(): boolean {
    return !this.state.physicalKillSwitch && this.state.microphoneEnabled;
  }

  canCaptureScreen(): boolean {
    return !this.state.physicalKillSwitch && this.state.screenVisionEnabled;
  }

  canCaptureCamera(): boolean {
    return !this.state.physicalKillSwitch && this.state.cameraEnabled;
  }

  /**
   * M2 hook: captures a single in-memory PNG frame only when explicitly enabled
   * and kill switch is disengaged; returns base64 data URL and never writes to disk.
   */
  async captureScreenFrameInMemory(provider: ScreenCaptureProvider): Promise<string | null> {
    if (!this.canCaptureScreen()) {
      return null;
    }
    this.state = {
      ...this.state,
      activeCapture: { ...this.state.activeCapture, screen: true },
    };
    this.emit();
    try {
      const buf = await provider.capturePrimaryPngBuffer();
      if (!buf || buf.length === 0) return null;
      return `data:image/png;base64,${buf.toString('base64')}`;
    } finally {
      this.state = {
        ...this.state,
        activeCapture: { ...this.state.activeCapture, screen: false },
      };
      this.emit();
    }
  }
}
