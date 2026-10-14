import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent } from 'react';
import {
  FiArrowDown,
  FiArrowUpRight,
  FiCheck,
  FiChevronDown,
  FiImage,
  FiMaximize2,
  FiPause,
  FiPlay,
  FiPlus,
  FiRefreshCw,
  FiUpload,
  FiX,
} from 'react-icons/fi';
import { track } from '../analytics';
import { Accordion, Section, Slider, Toggle } from './components';
import {
  BRAND_PALETTE,
  DEFAULT_OPTIONS,
  composeExport,
  hexToRgb,
  loadImage,
  loadLogo,
  paletteFor,
  renderDithered,
  sampleImageColors,
  toHex,
  type LogoCorner,
  type MakerOptions,
  type PixelSource,
  type RGB,
} from './pipeline';
import { ExportCanceledError, GIF_FPS, GIF_MAX_SECONDS } from './video/constants';
import { FrameRenderer } from './video/frameRenderer';
import { VIDEO_TYPES, formatTime, probeVideo, snapshotVideo } from './video/media';

const LOGO_SRC = '/brand/derpetual-logo.png';
const SAMPLE_SRC = '/derpetual-sample.png';

const LOGO_COLORS = [
  { value: '#E3FDE6', label: 'Mint' },
  { value: '#001FE9', label: 'Blue' },
  { value: '#0A0D0B', label: 'Ink' },
];

const LOGO_CORNERS: { value: LogoCorner; label: string }[] = [
  { value: 'top-left', label: 'Top left' },
  { value: 'top-right', label: 'Top right' },
  { value: 'bottom-left', label: 'Bottom left' },
  { value: 'bottom-right', label: 'Bottom right' },
];

const TEXTURE_PRESETS = [
  { name: 'Classic', resolution: 512, description: 'An ordered, graphic texture.' },
  { name: 'Fine', resolution: 768, description: 'A finer ordered texture.' },
  { name: 'Bold', resolution: 256, description: 'Chunky pixels. More character.' },
];

/** Tried after the photo's own colors when the user clicks "Add color". */
const ADD_COLOR_FALLBACKS: RGB[] = [
  [128, 128, 128],
  [255, 255, 255],
  [0, 0, 0],
  [255, 0, 0],
  [0, 255, 0],
  [0, 0, 255],
  [255, 255, 0],
];

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp', 'image/avif'];
const VIDEO_EXTENSIONS = /\.(mp4|m4v|mov|webm)$/i;

type ExportFormat = 'png' | 'jpg' | 'webp';
type VideoFormat = 'mp4' | 'gif';
type ExportSize = 'original' | 'working';

type ImageSource = { kind: 'image'; image: HTMLImageElement; name: string; url: string; width: number; height: number };
type VideoSource = {
  kind: 'video';
  file: File;
  poster: HTMLCanvasElement;
  name: string;
  url: string;
  width: number;
  height: number;
  duration: number;
};
type Source = ImageSource | VideoSource;

interface RenderResult {
  canvas: HTMLCanvasElement;
  palette: RGB[];
  options: MakerOptions;
  /** The frame this result was rendered from: the image itself, or a video's current frame. */
  still: PixelSource;
}

/** Where extra colors are sampled from: the image, or a video's first frame (so colors don't flicker). */
const colorSourceOf = (source: Source) => (source.kind === 'image' ? source.image : source.poster);

const fileStem = (name: string) => name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/-+$/, '') || 'image';

/** Preview canvas size: width min(1600, natural), height keeps the aspect ratio. */
const previewSize = (source: Source) => {
  const width = Math.min(1600, source.width);
  return { width, height: Math.max(1, Math.round((width * source.height) / source.width)) };
};

/** "45 s left", "12 min left", "1 h 20 min left". */
const formatRemaining = (seconds: number) => {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} s left`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes} min left` : `${Math.floor(minutes / 60)} h ${minutes % 60} min left`;
};

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function Maker() {
  const [source, setSource] = useState<Source | null>(null);
  const [still, setStill] = useState<PixelSource | null>(null);
  const [options, setOptions] = useState<MakerOptions>({ ...DEFAULT_OPTIONS });
  const [result, setResult] = useState<RenderResult | null>(null);
  const [logoEnabled, setLogoEnabled] = useState(false);
  const [logoCorner, setLogoCorner] = useState<LogoCorner>('bottom-right');
  const [logoColor, setLogoColor] = useState('#E3FDE6');
  const [view, setView] = useState<'dithered' | 'original'>('dithered');
  const [zoomed, setZoomed] = useState(false);
  const [exportFormat, setExportFormat] = useState<ExportFormat>('png');
  const [videoFormat, setVideoFormat] = useState<VideoFormat>('mp4');
  const [exportSize, setExportSize] = useState<ExportSize>('original');
  const [processing, setProcessing] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState<{ progress: number; secondsLeft: number | null } | null>(null);
  const [opening, setOpening] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const loadIdRef = useRef(0);
  const objectUrlRef = useRef<string | null>(null);
  const dragDepthRef = useRef(0);
  const exportAbortRef = useRef<AbortController | null>(null);

  const isVideo = source?.kind === 'video';

  // Palette for live playback, sampled from the first frame and cached per video.
  const livePalette = useMemo(
    () => (source?.kind === 'video' ? paletteFor(source.poster, options) : BRAND_PALETTE),
    [source, options],
  );
  const liveRef = useRef({ options, palette: livePalette, logo: { enabled: logoEnabled, corner: logoCorner, color: logoColor } });
  useEffect(() => {
    liveRef.current = { options, palette: livePalette, logo: { enabled: logoEnabled, corner: logoCorner, color: logoColor } };
  });

  const updateOption = <K extends keyof MakerOptions>(key: K, value: MakerOptions[K]) => {
    setProcessing(true);
    setOptions((current) => ({ ...current, [key]: value }));
    setNotice('');
  };

  const adoptSource = useCallback((next: Source, firstStill: PixelSource, objectUrl: string | null) => {
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    objectUrlRef.current = objectUrl;
    setSource(next);
    setStill(firstStill);
    setOptions((current) => ({ ...current, customColors: null }));
    setResult(null);
    setProcessing(true);
    setPlaying(false);
    setCurrentTime(0);
    setView('dithered');
    setNotice('');
  }, []);

  const loadSource = useCallback(
    async (url: string, name: string, isUpload = false) => {
      const loadId = ++loadIdRef.current;
      setOpening(true);
      setError('');
      try {
        const image = await loadImage(url, 'This image could not be opened. Try a PNG, JPG, or WebP file.');
        if (loadId !== loadIdRef.current) {
          if (isUpload) URL.revokeObjectURL(url);
          return;
        }
        if (image.naturalWidth * image.naturalHeight > 4e7 || Math.max(image.naturalWidth, image.naturalHeight) > 16384) {
          throw new Error('Please use an image smaller than 40 megapixels and 16,384 pixels per side.');
        }
        adoptSource(
          { kind: 'image', image, name, url, width: image.naturalWidth, height: image.naturalHeight },
          image,
          isUpload ? url : null,
        );
        if (isUpload) track('maker_image_uploaded');
      } catch (err) {
        if (isUpload) URL.revokeObjectURL(url);
        if (loadId === loadIdRef.current) setError(err instanceof Error ? err.message : 'Could not open this image.');
      } finally {
        if (loadId === loadIdRef.current) setOpening(false);
      }
    },
    [adoptSource],
  );

  const loadVideo = useCallback(
    async (file: File) => {
      const loadId = ++loadIdRef.current;
      const url = URL.createObjectURL(file);
      setOpening(true);
      setError('');
      try {
        const info = await probeVideo(url);
        if (loadId !== loadIdRef.current) {
          URL.revokeObjectURL(url);
          return;
        }
        adoptSource({ kind: 'video', file, name: file.name, url, ...info }, info.poster, url);
        track('maker_video_uploaded', { duration_seconds: Math.round(info.duration) });
      } catch (err) {
        URL.revokeObjectURL(url);
        if (loadId === loadIdRef.current) setError(err instanceof Error ? err.message : 'Could not open this video.');
      } finally {
        if (loadId === loadIdRef.current) setOpening(false);
      }
    },
    [adoptSource],
  );

  const openFile = useCallback(
    (file: File) => {
      if (VIDEO_TYPES.includes(file.type) || (!file.type && VIDEO_EXTENSIONS.test(file.name)) || file.type === 'video/x-m4v') {
        loadVideo(file);
        return;
      }
      if (!IMAGE_TYPES.includes(file.type)) {
        setError('Choose a PNG, JPG, WebP, GIF, BMP, or AVIF image, or an MP4, MOV, or WebM video.');
        return;
      }
      if (file.size > 50 * 1024 * 1024) {
        setError('Please choose an image under 50 MB.');
        return;
      }
      loadSource(URL.createObjectURL(file), file.name, true);
    },
    [loadSource, loadVideo],
  );

  useEffect(() => {
    loadSource(SAMPLE_SRC, 'Sunrise · sample image');
    return () => {
      loadIdRef.current++;
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    };
  }, [loadSource]);

  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const file = Array.from(event.clipboardData?.items ?? [])
        .find((item) => item.type.startsWith('image/'))
        ?.getAsFile();
      if (file) {
        event.preventDefault();
        openFile(file);
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [openFile]);

  useEffect(() => {
    if (!source || !still) return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const rendered = await renderDithered(still, options, colorSourceOf(source));
        if (!cancelled) {
          setResult({ ...rendered, options, still });
          setError('');
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Could not process this image.');
          setProcessing(false);
        }
      }
    }, 65);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [source, still, options]);

  useEffect(() => {
    if (!result || !source || result.options !== options || result.still !== still) return;
    // While a video plays, the playback loop owns the canvas.
    if (playing) {
      setProcessing(false);
      return;
    }
    let cancelled = false;
    composeExport(result.canvas, {
      ...previewSize(source),
      logo: { enabled: logoEnabled, src: LOGO_SRC, corner: logoCorner, color: logoColor },
    })
      .then((composed) => {
        if (cancelled || !canvasRef.current) return;
        const canvas = canvasRef.current;
        canvas.width = composed.width;
        canvas.height = composed.height;
        canvas.getContext('2d')?.drawImage(composed, 0, 0);
        setProcessing(false);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Could not prepare the preview.');
          setProcessing(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [result, source, still, options, logoEnabled, logoCorner, logoColor, playing]);

  // Live dithered playback: every new video frame goes through the same pipeline as a still.
  useEffect(() => {
    if (!playing || source?.kind !== 'video') return;
    const video = videoRef.current;
    if (!video) return;
    const renderer = new FrameRenderer({ exact: false });
    const { width, height } = previewSize(source);
    let logoImage: HTMLImageElement | null = null;
    loadLogo(LOGO_SRC).then((img) => (logoImage = img), () => undefined);
    let frameId = 0;
    let lastTime = -1;
    let lastShown = -1;
    const tick = () => {
      frameId = requestAnimationFrame(tick);
      if (video.readyState < 2 || video.currentTime === lastTime) return;
      lastTime = video.currentTime;
      const { options: live, palette, logo } = liveRef.current;
      const frame = renderer.render(
        (context, w, h) => context.drawImage(video, 0, 0, w, h),
        source.width,
        source.height,
        live,
        palette,
        width,
        height,
        logo.enabled && logoImage ? { image: logoImage, corner: logo.corner, color: logo.color } : null,
      );
      const canvas = canvasRef.current;
      if (!canvas) return;
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      canvas.getContext('2d')?.drawImage(frame, 0, 0);
      if (Math.abs(lastTime - lastShown) >= 0.2) {
        lastShown = lastTime;
        setCurrentTime(lastTime);
      }
    };
    frameId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameId);
  }, [playing, source]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), 4500);
    return () => window.clearTimeout(timer);
  }, [notice]);

  /** Freezes the frame the video is showing so the exact still pipeline renders it. */
  const captureStill = () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    setCurrentTime(video.currentTime);
    setProcessing(true);
    setStill(snapshotVideo(video));
  };

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      video.play().catch(() => setError('This video could not be played.'));
    } else {
      video.pause();
    }
  };

  const resetDefaults = () => {
    setOptions({ ...DEFAULT_OPTIONS });
    setLogoEnabled(false);
    setLogoCorner('bottom-right');
    setLogoColor('#E3FDE6');
    setProcessing(true);
    setNotice('Brand defaults restored.');
  };

  const downloadVideo = async (video: VideoSource, rendered: RenderResult) => {
    videoRef.current?.pause();
    const controller = new AbortController();
    exportAbortRef.current = controller;
    setExporting(true);
    setExportProgress({ progress: 0, secondsLeft: null });
    const startedAt = performance.now();
    let lastUpdate = 0;
    // Progress fires every frame; re-render a few times a second instead (a movie is ~150k frames).
    const reportProgress = (progress: number) => {
      const now = performance.now();
      if (now - lastUpdate < 250 && progress < 1) return;
      lastUpdate = now;
      const elapsed = (now - startedAt) / 1000;
      // The estimate settles once a little of the video is done.
      const secondsLeft = progress > 0.005 && elapsed > 3 ? (elapsed / progress) * (1 - progress) : null;
      setExportProgress({ progress, secondsLeft });
    };
    setError('');
    try {
      const job = {
        file: video.file,
        options,
        palette: rendered.palette,
        width: exportSize === 'original' ? video.width : rendered.canvas.width,
        height: exportSize === 'original' ? video.height : rendered.canvas.height,
        logo: { enabled: logoEnabled, src: LOGO_SRC, corner: logoCorner, color: logoColor },
        onProgress: reportProgress,
        signal: controller.signal,
      };
      const { exportGif, exportMp4 } = await import('./video/exportVideo');
      if (controller.signal.aborted) throw new ExportCanceledError();
      const { blob, audioDropped } = videoFormat === 'gif' ? await exportGif(job) : await exportMp4(job);
      saveBlob(blob, `${fileStem(video.name)}-derpetual.${videoFormat}`);
      setNotice(audioDropped ? 'Your Derpetual video is ready. This browser couldn’t keep the audio.' : 'Your Derpetual video is ready.');
      track('maker_video_downloaded', {
        format: videoFormat,
        export_size: exportSize,
        logo_enabled: logoEnabled,
        duration_seconds: Math.round(video.duration),
      });
    } catch (err) {
      if (!(err instanceof ExportCanceledError)) {
        setError(err instanceof Error ? err.message : 'The export failed. Please try again.');
      }
    } finally {
      exportAbortRef.current = null;
      setExporting(false);
      setExportProgress(null);
    }
  };

  const download = async () => {
    if (!result || !source || processing || opening || exporting) return;
    if (source.kind === 'video') return downloadVideo(source, result);
    setExporting(true);
    setError('');
    try {
      const canvas = await composeExport(result.canvas, {
        width: exportSize === 'original' ? source.width : result.canvas.width,
        height: exportSize === 'original' ? source.height : result.canvas.height,
        logo: { enabled: logoEnabled, src: LOGO_SRC, corner: logoCorner, color: logoColor },
      });
      const mime = exportFormat === 'jpg' ? 'image/jpeg' : `image/${exportFormat}`;
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Export failed. Please try PNG.'))), mime, 0.95),
      );
      if (blob.type !== mime) throw new Error('Your browser does not support this format. Please choose PNG.');
      saveBlob(blob, `${fileStem(source.name)}-derpetual.${exportFormat}`);
      setNotice('Your Derpetual image is ready.');
      track('maker_image_downloaded', { format: exportFormat, export_size: exportSize, logo_enabled: logoEnabled });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The export failed. Please try again.');
    } finally {
      setExporting(false);
    }
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    dragDepthRef.current = 0;
    setDragging(false);
    const file = event.dataTransfer.files[0];
    if (file) openFile(file);
  };

  const activePreset = TEXTURE_PRESETS.find((preset) => preset.resolution === options.workingResolution)?.name;
  const palette = result?.palette ?? BRAND_PALETTE;
  const extraColors = options.customColors ?? palette.slice(2);
  const setCustomColors = (colors: RGB[]) => updateOption('customColors', colors);
  const mediaWord = isVideo ? 'video' : 'photo';

  const addColor = () => {
    if (!source || extraColors.length >= 6) return;
    const used = new Set([...BRAND_PALETTE, ...extraColors].map(toHex));
    const next = [...sampleImageColors(colorSourceOf(source)), ...ADD_COLOR_FALLBACKS].find((c) => !used.has(toHex(c)));
    if (next) setCustomColors([...extraColors, next]);
  };

  const resampleColors = () => {
    setProcessing(true);
    setOptions((current) => ({ ...current, additionalColors: Math.max(2, extraColors.length), customColors: null }));
  };

  const naturalWidth = source?.width ?? 0;
  const naturalHeight = source?.height ?? 0;
  const duration = source?.kind === 'video' ? source.duration : 0;

  const downloadLabel = isVideo
    ? exporting
      ? `Rendering ${Math.floor((exportProgress?.progress ?? 0) * 100)}%${exportProgress?.secondsLeft != null ? ` · ${formatRemaining(exportProgress.secondsLeft)}` : '…'}`
      : 'Download video'
    : exporting
      ? 'Preparing download…'
      : 'Download image';

  return (
    <div
      className="maker-app"
      onDragEnter={(event) => {
        event.preventDefault();
        if (event.dataTransfer.types.includes('Files')) {
          dragDepthRef.current++;
          setDragging(true);
        }
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => {
        event.preventDefault();
        if (--dragDepthRef.current <= 0) {
          dragDepthRef.current = 0;
          setDragging(false);
        }
      }}
      onDrop={onDrop}
    >
      <a className="skip-link" href="#main-content">
        Skip to editor
      </a>
      <header className="site-header">
        <div className="header-inner">
          <a className="brand-link" href="https://derpetual.com" target="_blank" rel="noreferrer">
            <img src={LOGO_SRC} alt="Derpetual" width="183" height="40" />
          </a>
          <span className="header-divider" />
          <span className="maker-label">Maker</span>
          <a className="back-link" href="https://derpetual.com" target="_blank" rel="noreferrer">
            {'Visit Derpetual '}
            <FiArrowUpRight aria-hidden="true" />
          </a>
        </div>
      </header>
      <main id="main-content" className="page-frame">
        <section className="intro">
          <div>
            <h1>
              <em>Derpetual Maker</em>
            </h1>
          </div>
          <p className="intro-copy">
            Turn your images into Derpetual artifacts
            <br />
            ██████████████████
          </p>
        </section>
        <div className="editor-layout">
          <div className="workspace-column">
            <section className="workspace" aria-label="Image preview">
              <div className="workspace-toolbar">
                <div className="view-tabs" role="group" aria-label="Preview mode">
                  <button
                    className={view === 'dithered' ? 'active' : ''}
                    aria-pressed={view === 'dithered'}
                    onClick={() => setView('dithered')}
                  >
                    Dithered
                  </button>
                  <button
                    className={view === 'original' ? 'active' : ''}
                    aria-pressed={view === 'original'}
                    onClick={() => setView('original')}
                  >
                    Original
                  </button>
                </div>
                <div className="preview-actions">
                  <button
                    className="icon-button fullscreen-button"
                    title="Full screen preview"
                    aria-label="Full screen preview"
                    onClick={() => {
                      if (stageRef.current?.requestFullscreen) {
                        stageRef.current.requestFullscreen().catch(() => setError('Full screen is unavailable in this browser.'));
                      } else {
                        setError('Full screen is unavailable in this browser.');
                      }
                    }}
                  >
                    <FiMaximize2 />
                  </button>
                </div>
              </div>
              <div className={`preview-stage ${zoomed ? 'is-zoomed' : ''}`} ref={stageRef} aria-busy={processing || opening}>
                <div
                  className="artwork ph-no-capture"
                  style={{
                    aspectRatio: `${naturalWidth || 3} / ${naturalHeight || 2}`,
                    ...(zoomed ? { width: naturalWidth || 800, maxWidth: 'none', maxHeight: 'none', flexShrink: 0 } : {}),
                  }}
                >
                  <canvas
                    ref={canvasRef}
                    className={view === 'dithered' ? '' : 'hidden-canvas'}
                    aria-label="Dithered image with the selected Derpetual colors and logo"
                  />
                  {view === 'original' && source?.kind === 'image' && (
                    <img className="original-image" src={source.url} alt="Original uploaded image" />
                  )}
                  {source?.kind === 'video' && (
                    <video
                      key={source.url}
                      ref={videoRef}
                      className={view === 'original' ? 'original-image' : 'hidden-canvas'}
                      src={source.url}
                      aria-label="Original uploaded video"
                      playsInline
                      loop
                      preload="auto"
                      onPlay={() => setPlaying(true)}
                      onPause={() => {
                        setPlaying(false);
                        captureStill();
                      }}
                      onSeeked={() => {
                        if (videoRef.current?.paused) captureStill();
                      }}
                    />
                  )}
                  {(!result || opening) && (
                    <div className="preview-loading">
                      <span className="loading-ring" />
                      <span>Making pixels…</span>
                    </div>
                  )}
                </div>
                <span className="stage-cross cross-tl" aria-hidden="true">
                  +
                </span>
                <span className="stage-cross cross-br" aria-hidden="true">
                  +
                </span>
              </div>
              {source?.kind === 'video' && (
                <div className="video-bar">
                  <button className="icon-button play-button" aria-label={playing ? 'Pause video' : 'Play video'} onClick={togglePlay}>
                    {playing ? <FiPause aria-hidden="true" /> : <FiPlay aria-hidden="true" />}
                  </button>
                  <span className="video-time">
                    {formatTime(currentTime)} / {formatTime(duration)}
                  </span>
                  <input
                    className="video-scrubber"
                    type="range"
                    aria-label="Seek"
                    min={0}
                    max={duration || 0}
                    step="any"
                    value={Math.min(currentTime, duration)}
                    style={{ '--range': `${duration ? (Math.min(currentTime, duration) / duration) * 100 : 0}%` } as CSSProperties}
                    onChange={(event) => {
                      const time = Number(event.target.value);
                      setCurrentTime(time);
                      if (videoRef.current) videoRef.current.currentTime = time;
                    }}
                  />
                </div>
              )}
              <div className="canvas-caption">
                <span className="image-name ph-no-capture">
                  <FiImage aria-hidden="true" />
                  {source?.name ?? 'Loading sample…'}
                </span>
                <button
                  className="zoom-button"
                  onClick={() => setZoomed((z) => !z)}
                  aria-label={zoomed ? 'Fit image to preview' : 'View image at 100%'}
                >
                  {zoomed ? '100%' : 'Fit'}
                  <FiChevronDown />
                </button>
              </div>
              <div className="workspace-footnote">
                <span>
                  <span className="tiny-square" />
                  {naturalWidth
                    ? `${naturalWidth.toLocaleString()} × ${naturalHeight.toLocaleString()} PX${isVideo ? ` · ${formatTime(duration)}` : ''}`
                    : '—'}
                </span>
                <span>MADE OF PIXELS. FULL OF POSSIBILITIES.</span>
              </div>
            </section>
          </div>
          <aside className="controls" aria-label="Image settings">
            <div className="controls-title">
              <span>Make it yours</span>
              <button className="reset-button" onClick={resetDefaults} title="Reset to Derpetual defaults">
                <FiRefreshCw aria-hidden="true" />
                Reset
              </button>
            </div>
            <Section number="01" title={isVideo ? 'YOUR VIDEO' : 'YOUR IMAGE'}>
              <button className="upload-button" onClick={() => fileInputRef.current?.click()}>
                <FiUpload aria-hidden="true" />
                <span>{opening ? 'Opening file…' : 'Upload an image or video'}</span>
                <span className="circle-arrow">
                  <FiArrowUpRight />
                </span>
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept={[...IMAGE_TYPES, ...VIDEO_TYPES, '.mov', '.m4v'].join(',')}
                hidden
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) openFile(file);
                  event.target.value = '';
                }}
              />
              <p className="helper upload-helper">Drop a file anywhere, or paste an image.</p>
            </Section>
            <Section number="02" title="THE TEXTURE" action={<span className="small-tag">BAYER 16×16</span>}>
              <div className="preset-tabs" role="group" aria-label="Texture presets">
                {TEXTURE_PRESETS.map((preset) => (
                  <button
                    key={preset.name}
                    className={activePreset === preset.name ? 'active' : ''}
                    aria-pressed={activePreset === preset.name}
                    title={preset.description}
                    onClick={() => {
                      setProcessing(true);
                      setOptions((current) => ({ ...current, workingResolution: preset.resolution }));
                    }}
                  >
                    <span className={`texture-icon texture-${preset.name.toLowerCase()}`} aria-hidden="true" />
                    {preset.name}
                  </button>
                ))}
              </div>
              <Slider
                label="Detail"
                value={options.workingResolution}
                min={128}
                max={1024}
                step={32}
                suffix=" px"
                onChange={(value) => updateOption('workingResolution', value)}
              />
              <Accordion title="Fine-tune texture">
                <div className="detail-content">
                  <Slider label="Threshold" value={options.threshold} min={0} max={255} onChange={(value) => updateOption('threshold', value)} />
                  <Slider label="Contrast" value={options.contrast} min={-100} max={100} onChange={(value) => updateOption('contrast', value)} />
                  <div className="toggle-row">
                    <span>Invert tones</span>
                    <Toggle checked={options.invert} label="Invert tones" onChange={() => updateOption('invert', !options.invert)} />
                  </div>
                </div>
              </Accordion>
            </Section>
            <Section
              number="03"
              title="THE COLORS"
              action={<span className="small-tag">{options.additionalColors ? 'EXTRA COLORS' : 'BRAND PRESET'}</span>}
            >
              <div className="brand-palette">
                <div>
                  <span className="color-block blue-block" />
                  <span>
                    <strong>Derpetual blue</strong>
                    <code>#001FE9</code>
                  </span>
                  <span className="tone-label">Dark</span>
                </div>
                <div>
                  <span className="color-block mint-block" />
                  <span>
                    <strong>Derpetual mint</strong>
                    <code>#E3FDE6</code>
                  </span>
                  <span className="tone-label">Light</span>
                </div>
              </div>
              <Accordion title="Extra colors" className="color-details">
                <div className="detail-content">
                  <div className="toggle-row">
                    <span>Use extra colors</span>
                    <Toggle
                      checked={options.additionalColors > 0}
                      label="Use extra colors"
                      onChange={() => updateOption('additionalColors', options.additionalColors ? 0 : 2)}
                    />
                  </div>
                  <p className="helper">Start with colors from your {mediaWord}. Pick a swatch to change it, or add your own.</p>
                  {options.additionalColors > 0 && (
                    <>
                      <div className="extra-color-editor" aria-label="Editable extra colors">
                        {extraColors.map((color, index) => (
                          <div className="extra-color-row" key={index}>
                            <label className="extra-color-picker" title={`Change extra color ${index + 1}`}>
                              <input
                                type="color"
                                aria-label={`Extra color ${index + 1}`}
                                value={toHex(color)}
                                onInput={(event) => {
                                  const rgb = hexToRgb(event.currentTarget.value);
                                  setCustomColors(extraColors.map((c, i) => (i === index ? rgb : c)));
                                }}
                              />
                              <span>
                                <code>{toHex(color)}</code>
                                <span>Color {index + 1}</span>
                              </span>
                            </label>
                            <button
                              className="remove-color-button"
                              aria-label={`Remove extra color ${index + 1}`}
                              title="Remove color"
                              onClick={() => setCustomColors(extraColors.filter((_, i) => i !== index))}
                            >
                              <FiX aria-hidden="true" />
                            </button>
                          </div>
                        ))}
                        {!extraColors.length && <p className="helper">No extra colors. Add a color or sample your {mediaWord} again.</p>}
                      </div>
                      <div className="color-editor-actions">
                        <button
                          className="add-color-button"
                          disabled={!source || opening || processing || extraColors.length >= 6}
                          onClick={addColor}
                        >
                          <FiPlus aria-hidden="true" />
                          {' Add color'}
                        </button>
                        <button
                          className="resample-button"
                          disabled={!source || opening || processing}
                          onClick={resampleColors}
                          title={`Replace extra colors with colors sampled from this ${mediaWord}`}
                        >
                          <FiRefreshCw aria-hidden="true" />
                          {` Resample ${mediaWord}`}
                        </button>
                      </div>
                      <p className="helper color-limit">{extraColors.length}/6 extra colors · brand colors stay fixed</p>
                    </>
                  )}
                </div>
              </Accordion>
            </Section>
            <Section
              number="04"
              title="THE SIGNATURE"
              action={
                <Toggle
                  checked={logoEnabled}
                  label="Add Derpetual logo"
                  onChange={() => {
                    setProcessing(true);
                    setLogoEnabled((enabled) => !enabled);
                  }}
                />
              }
            >
              <p className="helper logo-helper">Finish it with the Derpetual logo.</p>
              <fieldset className="logo-options" disabled={!logoEnabled}>
                <legend className="sr-only">Logo options</legend>
                <div className="position-row">
                  <span>Placement</span>
                  <div className="position-controls">
                    {LOGO_CORNERS.map((corner) => (
                      <button
                        key={corner.value}
                        title={corner.label}
                        aria-label={corner.label}
                        aria-pressed={logoCorner === corner.value}
                        className={logoCorner === corner.value ? 'selected' : ''}
                        onClick={() => {
                          if (logoCorner !== corner.value) {
                            setProcessing(true);
                            setLogoCorner(corner.value);
                          }
                        }}
                      >
                        <span className={`corner-preview ${corner.value}`} />
                      </button>
                    ))}
                  </div>
                </div>
                <div className="logo-color-row">
                  <span>Logo color</span>
                  <div className="logo-swatches">
                    {LOGO_COLORS.map((color) => (
                      <button
                        key={color.value}
                        aria-label={`${color.label} logo ${color.value}`}
                        title={`${color.label} · ${color.value}`}
                        aria-pressed={logoColor === color.value}
                        className={logoColor === color.value ? 'selected' : ''}
                        style={
                          {
                            '--swatch': color.value,
                            color: color.value === '#E3FDE6' ? '#0A0D0B' : '#E3FDE6',
                          } as CSSProperties
                        }
                        onClick={() => {
                          if (logoColor !== color.value) {
                            setProcessing(true);
                            setLogoColor(color.value);
                          }
                        }}
                      >
                        {logoColor === color.value && <FiCheck />}
                      </button>
                    ))}
                  </div>
                </div>
              </fieldset>
            </Section>
          </aside>
          <div className="export-section">
            <div className="export-selects">
              <label>
                <span>FORMAT</span>
                {isVideo ? (
                  <select aria-label="Export format" value={videoFormat} onChange={(event) => setVideoFormat(event.target.value as VideoFormat)}>
                    <option value="mp4">MP4</option>
                    <option value="gif">GIF</option>
                  </select>
                ) : (
                  <select aria-label="Export format" value={exportFormat} onChange={(event) => setExportFormat(event.target.value as ExportFormat)}>
                    <option value="png">PNG</option>
                    <option value="jpg">JPG</option>
                    <option value="webp">WebP</option>
                  </select>
                )}
                <FiChevronDown />
              </label>
              <label>
                <span>SIZE</span>
                <select aria-label="Export size" value={exportSize} onChange={(event) => setExportSize(event.target.value as ExportSize)}>
                  <option value="original">Original size</option>
                  <option value="working">Working size</option>
                </select>
                <FiChevronDown />
              </label>
            </div>
            <button className="download-button" onClick={() => void download()} disabled={!result || processing || exporting || opening}>
              <span>{downloadLabel}</span>
              <FiArrowDown aria-hidden="true" />
            </button>
            {isVideo && exporting ? (
              <button className="text-button export-cancel" onClick={() => exportAbortRef.current?.abort()}>
                Cancel export
              </button>
            ) : (
              <p className="export-note">
                {isVideo && videoFormat === 'gif'
                  ? `GIF · ${GIF_FPS} fps · up to ${GIF_MAX_SECONDS} s · no sound`
                  : 'Derpetual Collective Forever'}
              </p>
            )}
          </div>
          <section className="earn-cta" aria-labelledby="earn-title">
            <div className="earn-cta-copy">
              <h2 id="earn-title">
                {'Earn '}
                <img className="earn-symbol" src="/brand/earn-symbol.svg" alt="✧" width="20" height="20" />
              </h2>
            </div>
            <a className="earn-cta-link !mb-2.5 !text-sm" href="https://early.derpetual.com/?utm_source=maker" target="_blank" rel="noreferrer">
              {'Join early access '}
              <FiArrowUpRight aria-hidden="true" />
            </a>
          </section>
        </div>
        <div className="privacy-strip h-20" />
      </main>
      <footer className="site-footer">
        <div className="footer-brand">
          <a className="footer-logo" href="https://derpetual.com" target="_blank" rel="noreferrer">
            <img src={LOGO_SRC} alt="Derpetual" width="146" height="32" />
          </a>
          <div className="footer-brand-copy">
            <span className="footer-tagline">888 · Don’t worry about it</span>
            <a className="footer-credit" href="https://github.com/Oslonline/dithering-studio" target="_blank" rel="noreferrer">
              {'Inspired by Dithering Studio '}
              <FiArrowUpRight aria-hidden="true" />
            </a>
          </div>
        </div>
        <nav className="footer-links" aria-label="Derpetual links">
          <a href="https://derpetual.com" target="_blank" rel="noreferrer">
            {'derpetual.com '}
            <FiArrowUpRight aria-hidden="true" />
          </a>
          <a href="https://x.com/derpetual" target="_blank" rel="noreferrer">
            {'X '}
            <FiArrowUpRight aria-hidden="true" />
          </a>
          <a href="https://discord.gg/derpetual" target="_blank" rel="noreferrer">
            {'Discord '}
            <FiArrowUpRight aria-hidden="true" />
          </a>
        </nav>
      </footer>
      {dragging && (
        <div className="drop-overlay">
          <FiUpload />
          <h2>Drop it like it’s Derpetual.</h2>
          <p>Release your image to start creating.</p>
        </div>
      )}
      {error && (
        <div className="toast error-toast" role="alert">
          <span>{error}</span>
          <button aria-label="Dismiss error" onClick={() => setError('')}>
            <FiX />
          </button>
        </div>
      )}
      {notice && (
        <div className="toast" role="status">
          <FiCheck />
          <span>{notice}</span>
        </div>
      )}
    </div>
  );
}
