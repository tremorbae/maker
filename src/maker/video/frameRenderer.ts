import { Ditherer } from '../dither';
import { LogoPainter, NearestUpscaler, createCanvas, workingSize, type LogoCorner, type MakerOptions, type RGB } from '../pipeline';

export interface FrameLogo {
  image: HTMLImageElement;
  corner: LogoCorner;
  color: string;
}

/**
 * GPU nearest-neighbor upscale: draws the dithered frame scaled with smoothing off onto a GPU-backed canvas, which
 * the encoder can take without another CPU copy. GPU sampling picks the source pixel at each output pixel's center,
 * so roughly 1 in 8 block edges lands one output pixel off from NearestUpscaler. Fine for MP4 and live preview.
 */
class GpuUpscaler {
  private readonly small = document.createElement('canvas');
  private readonly smallContext = this.small.getContext('2d')!;
  private readonly target = document.createElement('canvas');
  private readonly targetContext = this.target.getContext('2d')!;

  upscale(source: ImageData, width: number, height: number): HTMLCanvasElement {
    if (this.small.width !== source.width || this.small.height !== source.height) {
      this.small.width = source.width;
      this.small.height = source.height;
    }
    this.smallContext.putImageData(source, 0, 0);
    if (this.target.width !== width || this.target.height !== height) {
      this.target.width = width;
      this.target.height = height;
    }
    this.targetContext.imageSmoothingEnabled = false;
    this.targetContext.drawImage(this.small, 0, 0, width, height);
    return this.target;
  }
}

/**
 * One video frame through the image pipeline: working-size draw → dither → upscale → logo.
 * `exact` upscales on the CPU exactly like image exports (used for GIF); otherwise the upscale and logo run on the
 * GPU, which is much faster for MP4 export and live playback.
 */
export class FrameRenderer {
  private readonly work = createCanvas(1, 1);
  private readonly ditherer = new Ditherer();
  private readonly upscaler: { upscale(source: ImageData, width: number, height: number): HTMLCanvasElement };
  private readonly logoPainter = new LogoPainter();

  constructor({ exact }: { exact: boolean }) {
    this.upscaler = exact ? new NearestUpscaler() : new GpuUpscaler();
  }

  render(
    draw: (context: CanvasRenderingContext2D, width: number, height: number) => void,
    sourceWidth: number,
    sourceHeight: number,
    options: MakerOptions,
    palette: RGB[],
    outputWidth: number,
    outputHeight: number,
    logo: FrameLogo | null,
  ): HTMLCanvasElement {
    const { width, height } = workingSize(sourceWidth, sourceHeight, options.workingResolution);
    const { canvas, context } = this.work;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    } else {
      context.clearRect(0, 0, width, height);
    }
    draw(context, width, height);
    const dithered = this.ditherer.dither(context.getImageData(0, 0, width, height), options, palette);
    const output = this.upscaler.upscale(dithered, outputWidth, outputHeight);
    if (logo) this.logoPainter.draw(output, logo.image, logo.corner, logo.color);
    return output;
  }
}
