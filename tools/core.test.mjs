/**
 * Core unit tests for the Colortrend wall simulator maths.
 *
 *   node tools/core.test.mjs
 *
 * The CORE module is extracted straight out of index.html between the
 * @@CORE-BEGIN@@ / @@CORE-END@@ markers, so these assertions exercise the
 * exact functions the browser runs — no duplicated implementation drift.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '..', 'index.html'), 'utf8');

const start = html.indexOf('/* @@CORE-BEGIN@@ */');
const end = html.indexOf('/* @@CORE-END@@ */');
if (start < 0 || end < 0) throw new Error('CORE markers not found in index.html');
const coreSrc = html.slice(start, end);

const CORE = new Function(coreSrc + '\nreturn CORE;')();

let pass = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; return; }
  failures.push(name + (detail ? ' — ' + detail : ''));
}
function near(name, a, b, eps = 1e-3) {
  ok(name, Math.abs(a - b) <= eps, `got ${a}, expected ${b}`);
}

/* ---------------- colour space ---------------- */
near('white L*', CORE.rgbToLab(255, 255, 255)[0], 100, 0.02);
near('black L*', CORE.rgbToLab(0, 0, 0)[0], 0, 0.02);
ok('black has no chroma', Math.abs(CORE.rgbToLab(0, 0, 0)[1]) < 0.01);
near('mid grey L*', CORE.rgbToLab(119, 119, 119)[0], 50, 0.6);

const red = CORE.rgbToLab(255, 0, 0);
ok('red is warm in LAB (a*>0, b*>0)', red[1] > 60 && red[2] > 60, JSON.stringify(red));
const blue = CORE.rgbToLab(0, 0, 255);
ok('blue has negative b*', blue[2] < -100, JSON.stringify(blue));
ok('a* separates red from green',
  CORE.rgbToLab(255, 0, 0)[1] > CORE.rgbToLab(0, 255, 0)[1]);

// Neutral greys should sit on the achromatic axis.
for (const v of [32, 96, 160, 224]) {
  const lab = CORE.rgbToLab(v, v, v);
  ok(`grey ${v} is achromatic`, Math.abs(lab[1]) < 0.05 && Math.abs(lab[2]) < 0.05,
    `a=${lab[1]} b=${lab[2]}`);
}

ok('hex round-trip', CORE.rgbToHex(...CORE.hexToRgb('#C3B7CE')) === '#c3b7ce');
ok('short hex expands', JSON.stringify(CORE.hexToRgb('#f80')) === JSON.stringify([255, 136, 0]));
ok('invalid hex is safe', JSON.stringify(CORE.hexToRgb('nope')) === JSON.stringify([0, 0, 0]));

/* ---------------- Sobel ---------------- */
{
  const W = 12, H = 12, L = new Float32Array(W * H).fill(50);
  for (let y = 0; y < H; y++) for (let x = 6; x < W; x++) L[y * W + x] = 90;
  const edge = CORE.sobel(L, W, H);

  // A 40 L* step over one pixel must read 40 with the 1/4 solver scaling.
  ok('gradient magnitude matches the L* step', Math.abs(edge[5 * W + 6] - 40) < 0.5,
    `edge=${edge[5 * W + 6]}`);
  ok('flat wall has no gradient', edge[3 * W + 2] === 0, `flat=${edge[3 * W + 2]}`);
  ok('step edge is vertical', edge[7 * W + 6] > 30 && edge[2 * W + 3] === 0);
  // Absolute units: no normalisation to the strongest edge in the frame.
  // Absolute units: no normalisation to the strongest edge in the frame.
  const W2 = 8, H2 = 8, L2 = new Float32Array(W2 * H2).fill(50);
  for (let y = 0; y < H2; y++) L2[y * W2 + 4] = 90;         // same 40 step, larger frame
  L2[0] = 255;                                               // one extreme outlier pixel
  const e2 = CORE.sobel(L2, W2, H2);
  ok('an outlier pixel does not rescale the whole frame',
    Math.abs(e2[4 * W2 + 3] - 40) < 0.5, `edge=${e2[4 * W2 + 3]}`);
}

/* ---------------- gradient consolidation ---------------- */
{
  const W = 20, H = 6, g = new Float32Array(W * H);
  g[2 * W + 10] = 20;              // a single-pixel (noisy) ridge
  const soft = CORE.consolidateGradient(g, W, H, 1);
  ok('consolidation spreads a 1px ridge', soft[2 * W + 9] > 0 && soft[2 * W + 9] < 20,
    `neighbour=${soft[2 * W + 9]}`);
  ok('consolidation lowers the peak', soft[2 * W + 10] < 20, `peak=${soft[2 * W + 10]}`);
  ok('consolidation does not create far-field noise', soft[0] === 0);
  ok('radius 0 is identity', CORE.consolidateGradient(g, W, H, 0)[2 * W + 10] === 20);

  // A 3px soft ramp should become a *continuous* ridge after consolidation:
  // no usable gap for a flood fill to slip through.
  const W3 = 40, H3 = 8, g3 = new Float32Array(W3 * H3);
  for (let y = 0; y < H3; y++) { g3[y * W3 + 19] = 6; g3[y * W3 + 20] = 12; g3[y * W3 + 21] = 6; }
  const c3 = CORE.consolidateGradient(g3, W3, H3, 1);
  const col = [18, 19, 20, 21, 22].map((x) => c3[4 * W3 + x]);
  ok('soft ramp stays continuous after consolidation',
    col.every((v) => v > 1.5), `column=${col.map((v) => v.toFixed(1))}`);
  ok('soft ramp has no zero-width gap',
    Math.min(...col) > 0.2 * Math.max(...col), `min=${Math.min(...col)}`);
}

/* ---------------- edge-guard mapping ---------------- */
{
  const base = 0.64;                         // typical photo texture baseline
  const strict = CORE.edgeLimit(1, base), loose = CORE.edgeLimit(0, base), mid = CORE.edgeLimit(0.55, base);
  ok('edgeLimit is monotonic', strict < mid && mid < loose, `${strict} < ${mid} < ${loose}`);
  ok('edgeLimit(0) is the most permissive (~10x baseline)', Math.abs(loose - base * 10) < 1e-9, `loose=${loose}`);
  ok('edgeLimit(1) is the strictest (1x baseline)', Math.abs(strict - base) < 1e-9, `strict=${strict}`);
  ok('default guard sits in a useful band', mid > base * 2 && mid < base * 6, `mid=${mid}`);
  ok('edgeLimit clamps out-of-range input',
    CORE.edgeLimit(-5, base) === loose && CORE.edgeLimit(9, base) === strict);
  ok('edgeLimit defaults to an un-scaled threshold', Math.abs(CORE.edgeLimit(1) - 1) < 1e-9);
}

/* ---------------- texture baseline & local contrast ---------------- */
{
  // A realistic mix: mostly flat wall plus a few textured patches.
  const W = 40, H = 40, g = new Float32Array(W * H);
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < g.length; i++) g[i] = 0.4 + rnd() * 0.3;
  for (let i = 0; i < 200; i++) g[i * 7 % g.length] = 20 + rnd() * 30;
  const base = CORE.textureBaseline(g, W, H);
  ok('texture baseline ignores the busy tail', base > 0.2 && base < 2, `baseline=${base}`);
  ok('texture baseline is never degenerate', CORE.textureBaseline(new Float32Array(W * H), W, H) >= 0.05);

  // Local standard deviation must separate a smooth ramp (lighting) from noise.
  const W2 = 30, H2 = 30;
  const ramp = new Float32Array(W2 * H2), noise = new Float32Array(W2 * H2);
  for (let y = 0; y < H2; y++) {
    for (let x = 0; x < W2; x++) {
      ramp[y * W2 + x] = 50 + (x / W2) * 30;                 // smooth daylight gradient
      noise[y * W2 + x] = 50 + ((x * 7 + y * 13) % 11) * 2.2; // fabric-like micro texture
    }
  }
  const tRamp = CORE.textureMap(ramp, W2, H2, 2);
  const tNoise = CORE.textureMap(noise, W2, H2, 2);
  ok('a lighting gradient reads as smooth wall', tRamp[15 * W2 + 15] < 1.5, `sigma=${tRamp[15 * W2 + 15]}`);
  ok('micro texture reads as fabric', tNoise[15 * W2 + 15] > 3, `sigma=${tNoise[15 * W2 + 15]}`);
  ok('textureMap never returns NaN', tRamp.every((v) => Number.isFinite(v)));
}

/* ---------------- BFS flood fill ---------------- */
function syntheticScene(W, H) {
  // Single wall, flat colour, with a dark "bed" block in the lower rows and a
  // soft lighting gradient across the wall.
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = (y * W + x) * 4;
      let r = 205, g = 200, b = 190;
      const shade = 1 - 0.18 * (x / W);        // gentle light falloff
      r *= shade; g *= shade; b *= shade;
      if (y > H * 0.72 && x > W * 0.15) { r = 60; g = 55; b = 52; }   // bed
      if (y < H * 0.1) { r = 250; g = 250; b = 250; }                 // ceiling
      data[p] = r; data[p + 1] = g; data[p + 2] = b; data[p + 3] = 255;
    }
  }
  return data;
}

{
  const W = 90, H = 70;
  const data = syntheticScene(W, H);
  const lab = CORE.buildLab(data, W, H);
  const edge = CORE.consolidateGradient(CORE.sobel(lab.L, W, H), W, H, 1);
  const seg = CORE.segmentWall({ W, H, lab, edge, seedX: 45, seedY: 35, tol: 18, edgeGuard: 0.55 });

  const at = (x, y) => seg.mask[y * W + x];
  ok('seed is inside the mask', at(45, 35) === 1);
  ok('mask does not leak into the bed', at(60, 64) === 0);
  ok('mask does not leak into the ceiling', at(45, 1) === 0);
  ok('mask reaches the far wall edge', at(80, 30) === 1, 'tol should absorb light falloff');
  ok('region area is a plausible wall', seg.count > W * H * 0.4 && seg.count < W * H * 0.9,
    `count=${seg.count} of ${W * H}`);

  // Wider tolerance can only grow the region (monotonic in ΔE).
  const wide = CORE.segmentWall({ W, H, lab, edge, seedX: 45, seedY: 35, tol: 40, edgeGuard: 0.55 });
  ok('higher ΔE tolerance grows the mask', wide.count >= seg.count);

  // Zero edge guard should be at least as permissive.
  const loose = CORE.segmentWall({ W, H, lab, edge, seedX: 45, seedY: 35, tol: 18, edgeGuard: 0 });
  ok('relaxing Sobel guard grows the mask', loose.count >= seg.count);

  // Seeding on the bed must not swallow the wall.
  const bed = CORE.segmentWall({ W, H, lab, edge, seedX: 60, seedY: 64, tol: 18, edgeGuard: 0.55 });
  ok('bed seed stays on the bed', bed.count < W * H * 0.35, `count=${bed.count}`);
  ok('bed seed excludes the wall', bed.mask[30 * W + 45] === 0);

  // Seed exactly on the border must be clamped, not crash.
  const corner = CORE.segmentWall({ W, H, lab, edge, seedX: -20, seedY: 9999, tol: 18, edgeGuard: 0.55 });
  ok('out-of-range seed is clamped', corner.count >= 1);
}

/* ---------------- feathering ---------------- */
{
  const W = 40, H = 40;
  const mask = new Uint8Array(W * H);
  for (let y = 10; y < 30; y++) for (let x = 10; x < 30; x++) mask[y * W + x] = 1;

  const hard = CORE.featherMask(mask, W, H, 0);
  ok('zero feather is a no-op', hard[15 * W + 15] === 1 && hard[5 * W + 5] === 0);

  const soft = CORE.featherMask(mask, W, H, 2);
  ok('feather keeps the core solid', soft[20 * W + 20] > 0.99, `core=${soft[20 * W + 20]}`);
  ok('feather creates a gradient at the edge',
    soft[20 * W + 9] > 0 && soft[20 * W + 9] < 0.5, `edge=${soft[20 * W + 9]}`);
  ok('feather leaves far pixels empty', soft[2 * W + 2] < 0.001);
  let max = 0;
  for (const v of soft) if (v > max) max = v;
  ok('feathered mask is normalised (max <= 1)', max <= 1.0001, `max=${max}`);
}

/* ---------------- boundary windows ---------------- */
{
  const W = 100, H = 100;
  const w = CORE.windows(W, H, 0.5, 0.2, 0.8, 1.5);
  ok('window: above cutoff is painted', w.rowWin[10] === 1);
  ok('window: below cutoff is blocked', w.rowWin[90] === 0);
  ok('window: inside span is painted', w.colWin[50] === 1);
  ok('window: outside span is blocked', w.colWin[5] === 0 && w.colWin[95] === 0);
  ok('window: edge is soft', w.colWin[19] > 0 && w.colWin[19] < 1);

  const full = CORE.windows(W, H, 1, 0, 1, 1.5);
  ok('default windows allow everything', full.colWin[0] === 1 && full.rowWin[99] === 1);
}

/* ---------------- despeckle, morphology, connectivity ---------------- */
{
  const W = 21, H = 21;
  const mask = new Uint8Array(W * H).fill(1);
  mask[10 * W + 10] = 0;                    // a pinhole
  const d = CORE.despeckle(mask, W, H, 2);
  ok('despeckle closes an isolated hole', d[10 * W + 10] === 1);
  const speck = new Uint8Array(W * H);
  speck[5 * W + 5] = 1;
  ok('despeckle removes an isolated speck', CORE.despeckle(speck, W, H, 2)[5 * W + 5] === 0);

  // Two blobs joined by a 1px isthmus: opening must sever it.
  const bridge = new Uint8Array(W * H);
  for (let y = 4; y < 9; y++) for (let x = 4; x < 9; x++) bridge[y * W + x] = 1;
  for (let y = 12; y < 17; y++) for (let x = 12; x < 17; x++) bridge[y * W + x] = 1;
  for (let i = 0; i < 4; i++) bridge[(9 + i) * W + (9 + i)] = 1;      // diagonal thread
  const opened = CORE.openMask(bridge, W, H, 1);
  ok('opening keeps both blobs', opened[6 * W + 6] === 1 && opened[14 * W + 14] === 1);
  ok('opening severs the thin bridge', opened[11 * W + 11] === 0);
  ok('opening does not invent pixels', opened.every((v, i) => !v || bridge[i]));
  ok('radius 0 opening is a no-op', CORE.openMask(bridge, W, H, 0) === bridge);

  // Connectivity: only the seeded component survives.
  const two = new Uint8Array(W * H);
  two[2 * W + 2] = 1; two[2 * W + 3] = 1;
  two[15 * W + 15] = 1; two[15 * W + 16] = 1; two[15 * W + 17] = 1;
  const kept = CORE.keepComponent(two, W, H, 15 * W + 16);
  ok('keepComponent drops the far blob', kept[2 * W + 2] === 0);
  ok('keepComponent keeps the seeded blob', kept[15 * W + 15] === 1 && kept[15 * W + 17] === 1);
  ok('keepComponent result is a subset', kept.every((v, i) => !v || two[i]));
  // Seed outside the mask must not produce an empty region.
  const fallback = CORE.keepComponent(two, W, H, 0);
  ok('keepComponent falls back to the largest blob', fallback[15 * W + 15] === 1);
}

/* ---------------- hole filling ---------------- */
{
  const W = 60, H = 60;
  const mask = new Uint8Array(W * H);
  for (let y = 4; y < 56; y++) for (let x = 4; x < 56; x++) mask[y * W + x] = 1;
  mask[30 * W + 30] = 0;                       // texture pinhole
  mask[20 * W + 20] = 0; mask[20 * W + 21] = 0; // small enclosed gap
  // A large enclosed "picture frame" that must survive.
  for (let y = 40; y < 52; y++) for (let x = 10; x < 22; x++) mask[y * W + x] = 0;

  const filled = CORE.fillHoles(mask, W, H);
  ok('fillHoles closes an interior pinhole', filled[30 * W + 30] === 1);
  ok('fillHoles closes a small enclosed gap', filled[20 * W + 20] === 1);
  ok('fillHoles leaves large enclosed objects alone', filled[45 * W + 15] === 0);
  ok('fillHoles leaves the outside world alone', filled[0] === 0 && filled[H * W - 1] === 0);
  ok('fillHoles never removes painted pixels', filled.every((v, i) => v || !mask[i]));
  ok('fillHoles threshold is tunable', CORE.fillHoles(mask, W, H, 1000)[45 * W + 15] === 1);

  // A fully enclosed small ring interior is a wall pinhole and gets filled.
  const ring = new Uint8Array(W * H);
  for (let y = 2; y < 12; y++) { ring[y * W + 2] = 1; ring[y * W + 11] = 1; }
  for (let x = 2; x < 12; x++) { ring[2 * W + x] = 1; ring[11 * W + x] = 1; }
  ok('a small enclosed ring interior is filled', CORE.fillHoles(ring, W, H, 100)[6 * W + 6] === 1);
  ok('the default limit only absorbs speckle, not a 64px hole', CORE.fillHoles(ring, W, H)[6 * W + 6] === 0,
    'default limit = max(24, area*0.0003)');

  // An open bay is connected to the border and must not be sealed.
  const bay = new Uint8Array(W * H);
  for (let y = 2; y < 12; y++) { bay[y * W + 2] = 1; bay[y * W + 11] = 1; }
  for (let x = 2; x < 12; x++) { bay[2 * W + x] = 1; bay[11 * W + x] = 1; }
  for (let x = 6; x < 12; x++) bay[11 * W + x] = 0;
  ok('an open bay is not sealed', CORE.fillHoles(bay, W, H)[6 * W + 7] === 0);
}

/* ---------------- luminance-preserving composite ---------------- */
{
  const W = 8, H = 8;
  const src = new Uint8ClampedArray(W * H * 4);
  // A wall with a lighting gradient from 0.55x to 1.15x around a mid reference.
  const base = [180, 172, 160];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = (y * W + x) * 4;
      const k = 0.55 + (x / (W - 1)) * 0.6;
      src[p] = base[0] * k;
      src[p + 1] = base[1] * k;
      src[p + 2] = base[2] * k;
      src[p + 3] = 255;
    }
  }
  const dst = new Uint8ClampedArray(src);
  const alpha = new Float32Array(W * H).fill(1);
  const colWin = new Float32Array(W).fill(1);
  const rowWin = new Float32Array(H).fill(1);
  const paint = [90, 120, 160];   // a blue-ish paint

  const res = CORE.composite({
    src, dst, alpha, W, H, colWin, rowWin,
    color: paint, ref: base, light: 1, sheen: false
  });

  const px = (x) => [dst[((3 * W) + x) * 4], dst[((3 * W) + x) * 4 + 1], dst[((3 * W) + x) * 4 + 2]];
  const dark = px(0), bright = px(W - 1);
  ok('composite reports painted pixels', res.painted === W * H, JSON.stringify(res));

  // Luminance must still be modulated by the original lighting: the shadowed
  // end has to stay darker than the lit end.
  const lum = (c) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
  ok('shadows survive painting', lum(dark) < lum(bright) * 0.7,
    `dark=${lum(dark).toFixed(1)} bright=${lum(bright).toFixed(1)}`);

  // The painted hue should shift towards the blue paint.
  ok('paint colour is applied', bright[2] > bright[0],
    `rgb=${bright} (blue channel should dominate for a blue paint)`);

  // Highlight at the lit edge should approach the paint at full brightness.
  ok('lit paints reads close to the swatch', Math.abs(bright[2] - paint[2]) < 45,
    `b=${bright[2]} vs paint b=${paint[2]}`);

  // Zero lighting preservation collapses to a flat swatch.
  const flat = new Uint8ClampedArray(src);
  CORE.composite({
    src, dst: flat, alpha, W, H, colWin, rowWin,
    color: paint, ref: base, light: 0, sheen: false
  });
  const f0 = [flat[((3 * W) + 0) * 4], flat[((3 * W) + 0) * 4 + 1], flat[((3 * W) + 0) * 4 + 2]];
  const f1 = [flat[((3 * W) + W - 1) * 4], flat[((3 * W) + W - 1) * 4 + 1], flat[((3 * W) + W - 1) * 4 + 2]];
  ok('light=0 flattens the wall', JSON.stringify(f0) === JSON.stringify(f1),
    `${f0} vs ${f1} (both should equal the swatch)`);
  ok('light=0 matches the swatch exactly',
    Math.abs(f0[0] - paint[0]) <= 1 && Math.abs(f0[1] - paint[1]) <= 1 && Math.abs(f0[2] - paint[2]) <= 1);

  // Alpha 0 must leave the photograph untouched.
  const untouched = new Uint8ClampedArray(src);
  CORE.composite({
    src, dst: untouched, alpha: new Float32Array(W * H), W, H, colWin, rowWin,
    color: paint, ref: base, light: 1, sheen: false
  });
  ok('alpha=0 is non-destructive',
    untouched.every((v, i) => v === src[i]));

  // Fractional alpha must blend, never overflow the byte range.
  const blend = new Uint8ClampedArray(src);
  CORE.composite({
    src, dst: blend, alpha: new Float32Array(W * H).fill(0.5), W, H, colWin, rowWin,
    color: paint, ref: base, light: 1, sheen: false
  });
  ok('partial alpha stays in range', blend.every((v) => v >= 0 && v <= 255));

  // Extreme paint (pure black / white) must not produce NaN-ish artefacts.
  for (const extreme of [[0, 0, 0], [255, 255, 255]]) {
    const d2 = new Uint8ClampedArray(src);
    CORE.composite({
      src, dst: d2, alpha, W, H, colWin, rowWin,
      color: extreme, ref: base, light: 1, sheen: true
    });
    ok(`extreme paint ${extreme.join(',')} stays valid`,
      d2.every((v) => Number.isFinite(v) && v >= 0 && v <= 255));
  }

  // A dark source reference (near-black wall) must not divide by zero.
  const darkSrc = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    darkSrc[i * 4] = 2; darkSrc[i * 4 + 1] = 2; darkSrc[i * 4 + 2] = 2; darkSrc[i * 4 + 3] = 255;
  }
  const dDark = new Uint8ClampedArray(darkSrc);
  CORE.composite({
    src: darkSrc, dst: dDark, alpha, W, H, colWin, rowWin,
    color: paint, ref: [0, 0, 0], light: 1, sheen: false
  });
  ok('near-black reference is guarded', dDark.every((v) => Number.isFinite(v)));
  ok('near-black reference still paints', dDark[0] > 0 || dDark[1] > 0 || dDark[2] > 0);
}

/* ---------------- mean colour & IoU ---------------- */
{
  const W = 4, H = 1;
  const src = new Uint8ClampedArray([
    10, 20, 30, 255, 10, 20, 30, 255, 200, 210, 220, 255, 200, 210, 220, 255
  ]);
  const m1 = new Uint8Array([1, 1, 0, 0]);
  const m2 = new Uint8Array([0, 0, 1, 1]);
  const mean = CORE.meanColour(src, W, H, [{ mask: m1 }]);
  ok('mean colour averages the mask', mean[0] === 10 && mean[2] === 30, JSON.stringify(mean));
  const both = CORE.meanColour(src, W, H, [{ mask: m1 }, { mask: m2 }]);
  ok('mean colour unions masks', Math.abs(both[0] - 105) < 0.01, JSON.stringify(both));
  const empty = CORE.meanColour(src, W, H, [{ mask: new Uint8Array([0, 0, 0, 0]) }]);
  ok('empty mask falls back safely', empty.every((v) => v > 0));

  ok('IoU identical masks = 1', CORE.iou(m1, m1) === 1);
  ok('IoU disjoint masks = 0', CORE.iou(m1, m2) === 0);
  ok('IoU half overlap = 1/3', Math.abs(CORE.iou(new Uint8Array([1, 1, 0]), new Uint8Array([1, 0, 1])) - 1 / 3) < 1e-9);
}

/* ---------------- report ---------------- */
if (failures.length) {
  console.error(`\n✗ ${failures.length} test(s) failed, ${pass} passed\n`);
  for (const f of failures) console.error('  • ' + f);
  process.exit(1);
}
console.log(`✓ all ${pass} core assertions passed`);
