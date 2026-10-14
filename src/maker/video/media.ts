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

/** Nothing drawable by now: the browser is likely skipping preload (phones do), so a muted play() forces loading. */
const PROBE_PLAY_AFTER_MS = 1500;
/** The <video> element gets this long to produce a first frame before the WebCodecs decoder takes over. */
const PROBE_TIMEOUT_MS = 8000;
/** Where requestVideoFrameCallback exists but never fires (e.g. a browser skipping frames for invisible video). */
const FRAME_CALLBACK_GRACE_MS = 400;

class ProbeTimeoutError extends Error {}

/**
 * Loads metadata and the first frame of a video. No length, size or resolution limits.
 *
 * Phones don't reliably load a paused off-screen video, and Safari can report a frame before it can be drawn, so
 * this waits for requestVideoFrameCallback where available, nudges the element with a seek and then a muted play,
 * and finally falls back to decoding the first frame with WebCodecs.
 */
export async function probeVideo(file: File, url: string): Promise<VideoInfo> {
  try {
    return await probeWithElement(url);
  } catch (err) {
    if (!(err instanceof ProbeTimeoutError)) throw err;
    const { readFirstFrame } = await import('./exportVideo');
    return readFirstFrame(file);
  }
}

function probeWithElement(url: string): Promise<VideoInfo> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    // In the page but invisible: some browsers don't decode frames for a detached video.
    video.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0;pointer-events:none';
    let settled = false;
    let graceTimer = 0;
    const timers = [
      window.setTimeout(() => {
        if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) video.play().catch(() => undefined);
      }, PROBE_PLAY_AFTER_MS),
      window.setTimeout(() => settle(() => reject(new ProbeTimeoutError())), PROBE_TIMEOUT_MS),
    ];
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      timers.forEach((timer) => window.clearTimeout(timer));
      window.clearTimeout(graceTimer);
      video.pause();
      video.removeAttribute('src');
      video.load();
      video.remove();
      finish();
    };
    const hasFrameCallback = 'requestVideoFrameCallback' in video;
    const onPresented = () => {
      if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) video.requestVideoFrameCallback(onPresented);
      else capture();
    };
    const capture = () => {
      if (settled || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
      // Reached through the muted play: stop and go back to the first frame, which the other paths capture.
      if (!video.paused) {
        video.pause();
        window.clearTimeout(graceTimer);
        graceTimer = 0;
        if (hasFrameCallback) video.requestVideoFrameCallback(onPresented);
        video.currentTime = 0;
        return;
      }
      const { videoWidth: width, videoHeight: height, duration } = video;
      if (!width || !height) return settle(() => reject(new Error('This video has no readable frames.')));
      const poster = snapshotVideo(video);
      settle(() => resolve({ width, height, duration: Number.isFinite(duration) ? duration : 0, poster }));
    };
    if (hasFrameCallback) video.requestVideoFrameCallback(onPresented);
    const onFrameEvent = () => {
      if (!hasFrameCallback) capture();
      else if (!graceTimer) graceTimer = window.setTimeout(capture, FRAME_CALLBACK_GRACE_MS);
    };
    video.onloadeddata = onFrameEvent;
    video.onseeked = onFrameEvent;
    video.onplaying = onFrameEvent;
    // Phones that stop at metadata decode the first frame once asked to seek to it.
    video.onloadedmetadata = () => {
      if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) video.currentTime = 0.001;
    };
    video.onerror = () => settle(() => reject(new Error('This video could not be opened. Try an MP4 (H.264) file.')));
    document.body.append(video);
    video.src = url;
  });
}

/**
 * Calls `onFrame` after each seek, once the new frame can be drawn. Safari can fire `seeked` while still showing the
 * old frame, so where requestVideoFrameCallback exists this also waits for the new frame to be presented. Returns a
 * cleanup function.
 */
export function watchSeekFrames(video: HTMLVideoElement, onFrame: () => void) {
  const hasFrameCallback = 'requestVideoFrameCallback' in video;
  let seek = 0;
  let presented = false;
  let seeked = false;
  let timer = 0;
  const done = () => {
    window.clearTimeout(timer);
    if (!seeked) return;
    seeked = false;
    onFrame();
  };
  const onSeeking = () => {
    const current = ++seek;
    presented = false;
    seeked = false;
    window.clearTimeout(timer);
    if (hasFrameCallback) {
      video.requestVideoFrameCallback(() => {
        if (current !== seek) return;
        presented = true;
        done();
      });
    }
  };
  const onSeeked = () => {
    seeked = true;
    if (presented || !hasFrameCallback) done();
    else timer = window.setTimeout(done, FRAME_CALLBACK_GRACE_MS);
  };
  video.addEventListener('seeking', onSeeking);
  video.addEventListener('seeked', onSeeked);
  return () => {
    window.clearTimeout(timer);
    video.removeEventListener('seeking', onSeeking);
    video.removeEventListener('seeked', onSeeked);
  };
}

export function formatTime(seconds: number) {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
