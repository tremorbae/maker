import { GIFEncoder } from 'gifenc';
import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  Conversion,
  Input,
  Mp4OutputFormat,
  Output,
  StreamTarget,
  VideoSampleSink,
  canEncodeVideo,
  type Target,
  type VideoSample,
} from 'mediabunny';
import { createCanvas, hexToRgb, loadLogo, workingSize, type LogoSettings, type MakerOptions, type RGB } from '../pipeline';
import { ExportCanceledError, GIF_FPS, GIF_MAX_SECONDS, GIF_MAX_SIDE } from './constants';
import { FrameRenderer, type FrameLogo } from './frameRenderer';
import type { VideoInfo } from './media';

/**
 * H.264 bits per dither cell (one working-size pixel) per frame. Upscaling adds pixels but no detail, so the budget
 * follows the working size. Measured on the test clip: 1.5–2 bits/cell keeps ≥99.99% of pixels on their palette color.
 */
const MP4_BITS_PER_CELL = 2;
const MP4_MIN_BITRATE = 2e6;
const MP4_MAX_BITRATE = 60e6;

export interface VideoExportJob {
  file: File;
  options: MakerOptions;
  palette: RGB[];
  width: number;
  height: number;
  logo: LogoSettings;
  onProgress: (progress: number) => void;
  signal: AbortSignal;
}

export interface VideoExportResult {
  blob: Blob;
  audioDropped: boolean;
  /** True when the file was written to disk as it encoded (any length works) rather than held in memory. */
  streamed: boolean;
}

const EXPORT_FILE_PREFIX = 'maker-export-';

interface OutputSink {
  target: Target;
  streamed: boolean;
  /** Returns the finished file. */
  finish: () => Promise<Blob>;
  /** Best-effort removal of a partial file after a failure or cancel. */
  discard: () => Promise<void>;
}

/**
 * Where the MP4 is written. Prefers a file in the origin-private file system (OPFS), streamed as it encodes, so the
 * export never has to fit in memory: long videos work. The finished File is disk-backed and downloads like any
 * blob. Falls back to an in-memory buffer where OPFS writable streams aren't available.
 */
async function openOutputSink(extension: string): Promise<OutputSink> {
  const canStream =
    typeof navigator.storage?.getDirectory === 'function' &&
    typeof FileSystemFileHandle !== 'undefined' &&
    'createWritable' in FileSystemFileHandle.prototype;
  if (canStream) {
    try {
      const root = await navigator.storage.getDirectory();
      // Clear older exports, keeping the newest one in case its download is still being read.
      const previous: string[] = [];
      for await (const name of root.keys()) if (name.startsWith(EXPORT_FILE_PREFIX)) previous.push(name);
      for (const name of previous.sort().slice(0, -1)) await root.removeEntry(name).catch(() => undefined);
      const name = `${EXPORT_FILE_PREFIX}${Date.now()}.${extension}`;
      const handle = await root.getFileHandle(name, { create: true });
      const writable = await handle.createWritable();
      return {
        target: new StreamTarget(writable, { chunked: true }),
        streamed: true,
        finish: () => handle.getFile(),
        discard: async () => {
          await writable.abort().catch(() => undefined);
          await root.removeEntry(name).catch(() => undefined);
        },
      };
    } catch {
      // Fall through to memory.
    }
  }
  const target = new BufferTarget();
  return {
    target,
    streamed: false,
    finish: async () => {
      if (!target.buffer) throw new Error('The export failed. Please try again.');
      return new Blob([target.buffer]);
    },
    discard: async () => undefined,
  };
}

const even = (n: number) => Math.max(2, Math.round(n) - (Math.round(n) % 2));

const throwIfCanceled = (signal: AbortSignal) => {
  if (signal.aborted) throw new ExportCanceledError();
};

function videoCodecsAvailable() {
  return typeof VideoDecoder !== 'undefined' && typeof VideoEncoder !== 'undefined';
}

async function frameLogo(logo: LogoSettings): Promise<FrameLogo | null> {
  return logo.enabled ? { image: await loadLogo(logo.src), corner: logo.corner, color: logo.color } : null;
}

async function openVideoTrack(file: File) {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const track = await input.getPrimaryVideoTrack();
  if (!track || !(await track.canDecode())) {
    input.dispose();
    throw new Error('This video could not be decoded in this browser. Try an MP4 (H.264) file.');
  }
  return { input, track };
}

/** Size, duration and first frame via WebCodecs, for browsers whose <video> element won't produce a frame. */
export async function readFirstFrame(file: File): Promise<VideoInfo> {
  if (!videoCodecsAvailable()) throw new Error('This video could not be opened on this device. Try an MP4 (H.264) file.');
  const { input, track } = await openVideoTrack(file);
  try {
    const sample = await new VideoSampleSink(track).getSample(Math.max(0, await track.getFirstTimestamp()));
    if (!sample) throw new Error('This video has no readable frames.');
    const { canvas, context } = createCanvas(sample.displayWidth, sample.displayHeight);
    sample.draw(context, 0, 0, canvas.width, canvas.height);
    sample.close();
    return { width: canvas.width, height: canvas.height, duration: await input.computeDuration(), poster: canvas };
  } finally {
    input.dispose();
  }
}

const renderSample = (renderer: FrameRenderer, sample: VideoSample, job: VideoExportJob, width: number, height: number, logo: FrameLogo | null) =>
  renderer.render(
    (context, w, h) => sample.draw(context, 0, 0, w, h),
    sample.displayWidth,
    sample.displayHeight,
    job.options,
    job.palette,
    width,
    height,
    logo,
  );

/**
 * Runs decode → dither → H.264 encode (audio copied or converted to AAC) into `sink`. Returns whether audio was lost.
 * `onFrame` gets each rendered frame's end time.
 */
async function convertToMp4(
  input: Input,
  sink: OutputSink,
  job: VideoExportJob,
  width: number,
  height: number,
  bitrate: number,
  onFrame: (endTimestamp: number) => void,
) {
  const renderer = new FrameRenderer({ exact: false });
  const logo = await frameLogo(job.logo);
  // Streamed files put the index at the end (standard for camera files); in-memory ones can move it to the front.
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: sink.streamed ? false : 'in-memory' }), target: sink.target });
  const conversion = await Conversion.init({
    input,
    output,
    showWarnings: false,
    video: {
      codec: 'avc',
      bitrate,
      forceTranscode: true,
      allowTransformationMetadata: false,
      processedWidth: width,
      processedHeight: height,
      process: (sample) => {
        const frame = renderSample(renderer, sample, job, width, height, logo);
        onFrame(sample.timestamp + sample.duration);
        return frame;
      },
    },
    audio: { codec: 'aac' },
  });
  if (!conversion.isValid || conversion.discardedTracks.some((t) => t.track.type === 'video')) {
    throw new Error('This video could not be converted in this browser. Try an MP4 (H.264) file.');
  }
  const abort = () => void conversion.cancel();
  job.signal.addEventListener('abort', abort, { once: true });
  try {
    throwIfCanceled(job.signal);
    await conversion.execute();
  } catch (error) {
    if (job.signal.aborted) throw new ExportCanceledError();
    throw error;
  } finally {
    job.signal.removeEventListener('abort', abort);
  }
  return conversion.discardedTracks.some((t) => t.track.type === 'audio' && t.reason !== 'discarded_by_user');
}

export async function exportMp4(job: VideoExportJob): Promise<VideoExportResult> {
  if (!videoCodecsAvailable()) throw new Error('Video export needs a newer browser, like current Chrome, Edge, Safari, or Firefox.');
  const width = even(job.width);
  const height = even(job.height);
  const { input, track } = await openVideoTrack(job.file);
  try {
    throwIfCanceled(job.signal);
    const stats = await track.computePacketStats(120);
    const fps = stats.averagePacketRate > 0 ? Math.min(60, stats.averagePacketRate) : 30;
    const cells = workingSize(await track.getDisplayWidth(), await track.getDisplayHeight(), job.options.workingResolution);
    const bitsPerSecond = cells.width * cells.height * fps * MP4_BITS_PER_CELL;
    const bitrate = Math.round(Math.min(MP4_MAX_BITRATE, Math.max(MP4_MIN_BITRATE, bitsPerSecond)));
    if (!(await canEncodeVideo('avc', { width, height, bitrate }))) {
      throw new Error('This browser can’t encode MP4 at this size. Try Working size.');
    }
    // Progress follows the video frames. mediabunny's own progress is the slowest track's, which sits at 0% for the
    // whole export when the audio track is empty or ends early (common in screen recordings and edited clips).
    const start = Math.max(0, await track.getFirstTimestamp());
    const span = Math.max(1e-6, (await track.computeDuration()) - start);
    const onFrame = (end: number) => job.onProgress(Math.min(1, Math.max(0, (end - start) / span)));
    const sink = await openOutputSink('mp4');
    try {
      const audioDropped = await convertToMp4(input, sink, job, width, height, bitrate, onFrame);
      return { blob: await sink.finish(), audioDropped, streamed: sink.streamed };
    } catch (error) {
      await sink.discard();
      throw error;
    }
  } finally {
    input.dispose();
  }
}

/**
 * GIF color table: the dither palette exactly, plus (with a logo) the logo color and 15 blend steps from each
 * palette color toward it for the logo's anti-aliased edge. Dither pixels never get quantized.
 */
class GifIndexer {
  readonly palette: RGB[];
  private readonly exact = new Map<number, number>();
  private readonly nearest = new Map<number, number>();

  constructor(ditherPalette: RGB[], logoColor: RGB | null) {
    const colors: RGB[] = ditherPalette.map((c) => [...c] as RGB);
    if (logoColor) {
      colors.push(logoColor);
      for (const c of ditherPalette) {
        for (let k = 1; k < 16; k++) {
          colors.push([0, 1, 2].map((i) => Math.round(c[i] + ((logoColor[i] - c[i]) * k) / 16)) as RGB);
        }
      }
    }
    this.palette = [];
    for (const c of colors) {
      const key = (c[0] << 16) | (c[1] << 8) | c[2];
      if (!this.exact.has(key)) {
        this.exact.set(key, this.palette.length);
        this.palette.push(c);
      }
    }
  }

  index(rgba: Uint8ClampedArray, out: Uint8Array) {
    for (let p = 0, i = 0; i < rgba.length; p++, i += 4) {
      const key = (rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2];
      let index = this.exact.get(key) ?? this.nearest.get(key);
      if (index === undefined) {
        let best = 0;
        let bestDist = Infinity;
        this.palette.forEach((c, j) => {
          const d = (c[0] - rgba[i]) ** 2 + (c[1] - rgba[i + 1]) ** 2 + (c[2] - rgba[i + 2]) ** 2;
          if (d < bestDist) {
            bestDist = d;
            best = j;
          }
        });
        this.nearest.set(key, best);
        index = best;
      }
      out[p] = index;
    }
  }
}

/** GIF output size: the requested size, capped at GIF_MAX_SIDE on the long side. */
function gifSize(width: number, height: number) {
  const scale = Math.min(1, GIF_MAX_SIDE / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export async function exportGif(job: VideoExportJob): Promise<VideoExportResult> {
  if (!videoCodecsAvailable()) throw new Error('Video export needs a newer browser, like current Chrome, Edge, Safari, or Firefox.');
  const { width, height } = gifSize(job.width, job.height);
  const { input, track } = await openVideoTrack(job.file);
  try {
    throwIfCanceled(job.signal);
    const start = Math.max(0, await track.getFirstTimestamp());
    const end = await track.computeDuration();
    if (end - start > GIF_MAX_SECONDS + 0.05) {
      throw new Error(`GIFs are limited to ${GIF_MAX_SECONDS} seconds. Choose MP4 for longer videos.`);
    }
    const frameCount = Math.max(1, Math.round((end - start) * GIF_FPS));
    const timestamps = Array.from({ length: frameCount }, (_, i) => start + i / GIF_FPS);
    // Delay of frame i in centiseconds, rounded on the cumulative clock so the total length stays exact.
    const delayCs = (i: number) => Math.round(((i + 1) * 100) / GIF_FPS) - Math.round((i * 100) / GIF_FPS);

    const renderer = new FrameRenderer({ exact: true });
    const logo = await frameLogo(job.logo);
    const indexer = new GifIndexer(job.palette, logo ? hexToRgb(logo.color) : null);
    const gif = GIFEncoder();
    const indices = new Uint8Array(width * height);
    let pending: { index: Uint8Array; delay: number } | null = null;
    let written = 0;
    const flush = () => {
      if (!pending) return;
      gif.writeFrame(pending.index, width, height, {
        palette: written === 0 ? indexer.palette : undefined,
        delay: pending.delay * 10,
        repeat: 0,
      });
      written++;
    };

    const sink = new VideoSampleSink(track);
    let i = 0;
    for await (const sample of sink.samplesAtTimestamps(timestamps)) {
      if (job.signal.aborted) {
        sample?.close();
        throwIfCanceled(job.signal);
      }
      if (!sample) {
        // No frame for this slot: hold the previous frame longer.
        if (pending) pending.delay += delayCs(i);
      } else {
        const canvas = renderSample(renderer, sample, job, width, height, logo);
        sample.close();
        const rgba = canvas.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, width, height).data;
        indexer.index(rgba, indices);
        flush();
        pending = { index: indices.slice(), delay: delayCs(i) };
      }
      i++;
      job.onProgress(i / frameCount);
      // Let the UI paint progress between frames.
      if (i % 4 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    }
    flush();
    if (!written) throw new Error('This video could not be decoded in this browser. Try an MP4 (H.264) file.');
    gif.finish();
    return { blob: new Blob([gif.bytes()], { type: 'image/gif' }), audioDropped: false, streamed: false };
  } finally {
    input.dispose();
  }
}
