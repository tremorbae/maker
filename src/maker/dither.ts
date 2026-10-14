import { applyLuminancePreprocess } from '../vendor/dithering-studio/utils/preprocess';
import type { MakerOptions, RGB } from './pipeline';

/** Recursive 16×16 Bayer matrix, as in Dithering Studio's bayer.ts (Apache-2.0). */
function buildBayer(n: number): number[] {
  let m = [0];
  let size = 1;
  while (size < n) {
    const next = new Array<number>(size * 2 * size * 2);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const v = m[y * size + x];
        next[y * size * 2 + x] = 4 * v;
        next[y * size * 2 + (x + size)] = 4 * v + 2;
        next[(y + size) * size * 2 + x] = 4 * v + 3;
        next[(y + size) * size * 2 + (x + size)] = 4 * v + 1;
      }
    }
    m = next;
    size *= 2;
  }
  return m;
}

const BAYER_SIZE = 16;
const BAYER_MASK = BAYER_SIZE - 1;
const BAYER = buildBayer(BAYER_SIZE);

const luma = ([r, g, b]: RGB) => 0.299 * r + 0.587 * g + 0.114 * b;
const packRgba = ([r, g, b]: RGB) => ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;

/**
 * The Maker's dither: alpha onto white, Rec.601 luma, contrast, then Bayer 16×16. Two colors map light/dark to the
 * brand pair (pure 0/255 bypass the threshold); larger palettes are sorted by luma and used as a tone ramp.
 *
 * Same arithmetic, in the same order, as the original site's ditherImageData + Dithering Studio's runBayerGeneric
 * (Apache-2.0), so output is bit-identical (checked against all 34 goldens). It precomputes the Bayer thresholds and
 * reuses buffers, so it's fast enough to run per video frame.
 */
export class Ditherer {
  private gray = new Uint8ClampedArray(0);
  private output: ImageData | null = null;
  private readonly scratch = new Uint8ClampedArray(1);

  dither(source: ImageData, options: MakerOptions, palette: RGB[]): ImageData {
    const { width, height } = source;
    const length = width * height * 4;
    if (this.gray.length !== length) this.gray = new Uint8ClampedArray(length);
    if (!this.output || this.output.width !== width || this.output.height !== height) this.output = new ImageData(width, height);
    const gray = this.gray;
    const src = source.data;
    const scratch = this.scratch;

    // Alpha onto white, then Rec.601 luma, each stored through a Uint8ClampedArray exactly like the original.
    for (let i = 0; i < length; i += 4) {
      let r = src[i];
      let g = src[i + 1];
      let b = src[i + 2];
      const a = src[i + 3];
      if (a !== 255) {
        const alpha = a / 255;
        scratch[0] = r * alpha + 255 * (1 - alpha);
        r = scratch[0];
        scratch[0] = g * alpha + 255 * (1 - alpha);
        g = scratch[0];
        scratch[0] = b * alpha + 255 * (1 - alpha);
        b = scratch[0];
      }
      const y = 0.299 * r + 0.587 * g + 0.114 * b;
      gray[i] = gray[i + 1] = gray[i + 2] = y;
      gray[i + 3] = 255;
    }
    applyLuminancePreprocess(gray, { contrast: options.contrast, midtones: 1, highlights: 0 });

    const out = new Uint32Array(this.output.data.buffer);
    const threshold = Number.isFinite(options.threshold) ? Math.max(0, Math.min(255, options.threshold)) : 128;
    const twoTone = palette.length <= 2;

    if (twoTone) {
      // Upstream grayscale Bayer: dark when gray < clamp(M · 255/256 + (threshold − 128)).
      const scale255 = 255 / (BAYER_SIZE * BAYER_SIZE);
      const thresholdOffset = threshold - 128;
      const cutoff = new Float64Array(BAYER.length);
      for (let k = 0; k < BAYER.length; k++) {
        const t = BAYER[k] * scale255 + thresholdOffset;
        cutoff[k] = t < 0 ? 0 : t > 255 ? 255 : t;
      }
      // The palette always starts with the brand pair: [dark, light].
      const dark = packRgba(palette[options.invert ? 1 : 0]);
      const light = packRgba(palette[options.invert ? 0 : 1]);
      for (let y = 0, p = 0; y < height; y++) {
        const row = (y & BAYER_MASK) * BAYER_SIZE;
        for (let x = 0; x < width; x++, p++) {
          const g = gray[p * 4];
          const isLight = g === 0 ? false : g === 255 ? true : !(g < cutoff[row + (x & BAYER_MASK)]);
          out[p] = isLight ? light : dark;
        }
      }
    } else {
      if (options.invert) {
        for (let i = 0; i < length; i += 4) gray[i] = 255 - gray[i];
      }
      // Upstream palette Bayer: index = round((g/255 + bias + (M/255 − 0.5)/n) · (n − 1)) over the luma-sorted palette.
      const sorted = [...palette].sort((a, b) => luma(a) - luma(b));
      const colors = sorted.map(packRgba);
      const n = sorted.length;
      const bias = ((threshold - 128) / 255) * 2;
      const cellTerm = new Float64Array(BAYER.length);
      for (let k = 0; k < BAYER.length; k++) cellTerm[k] = (BAYER[k] / (BAYER_SIZE * BAYER_SIZE - 1) - 0.5) / n;
      for (let y = 0, p = 0; y < height; y++) {
        const row = (y & BAYER_MASK) * BAYER_SIZE;
        for (let x = 0; x < width; x++, p++) {
          let index = Math.round((gray[p * 4] / 255 + bias + cellTerm[row + (x & BAYER_MASK)]) * (n - 1));
          if (index < 0) index = 0;
          else if (index >= n) index = n - 1;
          out[p] = colors[index];
        }
      }
    }
    return this.output;
  }
}
