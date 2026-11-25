import type { JevNormalizedBox, PrivacyState } from '@asi/presence-protocol';

export interface VisionOverlayStatus {
  screenVisionEnabled: boolean;
  cameraEnabled: boolean;
  physicalKillSwitch: boolean;
  breathingLedActive: boolean;
  activeFocusBox: JevNormalizedBox | null;
}

/**
 * Renderer-side vision status & privacy indicator model.
 * Keeps camera & screen strictly OFF by default; M2 attaches live frame capture
 * and Jev Box bounding-box rendering onto this state contract.
 */
export function deriveVisionOverlayStatus(
  privacy: PrivacyState,
  activeFocusBox: JevNormalizedBox | null = null,
): VisionOverlayStatus {
  const screenVisionEnabled = !privacy.physicalKillSwitch && privacy.screenVisionEnabled;
  const cameraEnabled = !privacy.physicalKillSwitch && privacy.cameraEnabled;
  return {
    screenVisionEnabled,
    cameraEnabled,
    physicalKillSwitch: privacy.physicalKillSwitch,
    breathingLedActive: screenVisionEnabled || cameraEnabled,
    activeFocusBox: screenVisionEnabled ? activeFocusBox : null,
  };
}
