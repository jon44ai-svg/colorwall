/**
 * End-to-end pipeline check against the real embedded room photo.
 *
 *   node tools/pipeline.mjs [--code 6151P] [--scale 0.6] [--tol 18] [--edge 0.55]
 *
 * Runs the exact CORE code from index.html: decode -> LAB -> Sobel -> BFS ->
 * feather -> composite, prints per-region stats, and writes a PNG preview so
 * the paint result can be eyeballed.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const args = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : dflt;
};

const html = readFileSync(join(root, 'index.html'), 'utf8');
const coreSrc = html.slice(
  html.indexOf('/* @@CORE-BEGIN@@ */'),
  html.indexOf('/* @@CORE-END@@ */')
);
const CORE = new Function(coreSrc + '\nreturn CORE;')();

// Pull the palette + defaults out of the app source so the check uses the
// same shades and tuning values a user starts with.
const palStart = html.indexOf('var PALETTE = [');
const palEnd = html.indexOf('var CAT_LABEL');
const paletteSrc = html.substring(palStart, palEnd);
const PALETTE = new Function('CORE', paletteSrc + '\nreturn PALETTE;')(CORE);

const code = arg('code', '6151P');
const scale = parseFloat(arg('scale', '0.55'));
const tol = parseFloat(arg('tol', '22'));
const edgeGuard = parseFloat(arg('edge', '0.55'));
const feather = parseFloat(arg('feather', '1.5'));
const heightCut = parseFloat(arg('height', '1'));
const spanMin = parseFloat(arg('spanMin', '0'));
const spanMax = parseFloat(arg('spanMax', '1'));
const outPath = arg('out', join(root, 'tools', 'out', 'preview.png'));

const paint = PALETTE.find((c) => c.code === code);
if (!paint) throw new Error('unknown colour code ' + code);

/* ---------------- decode ---------------- */
const raw = jpeg.decode(readFileSync(join(root, 'assets', 'room.jpg')), { useTArray: true });
const SW = Math.round(raw.width * scale);
const SH = Math.round(raw.height * scale);

// Nearest-ish area resample (box filter) to keep the check resolution-honest.
function resample(src, sw, sh, dw, dh) {
  const out = new Uint8ClampedArray(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const y0 = Math.floor((y * sh) / dh), y1 = Math.max(y0 + 1, Math.floor(((y + 1) * sh) / dh));
    for (let x = 0; x < dw; x++) {
      const x0 = Math.floor((x * sw) / dw), x1 = Math.max(x0 + 1, Math.floor(((x + 1) * sw) / dw));
      let r = 0, g = 0, b = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const p = (yy * sw + xx) * 4;
          r += src[p]; g += src[p + 1]; b += src[p + 2]; n++;
        }
      }
      const o = (y * dw + x) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
    }
  }
  return out;
}

const W = SW, H = SH;
const data = resample(raw.data, raw.width, raw.height, W, H);
const N = W * H;
console.log(`image ${W}x${H} (${N} px)`);

/* ---------------- buffers ---------------- */
let t = Date.now();
const lab = CORE.buildLab(data, W, H);
const tLab = Date.now() - t;
t = Date.now();
const edge = CORE.consolidateGradient(CORE.sobel(lab.L, W, H), W, H, 1);
const tSobel = Date.now() - t;
const tex = CORE.textureMap(lab.L, W, H, 2);
const base = CORE.textureBaseline(edge, W, H);
console.log(`buildLab ${tLab}ms · sobel ${tSobel}ms · texture baseline ${base.toFixed(2)}`);

/* ---------------- segmentation ---------------- */
const featherPx = feather * Math.max(1, W / 1400);
const probes = args.includes('--auto')
  ? [[0.5, 0.34], [0.18, 0.52], [0.84, 0.46], [0.34, 0.2], [0.66, 0.7]]
  : [[0.62, 0.4]];

const regions = [];
t = Date.now();
for (const [px, py] of probes) {
  const sx = Math.round(W * px), sy = Math.round(H * py);
  let seg = CORE.segmentWall({ W, H, lab, edge, tex, seedX: sx, seedY: sy, tol, edgeGuard, baseline: base });
  // Mirror the app's post-processing exactly.
  seg.mask = CORE.despeckle(seg.mask, W, H, 2);
  seg.mask = CORE.openMask(seg.mask, W, H, Math.max(1, Math.round(W / 700)));
  seg.mask = CORE.keepComponent(seg.mask, W, H, seg.seedIndex);
  seg.mask = CORE.fillHoles(seg.mask, W, H);
  seg.mask = CORE.despeckle(seg.mask, W, H, 1);
  seg.count = 0;
  for (let q = 0; q < seg.mask.length; q++) if (seg.mask[q]) seg.count++;
  if (seg.count < Math.max(64, N * 0.0015)) { console.log(`  probe ${px},${py}: too small (${seg.count}px)`); continue; }
  const dup = regions.find((r) => CORE.iou(r.mask, seg.mask) > 0.82);
  if (dup) { console.log(`  probe ${px},${py}: duplicate of existing region`); continue; }
  regions.push({
    mask: seg.mask, count: seg.count, seedX: sx, seedY: sy,
    alphaF: CORE.featherMask(seg.mask, W, H, featherPx)
  });
  console.log(`  probe ${px},${py} -> ${(seg.count / N * 100).toFixed(1)}% of frame`);
}
const tSeg = Date.now() - t;
console.log(`segmentation ${tSeg}ms for ${regions.length} region(s)`);

/* ---------------- composite ---------------- */
const alpha = new Float32Array(N);
for (const r of regions) for (let i = 0; i < N; i++) if (r.alphaF[i] > alpha[i]) alpha[i] = r.alphaF[i];

const src = new Uint8ClampedArray(data);
const dst = new Uint8ClampedArray(data);
const soft = Math.max(1.5, W * 0.0018);
const wins = CORE.windows(W, H, heightCut, spanMin, spanMax, soft);
const ref = CORE.meanColour(src, W, H, regions);

t = Date.now();
const res = CORE.composite({
  src, dst, alpha, W, H,
  colWin: wins.colWin, rowWin: wins.rowWin,
  color: paint.rgb, ref, light: 1, sheen: true
});
const tComp = Date.now() - t;
console.log(`composite ${tComp}ms · painted ${(res.painted / N * 100).toFixed(1)}% · ref ${ref.map((v) => v.toFixed(0)).join(',')}`);

/* ---------------- leak checks ---------------- */
// Known non-wall zones in the default photo (fractions of the frame).
const zones = [
  // [label, x0, y0, x1, y1] in frame fractions — areas that must NOT be painted
  ['duvet / folded bedding', 0.30, 0.945, 0.85, 1.0],
  ['nightstand + vase', 0.76, 0.80, 0.86, 0.92],
  ['lamp shade', 0.86, 0.58, 0.96, 0.70],
  ['picture frame', 0.245, 0.30, 0.39, 0.62],
  ['window + foliage', 0.0, 0.30, 0.10, 0.60],
  ['curtain', 0.11, 0.20, 0.16, 0.70]
];
let leaks = 0;
for (const [name, x0, y0, x1, y1] of zones) {
  const ax = Math.round(W * x0), bx = Math.round(W * x1);
  const ay = Math.round(H * y0), by = Math.round(H * y1);
  let hit = 0, tot = 0;
  for (let y = ay; y < by; y++) {
    for (let x = ax; x < bx; x++) {
      tot++;
      if (alpha[y * W + x] > 0.5) hit++;
    }
  }
  const pct = tot ? (hit / tot) * 100 : 0;
  const bad = pct > 18;
  if (bad) leaks++;
  console.log(`  ${bad ? 'LEAK' : '  ok'}  ${name}: ${pct.toFixed(0)}% covered`);
}

// Wall zones must actually be painted.
for (const [name, fx, fy] of [['outer wall', 0.78, 0.25], ['outer wall low', 0.5, 0.62], ['wall above frame', 0.3, 0.28], ['wall beside lamp', 0.90, 0.30]]) {
  const i = Math.round(H * fy) * W + Math.round(W * fx);
  const pct = alpha[i] * 100;
  console.log(`  ${pct > 90 ? '  ok' : 'MISS'}  ${name}: alpha ${pct.toFixed(0)}%`);
  if (pct <= 90) leaks++;
}

/* ---------------- write preview ---------------- */
mkdirSync(dirname(outPath), { recursive: true });
const png = new PNG({ width: W, height: H });
png.data = Buffer.from(dst.buffer, dst.byteOffset, dst.byteLength);
writeFileSync(outPath, PNG.sync.write(png));
console.log('preview -> ' + outPath);

if (leaks) {
  console.error(`\n✗ ${leaks} pipeline check(s) failed`);
  process.exit(1);
}
console.log('\n✓ pipeline checks passed');
