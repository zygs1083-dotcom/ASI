export const PARTICLE_VERTEX_SHADER = /* glsl */ `
  attribute vec3 aTarget;
  attribute vec3 aRandom;
  attribute float aRegion;
  attribute float aSize;

  uniform float uTime;
  uniform float uMorph;
  uniform float uAudioRms;
  uniform float uLowBand;
  uniform float uMidBand;
  uniform float uHighBand;
  uniform float uMouthOpen;
  uniform float uMouthWide;
  uniform float uBlink;
  uniform float uSmile;
  uniform float uEarPerk;
  uniform vec2 uGaze;
  uniform float uQuietFactor;
  uniform float uPixelRatio;
  uniform float uParticleGlow;

  varying float vRegion;
  varying float vEnergy;
  varying float vMorphBurst;
  varying float vDepth;
  varying float vRand;

  mat2 rot2(float a) {
    float c = cos(a);
    float s = sin(a);
    return mat2(c, -s, s, c);
  }

  void main() {
    float burst = sin(uMorph * 3.14159265);
    float eased = uMorph * uMorph * (3.0 - 2.0 * uMorph);

    vec3 facePos = position;
    float breathe = sin(uTime * 1.9 + aRandom.x * 2.5) * 0.018;

    // Region 0: Sculpted virtual face contour
    if (aRegion < 0.5) {
      facePos.z += breathe + uAudioRms * 0.03 * cos(facePos.y * 5.0 + uTime * 6.0);
      facePos.xy += uGaze * 0.035;
    }
    // Region 1: Expressive luminous eyes (blink + gaze + warm crescent smile)
    else if (aRegion < 1.5) {
      float eyeCenterY = 0.14;
      float dy = facePos.y - eyeCenterY;
      float blinkScale = mix(1.0, 0.12, uBlink);
      facePos.y = eyeCenterY + dy * blinkScale;
      // Happy crescent curve when joyful/affectionate
      float dxEye = abs(facePos.x) - 0.23;
      facePos.y += uSmile * (0.025 - dxEye * dxEye * 0.8);
      facePos.xy += uGaze * 0.055;
      facePos.z += 0.01 + uAudioRms * 0.02;
    }
    // Region 2: Acoustic holographic mouth arc (60fps viseme + formant wave)
    else if (aRegion < 2.5) {
      float mouthCenterY = -0.22;
      float dy = facePos.y - mouthCenterY;
      float wave = sin(facePos.x * 22.0 + uTime * 16.0) * (uMidBand * 0.045 + uHighBand * 0.02);
      facePos.x *= mix(0.86, 1.18, uMouthWide);
      facePos.y = mouthCenterY + dy * (1.0 + uMouthOpen * 3.2) + wave + uSmile * (facePos.x * facePos.x * 0.35);
      facePos.z += uAudioRms * 0.08 + uLowBand * 0.04;
    }
    // Region 3: Snow-white holographic puppy-ear acoustic crests
    else if (aRegion < 3.5) {
      float side = sign(facePos.x);
      vec2 pivot = vec2(side * 0.34, 0.50);
      vec2 rel = facePos.xy - pivot;
      float perkAngle = side * ((0.55 - uEarPerk) * 0.38 - uAudioRms * 0.14);
      float twitch = sin(uTime * 2.6 + side * 1.4) * 0.035;
      rel = rot2(perkAngle + twitch) * rel;
      facePos.xy = pivot + rel;
      facePos.z += breathe * 1.4;
    }
    // Region 4: J.A.R.V.I.S. orbital telemetry rings
    else if (aRegion < 4.5) {
      float spin = uTime * (0.45 + aRandom.y * 0.35 + uAudioRms * 0.9);
      facePos.xz = rot2(spin) * facePos.xz;
      facePos.xy = rot2(spin * 0.32 * (aRandom.z - 0.5)) * facePos.xy;
      float radialPulse = 1.0 + uAudioRms * 0.16 + sin(uTime * 4.5 + aRandom.x * 6.28) * (0.02 + uHighBand * 0.08);
      facePos *= radialPulse;
    }
    // Region 5: Drifting ambient snowlight stardust
    else {
      float drift = uTime * (0.28 + aRandom.y * 0.25);
      facePos.y = mod(facePos.y + drift + 1.4, 2.8) - 1.4;
      facePos.x += sin(uTime * 0.9 + aRandom.x * 6.28) * 0.08;
      facePos.z += cos(uTime * 0.8 + aRandom.z * 6.28) * 0.08;
    }

    // Morph toward target 3D humanoid surface with luminous tangential vortex burst
    vec3 morphed = mix(facePos, aTarget, eased);
    float swirlAngle = burst * (2.6 + aRandom.y * 3.4) * (aRandom.z > 0.5 ? 1.0 : -1.0);
    vec3 offsetDir = normalize(vec3(
      cos(aRandom.x * 6.2831 + swirlAngle),
      (aRandom.y - 0.5) * 1.4,
      sin(aRandom.x * 6.2831 + swirlAngle)
    ));
    morphed += offsetDir * burst * (0.48 + aRandom.z * 0.65);

    // Subtle gentle scale-down in quiet ToM defer mode
    morphed *= mix(1.0, 0.84, uQuietFactor);

    vec4 mvPosition = modelViewMatrix * vec4(morphed, 1.0);
    gl_Position = projectionMatrix * mvPosition;

    float baseSize = aSize * uParticleGlow * (1.0 + burst * 0.65 + uAudioRms * 0.35);
    if (aRegion > 0.5 && aRegion < 2.5) {
      baseSize *= 1.18;
    }
    gl_PointSize = clamp(baseSize * uPixelRatio * (3.1 / max(0.8, -mvPosition.z)), 1.2, 18.0);

    vRegion = aRegion;
    vEnergy = clamp(uAudioRms * 1.5 + burst * 0.9, 0.0, 1.5);
    vMorphBurst = burst;
    vDepth = clamp((-mvPosition.z - 1.0) / 5.0, 0.0, 1.0);
    vRand = aRandom.x;
  }
`;

export const PARTICLE_FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uPrimaryColor;
  uniform vec3 uSecondaryColor;
  uniform vec3 uAccentColor;
  uniform float uTime;
  uniform float uOpacity;
  uniform float uScanlineDensity;

  varying float vRegion;
  varying float vEnergy;
  varying float vMorphBurst;
  varying float vDepth;
  varying float vRand;

  void main() {
    vec2 uv = gl_PointCoord - vec2(0.5);
    float dist = length(uv);
    if (dist > 0.5) discard;

    // Soft glowing holographic disc with crisp luminous core
    float core = smoothstep(0.5, 0.04, dist);
    float halo = pow(max(0.0, 1.0 - dist * 2.0), 2.1);

    vec3 color = mix(uSecondaryColor, uPrimaryColor, halo * 0.78);

    // Eyes & mouth glow bright snow-white/cyan; ears get pure snow-white rim shimmer
    if (vRegion > 0.5 && vRegion < 1.5) {
      color = mix(uPrimaryColor, vec3(1.0), 0.55);
    } else if (vRegion > 1.5 && vRegion < 2.5) {
      color = mix(uAccentColor, uPrimaryColor, 0.55 + vEnergy * 0.25);
    } else if (vRegion > 2.5 && vRegion < 3.5) {
      color = mix(uPrimaryColor, uSecondaryColor, 0.28);
    } else if (vRegion > 3.5 && vRegion < 4.5) {
      color = mix(uAccentColor, uSecondaryColor, 0.5);
    } else if (vRegion > 4.5) {
      color = mix(uPrimaryColor, uSecondaryColor, 0.4);
    }

    // Morph energy flash
    color = mix(color, vec3(1.0), vMorphBurst * 0.35);

    // Gentle holographic scanline flicker
    float scan = 0.88 + 0.12 * sin(gl_FragCoord.y * (0.2 + uScanlineDensity * 0.65) - uTime * 5.0 + vRand * 6.28);
    float alpha = (core * 0.65 + halo * 0.45) * scan * uOpacity * mix(1.0, 0.55, vDepth);
    if (vRegion > 4.5) {
      alpha *= 0.52;
    }

    gl_FragColor = vec4(color, clamp(alpha, 0.0, 1.0));
  }
`;

export const HOLOGRAM_SURFACE_VERTEX_SHADER = /* glsl */ `
  varying vec3 vNormalWorld;
  varying vec3 vViewDir;
  varying vec3 vWorldPos;
  varying vec3 vLocalPos;

  void main() {
    vLocalPos = position;
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldPos = worldPos.xyz;
    vNormalWorld = normalize(mat3(modelMatrix) * normal);
    vViewDir = normalize(cameraPosition - worldPos.xyz);
    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`;

export const HOLOGRAM_SURFACE_FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uBaseColor;
  uniform vec3 uRimColor;
  uniform vec3 uAccentColor;
  uniform float uTime;
  uniform float uHologramIntensity;
  uniform float uScanlineDensity;
  uniform float uAudioPulse;
  uniform float uDissolve;
  uniform float uBaseOpacity;

  varying vec3 vNormalWorld;
  varying vec3 vViewDir;
  varying vec3 vWorldPos;
  varying vec3 vLocalPos;

  void main() {
    // Smooth vertical/energy dissolve during particle morph transition
    float pattern = fract(sin(dot(vLocalPos.xy * 12.0, vec2(12.9898, 78.233))) * 43758.5453);
    float threshold = (vLocalPos.y + 1.5) * 0.32 + pattern * 0.24;
    if (uDissolve > 0.01 && threshold < uDissolve * 1.25) {
      discard;
    }
    float edgeBand = smoothstep(uDissolve * 1.25 + 0.09, uDissolve * 1.25, threshold) * step(0.01, uDissolve);

    vec3 N = normalize(vNormalWorld);
    vec3 V = normalize(vViewDir);
    float fresnel = pow(1.0 - max(dot(N, V), 0.0), 2.35);

    // Subtle soft key + rim studio illumination so the ceramic snow-white form looks sculptural
    vec3 lightDir = normalize(vec3(0.45, 0.8, 0.9));
    float diff = 0.52 + 0.48 * max(dot(N, lightDir), 0.0);

    float scanFreq = 24.0 + uScanlineDensity * 95.0;
    float scanline = 0.86 + 0.14 * sin(vWorldPos.y * scanFreq - uTime * 3.8);
    float holoWave = 0.5 + 0.5 * sin(vWorldPos.y * 5.0 - uTime * 2.2);

    vec3 litBase = uBaseColor * diff;
    vec3 holoTint = mix(uRimColor, uAccentColor, holoWave * 0.45);
    vec3 color = mix(litBase, litBase * 0.82 + holoTint * 0.45, uHologramIntensity * 0.55);
    color += holoTint * fresnel * (0.65 + uHologramIntensity * 1.15 + uAudioPulse * 0.5);
    color += vec3(0.92, 0.98, 1.0) * edgeBand * 1.4;
    color *= mix(1.0, scanline, uHologramIntensity * 0.72);

    float alpha = clamp(uBaseOpacity + fresnel * 0.35 + edgeBand * 0.5, 0.0, 1.0);
    gl_FragColor = vec4(color, alpha);
  }
`;
