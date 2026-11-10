/**
 * Headless UI smoke test.
 *
 *   node tools/ui.test.mjs
 *
 * jsdom has no raster canvas, so a small software stand-in is installed that
 * supports everything the app touches (2D context, ImageData, drawImage of a
 * pre-decoded bitmap, getImageData, putImageData). The app itself is executed
 * unmodified from index.html, so this exercises the real boot path, event
 * wiring, palette rendering, seeding, sliders, reset and the error boundary.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';
import jpeg from 'jpeg-js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

let pass = 0;
const failures = [];
const ok = (name, cond, detail) => {
  if (cond) pass++;
  else failures.push(name + (detail ? ' — ' + detail : ''));
};

/* ---------- decode the built-in room photo once ---------- */
const room = jpeg.decode(readFileSync(join(root, 'assets', 'room.jpg')), { useTArray: true });
const ROOM = { width: room.width, height: room.height, data: room.data };

/* ---------- software canvas ---------- */
function makeCanvas(nativeWidth, nativeHeight) {
  const canvas = {
    width: nativeWidth || 300,
    height: nativeHeight || 150,
    _img: null,
    getContext(type) {
      if (type !== '2d') return null;
      const self = canvas;
      const ctx = {
        canvas: self,
        imageSmoothingEnabled: true,
        imageSmoothingQuality: 'low',
        fillStyle: '#000',
        strokeStyle: '#000',
        lineWidth: 1,
        // --- state / path no-ops: recorded so tests can assert drawing happened
        _calls: [],
        clearRect() { ctx._calls.push('clearRect'); self._img = null; },
        beginPath() {}, arc() { ctx._calls.push('arc'); }, fill() { ctx._calls.push('fill'); },
        stroke() { ctx._calls.push('stroke'); }, closePath() {},
        save() {}, restore() {}, translate() {}, scale() {},
        drawImage(src) {
          // Only used to rasterise a decoded bitmap into the working canvas.
          if (!src || !src._bitmap) throw new Error('drawImage needs a decoded bitmap');
          const bm = src._bitmap;
          const w = self.width, h = self.height;
          const out = new Uint8ClampedArray(w * h * 4);
          for (let y = 0; y < h; y++) {
            const sy = Math.min(bm.height - 1, Math.floor((y * bm.height) / h));
            for (let x = 0; x < w; x++) {
              const sx = Math.min(bm.width - 1, Math.floor((x * bm.width) / w));
              const s = (sy * bm.width + sx) * 4, d = (y * w + x) * 4;
              out[d] = bm.data[s]; out[d + 1] = bm.data[s + 1];
              out[d + 2] = bm.data[s + 2]; out[d + 3] = 255;
            }
          }
          self._img = { width: w, height: h, data: out };
        },
        getImageData(x, y, w, h) {
          if (x !== 0 || y !== 0 || w !== self.width || h !== self.height) {
            throw new Error('harness only supports full-canvas getImageData');
          }
          if (self._img) {
            return { width: w, height: h, data: new Uint8ClampedArray(self._img.data) };
          }
          const d = new Uint8ClampedArray(w * h * 4);
          for (let i = 3; i < d.length; i += 4) d[i] = 255;
          return { width: w, height: h, data: d };
        },
        putImageData(img) {
          self._img = { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) };
          ctx._calls.push('putImageData');
        },
        createImageData(w, h) {
          return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
        }
      };
      return ctx;
    },
    getBoundingClientRect() { return { left: 0, top: 0, width: 900, height: 600, right: 900, bottom: 600 }; },
    addEventListener(t, fn) { (canvas._ev = canvas._ev || {}); (canvas._ev[t] = canvas._ev[t] || []).push(fn); },
    dispatch(t, e) { ((canvas._ev || {})[t] || []).forEach((fn) => fn(e)); },
    classList: { add() {}, remove() {}, toggle() {} }
  };
  return canvas;
}

/* ---------- boot jsdom with the real page ---------- */
const html = readFileSync(join(root, 'index.html'), 'utf8')
  // strip the Tailwind CDN: no network in tests, and it is cosmetic only
  .replace(/<script src="https:\/\/cdn\.tailwindcss\.com"><\/script>/, '');

const vc = new VirtualConsole();
const consoleErrors = [];
vc.on('jsdomError', (e) => consoleErrors.push('jsdomError: ' + e.message));
vc.on('error', (msg) => consoleErrors.push('console.error: ' + msg));

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  virtualConsole: vc,
  beforeParse(win) {
    win.HTMLCanvasElement.prototype.getContext = function (t) {
      if (!this._sw) this._sw = makeCanvas(this.width, this.height);
      return this._sw.getContext(t);
    };
    // Route width/height through to the software surface when the app resizes.
    for (const prop of ['width', 'height']) {
      const desc = Object.getOwnPropertyDescriptor(win.HTMLCanvasElement.prototype, prop);
      if (desc && desc.set) {
        Object.defineProperty(win.HTMLCanvasElement.prototype, prop, {
          get() { return desc.get.call(this); },
          set(v) { desc.set.call(this, v); if (this._sw) this._sw[prop] = v; },
          configurable: true
        });
      }
    }
    win.HTMLCanvasElement.prototype.getBoundingClientRect = function () {
      return { left: 0, top: 0, width: 900, height: 600, right: 900, bottom: 600 };
    };
    win.HTMLCanvasElement.prototype.toDataURL = () => 'data:,';
    // Image decoding: resolve immediately with the bundled room bitmap.
    const RealImage = win.Image;
    win.Image = class {
      constructor() {
        this._bitmap = null;
        this.naturalWidth = 0; this.naturalHeight = 0;
        this.decoding = 'sync';
      }
      set src(v) {
        this._src = v;
        this._bitmap = ROOM;
        this.naturalWidth = ROOM.width; this.naturalHeight = ROOM.height;
        this.width = ROOM.width; this.height = ROOM.height;
        setTimeout(() => this.onload && this.onload(), 0);
      }
      get src() { return this._src; }
    };
    // jsdom's ImageData is incomplete for our purposes; supply the standard one.
    win.ImageData = class ImageData {
      constructor(a, b, c) {
        if (typeof a === 'number') {
          this.width = a; this.height = b; this.data = new Uint8ClampedArray(a * b * 4);
        } else {
          this.data = a; this.width = b; this.height = c;
        }
      }
    };
    win.URL.createObjectURL = () => 'blob:mock';
    win.URL.revokeObjectURL = () => {};
    win.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
    if (!win.performance) win.performance = { now: () => Date.now() };
  }
});

const win = dom.window;
const doc = win.document;

/** wait for pending rAF/timeouts and the load promise chain to settle */
const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));

let sim;
/* ---------------- tests ---------------- */
try {
  await settle(400);
  sim = win.ColortrendSim;
  ok('app booted and exposed its API', !!sim);
  ok('no jsdom errors during boot', consoleErrors.length === 0, consoleErrors.join(' | '));

  const state = sim.state;
  ok('image loaded from the embedded photo', state.ready && state.W > 100 && state.H > 100,
    `ready=${state.ready} ${state.W}x${state.H}`);
  ok('image is bounded by the pixel budget', state.W * state.H <= 2400000);
  ok('a default wall region was auto-seeded', state.regions.length === 1,
    `regions=${state.regions.length}`);
  ok('the default region covers a real wall area',
    state.regions[0] && state.regions[0].count > state.W * state.H * 0.25,
    `count=${state.regions[0] && state.regions[0].count}`);

  /* --- palette --- */
  const names = [...doc.querySelectorAll('#paletteGrid .pcard')].map((n) => n.textContent);
  ok('palette renders 40+ shades', names.length >= 40, `rendered ${names.length}`);
  ok('spec shade Lavender Posy 6151P is present', names.some((n) => /Lavender Posy6151P/.test(n)));
  ok('spec shade Savin Hill 1113D is present', names.some((n) => /Savin Hill1113D/.test(n)));
  ok('default active paint is Lavender Posy',
    doc.getElementById('heroName').textContent === 'Lavender Posy' &&
    doc.getElementById('heroCode').textContent === '6151P');
  ok('top bar mirrors the active paint',
    doc.getElementById('topSwatch').style.background !== '' &&
    /6151P/.test(doc.getElementById('topCode').textContent));

  /* --- search: partial name and partial code --- */
  const search = doc.getElementById('searchInput');
  const typeSearch = async (q) => {
    search.value = q;
    search.dispatchEvent(new win.Event('input', { bubbles: true }));
    await settle(10);
    return [...doc.querySelectorAll('#paletteGrid .pcard')].map((n) => n.textContent);
  };
  let res = await typeSearch('Lavender');
  ok('name search is real-time and partial', res.length === 1 && /Lavender Posy/.test(res[0]),
    JSON.stringify(res));
  res = await typeSearch('6151');
  ok('code search matches a partial code', res.some((n) => /6151P/.test(n)), JSON.stringify(res));
  res = await typeSearch('1113');
  ok('partial code 1113 finds Savin Hill', res.some((n) => /1113D/.test(n)), JSON.stringify(res));
  res = await typeSearch('savin');
  ok('search is case-insensitive', res.length === 1 && /Savin/.test(res[0]));
  res = await typeSearch('zzzz');
  ok('empty state appears for no matches',
    res.length === 0 && !doc.getElementById('paletteEmpty').classList.contains('hidden'));
  doc.getElementById('searchClear').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await settle(10);
  ok('search clear restores the full list',
    doc.querySelectorAll('#paletteGrid .pcard').length >= 40 && search.value === '');

  /* --- category tabs --- */
  const clickTab = async (cat) => {
    doc.querySelector(`#tabs .tab[data-cat="${cat}"]`).dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await settle(10);
    return [...doc.querySelectorAll('#paletteGrid .pcard')].map((n) => n.textContent);
  };
  const all = await clickTab('all');
  const neutrals = await clickTab('neutral');
  const warms = await clickTab('warm');
  const cools = await clickTab('cool');
  const deeps = await clickTab('deep');
  ok('category tabs all return shades',
    neutrals.length && warms.length && cools.length && deeps.length,
    `${neutrals.length}/${warms.length}/${cools.length}/${deeps.length}`);
  ok('categories partition the palette exactly',
    neutrals.length + warms.length + cools.length + deeps.length === all.length,
    `${neutrals.length + warms.length + cools.length + deeps.length} vs ${all.length}`);
  ok('Lavender Posy is filed under Cools', cools.some((n) => /6151P/.test(n)));
  ok('active tab is marked for a11y',
    doc.querySelector('#tabs .tab[data-cat="deep"]').getAttribute('aria-selected') === 'true');
  await clickTab('all');

  /* --- colour selection --- */
  const savin = [...doc.querySelectorAll('#paletteGrid .pcard')].find((n) => /1113D/.test(n.textContent));
  savin.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await settle(40);
  ok('selecting a swatch updates the active paint', state.color.code === '1113D', state.color.code);
  ok('header preview updates with the swatch',
    doc.getElementById('heroName').textContent === 'Savin Hill' &&
    doc.getElementById('topName').textContent === 'Savin Hill');
  ok('selection is reflected in aria-pressed',
    [...doc.querySelectorAll('#paletteGrid .pcard')].filter((n) => n.getAttribute('aria-pressed') === 'true').length === 1);
  ok('coverage is reported after painting', /%/.test(doc.getElementById('coverageBadge').textContent),
    doc.getElementById('coverageBadge').textContent);

  /* --- canvas seeding --- */
  const canvas = doc.getElementById('scene');
  const before = state.regions.length;
  canvas.dispatchEvent(new win.MouseEvent('click', { bubbles: true, clientX: 360, clientY: 300 }));
  await settle(200);
  ok('clicking the canvas adds or selects a region', state.regions.length >= before,
    `${before} -> ${state.regions.length}`);
  ok('regions are capped at 8', state.regions.length <= 8);

  /* --- paint modes --- */
  doc.querySelector('#paintMode button[data-mode="isolate"]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await settle(50);
  ok('"this region" mode activates', state.paintMode === 'isolate', state.paintMode);
  ok('mode button is aria-pressed',
    doc.querySelector('#paintMode button[data-mode="isolate"]').getAttribute('aria-pressed') === 'true');
  ok('mode hint explains isolation', /only/i.test(doc.getElementById('modeHint').textContent),
    doc.getElementById('modeHint').textContent);
  doc.querySelector('#paintMode button[data-mode="all"]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await settle(20);
  ok('"all walls" mode restores', state.paintMode === 'all');

  /* --- sliders --- */
  const setRange = async (id, v) => {
    const r = doc.getElementById(id);
    r.value = String(v);
    r.dispatchEvent(new win.Event('input', { bubbles: true }));
    await settle(180);
  };
  await setRange('tolRange', 30);
  ok('tolerance slider updates state and label', state.tol === 30 && doc.getElementById('tolVal').textContent === '30');
  ok('re-segmentation keeps regions alive after a tolerance change', state.regions.length >= 1);
  await setRange('tolRange', 22);
  await setRange('edgeRange', 0.8);
  ok('edge guard slider updates state', Math.abs(state.edgeGuard - 0.8) < 1e-6 &&
    doc.getElementById('edgeVal').textContent === '0.80');
  await setRange('edgeRange', 0.55);
  await setRange('lightRange', 40);
  ok('lighting slider updates state', Math.abs(state.light - 0.4) < 1e-6 &&
    doc.getElementById('lightVal').textContent === '40%');
  await setRange('lightRange', 100);
  await setRange('heightRange', 55);
  ok('height cutoff updates state', Math.abs(state.height - 0.55) < 1e-6 &&
    doc.getElementById('heightVal').textContent === '55%');
  await setRange('heightRange', 100);
  await setRange('featherRange', 3);
  ok('feather slider updates state', state.feather === 3 &&
    doc.getElementById('featherVal').textContent === '3.0px');
  await setRange('featherRange', 1.5);

  /* --- dual-range span (including the crossed-handle guard) --- */
  await setRange('spanMinRange', 20);
  await setRange('spanMaxRange', 80);
  ok('span range updates state', Math.abs(state.spanMin - 0.2) < 1e-6 && Math.abs(state.spanMax - 0.8) < 1e-6);
  ok('span label and fill bar follow', doc.getElementById('spanVal').textContent === '20% – 80%' &&
    doc.getElementById('spanFill').style.width === '60%');
  await setRange('spanMaxRange', 10);   // crosses the min handle
  ok('handles cannot cross', state.spanMin <= state.spanMax,
    `${state.spanMin} > ${state.spanMax}`);
  await settle(220);
  await setRange('spanMinRange', 0);
  await setRange('spanMaxRange', 100);

  /* --- render switches --- */
  const toggle = async (id) => {
    doc.getElementById(id).dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await settle(40);
  };
  await toggle('maskToggle');
  ok('overlay toggle flips state and aria-checked',
    state.showMask === true && doc.getElementById('maskToggle').getAttribute('aria-checked') === 'true');
  await toggle('maskToggle');
  await toggle('seedToggle');
  ok('seed marker toggle works', state.showSeeds === false &&
    doc.getElementById('seedToggle').getAttribute('aria-checked') === 'false');
  await toggle('seedToggle');
  await toggle('sheenToggle');
  ok('sheen toggle works', state.sheen === false &&
    doc.getElementById('sheenToggle').getAttribute('aria-checked') === 'false');
  await toggle('sheenToggle');

  /* --- compare original --- */
  const compare = doc.getElementById('compareBtn');
  compare.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await settle(40);
  ok('compare toggle engages', state.compare === true && compare.getAttribute('aria-pressed') === 'true');
  ok('compare label changes', doc.getElementById('compareLabel').textContent === 'Showing Original');
  ok('compare zeroes the reported coverage', state.coverage === 0);
  doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'o', bubbles: true }));
  await settle(40);
  ok('keyboard shortcut toggles compare back', state.compare === false);

  /* --- reset --- */
  doc.getElementById('resetBtn').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await settle(250);
  ok('reset restores defaults',
    state.tol === 22 && state.edgeGuard === 0.55 && state.light === 1 &&
    state.height === 1 && state.spanMin === 0 && state.spanMax === 1 &&
    state.feather === 1.5 && state.color.code === '6151P' && state.showSeeds === true,
    JSON.stringify({ tol: state.tol, e: state.edgeGuard, l: state.light, h: state.height, c: state.color.code }));
  ok('reset regenerates a default region', state.regions.length === 1);
  ok('reset restores the palette filter', doc.querySelectorAll('#paletteGrid .pcard').length >= 40);
  ok('reset closes the error modal', !doc.getElementById('errorOverlay').classList.contains('show'));

  /* --- auto-detect --- */
  doc.getElementById('resetBtn').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await settle(250);
  doc.getElementById('sampleWallsBtn').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await settle(600);
  ok('auto-detect runs without throwing', state.ready);
  ok('auto-detect yields usable regions', state.regions.length >= 1 && state.regions.length <= 8,
    `regions=${state.regions.length}`);
  ok('auto-detected regions are distinct surfaces', (() => {
    for (let i = 0; i < state.regions.length; i++) {
      for (let j = i + 1; j < state.regions.length; j++) {
        if (sim.core.iou(state.regions[i].mask, state.regions[j].mask) > 0.55) return false;
      }
    }
    return true;
  })());
  ok('every auto-detected region has area and a label',
    state.regions.every((r) => r.count > 0 && /Wall|Left|Right|Center/.test(r.name)),
    JSON.stringify(state.regions.map((r) => r.name)));

  /* --- region removal & clear --- */
  doc.getElementById('clearRegionsBtn').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await settle(60);
  ok('clear removes all regions', state.regions.length === 0);
  ok('empty-state note is shown in the region list',
    /No regions yet/.test(doc.getElementById('regionList').textContent));
  canvas.dispatchEvent(new win.MouseEvent('click', { bubbles: true, clientX: 500, clientY: 250 }));
  await settle(200);
  ok('a fresh seed works after clearing', state.regions.length === 1);
  const del = doc.querySelector('#regionList .region-del');
  ok('region rows expose a delete control', !!del);
  del.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await settle(60);
  ok('delete removes the region', state.regions.length === 0);

  /* --- error boundary: invalid upload --- */
  doc.getElementById('uploadBtn').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  const fileInput = doc.getElementById('fileInput');
  const fakeFile = (name, type, size) => ({ name, type, size });
  Object.defineProperty(fileInput, 'files', {
    value: [fakeFile('notes.pdf', 'application/pdf', 1024)], configurable: true
  });
  fileInput.dispatchEvent(new win.Event('change', { bubbles: true }));
  await settle(80);
  ok('non-image upload raises the error modal',
    doc.getElementById('errorOverlay').classList.contains('show'));
  ok('error modal names the failing stage',
    /image upload/i.test(doc.getElementById('errCtx').textContent),
    doc.getElementById('errCtx').textContent);
  ok('error modal explains the problem',
    /not an image file/i.test(doc.getElementById('errMsg').textContent),
    doc.getElementById('errMsg').textContent);
  doc.getElementById('errDismiss').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await settle(30);
  ok('dismiss closes the modal', !doc.getElementById('errorOverlay').classList.contains('show'));

  // Oversized file
  Object.defineProperty(fileInput, 'files', {
    value: [fakeFile('huge.png', 'image/png', 40 * 1024 * 1024)], configurable: true
  });
  fileInput.dispatchEvent(new win.Event('change', { bubbles: true }));
  await settle(80);
  ok('oversized upload is rejected with a clear message',
    /limit is/i.test(doc.getElementById('errMsg').textContent), doc.getElementById('errMsg').textContent);
  doc.getElementById('errReset').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await settle(300);
  ok('"reset simulator" recovers from the error state',
    !doc.getElementById('errorOverlay').classList.contains('show') && state.ready);

  /* --- graceful degradation for a tiny image --- */
  const RealImage = win.Image;
  win.Image = class extends RealImage {
    set src(v) {
      this._bitmap = { width: 40, height: 30, data: new Uint8ClampedArray(40 * 30 * 4).fill(200) };
      this.naturalWidth = 40; this.naturalHeight = 30;
      setTimeout(() => this.onload && this.onload(), 0);
    }
  };
  Object.defineProperty(fileInput, 'files', {
    value: [fakeFile('tiny.png', 'image/png', 2048)], configurable: true
  });
  fileInput.dispatchEvent(new win.Event('change', { bubbles: true }));
  await settle(120);
  ok('a too-small image is rejected gracefully',
    /too small/i.test(doc.getElementById('errMsg').textContent), doc.getElementById('errMsg').textContent);
  doc.getElementById('errDismiss').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  win.Image = RealImage;

  /* --- no uncaught failures anywhere in the run --- */
  // The app logs deliberately for every handled upload failure; anything else
  // (uncaught exceptions, resource errors) would be a real defect.
  const unexpected = consoleErrors.filter((e) => !/\[image upload\]|\[image load\]/.test(e));
  ok('no unexpected errors across the whole session', unexpected.length === 0,
    unexpected.slice(0, 3).join(' | '));

  /* --- canvas fitting keeps the overlay aligned --- */
  const holder = doc.getElementById('canvasHolder');
  const sceneEl = doc.getElementById('scene');
  ok('canvas is sized in JS to the stage', /^\d+px$/.test(sceneEl.style.width) && /^\d+px$/.test(sceneEl.style.height),
    `${sceneEl.style.width} x ${sceneEl.style.height}`);
  ok('overlay holder matches the canvas box exactly',
    holder.style.width === sceneEl.style.width && holder.style.height === sceneEl.style.height,
    `${holder.style.width}x${holder.style.height} vs ${sceneEl.style.width}x${sceneEl.style.height}`);
  ok('fitted canvas preserves the photo aspect ratio', (() => {
    const w = parseFloat(sceneEl.style.width), h = parseFloat(sceneEl.style.height);
    return Math.abs(w / h - state.W / state.H) < 0.02;
  })(), `${sceneEl.style.width}x${sceneEl.style.height} vs ${state.W}x${state.H}`);
} catch (e) {
  failures.push('unexpected exception: ' + (e && e.stack ? e.stack.split('\n')[0] : e));
}

if (failures.length) {
  console.error(`\n✗ ${failures.length} UI test(s) failed, ${pass} passed\n`);
  for (const f of failures) console.error('  • ' + f);
  process.exit(1);
}
console.log(`✓ all ${pass} UI assertions passed`);
