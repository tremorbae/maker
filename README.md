# Maker

A fork of [Derpetual Maker](https://maker.derpetual.com/): a client-side ditherer that renders images in a two-color brand palette, with optional extra colors and a logo. This fork adds **video** (MP4 and GIF export).

The image path is an exact clone of the original. It produces byte-identical exports, the same DOM, and the same screenshots. It still uses Derpetual's branding; see [Before shipping](#before-shipping).

## Run it

Node is installed user-locally in `~/.local/node`. Put it on your `PATH` first:

```bash
export PATH="$HOME/.local/node/bin:$PATH"
npm install
npm run dev        # http://localhost:5173
npm run build      # typecheck + production build to dist/
npm run preview    # serve dist/ on http://localhost:4173
```

Analytics are off unless you set `VITE_POSTHOG_KEY` (and optionally `VITE_POSTHOG_HOST`) in `.env.local`. When they're on, the fork sends the same events as the original, plus `maker_video_uploaded` and `maker_video_downloaded`.

Deploys to Vercel as a static site; `vercel.json` has the SPA rewrite.

## Layout

| Path | What |
| --- | --- |
| `src/maker/Maker.tsx` | The single screen: state, upload, preview, playback, export |
| `src/maker/pipeline.ts` | Image pipeline: brand palette, color sampling, working-size render, nearest-neighbor upscale, logo, export compose |
| `src/maker/dither.ts` | The one ditherer (Bayer 16×16), shared by images and video |
| `src/maker/components.tsx` | Switch, numbered section, accordion, slider |
| `src/maker/video/` | Video: frame renderer, MP4/GIF exporters (loaded on demand), metadata probe |
| `src/vendor/dithering-studio/` | Dithering Studio's tone preprocess, unmodified (Apache-2.0), with `LICENSE`, `NOTICE`, and notes on what's derived from it |
| `src/index.css` | Tailwind preflight, the original hand-written CSS (minus rules for elements it no longer renders), and a marked block of fork additions |

## Video

Upload an MP4, MOV, or WebM of any length, file size, or resolution. The video goes through the same pipeline as an image:

- **Preview.** Play and scrub the video with the settings applied live. When paused, the current frame renders through the exact image path.
- **Extra colors** are sampled once, from the first frame, so they don't flicker between frames.
- **MP4.** Frame-accurate decode → dither → H.264 encode using WebCodecs ([mediabunny](https://mediabunny.dev)).
  - Keeps the source frame rate.
  - Copies the audio, or converts it to AAC (WebM's Opus audio becomes AAC).
  - Bakes phone rotation into the frames.
  - Streams to disk as it encodes (into the browser's private file storage, OPFS), so long videos never have to fit in memory. Browsers without OPFS write support fall back to memory. Streamed files keep the MP4 index at the end, as camera files do.
  - Speed, measured in Chrome on a 2019 Intel MacBook Pro (i7-9750H): 1080p source → 1080p MP4 at about 80–88 fps (3.3–3.6× real time for 24 fps). A 4K source runs at 34 fps to 4K and 50 fps to Working size. A 1h50m 1080p movie takes about 30–35 minutes. The button shows a percentage and time remaining, and there's Cancel throughout.
  - How it's fast: one shared ditherer (`dither.ts`) precomputes the Bayer thresholds and reuses buffers, and MP4 upscales and draws the logo on the GPU. GPU nearest-neighbor shifts about 1 in 8 block edges by one pixel versus image exports; GIF keeps the exact CPU path.
  - Original-size export of videos beyond the browser's H.264 encoder limit (typically above 4K) asks you to use Working size.
  - Bitrate is 2 bits per dither cell per frame, between 2 and 60 Mbps. That keeps ≥99.99% of pixels on their intended palette color.
  - H.264's chroma subsampling still softens blue/mint edges slightly, as it does in every MP4.
- **GIF** ([gifenc](https://github.com/mattdesl/gifenc)).
  - 15 fps, up to 30 s, long side capped at 1080 px, no sound.
  - The color table is the exact dither palette, so frames are pixel-identical to the image pipeline.
  - With the logo on, its anti-aliased edge snaps to a 16-step blend ramp (max error 8/255).
- **Export flow.** Export shows progress and can be canceled. The ~560 KB of video code loads only when someone exports a video.
- **Browsers.** Export needs WebCodecs: current Chrome, Edge, Safari, or Firefox.

## Deviations from the original

Everything else matches the original exactly.

- Upload button reads "Upload an image or video", and the file picker accepts video types.
- With a video loaded, the screen changes in these ways:
  - The first section is titled "YOUR VIDEO".
  - A play/scrub bar sits under the preview.
  - The footnote adds the duration.
  - "photo" becomes "video" in the extra-colors copy.
  - Format choices are MP4/GIF, and the download button reads "Download video".
- Analytics only run with your own PostHog key.
- Nothing unused ships. The original bundles all 30 upstream algorithms, computes an unused blue-noise mask at page load, and carries CSS and a Bold font for elements it no longer renders. The fork keeps only the code paths it runs, with identical output.

## Verification

Before the test tools were removed (2026-10-14), image exports matched all 34 golden exports from the live site byte for byte (Chrome 154, macOS). The video suite also passed 26/26: upload, playback, cancel, rotation, WebM→MP4, MP4 tracks and quality, and GIF pixel-exactness.

## Before shipping

- [ ] Replace the brand: name and copy, logo (`public/brand/derpetual-logo.png`), favicon, sample image, OG image, palette (`BRAND_PALETTE` in `pipeline.ts` and the CSS tokens), logo colors, and links.
- [ ] License **Supply** (Pangram Pangram, commercial) or swap the monospace font.
- [ ] Keep Satoshi's attribution (Fontshare terms) and Dithering Studio's `LICENSE`/`NOTICE`.
- [ ] Set your own PostHog key, or leave analytics off.
