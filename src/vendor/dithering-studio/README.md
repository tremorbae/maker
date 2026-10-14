# Vendored from Dithering Studio

Source: <https://github.com/Oslonline/dithering-studio> @ `9298a44` (2026-06-05), © Oslo418, Apache-2.0. See `LICENSE` and `NOTICE`.

| File | Upstream path | Changes |
| --- | --- | --- |
| `utils/preprocess.ts` | `src/utils/preprocess.ts` | none |

The original Maker bundles all 30 upstream algorithms but uses only Bayer 16×16 and the nearest-neighbor export upscale. This fork reimplements those two with the same arithmetic. They're derived from upstream's `src/utils/algorithms/bayer.ts` and `src/utils/export.ts` (`upscaleCanvasNearestNeighbor`) under Apache-2.0:

- `src/maker/dither.ts` (`Ditherer`): Bayer 16×16 with precomputed thresholds.
- `src/maker/pipeline.ts` (`NearestUpscaler`): the same `floor(x · src/dst)` sampling into a reused canvas.

Output is byte-identical to the original site (verified against 34 exports from the live site).
