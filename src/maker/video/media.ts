import { createCanvas } from '../pipeline';

export const VIDEO_TYPES = ['video/mp4', 'video/quicktime', 'video/webm'];

export interface VideoInfo {
  width: number;
  height: number;
  duration: number;
  /** The first frame, used for the paused preview and as the color-sampling source. */
  poster: HTMLCanvasElement;
}

/** Copies the frame a <video> is currently showing into a canvas at its natural size. */
export function snapshotVideo(video: HTMLVideoElement) {
  const { canvas, context } = createCanvas(video.videoWidth, video.videoHeight);
  context.drawImage(video, 0, 0, video.videoWidth, video.videoHeight);
  return canvas;
}

/** Loads metadata and the first frame of a video URL. No length, size or resolution limits. */
export function probeVideo(url: string): Promise<VideoInfo> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    const fail = (message: string) => {
      video.removeAttribute('src');
      video.load();
      reject(new Error(message));
    };
    video.onerror = () => fail('This video could not be opened. Try an MP4 (H.264) file.');
    video.onloadeddata = () => {
      const { videoWidth: width, videoHeight: height, duration } = video;
      if (!width || !height) return fail('This video has no readable frames.');
      const poster = snapshotVideo(video);
      video.removeAttribute('src');
      video.load();
      resolve({ width, height, duration: Number.isFinite(duration) ? duration : 0, poster });
    };
    video.src = url;
  });
}

export function formatTime(seconds: number) {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
