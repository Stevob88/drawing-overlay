"""
Generate SYNTHETIC test fixtures for RoofLine.

These are NOT the real Ellerton drawings. They imitate the structure the real
drawings are described as having (vector walls, room names, 10436 overall
width, 10113 wall plate dimension, plot-list notes, a multi-page plot schedule
with a wrapped row at plot 63) so the parser / geometry / mirror code can be
tested without committing confidential drawings to git.

Real drawings go in tests/fixtures/real/ (git-ignored) and are picked up by
the test suite automatically.

Run:  python3 tests/fixtures/make_fixtures.py
"""
import io
import os
from reportlab.lib.pagesizes import A3, landscape
from reportlab.pdfgen import canvas

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "synthetic")
os.makedirs(OUT, exist_ok=True)

PAGE_W, PAGE_H = landscape(A3)  # 1190.55 x 841.89 pt
SCALE = 50  # 1:50
MM2PT = 72 / 25.4 / SCALE  # real-world mm -> pt on paper

W = 10436.0  # overall masonry width (mm)
D = 6200.0   # overall masonry depth (mm)
CAV = 300.0  # external wall thickness
PART = 100.0  # partition thickness


class Plan:
    """Draw in real-world mm with origin at a chosen page position (pt)."""

    def __init__(self, c, ox, oy, scale=SCALE):
        self.c, self.ox, self.oy = c, ox, oy
        self.k = 72 / 25.4 / scale  # mm -> pt at this drawing scale

    def p(self, x, y):
        # mm (x right, y down from top-left outer corner) -> page pt (y up)
        return self.ox + x * self.k, self.oy - y * self.k

    def line(self, x1, y1, x2, y2):
        a, b = self.p(x1, y1)
        e, f = self.p(x2, y2)
        self.c.line(a, b, e, f)

    def rect(self, x, y, w, h, fill=0, stroke=1):
        a, b = self.p(x, y + h)
        self.c.rect(a, b, w * self.k, h * self.k, fill=fill, stroke=stroke)

    def text(self, x, y, s, size=9, centre=True):
        a, b = self.p(x, y)
        if centre:
            self.c.drawCentredString(a, b, s)
        else:
            self.c.drawString(a, b, s)

    def circle(self, x, y, r_mm, fill=0):
        a, b = self.p(x, y)
        self.c.circle(a, b, r_mm * self.k, fill=fill, stroke=1)


def title_block(c, title, code, rev_date, scale_text="Scale 1:50 @ A3"):
    c.setLineWidth(0.5)
    c.setStrokeColorRGB(0, 0, 0)
    c.rect(PAGE_W - 260, 20, 240, 160)
    c.setFont("Helvetica-Bold", 14)
    c.drawString(PAGE_W - 250, 155, "ELLERTON")
    c.setFont("Helvetica", 10)
    c.drawString(PAGE_W - 250, 135, title)
    c.drawString(PAGE_W - 250, 115, "Drawing no. " + code)
    if scale_text:
        c.drawString(PAGE_W - 250, 95, scale_text)
    c.drawString(PAGE_W - 250, 75, "Date " + rev_date)
    c.drawString(PAGE_W - 250, 55, "SYNTHETIC TEST FIXTURE - NOT A REAL DRAWING")


def dim_line(pl, x1, x2, y, label):
    c = pl.c
    c.setLineWidth(0.18)
    c.setStrokeColorRGB(0, 0, 0)
    pl.line(x1, y, x2, y)
    for x in (x1, x2):
        pl.line(x, y - 150, x, y + 150)  # extension / tick
        pl.line(x - 80, y + 80, x + 80, y - 80)  # oblique tick
    c.setFont("Helvetica", 8)
    pl.text((x1 + x2) / 2, y - 100, label)


def floor_plan(path, raster=False):
    c = canvas.Canvas(path, pagesize=(PAGE_W, PAGE_H))
    pl = Plan(c, 120, 640)
    # External walls: thick
    c.setStrokeColorRGB(0, 0, 0)
    c.setLineWidth(0.7)
    pl.rect(0, 0, W, D)
    pl.rect(CAV, CAV, W - 2 * CAV, D - 2 * CAV)
    # Partitions (double thin-ish lines, 0.5)
    c.setLineWidth(0.5)
    xs = [3600, 6300]
    for x in xs:
        pl.line(x, CAV, x, 3400)
        pl.line(x + PART, CAV, x + PART, 3400)
    pl.line(CAV, 3400, W - CAV, 3400)
    pl.line(CAV, 3400 + PART, W - CAV, 3400 + PART)
    pl.line(5000, 3400 + PART, 5000, D - CAV)
    pl.line(5000 + PART, 3400 + PART, 5000 + PART, D - CAV)
    # Window openings (thin lines across external wall)
    c.setLineWidth(0.25)
    for x0 in (1000, 7400):
        for off in (0, 120, 180):
            pl.line(x0, off, x0 + 1200, off)
    # Room names
    c.setFillColorRGB(0, 0, 0)
    c.setFont("Helvetica-Bold", 9)
    pl.text(1900, 1900, "BED 1")
    pl.text(5000, 1900, "BATH")
    pl.text(8300, 1900, "BED 2")
    pl.text(2600, 4900, "LANDING")
    pl.text(7600, 4900, "EN-SUITE")
    # Electrical symbols (coloured, small circles)
    c.setStrokeColorRGB(0.0, 0.5, 0.0)
    c.setLineWidth(0.25)
    for (x, y) in [(1500, 1200), (8000, 1200), (2500, 4500)]:
        pl.circle(x, y, 120)
        pl.line(x - 85, y - 85, x + 85, y + 85)
    # Dimensions
    dim_line(pl, 0, W, -900, "10436")
    dim_line(pl, 0, 3600, D + 700, "3600")
    # Hatching inside the stair void (many short parallel lines)
    c.setStrokeColorRGB(0.3, 0.3, 0.3)
    c.setLineWidth(0.1)
    for i in range(12):
        pl.line(3800 + i * 100, 3600, 3800 + i * 100 + 600, 4200)
    # Plot-list notes
    c.setFillColorRGB(0, 0, 0)
    c.setFont("Helvetica", 8)
    c.drawString(120, 160, "Rad position to plots: 30, 31, 82, 83, 110, 111")
    c.drawString(120, 148, "Extract fan omitted to plots: 45, 46")
    title_block(c, "FIRST FLOOR PLAN", "BELX 2401 AA04", "2026-03-01")
    c.showPage()
    c.save()


def roof_plan(path, scale=SCALE, scale_text="Scale 1:50 @ A3"):
    c = canvas.Canvas(path, pagesize=(PAGE_W, PAGE_H))
    # Deliberately placed at a different page origin to the floor plan
    pl = Plan(c, 160, 600, scale)
    wp_in = (W - 10113.0) / 2  # 161.5 mm: wall plate outer face inside masonry face
    ovh = 300.0  # eaves overhang beyond masonry face
    # Roof outline (thick)
    c.setStrokeColorRGB(0, 0, 0)
    c.setLineWidth(0.7)
    pl.rect(-ovh, -ovh, W + 2 * ovh, D + 2 * ovh)
    # Ridge and hips
    c.setLineWidth(0.5)
    pl.line(D / 2, D / 2, W - D / 2, D / 2)
    for (x, y) in [(-ovh, -ovh), (-ovh, D + ovh)]:
        pl.line(x, y, D / 2, D / 2)
    for (x, y) in [(W + ovh, -ovh), (W + ovh, D + ovh)]:
        pl.line(x, y, W - D / 2, D / 2)
    # Wall plate outer faces (dashed)
    c.setDash(6, 3)
    c.setLineWidth(0.35)
    pl.rect(wp_in, wp_in, W - 2 * wp_in, D - 2 * wp_in)
    c.setDash()
    # Tile vents (red markers)
    c.setStrokeColorRGB(0.85, 0, 0)
    c.setLineWidth(0.35)
    for (x, y) in [(2000, 1000), (8400, 1000), (5200, 5200)]:
        pl.circle(x, y, 150)
    c.setFillColorRGB(0.85, 0, 0)
    c.setFont("Helvetica", 7)
    pl.text(2000, 700, "TV")
    pl.text(8400, 700, "TV")
    pl.text(5200, 4900, "TV")
    # Rainwater pipes
    c.setStrokeColorRGB(0, 0, 0.8)
    for (x, y) in [(-150, D + 150), (W + 150, D + 150)]:
        pl.circle(x, y, 60)
    c.setFillColorRGB(0, 0, 0.8)
    pl.text(-150, D + 500, "RWP")
    # Dimensions
    c.setStrokeColorRGB(0, 0, 0)
    c.setFillColorRGB(0, 0, 0)
    dim_line(pl, wp_in, W - wp_in, -1100, "10113")
    c.setFont("Helvetica", 8)
    c.drawString(160, 175, "10113 outer faces of wall plates")
    c.drawString(160, 163, "Trussed rafters at 600 centres. Tile vents to plots: 30, 31, 63")
    c.drawString(160, 151, "Solar PV to plots: 5, 6")
    title_block(c, "ROOF PLAN", "BELX 2401 AA04", "2026-03-01", scale_text)
    c.showPage()
    c.save()


def raster_floor(vector_path, path):
    """Flatten the vector floor plan into an image-only PDF (Method B test)."""
    from PIL import Image, ImageDraw
    dpi = 150
    pw, ph = int(PAGE_W / 72 * dpi), int(PAGE_H / 72 * dpi)
    img = Image.new("L", (pw, ph), 255)
    d = ImageDraw.Draw(img)
    s = dpi / 72
    ox, oy = 120, 640

    def P(x, y):
        return ((ox + x * MM2PT) * s, (PAGE_H - (oy - y * MM2PT)) * s)
    d.rectangle([P(0, 0), P(W, D)], outline=0, width=2)
    d.rectangle([P(CAV, CAV), P(W - CAV, D - CAV)], outline=0, width=2)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    buf.seek(0)
    from reportlab.lib.utils import ImageReader
    c = canvas.Canvas(path, pagesize=(PAGE_W, PAGE_H))
    c.drawImage(ImageReader(buf), 0, 0, PAGE_W, PAGE_H)
    c.showPage()
    c.save()


COLS = [
    ("PLOT\nNO", 40), ("HOUSE\nTYPE", 80), ("SALES NAME", 110), ("FLAT/HOUSE\nTYPE", 70),
    ("HANDINGS", 60), ("HOUSE\nRANGE", 60), ("ACTUAL PORTAL\nCODE", 110), ("BASE CODE", 100),
    ("BEDS", 35), ("ROOF FINISH", 110), ("ROOF TYPE", 70),
]

TYPES = [
    ("ELLERTON", "Ellerton Elder", "House", "Elder", "BELX 2401 AA04", "BELX 2401", 4),
    ("ELLERTON", "Ellerton Elder", "House", "Elder", "BELX 2401 AA05", "BELX 2401", 4),
    ("ELLERTON", "Ellerton Elder", "House", "Elder", "BELX 2401 AA00", "BELX 2401", 4),
    ("HADLEY", "Hadley", "House", "Classic", "BHAD 2201 AA02", "BHAD 2201", 3),
    ("ASHDOWN", "Ashdown", "Flat", "Classic", "FASH 1101 AA01", "FASH 1101", 2),
]


def schedule_rows():
    rows = []
    for n in range(1, 182):
        t = TYPES[n % len(TYPES)]
        if n in (30, 31):
            t = TYPES[0]
        hand = "As" if n % 2 == 0 else "Opp"
        if n == 30:
            hand = "As"
        if n == 31:
            hand = "Opp"
        roof = "Marley Edgemere Slate Grey" if n % 3 else "Russell Grampian Brown"
        rtype = "Hipped" if t[0] == "ELLERTON" else "Gable"
        rows.append([str(n), t[0], t[1], t[2], hand, t[3], t[4], t[5], str(t[6]), roof, rtype])
    # Plot 63 wraps: long sales name over two lines, blank house range
    rows[62][2] = "Hadley (show home\nvariant)"
    rows[62][5] = ""
    # Some blank roof types
    rows[99][10] = ""
    return rows


def schedule(path):
    c = canvas.Canvas(path, pagesize=(PAGE_W, PAGE_H))
    rows = schedule_rows()
    per_page = 45
    row_h = 15
    for p0 in range(0, len(rows), per_page):
        c.setFont("Helvetica-Bold", 12)
        c.drawString(30, PAGE_H - 30, "PLOT VARIATION SHEET - SYNTHETIC TEST FIXTURE")
        y = PAGE_H - 60
        x = 30
        c.setFont("Helvetica-Bold", 7)
        for name, w in COLS:
            for i, part in enumerate(name.split("\n")):
                c.drawString(x + 2, y - i * 8, part)
            x += w
        y -= 24
        c.setFont("Helvetica", 7)
        for r in rows[p0:p0 + per_page]:
            x = 30
            extra = 0
            for (name, w), val in zip(COLS, r):
                for i, part in enumerate(val.split("\n")):
                    c.drawString(x + 2, y - i * 8, part)
                    extra = max(extra, i)
                x += w
            c.setLineWidth(0.2)
            c.line(30, y - 4 - extra * 8, x, y - 4 - extra * 8)
            y -= row_h + extra * 8
        c.showPage()
    c.save()


if __name__ == "__main__":
    floor_plan(os.path.join(OUT, "ellerton_first_floor.pdf"))
    roof_plan(os.path.join(OUT, "ellerton_roof.pdf"))
    raster_floor(None, os.path.join(OUT, "ellerton_first_floor_raster.pdf"))
    # Roof plans drawn at 1:100 (floor plan is 1:50): scale stated / not stated / stated for the
    # wrong paper size (issued 1:50 @A1, saved on an A3 page, so really 1:100 here).
    roof_plan(os.path.join(OUT, "ellerton_roof_1to100.pdf"), 100, "Scale 1:100 @ A3")
    roof_plan(os.path.join(OUT, "ellerton_roof_1to100_unstated.pdf"), 100, "")
    roof_plan(os.path.join(OUT, "ellerton_roof_1to100_wrongpaper.pdf"), 100, "Scale 1:50 @ A1")
    print("written to", OUT)
