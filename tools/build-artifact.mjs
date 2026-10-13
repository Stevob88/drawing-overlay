// Builds a single self-contained page (inline CSS + bundled JS) for hosts that only allow
// inline code, e.g. a claude.ai artifact. PDF.js worker and fonts ship as separate files.
// Usage: node tools/build-artifact.mjs <outDir>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(process.argv[2] || path.join(root, 'dist-artifact'));
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'vendor/pdfjs/standard_fonts'), { recursive: true });
const res = await build({ entryPoints: [path.join(root, 'js/app.js')], bundle: true, format: 'esm', minify: true, write: false, target: 'es2020', legalComments: 'none' });
const js = res.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const css = fs.readFileSync(path.join(root, 'css/app.css'), 'utf8');
const html = `<title>RoofLine</title>
<style>
${css}
body { background: var(--bg); }
</style>
<div id="app" aria-live="polite"><p class="boot">Loading RoofLine…</p></div>
<div id="sheet" class="sheet" hidden></div>
<div id="toast" class="toast" hidden></div>
<script type="module">
${js}
</script>
`;
fs.writeFileSync(path.join(out, 'index.html'), html);
// Some hosts refuse text files with raw control bytes; pdf.js has a few inside string
// literals. In valid JS they can only sit in strings/templates/regexes, where \xNN is identical.
const worker = fs.readFileSync(path.join(root, 'vendor/pdfjs/pdf.worker.min.mjs'));
const parts = [];
for (const c of worker) parts.push(c < 32 && c !== 9 && c !== 10 && c !== 13 ? Buffer.from('\\x' + c.toString(16).padStart(2, '0')) : Buffer.from([c]));
fs.writeFileSync(path.join(out, 'vendor/pdfjs/pdf.worker.min.mjs'), Buffer.concat(parts));
for (const f of fs.readdirSync(path.join(root, 'vendor/pdfjs/standard_fonts'))) {
  if (f.endsWith('.ttf')) fs.copyFileSync(path.join(root, 'vendor/pdfjs/standard_fonts', f), path.join(out, 'vendor/pdfjs/standard_fonts', f));
}
console.log('built', out, (html.length / 1024).toFixed(0) + ' KB page');
