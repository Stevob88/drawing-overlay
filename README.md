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
  corner you lined up on. Room names and roof notes stay readable (writing reads backwards only if you untick the roof clean-up below).
- **Floor plan: walls and room names only** (on by default): shows just the walls (the grey
  wall layer plus stud partitions drawn as paired lines) and room names such as BED 1,
  EN-SUITE, BATH, LANDING. Untick to see the full floor drawing. Floor plans without a
  separate wall layer get the same clean-up as the roof instead ("hide measurements, keys
  and notes"): dimensions, keys, schedules and title block are left out, room names kept.
- **Roof plan: hide measurements and sheet notes** (on by default): the roof is drawn from
  its own lines without dimension lines, measurements, title block or keys. Kept: roof
  lines, wall hatching, tile vent symbols, short roof notes (SVP, EF to tile vent, Rwp,
  ridge) and markup comments such as the pink 20K vent boxes and yellow PV areas with
  their notes. Untick to see the roof sheet exactly as printed.
- **Move roof**: drag to nudge it. **Undo roof moves** puts it back.
- **Line up again**, **Fit** (zooms to the house).

The two drawings and the line-up are remembered on the phone, so it opens where you left
off. Choose a different PDF at any time with **Change**.

Keys, schedules and sheet notes are hidden by finding the plan itself: the separate blocks of
linework on the sheet (once dimensions and the sheet border are removed) are kept when they are
at least 30% the size of the largest block or contain a room name, so a spread-out building
with wings, or a small store wing, is never cut. The "Hide keys, schedules and sheet notes"
switch turns this off if you ever want to see everything on the sheet.

Measurements are removed automatically from both drawings, whatever the drawing style:
every measurement number (e.g. 5100, 955 int.) marks its dimension line, which is removed
with its extension lines and end marks (ticks, arrows, dots); dimension ticks are also
recognised on their own. Wall faces (lines with a parallel partner 50-130 mm away) are
never treated as dimensions. Measurement numbers are never drawn.

Scales: the two drawings do not need to be at the same scale. The app works out each
drawing's scale (the N in 1:N) and resizes the roof to match the floor plan:
1. It measures the scale from the drawing's own dimensions. Each measurement number (e.g.
   5461) sits between two extension lines, so real mm / drawn length gives the scale.
   Votes are snapped to standard scales (1:20, 1:50, 1:100 ...) and outvoted if odd.
2. If that is not possible it reads the stated scale ("1:50 @A3") and corrects it for the page
   it is on: a drawing issued "1:50 @A1" but saved on an A3 page is really 1:100.
3. If one dimension is all it has, it uses that and says it is less certain.
The "Drawing scales" panel says what it decided ("Roof is 1:100, floor is 1:50. The roof is
enlarged ×2 to match.") and lets you set either scale by hand if a drawing looks the wrong size.

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
npm run e2e:scales   # roof at 1:100 over floor at 1:50 (three ways the scale can be given)
npm run e2e:spread   # spread-out bungalow: wings separated by gaps, nothing may be cut off
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
