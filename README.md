# RoofLine

Lay a roof plan over a first or second floor plan on your phone, so you can see roughly
which room sits under each roof tile vent when marking out on the roof.

> **Setting-out aid only. Vent positions on the roof plan are indicative. Check against
> the truss layout / designer before fixing.**

## How to use it

1. **Roof plan → Choose PDF.**
2. **Floor plan → Choose PDF** (first or second floor).
3. **Line up:** tap a corner of the building on the roof plan (e.g. the top-left outside
   corner of the walls), then the same corner on the floor plan. Drag one finger to aim
   (the crosshair sits above your finger and snaps to the drawing's lines), lift to place.
   Two fingers to zoom.

The roof then sits on top of the floor plan, see-through, showing everything exactly as
drawn (vent boxes, tile vents, notes). Optional:
- **Roof see-through** slider.
- **Colour the drawings**: roof red, floor blue. Untick to see the original colours.
- **Flip (opp. hand)**: mirrors roof and floor together for opposite-hand plots, about the
  corner you lined up on. Room names stay readable; writing on the roof plan reads backwards.
- **Floor plan: walls and room names only** (on by default): shows just the walls (the grey
  wall layer plus stud partitions drawn as paired lines) and room names such as BED 1,
  EN-SUITE, BATH, LANDING. Untick to see the full floor drawing. Floor plans without a
  separate wall layer always show in full.
- **Move roof**: drag to nudge it. **Undo roof moves** puts it back.
- **Line up again**, **Fit** (zooms to the house).

The two drawings and the line-up are remembered on the phone, so it opens where you left
off. Choose a different PDF at any time with **Change**.

Scale: if both drawings state a scale (e.g. "1:50") they are matched to it. If they don't,
they are assumed to be at the same scale.

Everything runs on the phone. Drawings are never uploaded. It works offline after the
first visit.

## Install on iPhone

Open the app's web address in Safari → Share → **Add to Home Screen**. Open it once while
online; after that it works offline.

## Hosting

It is a static site with no server. To host it free with GitHub Pages: repository
Settings → Pages → deploy from `main`, root folder (on a free plan the repository must be
public; only the app code is published, never drawings).

`npm run build:artifact` builds a single self-contained page for hosts that only allow
inline code (used for the claude.ai test link).

## Development

```bash
npm install
npm run serve        # http://localhost:8123
npm test             # unit tests
npm run e2e          # full run in headless Chromium at iPhone size (synthetic drawings)
npm run e2e:real     # same, on real drawings in tests/fixtures/real/ (git-ignored)
npm run build:sw     # after changing app files, so phones pick up the new version
```

Real drawings go in `tests/fixtures/real/` as `ellerton_roof.pdf` and
`ellerton_first_floor.pdf`. That folder is git-ignored: never commit real drawings.

```
index.html, css/app.css, js/app.js   the app (one screen)
js/pdfdoc.js                         render PDF pages (bundled PDF.js, no network)
js/pdf-extract.js                    line geometry for snapping, stated scale
js/geom.js                           snapping, roof-to-floor placement, house finder
js/viewer.js                         pinch-zoom canvas, precise tap with loupe
js/db.js                             on-device storage (IndexedDB)
vendor/pdfjs/                        PDF.js 4.10.38 (Apache-2.0)
```
