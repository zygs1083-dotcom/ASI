import { deflateSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c = (CRC_TABLE[(c ^ (buf[i] ?? 0)) & 0xff] ?? 0) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const combined = Buffer.concat([typeBuf, Buffer.from(data)]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(combined), 0);
  return Buffer.concat([lenBuf, combined, crcBuf]);
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/** Signed distance to a 2D capsule / line segment (negative inside). */
function sdSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const pax = px - ax;
  const pay = py - ay;
  const bax = bx - ax;
  const bay = by - ay;
  const h = clamp01((pax * bax + pay * bay) / (bax * bax + bay * bay));
  return Math.hypot(pax - bax * h, pay - bay * h);
}

/** Signed distance to a 2D triangle (negative inside). */
function sdTriangle(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
): number {
  const e0x = bx - ax;
  const e0y = by - ay;
  const e1x = cx - bx;
  const e1y = cy - by;
  const e2x = ax - cx;
  const e2y = ay - cy;

  const v0x = px - ax;
  const v0y = py - ay;
  const v1x = px - bx;
  const v1y = py - by;
  const v2x = px - cx;
  const v2y = py - cy;

  const t0 = clamp01((v0x * e0x + v0y * e0y) / (e0x * e0x + e0y * e0y));
  const t1 = clamp01((v1x * e1x + v1y * e1y) / (e1x * e1x + e1y * e1y));
  const t2 = clamp01((v2x * e2x + v2y * e2y) / (e2x * e2x + e2y * e2y));

  const pq0x = v0x - e0x * t0;
  const pq0y = v0y - e0y * t0;
  const pq1x = v1x - e1x * t1;
  const pq1y = v1y - e1y * t1;
  const pq2x = v2x - e2x * t2;
  const pq2y = v2y - e2y * t2;

  const s = Math.sign(e0x * e2y - e0y * e2x);
  const d0 = pq0x * pq0x + pq0y * pq0y;
  const s0 = s * (v0x * e0y - v0y * e0x);
  const d1 = pq1x * pq1x + pq1y * pq1y;
  const s1 = s * (v1x * e1y - v1y * e1x);
  const d2 = pq2x * pq2x + pq2y * pq2y;
  const s2 = s * (v2x * e2y - v2y * e2x);

  const minD = Math.min(d0, d1, d2);
  const minS = Math.min(s0, s1, s2);
  return -Math.sqrt(minD) * Math.sign(minS);
}

/**
 * Generates a crisp 36x36 (@2x Retina = 18x18pt) RGBA PNG template icon for macOS Menu Bar.
 * Uses pure solid black + pure transparent cutouts (no muddy mid-alpha fills) with soft
 * rounded snow-puppy ears and full cheeks so macOS Light/Dark menu bar tinting is razor-sharp.
 */
export function createSnowPawTrayPngBuffer(size = 36): Buffer {
  const rgba = new Uint8Array(size * size * 4);
  const aa = 0.72 / size;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      // Normalized coords in [-1, 1], y pointing down
      const nx = ((x + 0.5) / size) * 2 - 1;
      const ny = ((y + 0.5) / size) * 2 - 1;
      const ax = Math.abs(nx);

      // Soft rounded snow-puppy head with fuller cute cheeks & soft chin
      const headDx = nx / 0.72;
      const headDy = (ny - 0.19) / 0.56;
      const dHead = (Math.hypot(headDx, headDy) - 1.0) * 0.56;

      // Soft lower cheek puff for friendly puppy face (less pointed than a cat)
      const dCheek = Math.hypot((ax - 0.25) / 0.52, (ny - 0.34) / 0.36) * 0.36 - 0.34;
      const kCheek = 0.14;
      const hCheek = clamp01(0.5 + (0.5 * (dCheek - dHead)) / kCheek);
      const dFace = dCheek * (1 - hCheek) + dHead * hCheek - kCheek * hCheek * (1 - hCheek);

      // Twin upright rounded puppy ears (generous tip rounding radius so ears feel soft & fluffy)
      const dEarTri = sdTriangle(ax, ny, 0.22, -0.14, 0.64, -0.74, 0.65, -0.02) - 0.115;
      const dEarTip = sdSegment(ax, ny, 0.54, -0.58, 0.58, -0.22) - 0.175;
      const dEar = Math.min(dEarTri, dEarTip);

      // Smooth organic union of head and ears
      const k = 0.09;
      const h = clamp01(0.5 + (0.5 * (dEar - dFace)) / k);
      const dSilhouette = dEar * (1 - h) + dFace * h - k * h * (1 - h);

      let alpha = 1 - smoothstep(-aa, aa, dSilhouette);

      // Crisp 100%-transparent cutouts for bright expressive eyes & friendly puppy nose
      const dEye = Math.hypot(ax - 0.25, (ny - 0.14) * 1.08) - 0.108;
      const eyeCut = smoothstep(-aa, aa, dEye);

      const dNose = Math.hypot(nx / 1.32, ny - 0.35) - 0.072;
      const noseCut = smoothstep(-aa, aa, dNose);

      // Subtle clean transparent inner-ear droplet notch (pure 0-alpha cutout, zero muddy gray!)
      const dInnerEar = sdSegment(ax, ny, 0.48, -0.52, 0.52, -0.28) - 0.055;
      const earCut = smoothstep(-aa, aa, dInnerEar);

      alpha *= eyeCut * noseCut * earCut;

      const idx = (y * size + x) * 4;
      // Template image uses pure black with sharp anti-aliased alpha; macOS tints for light/dark bar
      rgba[idx] = 0;
      rgba[idx + 1] = 0;
      rgba[idx + 2] = 0;
      rgba[idx + 3] = Math.round(clamp01(alpha) * 255);
    }
  }

  // Encode valid RGBA PNG (signature + IHDR + IDAT + IEND)
  const stride = size * 4 + 1;
  const raw = new Uint8Array(stride * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * stride] = 0; // filter type None
    raw.set(rgba.subarray(y * size * 4, (y + 1) * size * 4), y * stride + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', new Uint8Array(0)),
  ]);
}
