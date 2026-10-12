// Step 0 report for one or more PDFs, entirely local.
// Usage: npm run inspect -- path/to/drawing.pdf [more.pdf ...]
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectPdf } from '../js/pdf-extract.js';

const fontDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', 'pdfjs-dist', 'standard_fonts') + '/';
for (const f of process.argv.slice(2)) {
  const r = await inspectPdf(pdfjs, new Uint8Array(fs.readFileSync(f)), { standardFontDataUrl: fontDir, verbosity: 0 });
  console.log(`\n=== ${path.basename(f)} : ${r.pageCount} page(s)`);
  for (const p of r.pages) {
    console.log(`-- page ${p.page}: ${p.widthMm} x ${p.heightMm} mm (${p.paper}), ${p.opCount} ops, ${p.segCount} vector segments, ${p.imageCount} images (${Math.round(p.imageCoverage * 100)}% cover), ${p.textItems} text items`);
    console.log(`   rooms: ${p.rooms.join(', ') || '(none)'}`);
    console.log(`   dimension-like text: ${p.dims.slice(0, 30).join(', ') || '(none)'}`);
    console.log(`   stated scales: ${p.statedScales.map((s) => '1:' + s).join(', ') || '(none found)'}`);
    console.log(`   METHOD ${p.method}: ${p.reasons.join(' ')}`);
  }
}
