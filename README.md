# RoofLine

Plot-specific roof plan over floor plan overlay for housebuilding site managers.
Type a plot number, see that plot's roof plan (red) over its top floor plan (blue),
correctly handed (As / Opp), at a scale you have calibrated and checked with a tape.

> **Setting-out aid only. Roof plan vent positions are indicative. Check against the
> truss layout / designer before fixing.**

Everything runs in the browser on your phone. Drawings, the schedule and calibrations
are stored in IndexedDB on the device. There are no uploads, no analytics and no external
requests: PDF.js is bundled in `vendor/`, and a Content-Security-Policy blocks other origins.
After the first load it works offline.

## Run it

It is a static site with no build step. Serve this folder over HTTP(S):

```bash
npm install            # dev tools only: pdfjs-dist (tests/CLI) and playwright (e2e)
npm run serve          # http://localhost:8123
npm test               # unit/integration tests (node:test)
npm run e2e            # full browser run at iPhone size, screenshots in tests/e2e/out/
npm run inspect -- some.pdf   # Step 0 report for a PDF, locally
```

Hosting: serve this repository with GitHub Pages (Settings → Pages → deploy from `main`,
root folder). Only the app code is published: drawings never leave the phone. The service
worker and IndexedDB need HTTPS, which GitHub Pages provides. On a free GitHub plan, Pages
needs the repository to be public.

After changing any app file, run `npm run build:sw` so phones pick up the new version.

## Install on iPhone

1. Open the RoofLine URL in **Safari**.
2. Tap **Share** → **Add to Home Screen** → **Add**.
3. Open it once from the home screen while online. It then works offline.
4. Import the schedule and drawings (below). Use **Settings → Save backup** now and then.
   iOS can clear website data that hasn't been used for weeks, and a backup restores everything.

## First-time setup (Ellerton Elder prototype)

1. **Settings → Import schedule PDF.** Pick the variation sheet. The review screen shows:
   - the **column mapping**. Choose which column holds the drawing code that matches your
     drawing set (`ACTUAL PORTAL CODE` vs `BASE CODE`), plus the name and handing columns;
   - missing or duplicated plot numbers against the expected range (1–181);
   - highlighted **uncertain rows** (wrapped cells like plot 63, blanks, unrecognised
     handing). Fix the cells, tick **OK**, then **Save schedule**.
2. **House types → Import house type.** Name `ELLERTON` (as in the schedule), other names
   (e.g. `Ellerton Elder`), and drawing code exactly as in the code column (e.g.
   `BELX 2401 AA04`). Choose the roof plan PDF and the first floor plan PDF, and pick the
   page. Each page gets a Step 0 report (vector or raster, text, room names, dimensions) and
   is assigned **Method A** (vector) or **Method B** (raster) with the reasons shown.
3. **Calibrate** (6 steps):
   1. Roof plan scale: place A and B on a known dimension (e.g. `10113` wall-plate outer faces), type the real mm.
   2. Roof reference point (e.g. wall-plate outer corner).
   3. Floor plan scale (e.g. `10436` overall).
   4. Floor reference point (e.g. the masonry corner at the same corner of the house).
   5. **Offset** between the two references in mm. The app shows the numbers (e.g.
      (10436 − 10113) / 2 = 161.5) but never assumes them. You confirm.
   6. Check: rotation between the two reference lines (warns over 0.1°), stated-scale
      cross-check, error estimate, and a **required measure check** on the overlay.
   Saving creates a new version with the drawing code and date. Older versions are kept.
4. **On site:** open a plot, use **Measure** on a dimension you can tape, then tick
   **Checked on site** with the date and what you measured. Until you do, every plot of
   that type shows "NOT yet checked on site".

Precision tapping: in point mode, drag one finger. The orange crosshair sits **above** your
finger, a 4× loupe shows the spot, and on vector drawings it snaps to line ends (green
SNAP). Lift to place. Two fingers pan and zoom.

## What we learned from the real Ellerton drawings

Checked on the `Elder (End) - TF` roof plan and first floor plan, and on the
site variation sheet:

- Both drawings are **vector** at a stated 1:50 on A3. They share one template, so the
  roof and floor plans line up once each is calibrated on the same corner.
- **Dimension lines overshoot.** On these CAD sheets the dimension line runs about 1 mm
  on paper past each measured point. Calibrate by snapping to where the **extension line
  crosses** the dimension line: the loupe shows `SNAP ✕`. Using the dimension line's end
  instead gives 1:49.09, a 1.8% error, and the app warns you.
- Calibrating on the 10436 overall depth (crossings) gives exactly 1:50.00 on both
  sheets. Top-left masonry corner as the reference on both, offset 0,0. The 5461 width
  then measures 5461 mm (0.4 mm out). The PDF coordinates themselves are only good to
  about ±1 mm at full size.
- **Vent and PV notes are PDF markups** (comments added in a PDF editor), not CAD text.
  The app reads their full text, so `75/7` + `6/82` reads as 76. A plot number not in the
  schedule (the roof plan has `756`) turns the note into a warning, never a silent filter.
- These drawings serve **two variants**: `BELX 2401 AA04` (plots 30, 31, 82, 83, 110–113)
  and `BELX 2401 AA05` (16, 17, 26, 27, 66, 67, 71, 72, 75, 76, 124, 125, 133, 134). The
  differences between them are in the plot-filtered notes. Enter both codes on one house
  type: `BELX 2401 AA04, BELX 2401 AA05`. `BELX 2403 AA05` (plots 7, 9, 48, 50) needs its
  own drawings.
- Most lines are the same 0.24pt black, so the floor plan shows walls (grey layer and black
  poché) in strong blue and everything else faint. Windows are in the faint layer.
- The house roof finish column holds a key letter (e.g. `B`), not a description.

`npm run e2e:real` repeats this whole check on the real files in `tests/fixtures/real/`.

## Adding more house types

Do not do this until the Ellerton prototype has been checked with a tape on a real plot.
Then repeat steps 2–4 per house type. Variants (AA04 / AA05 / AA00) are separate house
types, because a plot only matches when **both** the drawing code and the name match.
Use **Layers → Layer picker** to tap any line, see its group, re-categorise or hide it, and
set the plan area. Choices are saved per house type.

## How it decides things

| Topic | Behaviour |
|---|---|
| Vector vs raster | Per page: ≥50 vector segments and <50% image coverage = A (vector), otherwise B (raster). Images over 10% of a vector page give a warning. |
| Layers (A) | Paths grouped by stroke width, colour and dash, then auto-classified (walls, openings near walls, dimensions, symbols, hatching; roof outline, ridge/hips, dashed, coloured markers). Always check them in the layer picker. |
| Plan area | Automatic: the largest connected cluster of wall (or roof outline) lines plus 15%, which hides title blocks. You can override it. |
| Opp handing | Geometry mirrored about the vertical axis through the floor reference, with the same transform for roof and floor. Text is re-placed, never mirrored. Dimension text is hidden on Opp. Raster drawings mirror the whole image (text included) and say so. |
| Plot notes | Notes with "plot(s): …" lists show only if they include the plot. Lists that can't be read reliably show a warning instead. |
| Lookup | Code AND name must match. Missing plots, duplicates and unknown handing are refused with a message, never substituted. |

## Tests

`npm test` uses **synthetic** fixtures generated by `tests/fixtures/make_fixtures.py`.
They imitate the described drawings but are **not** the real ones. To run the same
checks on the real files, copy them to `tests/fixtures/real/` (git-ignored) as
`schedule.pdf`, `ellerton_roof.pdf` and `ellerton_first_floor.pdf`.

Covered: 181 plots and no duplicates; plots 30 (As) and 31 (Opp) resolve to the same
code; 31 is mirrored with upright text; calibration measure within 1 mm; mirror twice
gives exactly the original coordinates; vector/raster detection; plot-note filtering;
lookup refusals; wrapped/centred schedule cells; auto plan area. `npm run e2e` drives
the full flow in Chromium and checks for zero external requests and offline reload.

## Files

```
index.html, css/, js/          the app (plain ES modules, no build)
  js/geom.js                   calibration, mirror, error maths (pure)
  js/pdf-extract.js            Step 0 inspection + vector extraction
  js/classify.js, text.js      line groups, text classes, plot lists
  js/schedule.js, lookup.js    schedule parser and plot resolution
  js/scene.js                  builds the overlay in world mm (pure, tested)
  js/viewer.js, render.js      touch canvas, loupe, drawing
vendor/pdfjs/                  PDF.js 4.10.38 legacy build (Apache-2.0), bundled
sw.js                          generated offline cache (npm run build:sw)
tools/inspect-pdf.mjs          Step 0 CLI
tests/                         node tests, fixtures generator, e2e
```
