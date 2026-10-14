import { Ditherer } from './dither';

export type RGB = [number, number, number];

export interface MakerOptions {
  workingResolution: number;
  threshold: number;
  contrast: number;
  invert: boolean;
  additionalColors: number;
  customColors: RGB[] | null;
}

export type LogoCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

export interface LogoSettings {
  enabled: boolean;
  src: string;
  corner: LogoCorner;
  color: string;
}

/** Fixed brand palette: index 0 is the dark color, index 1 the light color. */
export const BRAND_PALETTE: RGB[] = [
  [0, 31, 233],
  [227, 253, 230],
];

export const DEFAULT_OPTIONS: MakerOptions = {
  workingResolution: 512,
  threshold: 128,
  contrast: 0,
  invert: false,
  additionalColors: 0,
  customColors: null,
};

const distanceSq = (a: RGB, b: RGB) => a.reduce((sum, v, i) => sum + (v - b[i]) ** 2, 0);
const colorKey = (c: RGB) => c.join(',');
const BRAND_KEYS = new Set(BRAND_PALETTE.map(colorKey));
const clampOption = (value: number, fallback: number, min: number, max: number) =>
  Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;

export const toHex = (rgb: RGB) => `#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
export const hexToRgb = (hex: string): RGB => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as RGB;

/**
 * Picks up to `count` (max 6) representative colors from raw RGBA pixels. Transparent pixels and exact brand
 * colors are skipped; colors are bucketed at 4 bits per channel and chosen greedily by
 * sqrt(bucketCount) * sqrt(minSquaredDistanceToChosen + 1), starting from the brand colors.
 */
function extractColors(data: Uint8ClampedArray, count: number): RGB[] {
  const n = Math.floor(clampOption(count, 0, 0, 6));
  if (!n) return [];
  const buckets = new Map<number, { count: number; colors: Map<number, number> }>();
  for (let i = 0; i + 3 < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    if (BRAND_KEYS.has(`${r},${g},${b}`)) continue;
    const rgb = (r << 16) | (g << 8) | b;
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const bucket = buckets.get(key) ?? { count: 0, colors: new Map<number, number>() };
    bucket.count++;
    bucket.colors.set(rgb, (bucket.colors.get(rgb) ?? 0) + 1);
    buckets.set(key, bucket);
  }
  const candidates = Array.from(buckets.values(), (bucket) => {
    let best = 0;
    let bestCount = 0;
    for (const [rgb, c] of bucket.colors) {
      if (c > bestCount) {
        best = rgb;
        bestCount = c;
      }
    }
    return { color: [(best >> 16) & 255, (best >> 8) & 255, best & 255] as RGB, count: bucket.count };
  });
  const picked: RGB[] = [];
  while (picked.length < n && candidates.length) {
    let bestIndex = 0;
    let bestScore = -1;
    candidates.forEach((candidate, index) => {
      const minDist = Math.min(...[...BRAND_PALETTE, ...picked].map((c) => distanceSq(c, candidate.color)));
      const score = Math.sqrt(candidate.count) * Math.sqrt(minDist + 1);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    });
    picked.push(candidates.splice(bestIndex, 1)[0].color);
  }
  return picked;
}

/** RGB byte triples only, no brand colors, no duplicates, at most 6. */
function sanitizeCustomColors(colors: unknown[]): RGB[] {
  const seen = new Set(BRAND_KEYS);
  const out: RGB[] = [];
  for (const c of colors) {
    if (!Array.isArray(c) || c.length !== 3 || !c.every((v) => Number.isInteger(v) && v >= 0 && v <= 255)) continue;
    const key = colorKey(c as RGB);
    if (!seen.has(key)) {
      seen.add(key);
      out.push([...c] as RGB);
      if (out.length === 6) break;
    }
  }
  return out;
}

function buildPalette(data: Uint8ClampedArray, additionalColors = 0, customColors?: RGB[] | null): RGB[] {
  const n = Math.floor(clampOption(additionalColors, 0, 0, 6));
  const extras = n ? (customColors == null ? extractColors(data, n) : sanitizeCustomColors(customColors)) : [];
  return [...BRAND_PALETTE.map((c) => [...c] as RGB), ...extras];
}

/** Every pipeline canvas is CPU-backed (willReadFrequently); it changes drawImage resampling, so keep it. */
export function createCanvas(width: number, height: number) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Your browser could not create an image canvas.');
  return { canvas, context };
}

export type PixelSource = HTMLImageElement | HTMLCanvasElement;

const sourceSize = (source: PixelSource) =>
  source instanceof HTMLImageElement
    ? { width: source.naturalWidth || source.width, height: source.naturalHeight || source.height }
    : { width: source.width, height: source.height };

const sampledColorCache = new WeakMap<PixelSource, RGB[]>();

/** The 6 colors offered for an image: nearest-neighbor copy at most 512px on the long side, cached per source. */
export function sampleImageColors(source: PixelSource): RGB[] {
  let colors = sampledColorCache.get(source);
  if (!colors) {
    const { width: w0, height: h0 } = sourceSize(source);
    if (!w0 || !h0) throw new Error('The image has no readable pixels.');
    const scale = Math.min(1, 512 / Math.max(w0, h0));
    const w = Math.max(1, Math.round(w0 * scale));
    const h = Math.max(1, Math.round(h0 * scale));
    const { context } = createCanvas(w, h);
    context.imageSmoothingEnabled = false;
    context.drawImage(source, 0, 0, w, h);
    colors = extractColors(context.getImageData(0, 0, w, h).data, 6);
    sampledColorCache.set(source, colors);
  }
  return colors.map((c) => [...c] as RGB);
}

/** Working-size dimensions: long side = min(natural, Detail); never upscales. */
export function workingSize(width: number, height: number, workingResolution: number) {
  const scale = Math.min(1, clampOption(workingResolution, 512, 16, 2048) / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** The palette a render will use: brand pair plus custom colors, or the first N sampled colors. */
export function paletteFor(source: PixelSource, options: Partial<MakerOptions> = {}): RGB[] {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const n = Math.floor(clampOption(opts.additionalColors, 0, 0, 6));
  const extras = opts.customColors ?? (n ? sampleImageColors(source).slice(0, n) : []);
  return buildPalette(new Uint8ClampedArray(), n, extras);
}

/**
 * Full render at working size. The resize is a plain drawImage on a CPU canvas with default smoothing.
 * `colorSource` is where extra colors are sampled from (a video's first frame, so colors stay stable).
 */
export async function renderDithered(image: PixelSource, options: Partial<MakerOptions> = {}, colorSource: PixelSource = image) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const { width: w0, height: h0 } = sourceSize(image);
  if (!w0 || !h0) throw new Error('The image has no readable pixels.');
  const { width: w, height: h } = workingSize(w0, h0, opts.workingResolution);
  const { canvas, context } = createCanvas(w, h);
  const palette = paletteFor(colorSource, opts);
  context.drawImage(image, 0, 0, w, h);
  context.putImageData(new Ditherer().dither(context.getImageData(0, 0, w, h), opts, palette), 0, 0);
  return { canvas, palette };
}

/** Logo box: margin 4.5% of the short side; width = min(26% of W, 12% of H × aspect, W − 2·margin). */
export function logoRect(width: number, height: number, aspect: number, corner: LogoCorner) {
  if (![width, height, aspect].every((v) => Number.isFinite(v) && v > 0)) {
    throw new Error('Logo placement requires positive image and logo dimensions.');
  }
  const margin = Math.min(width, height) * 0.045;
  const logoWidth = Math.min(width * 0.26, height * 0.12 * aspect, width - margin * 2);
  const logoHeight = logoWidth / aspect;
  return {
    x: corner.endsWith('right') ? width - margin - logoWidth : margin,
    y: corner.startsWith('bottom') ? height - margin - logoHeight : margin,
    width: logoWidth,
    height: logoHeight,
  };
}

export const loadImage = (url: string, errorMessage: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(errorMessage));
    img.src = url;
  });

const logoCache = new Map<string, Promise<HTMLImageElement>>();

export function loadLogo(src: string) {
  const cached = logoCache.get(src);
  if (cached) return cached;
  const promise = loadImage(src, 'The Derpetual logo could not be loaded. Please try again.');
  promise.catch(() => logoCache.delete(src));
  logoCache.set(src, promise);
  return promise;
}

/**
 * Nearest-neighbor upscale (floor(x · src/dst) sampling, as in Dithering Studio's upscaleCanvasNearestNeighbor) into a
 * reused CPU canvas. Duplicate rows are copied in one go.
 */
export class NearestUpscaler {
  private readonly target = createCanvas(1, 1);
  private output: ImageData | null = null;
  private columnMap: Uint32Array | null = null;
  private mapKey = '';

  upscale(source: ImageData, width: number, height: number): HTMLCanvasElement {
    const { canvas, context } = this.target;
    if (canvas.width !== width || canvas.height !== height || !this.output) {
      canvas.width = width;
      canvas.height = height;
      this.output = context.createImageData(width, height);
    }
    const key = `${source.width}:${width}`;
    if (this.mapKey !== key || !this.columnMap) {
      const scaleX = source.width / width;
      this.columnMap = new Uint32Array(width);
      for (let x = 0; x < width; x++) this.columnMap[x] = Math.floor(x * scaleX);
      this.mapKey = key;
    }
    const src = new Uint32Array(source.data.buffer, source.data.byteOffset, source.width * source.height);
    const dst = new Uint32Array(this.output.data.buffer);
    const map = this.columnMap;
    const scaleY = source.height / height;
    let previousRow = -1;
    for (let y = 0; y < height; y++) {
      const srcY = Math.floor(y * scaleY);
      const rowStart = y * width;
      if (srcY === previousRow) {
        dst.copyWithin(rowStart, rowStart - width, rowStart);
      } else {
        const srcStart = srcY * source.width;
        for (let x = 0; x < width; x++) dst[rowStart + x] = src[srcStart + map[x]];
        previousRow = srcY;
      }
    }
    context.putImageData(this.output, 0, 0);
    return canvas;
  }
}

/** Draws the logo tinted with a source-in fill at its placement for the canvas size, caching the tinted bitmap. */
export class LogoPainter {
  private tint: { canvas: HTMLCanvasElement; key: string } | null = null;

  draw(canvas: HTMLCanvasElement, logo: HTMLImageElement, corner: LogoCorner, color: string) {
    const rect = logoRect(canvas.width, canvas.height, (logo.naturalWidth || logo.width) / (logo.naturalHeight || logo.height), corner);
    const width = Math.max(1, Math.ceil(rect.width));
    const height = Math.max(1, Math.ceil(rect.height));
    const key = `${logo.src}|${width}x${height}|${color}`;
    if (this.tint?.key !== key) {
      const tint = createCanvas(width, height);
      tint.context.drawImage(logo, 0, 0, width, height);
      tint.context.globalCompositeOperation = 'source-in';
      tint.context.fillStyle = color;
      tint.context.fillRect(0, 0, width, height);
      this.tint = { canvas: tint.canvas, key };
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Your browser could not draw the Derpetual logo.');
    ctx.drawImage(this.tint.canvas, rect.x, rect.y, rect.width, rect.height);
  }
}

const logoPainter = new LogoPainter();

/** Nearest-neighbor upscale to the target size, then the logo, drawn crisp at full resolution. */
export async function composeExport(
  workingCanvas: HTMLCanvasElement,
  { width, height, logo }: { width?: number; height?: number; logo?: LogoSettings } = {},
) {
  const w = Math.max(1, Math.round(width ?? workingCanvas.width));
  const h = Math.max(1, Math.round(height ?? workingCanvas.height));
  const pixels = workingCanvas.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, workingCanvas.width, workingCanvas.height);
  const canvas = new NearestUpscaler().upscale(pixels, w, h);
  if (!logo?.enabled) return canvas;
  logoPainter.draw(canvas, await loadLogo(logo.src), logo.corner, logo.color);
  return canvas;
}
