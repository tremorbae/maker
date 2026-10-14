// Kept separate from exportVideo.ts so the UI can use these without loading mediabunny/gifenc up front.

export const GIF_FPS = 15;
export const GIF_MAX_SECONDS = 30;
export const GIF_MAX_SIDE = 1080;

export class ExportCanceledError extends Error {
  constructor() {
    super('Export canceled.');
  }
}
