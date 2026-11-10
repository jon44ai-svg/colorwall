/* =====================================================================
   Colortrend Ambiance — Wall Simulator
   Single-file canvas application.

   Pipeline:
     photo -> CIELAB buffers -> 3x3 Sobel gradient -> BFS flood fill
           -> feathered region mask -> luminance-multiplied paint composite
   ===================================================================== */
(function () {
  'use strict';

  /* @@CORE-BEGIN@@ */
  /* ------------------------------------------------------------------
     CORE — pure colour/vision maths. No DOM access, fully deterministic
     so it can be unit tested in isolation.
     ------------------------------------------------------------------ */
  var CORE = (function () {

    /** sRGB (0-255) -> CIE L*a*b* (D65, 2°) */
    function rgbToLab(r, g, b, out) {
      var R = r / 255, G = g / 255, B = b / 255;
      R = R > 0.04045 ? Math.pow((R + 0.055) / 1.055, 2.4) : R / 12.92;
      G = G > 0.04045 ? Math.pow((G + 0.055) / 1.055, 2.4) : G / 12.92;
      B = B > 0.04045 ? Math.pow((B + 0.055) / 1.055, 2.4) : B / 12.92;

      var X = (R * 0.4124564 + G * 0.3575761 + B * 0.1804375) / 0.95047;
      var Y = (R * 0.2126729 + G * 0.7151522 + B * 0.0721750) / 1.00000;
      var Z = (R * 0.0193339 + G * 0.1191920 + B * 0.9503041) / 1.08883;

      var fx = X > 0.008856 ? Math.cbrt(X) : 7.787 * X + 16 / 116;
      var fy = Y > 0.008856 ? Math.cbrt(Y) : 7.787 * Y + 16 / 116;
      var fz = Z > 0.008856 ? Math.cbrt(Z) : 7.787 * Z + 16 / 116;

      var L = 116 * fy - 16;
      var A = 500 * (fx - fy);
      var Bb = 200 * (fy - fz);

      if (out) { out[0] = L; out[1] = A; out[2] = Bb; return out; }
      return [L, A, Bb];
    }

    function hexToRgb(hex) {
      var h = String(hex).replace('#', '').trim();
      if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
      var n = parseInt(h, 16);
      if (!isFinite(n) || h.length !== 6) return [0, 0, 0];
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }

    function rgbToHex(r, g, b) {
      function p(v) { v = Math.max(0, Math.min(255, Math.round(v))); return (v < 16 ? '0' : '') + v.toString(16); }
      return '#' + p(r) + p(g) + p(b);
    }

    /** Relative luminance 0..1, used for contrast-aware UI accents. */
    function luminance(r, g, b) { return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; }

    /** Build packed CIELAB buffers from RGBA bytes. */
    function buildLab(data, W, H) {
      var n = W * H;
      var L = new Float32Array(n), A = new Float32Array(n), B = new Float32Array(n);
      var tmp = [0, 0, 0], i, p;
      for (i = 0, p = 0; i < n; i++, p += 4) {
        rgbToLab(data[p], data[p + 1], data[p + 2], tmp);
        L[i] = tmp[0]; A[i] = tmp[1]; B[i] = tmp[2];
      }
      return { L: L, A: A, B: B };
    }

    /**
     * 3x3 Sobel gradient magnitude over the L* channel.
     *
     * Returned in raw L-star units per pixel (classic G / 8 scaling),
     * so thresholds are physically meaningful and independent of how extreme
     * the strongest edge in a particular photo happens to be. A wall's own
     * paint texture sits around 0.1–0.8; a soft duvet or frame boundary sits
     * around 2–6; a hard window frame or lamp edge runs to 20–80.
     */
    function sobel(L, W, H) {
      var out = new Float32Array(W * H);
      var x, y;
      for (y = 0; y < H; y++) {
        var ym = y > 0 ? y - 1 : 0;
        var yp = y < H - 1 ? y + 1 : H - 1;
        var r0 = ym * W, r1 = y * W, r2 = yp * W;
        for (x = 0; x < W; x++) {
          var xm = x > 0 ? x - 1 : 0;
          var xp = x < W - 1 ? x + 1 : W - 1;
          var tl = L[r0 + xm], tc = L[r0 + x], tr = L[r0 + xp];
          var ml = L[r1 + xm], mr = L[r1 + xp];
          var bl = L[r2 + xm], bc = L[r2 + x], br = L[r2 + xp];
          var gx = (tr + 2 * mr + br) - (tl + 2 * ml + bl);
          var gy = (bl + 2 * bc + br) - (tl + 2 * tc + tr);
          out[r1 + x] = Math.sqrt(gx * gx + gy * gy) * 0.25;
        }
      }
      return out;
    }

    /**
     * Local contrast map: standard deviation of L* in a (2r+1)^2 window,
     * computed with integral images in one linear pass.
     *
     * A painted wall is smooth (sigma well under 1) even across a strong
     * lighting gradient, while fabric folds, foliage and frames carry real
     * texture (sigma 2–12). This is the cue that separates a bright duvet from
     * a bright patch of wall that happen to share a nearly identical CIELAB
     * value — ΔE alone cannot tell those apart.
     */
    function textureMap(L, W, H, r) {
      r = r || 2;
      var i, x, y, n = W * H;
      var S = new Float64Array((W + 1) * (H + 1));
      var Q = new Float64Array((W + 1) * (H + 1));
      var stride = W + 1;
      for (y = 0; y < H; y++) {
        var rowS = 0, rowQ = 0;
        for (x = 0; x < W; x++) {
          var i1 = y * W + x;
          var v = L[i1];
          rowS += v; rowQ += v * v;
          var o = (y + 1) * stride + x + 1;
          S[o] = S[o - stride] + rowS;
          Q[o] = Q[o - stride] + rowQ;
        }
      }
      var out = new Float32Array(n);
      for (y = 0; y < H; y++) {
        var y0 = y - r < 0 ? 0 : y - r, y1 = y + r + 1 > H ? H : y + r + 1;
        for (x = 0; x < W; x++) {
          var x0 = x - r < 0 ? 0 : x - r, x1 = x + r + 1 > W ? W : x + r + 1;
          var a = y0 * stride + x0, b = y0 * stride + x1, c = y1 * stride + x0, d = y1 * stride + x1;
          var area = (x1 - x0) * (y1 - y0);
          var sum = S[d] - S[b] - S[c] + S[a];
          var sq = Q[d] - Q[b] - Q[c] + Q[a];
          var m = sum / area;
          var varr = sq / area - m * m;
          out[y * W + x] = varr > 0 ? Math.sqrt(varr) : 0;
        }
      }
      return out;
    }

    /**
     * Consolidate the gradient with a small box blur so that a boundary reads
     * as one continuous ridge. Photographic edges are 2–4 px soft ramps, and
     * a raw per-pixel derivative leaves gaps in them that the flood fill can
     * slip through — this closes those gaps.
     */
    function consolidateGradient(g, W, H, r) {
      return blur(g, W, H, r === undefined ? 1 : r);
    }

    /**
     * Texture baseline for a photo: a low percentile of the consolidated
     * gradient. It approximates "how busy the wall's own surface noise is",
     * which lets the edge guard adapt to a photo's resolution and sharpness
     * instead of relying on absolute numbers that only suit one image.
     */
    function textureBaseline(g, W, H) {
      var n = W * H;
      var step = Math.max(1, Math.floor(n / 24000));
      var sample = [];
      for (var i = 0; i < n; i += step) sample.push(g[i]);
      sample.sort(function (a, b) { return a - b; });
      var p = sample[Math.floor(sample.length * 0.4)] || 0;
      return Math.max(0.05, p);
    }

    /**
     * Edge-guard slider (0..1) -> gradient threshold, expressed as a multiple
     * of the photo's own texture baseline.
     *
     *   0.0  ~10x baseline : only very hard ridges stop the fill
     *   0.55 ~4x  baseline : the sweet spot for typical interior photos
     *   1.0   1x  baseline : strictest, follows fine detail
     */
    function edgeLimit(edgeGuard, baseline) {
      var g = Math.max(0, Math.min(1, edgeGuard));
      var base = baseline === undefined ? 1 : baseline;
      return base * (1 + 9 * Math.pow(1 - g, 1.6));
    }

    /**
     * BFS flood fill in CIELAB with a Sobel edge guard.
     * CIE76 ΔE is the acceptance test against the *seed* colour, which keeps
     * the region from drifting across a gradient into an adjacent surface.
     */
    function segmentWall(o) {
      var W = o.W, H = o.H, lab = o.lab, edge = o.edge, tex = o.tex;
      var n = W * H;
      var sx = Math.max(0, Math.min(W - 1, o.seedX | 0));
      var sy = Math.max(0, Math.min(H - 1, o.seedY | 0));
      var si = sy * W + sx;

      var L0 = lab.L[si], A0 = lab.A[si], B0 = lab.B[si];
      var tol2 = o.tol * o.tol;
      // Edge guard: 0 -> "ignore edges", 1 -> "block almost every ridge".
      // Scaled by resolution because the per-pixel derivative of the same
      // soft boundary shrinks when the photo is downsampled.
      var gLimit = edgeLimit(o.edgeGuard, o.baseline);
      // Texture is weighted above raw gradient: folded fabric, foliage and
      // frame borders all carry far more local variance than flat wall.
      var texW = o.texWeight === undefined ? 1.6 : o.texWeight;

      var mask = new Uint8Array(n);
      var queue = new Int32Array(n);
      var head = 0, tail = 1;
      queue[0] = si;
      mask[si] = 1;
      var count = 1;

      var L = lab.L, A = lab.A, B = lab.B;

      while (head < tail) {
        var p = queue[head++];
        var px = p % W;
        var py = (p - px) / W;

        // 4-connected neighbours: left, right, up, down
        for (var d = 0; d < 4; d++) {
          var nx = px + (d === 0 ? -1 : d === 1 ? 1 : 0);
          var ny = py + (d === 2 ? -1 : d === 3 ? 1 : 0);
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          var ni = ny * W + nx;
          if (mask[ni]) continue;
          var ridge = tex ? (tex[ni] * texW > edge[ni] ? tex[ni] * texW : edge[ni]) : edge[ni];
          if (ridge > gLimit) continue;
          var dL = L[ni] - L0, dA = A[ni] - A0, dB = B[ni] - B0;
          if (dL * dL + dA * dA + dB * dB > tol2) continue;
          mask[ni] = 1;
          queue[tail++] = ni;
          count++;
        }
      }
      return { mask: mask, count: count, seedIndex: si };
    }

    /**
     * Majority (despeckle) filter: a background pixel with 7+ of its 8
     * neighbours inside becomes inside, and vice versa. Photographic noise
     * leaves single-pixel speckles on a wall; two passes clean them without
     * rounding off the real boundary.
     */
    function despeckle(mask, W, H, passes) {
      passes = passes === undefined ? 2 : passes;
      var src = mask, dst = new Uint8Array(W * H);
      for (var p = 0; p < passes; p++) {
        for (var y = 0; y < H; y++) {
          var up = y > 0 ? (y - 1) * W : -1;
          var dn = y < H - 1 ? (y + 1) * W : -1;
          var row = y * W;
          for (var x = 0; x < W; x++) {
            var n = 0, i = row + x;
            if (x > 0) { n += src[i - 1]; if (up >= 0) n += src[up + x - 1]; if (dn >= 0) n += src[dn + x - 1]; }
            if (x < W - 1) { n += src[i + 1]; if (up >= 0) n += src[up + x + 1]; if (dn >= 0) n += src[dn + x + 1]; }
            if (up >= 0) n += src[up + x];
            if (dn >= 0) n += src[dn + x];
            var self = src[i];
            dst[i] = self ? (n >= 3 ? 1 : 0) : (n >= 6 ? 1 : 0);
          }
        }
        var t = src; src = dst; dst = (t === mask ? new Uint8Array(W * H) : t);
      }
      return src === mask ? mask : src;
    }

    /** Separable 1-D min/max pass — the building blocks of morphology. */
    function morph1D(src, W, H, r, isMax) {
      var out = new Uint8Array(src.length);
      var x, y, k, best;
      // horizontal
      var tmp = new Uint8Array(src.length);
      for (y = 0; y < H; y++) {
        var row = y * W;
        for (x = 0; x < W; x++) {
          best = src[row + x];
          var lo = x - r < 0 ? 0 : x - r;
          var hi = x + r >= W ? W - 1 : x + r;
          for (k = lo; k <= hi; k++) {
            var v = src[row + k];
            if (isMax ? v > best : v < best) best = v;
          }
          tmp[row + x] = best;
        }
      }
      // vertical
      for (y = 0; y < H; y++) {
        var loY = y - r < 0 ? 0 : y - r;
        var hiY = y + r >= H ? H - 1 : y + r;
        for (x = 0; x < W; x++) {
          best = tmp[loY * W + x];
          for (k = loY; k <= hiY; k++) {
            var v2 = tmp[k * W + x];
            if (isMax ? v2 > best : v2 < best) best = v2;
          }
          out[y * W + x] = best;
        }
      }
      return out;
    }

    /**
     * Morphological opening (erode then dilate).
     *
     * Walls are joined to rugs, bedding and shelves by thin colour bridges
     * that no threshold cleanly severs. Opening removes anything narrower than
     * the kernel — those bridges and stray speckles — while leaving the broad
     * wall body its original size.
     */
    function openMask(mask, W, H, r) {
      if (!r) return mask;
      return morph1D(morph1D(mask, W, H, r, false), W, H, r, true);
    }

    /**
     * Fill *small* enclosed holes only.
     *
     * Wall texture leaves pinholes of a few pixels, and those belong to the
     * region. A framed picture or a lampshade standing on the wall is also
     * "enclosed" from the flood fill's point of view, but it is a genuinely
     * separate object — so holes above `maxArea` are deliberately left alone.
     * Components touching the image border are always outside.
     */
    function fillHoles(mask, W, H, maxArea) {
      var n = W * H;
      var limit = maxArea === undefined ? Math.max(24, n * 0.0003) : maxArea;
      var seen = new Uint8Array(n);
      var out = new Uint8Array(n);
      var mask8 = mask;
      for (var i = 0; i < n; i++) out[i] = mask8[i];

      var queue = new Int32Array(n);
      var comp = new Int32Array(n);
      for (var start = 0; start < n; start++) {
        if (mask8[start] || seen[start]) continue;
        var head = 0, tail = 1, size = 0, touchesBorder = false;
        queue[0] = start;
        seen[start] = 1;
        while (head < tail) {
          var p = queue[head++];
          comp[size++] = p;
          var px = p % W, py = (p - px) / W;
          if (px === 0 || py === 0 || px === W - 1 || py === H - 1) touchesBorder = true;
          if (px > 0 && !mask8[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; queue[tail++] = p - 1; }
          if (px < W - 1 && !mask8[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; queue[tail++] = p + 1; }
          if (py > 0 && !mask8[p - W] && !seen[p - W]) { seen[p - W] = 1; queue[tail++] = p - W; }
          if (py < H - 1 && !mask8[p + W] && !seen[p + W]) { seen[p + W] = 1; queue[tail++] = p + W; }
        }
        if (!touchesBorder && size <= limit) {
          for (var k = 0; k < size; k++) out[comp[k]] = 1;
        }
      }
      return out;
    }

    /** Keep only the connected component containing the seed point. */
    function keepComponent(mask, W, H, seedIndex) {
      var n = W * H;
      var out = new Uint8Array(n);
      if (seedIndex < 0 || seedIndex >= n || !mask[seedIndex]) {
        // Seed fell outside after opening: fall back to the largest component.
        var bestSize = 0, bestSeed = -1;
        for (var i = 0; i < n; i++) {
          if (!mask[i] || out[i]) continue;
          var q = [i], head = 0; out[i] = 2;
          while (head < q.length) {
            var p = q[head++], px = p % W, py = (p - px) / W;
            if (px > 0 && mask[p - 1] && out[p - 1] !== 2) { out[p - 1] = 2; q.push(p - 1); }
            if (px < W - 1 && mask[p + 1] && out[p + 1] !== 2) { out[p + 1] = 2; q.push(p + 1); }
            if (py > 0 && mask[p - W] && out[p - W] !== 2) { out[p - W] = 2; q.push(p - W); }
            if (py < H - 1 && mask[p + W] && out[p + W] !== 2) { out[p + W] = 2; q.push(p + W); }
          }
          if (q.length > bestSize) { bestSize = q.length; bestSeed = i; }
        }
        if (bestSeed < 0) return mask;
        seedIndex = bestSeed;
        out = new Uint8Array(n);
      }
      var queue = new Int32Array(n), head = 0, tail = 1;
      queue[0] = seedIndex;
      out[seedIndex] = 1;
      while (head < tail) {
        var pp = queue[head++], ppx = pp % W, ppy = (pp - ppx) / W;
        if (ppx > 0 && mask[pp - 1] && !out[pp - 1]) { out[pp - 1] = 1; queue[tail++] = pp - 1; }
        if (ppx < W - 1 && mask[pp + 1] && !out[pp + 1]) { out[pp + 1] = 1; queue[tail++] = pp + 1; }
        if (ppy > 0 && mask[pp - W] && !out[pp - W]) { out[pp - W] = 1; queue[tail++] = pp - W; }
        if (ppy < H - 1 && mask[pp + W] && !out[pp + W]) { out[pp + W] = 1; queue[tail++] = pp + W; }
      }
      return out;
    }

    /** Separable sliding-window box blur — used to feather mask edges. */
    function blur(maskF, W, H, r) {
      if (r < 1) return maskF;
      var win = 2 * r + 1;
      var tmp = new Float32Array(W * H);
      var out = new Float32Array(W * H);
      var x, y, k, sum, row, add, rem;

      for (y = 0; y < H; y++) {
        row = y * W;
        sum = 0;
        for (k = -r; k <= r; k++) sum += maskF[row + (k < 0 ? 0 : k >= W ? W - 1 : k)];
        for (x = 0; x < W; x++) {
          tmp[row + x] = sum / win;
          add = x + r + 1; rem = x - r;
          sum += maskF[row + (add >= W ? W - 1 : add)] - maskF[row + (rem < 0 ? 0 : rem)];
        }
      }
      for (x = 0; x < W; x++) {
        sum = 0;
        for (k = -r; k <= r; k++) sum += tmp[(k < 0 ? 0 : k >= H ? H - 1 : k) * W + x];
        for (y = 0; y < H; y++) {
          out[y * W + x] = sum / win;
          add = y + r + 1; rem = y - r;
          sum += tmp[(add >= H ? H - 1 : add) * W + x] - tmp[(rem < 0 ? 0 : rem) * W + x];
        }
      }
      return out;
    }

    function featherMask(mask, W, H, radius) {
      var n = W * H;
      if (radius < 1) {
        var f = new Float32Array(n);
        for (var i = 0; i < n; i++) f[i] = mask[i];
        return f;
      }
      var m = new Float32Array(n);
      for (var j = 0; j < n; j++) m[j] = mask[j];
      return blur(m, W, H, Math.round(radius));
    }

    /** Soft vertical/horizontal kept-inside window for the boundary sliders. */
    function windows(W, H, heightCut, spanMin, spanMax, soft) {
      var colWin = new Float32Array(W);
      var rowWin = new Float32Array(H);
      var yCut = heightCut * H, x0 = spanMin * W, x1 = spanMax * W;
      var x, y;
      for (x = 0; x < W; x++) {
        var a = Math.min((x - x0 + soft) / soft, (x1 - x + soft) / soft);
        colWin[x] = a < 0 ? 0 : a > 1 ? 1 : a;
      }
      for (y = 0; y < H; y++) {
        var b = (yCut - y + soft) / soft;
        rowWin[y] = b < 0 ? 0 : b > 1 ? 1 : b;
      }
      return { colWin: colWin, rowWin: rowWin };
    }

    /**
     * Luminance-multiplying paint composite.
     *
     * Each pixel's shading ratio (source / wall reference) is applied to the
     * target paint colour per channel. Shadows stay shadows, highlights stay
     * highlights, warm lamp light keeps its warmth, wall texture is untouched.
     * `light` (0..1) controls how much of that shading is preserved.
     */
    function composite(o) {
      var src = o.src, dst = o.dst, alpha = o.alpha;
      var W = o.W, H = o.H, colWin = o.colWin, rowWin = o.rowWin;
      var c = o.color, ref = o.ref;
      var K = o.light, sheen = o.sheen ? 1 : 0;
      var tr = c[0], tg = c[1], tb = c[2];
      var rr = ref[0] > 4 ? ref[0] : 4, rg = ref[1] > 4 ? ref[1] : 4, rb = ref[2] > 4 ? ref[2] : 4;
      var inv_r = 1 / (rr + 1), inv_g = 1 / (rg + 1), inv_b = 1 / (rb + 1);
      var painted = 0, partial = 0;

      for (var y = 0; y < H; y++) {
        var rw = rowWin[y];
        if (rw <= 0) continue;
        var off = y * W;
        for (var x = 0; x < W; x++) {
          var a = alpha[off + x];
          if (a <= 0.002) continue;
          a *= rw * colWin[x];
          if (a <= 0.002) continue;
          if (a > 1) a = 1;

          var p = (off + x) << 2;
          var sr = src[p], sg = src[p + 1], sb = src[p + 2];

          var mr = (sr + 1) * inv_r;
          var mg = (sg + 1) * inv_g;
          var mb = (sb + 1) * inv_b;
          if (mr < 0.25) mr = 0.25; else if (mr > 2.2) mr = 2.2;
          if (mg < 0.25) mg = 0.25; else if (mg > 2.2) mg = 2.2;
          if (mb < 0.25) mb = 0.25; else if (mb > 2.2) mb = 2.2;
          if (K !== 1) {
            mr = 1 + (mr - 1) * K;
            mg = 1 + (mg - 1) * K;
            mb = 1 + (mb - 1) * K;
          }

          var orr = tr * mr, og = tg * mg, ob = tb * mb;

          if (sheen) {
            var lum = sr * 0.299 + sg * 0.587 + sb * 0.114;
            if (lum > 198) {
              var sp = (lum - 198) / 57;
              if (sp > 1) sp = 1;
              var amt = sp * 0.34;
              orr += (255 - orr) * amt;
              og += (255 - og) * amt;
              ob += (255 - ob) * amt;
            }
          }

          if (a >= 0.999) {
            dst[p] = orr; dst[p + 1] = og; dst[p + 2] = ob;
            painted++;
          } else {
            dst[p] = sr + (orr - sr) * a;
            dst[p + 1] = sg + (og - sg) * a;
            dst[p + 2] = sb + (ob - sb) * a;
            if (a >= 0.5) painted++; else partial++;
          }
        }
      }
      return { painted: painted, partial: partial };
    }

    /** Mean source colour under a set of masks — the shading reference. */
    function meanColour(src, W, H, regions) {
      var sr = 0, sg = 0, sb = 0, n = 0, i, p, m;
      for (var r = 0; r < regions.length; r++) {
        m = regions[r].mask;
        for (i = 0, p = 0; i < m.length; i++, p += 4) {
          if (!m[i]) continue;
          sr += src[p]; sg += src[p + 1]; sb += src[p + 2]; n++;
        }
      }
      if (!n) return [140, 140, 138];
      return [sr / n, sg / n, sb / n];
    }

    /** Intersection-over-union of two masks, for de-duplicating seeds. */
    function iou(a, b) {
      var inter = 0, uni = 0;
      for (var i = 0; i < a.length; i++) {
        var x = a[i], y = b[i];
        if (x && y) inter++;
        if (x || y) uni++;
      }
      return uni ? inter / uni : 0;
    }

    return {
      rgbToLab: rgbToLab, hexToRgb: hexToRgb, rgbToHex: rgbToHex,
      luminance: luminance, buildLab: buildLab, sobel: sobel,
      segmentWall: segmentWall, featherMask: featherMask, blur: blur, despeckle: despeckle,
      openMask: openMask, keepComponent: keepComponent, morph1D: morph1D, fillHoles: fillHoles,
      consolidateGradient: consolidateGradient, edgeLimit: edgeLimit, textureMap: textureMap,
      textureBaseline: textureBaseline,
      windows: windows, composite: composite, meanColour: meanColour, iou: iou
    };
  })();
  /* @@CORE-END@@ */

  /* ------------------------------------------------------------------
     Colortrend Ambiance library (56 shades, cross-checked with the spec's
     Lavender Posy 6151P and Savin Hill 1113D).
     ------------------------------------------------------------------ */
  var PALETTE = [
    { name: 'Lavender Posy',    code: '6151P', hex: '#C3B7CE', cat: 'cool' },
    { name: 'Savin Hill',       code: '1113D', hex: '#48594B', cat: 'deep' },
    { name: 'Chalk White',      code: '1100N', hex: '#F7F4EE', cat: 'neutral' },
    { name: 'Alpine Snow',      code: '1101N', hex: '#F2EFE8', cat: 'neutral' },
    { name: 'Chalk Bluff',      code: '1102N', hex: '#E9E4DA', cat: 'neutral' },
    { name: 'Sea Salt',         code: '1104N', hex: '#DCE0DA', cat: 'neutral' },
    { name: 'Oat Milk',         code: '1106W', hex: '#E6DAC6', cat: 'neutral' },
    { name: 'Antique White',    code: '1108W', hex: '#EDE4D3', cat: 'neutral' },
    { name: 'Cashmere',         code: '1112N', hex: '#DCD2C4', cat: 'neutral' },
    { name: 'Wild Flax',        code: '1118N', hex: '#D5C8B0', cat: 'warm' },
    { name: 'Putty',            code: '1119N', hex: '#CBBBA5', cat: 'warm' },
    { name: 'Linen Whisper',    code: '1124W', hex: '#E4DCCE', cat: 'neutral' },
    { name: 'Townhouse Tan',    code: '1110W', hex: '#C7B49A', cat: 'warm' },
    { name: 'River Stone',      code: '4147N', hex: '#A9A69D', cat: 'neutral' },
    { name: 'River Pebble',     code: '4145N', hex: '#B4B0A8', cat: 'neutral' },
    { name: 'Driftwood',        code: '2109N', hex: '#BEB3A4', cat: 'neutral' },
    { name: 'Frosted Glass',    code: '6145N', hex: '#DDE4E6', cat: 'neutral' },
    { name: 'Morning Mist',     code: '6142C', hex: '#C7CFD3', cat: 'cool' },
    { name: 'Powder Blue',      code: '4170N', hex: '#C3D2DA', cat: 'cool' },
    { name: 'Harbor Mist',      code: '6148C', hex: '#A9BEC6', cat: 'cool' },
    { name: 'Harbor Blue',      code: '4175C', hex: '#6C8AA0', cat: 'cool' },
    { name: 'Weathered Pine',   code: '5120C', hex: '#8A9A87', cat: 'cool' },
    { name: 'Pale Moss',        code: '5132C', hex: '#C3C8A8', cat: 'cool' },
    { name: 'Sage Garden',      code: '5136C', hex: '#A3AC90', cat: 'cool' },
    { name: 'Eucalyptus',       code: '5144C', hex: '#8E9E92', cat: 'cool' },
    { name: 'Olive Branch',     code: '3150C', hex: '#6E7451', cat: 'cool' },
    { name: 'Lilac Veil',       code: '6155P', hex: '#C9BED4', cat: 'cool' },
    { name: 'Wisteria',         code: '6158P', hex: '#B3A3C4', cat: 'cool' },
    { name: 'Evening Haze',     code: '6167P', hex: '#8C7FA0', cat: 'cool' },
    { name: 'Cornflower',       code: '4172P', hex: '#8E9BC1', cat: 'cool' },
    { name: 'Dusty Rose',       code: '6165P', hex: '#C79A97', cat: 'warm' },
    { name: 'Blush Plaster',    code: '6162W', hex: '#E3C6BD', cat: 'warm' },
    { name: 'Peach Bloom',      code: '6160W', hex: '#E8C2AE', cat: 'warm' },
    { name: 'Candlestick',      code: '1116W', hex: '#E8C89A', cat: 'warm' },
    { name: 'Butter Cream',     code: '1120W', hex: '#F0DFB4', cat: 'warm' },
    { name: 'Golden Straw',     code: '3142W', hex: '#E0C48A', cat: 'warm' },
    { name: 'Honey Glow',       code: '3148W', hex: '#D9A85F', cat: 'warm' },
    { name: 'Saffron Wall',     code: '3146W', hex: '#D9A24E', cat: 'warm' },
    { name: 'Amber Hearth',     code: '3145W', hex: '#C98F4E', cat: 'warm' },
    { name: 'Clay Pot',         code: '2135W', hex: '#C08B6A', cat: 'warm' },
    { name: 'Terracotta',       code: '2140W', hex: '#B2674A', cat: 'warm' },
    { name: 'Toasted Almond',   code: '2114W', hex: '#BFA08A', cat: 'warm' },
    { name: 'Cocoa Dust',       code: '2120W', hex: '#8A6A55', cat: 'warm' },
    { name: 'Baked Clay',       code: '2138D', hex: '#7A4B38', cat: 'deep' },
    { name: 'Espresso Bean',    code: '2125D', hex: '#3B2A22', cat: 'deep' },
    { name: 'Charcoal Smoke',   code: '2101D', hex: '#3A3B3C', cat: 'deep' },
    { name: 'Iron Gate',        code: '2104D', hex: '#4A4C50', cat: 'deep' },
    { name: 'Slate Harbor',     code: '4190D', hex: '#3A4A5A', cat: 'deep' },
    { name: 'Deep Sea',         code: '4180D', hex: '#2C4557', cat: 'deep' },
    { name: 'Ink Well',         code: '4185D', hex: '#1E2A37', cat: 'deep' },
    { name: 'Midnight Spruce',  code: '5180D', hex: '#1B302E', cat: 'deep' },
    { name: 'Pine Needle',      code: '5188D', hex: '#294036', cat: 'deep' },
    { name: 'Forest Floor',     code: '5175D', hex: '#2C3B2A', cat: 'deep' },
    { name: 'Moss Shadow',      code: '5170D', hex: '#39492F', cat: 'deep' },
    { name: 'Plum Velvet',      code: '6170D', hex: '#4A3247', cat: 'deep' },
    { name: 'Aubergine',        code: '6175D', hex: '#3B2734', cat: 'deep' }
  ].map(function (c) {
    var rgb = CORE.hexToRgb(c.hex);
    c.rgb = rgb;
    c.lab = CORE.rgbToLab(rgb[0], rgb[1], rgb[2]);
    c.id = c.code;
    return c;
  });

  var CAT_LABEL = { all: 'All', neutral: 'Neutral', warm: 'Warm', cool: 'Cool', deep: 'Deep' };
  var EMBEDDED_ROOM = '@@ROOM_SRC@@';
  var MAX_PIXELS = 2400000;
  var MAX_REGIONS = 8;
  var MAX_UPLOAD_BYTES = 28 * 1024 * 1024;
  var DEFAULTS = {
    code: '6151P',
    tol: 22,
    edgeGuard: 0.55,
    light: 100,
    height: 100,
    spanMin: 0,
    spanMax: 100,
    feather: 1.5,
    paintMode: 'all',
    mask: false,
    seeds: true,
    sheen: true
  };

  /* ------------------------------ state ------------------------------ */
  var state = {
    W: 0, H: 0,
    srcImage: null,        // pristine ImageData
    outImage: null,        // reusable output ImageData
    lab: null, edge: null,
    alpha: null,           // combined feathered alpha
    regions: [],
    nextRegionId: 1,
    activeRegionId: null,
    color: PALETTE[0],
    paintMode: DEFAULTS.paintMode,
    tol: DEFAULTS.tol,
    edgeGuard: DEFAULTS.edgeGuard,
    light: DEFAULTS.light,
    height: DEFAULTS.height,
    spanMin: DEFAULTS.spanMin,
    spanMax: DEFAULTS.spanMax,
    feather: DEFAULTS.feather,
    showMask: DEFAULTS.mask,
    showSeeds: DEFAULTS.seeds,
    sheen: DEFAULTS.sheen,
    compare: false,
    cat: 'all',
    query: '',
    coverage: 0,
    imageTitle: 'Bedroom · natural daylight',
    refPix: [150, 150, 145],
    texBase: 1,
    tex: null,
    refKey: '',
    lastSegmentMs: 0,
    lastRenderMs: 0,
    ready: false,
    busy: false
  };

  /* ------------------------------ dom ------------------------------ */
  var el = {};
  function $(id) { return document.getElementById(id); }

  var scene, sceneCtx, marks, marksCtx, markOverlay = null;

  /* ------------------------------ utils ------------------------------ */
  var rafPending = false;

  function scheduleRender() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(function () {
      rafPending = false;
      render();
    });
  }

  function setBusy(v) {
    state.busy = v;
    if (el.busy) el.busy.classList.toggle('show', !!v);
  }

  var toastTimer = null;
  function toast(msg, isError) {
    if (!el.toast) return;
    el.toast.textContent = msg;
    el.toast.classList.toggle('err', !!isError);
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.toast.classList.remove('show'); }, 2600);
  }

  function announce(msg) {
    if (el.live) el.live.textContent = msg;
  }

  /**
   * Error boundary. Every risky stage (decoding, buffer precompute,
   * segmentation, compositing) funnels here instead of killing the app.
   */
  function fail(context, err) {
    var msg = err && err.message ? err.message : String(err || 'Unknown failure');
    if (window.console && console.error) console.error('[' + context + ']', err);
    setBusy(false);
    if (!el.errorOverlay) { toast(context + ': ' + msg, true); return; }
    el.errTitle.textContent = 'Simulator hit a snag';
    el.errCtx.textContent = context;
    el.errMsg.textContent = msg + (err && err.stack ? '\n\n' + String(err.stack).split('\n').slice(0, 3).join('\n') : '');
    el.errorOverlay.classList.add('show');
    announce('Error: ' + msg);
  }

  function guard(context, fn, fallback) {
    try { return fn(); } catch (e) { fail(context, e); return fallback; }
  }

  /* ------------------------ palette rendering ------------------------ */
  function filteredPalette() {
    var q = state.query.trim().toLowerCase();
    return PALETTE.filter(function (c) {
      if (state.cat !== 'all' && c.cat !== state.cat) return false;
      if (!q) return true;
      return c.name.toLowerCase().indexOf(q) !== -1 ||
             c.code.toLowerCase().indexOf(q) !== -1 ||
             c.hex.toLowerCase().indexOf(q) !== -1;
    });
  }

  function renderPalette() {
    var list = filteredPalette();
    var frag = document.createDocumentFragment();
    list.forEach(function (c) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'pcard';
      b.setAttribute('aria-pressed', String(state.color.id === c.id));
      b.dataset.code = c.code;
      b.title = c.name + ' · ' + c.code;
      var sw = document.createElement('div');
      sw.className = 'sw';
      sw.style.background = c.hex;
      var nm = document.createElement('div');
      nm.className = 'pname';
      nm.textContent = c.name;
      var cd = document.createElement('div');
      cd.className = 'pcode';
      cd.textContent = c.code;
      b.appendChild(sw); b.appendChild(nm); b.appendChild(cd);
      frag.appendChild(b);
    });
    el.paletteGrid.innerHTML = '';
    el.paletteGrid.appendChild(frag);
    el.paletteEmpty.classList.toggle('hidden', list.length > 0);
    el.paletteCount.textContent = list.length + ' / ' + PALETTE.length;
  }

  function setColor(code, opts) {
    var c = PALETTE.find(function (x) { return x.code === code; }) || PALETTE[0];
    state.color = c;
    el.topSwatch.style.background = c.hex;
    el.topName.textContent = c.name;
    el.topCode.textContent = c.code + ' · ' + CAT_LABEL[c.cat].toUpperCase();
    el.heroSwatch.style.background = c.hex;
    el.heroName.textContent = c.name;
    el.heroCode.textContent = c.code;
    el.heroHex.textContent = c.hex.toUpperCase() + ' · ' + CAT_LABEL[c.cat].toUpperCase();
    Array.prototype.forEach.call(el.paletteGrid.children, function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.code === c.id));
    });
    if (!opts || !opts.silent) scheduleRender();
  }

  /* ------------------------- region handling ------------------------- */
  function regionLabel(mask, W, H) {
    var n = mask.length, sx = 0, sy = 0, cnt = 0;
    for (var i = 0; i < n; i++) {
      if (!mask[i]) continue;
      var x = i % W;
      sx += x; sy += (i - x) / W; cnt++;
    }
    if (!cnt) return 'Wall';
    var cx = (sx / cnt) / W, cy = (sy / cnt) / H;
    var side = cx < 0.34 ? 'Left' : cx > 0.66 ? 'Right' : 'Center';
    var band = cy < 0.34 ? 'Upper' : cy > 0.68 ? 'Lower' : '';
    return band ? side + ' ' + band + ' Wall' : side + ' Wall';
  }

  function uniqueName(base) {
    var n = base, i = 2;
    var used = state.regions.map(function (r) { return r.baseName; });
    while (used.indexOf(n) !== -1) { n = base + ' ' + (i++); }
    return n;
  }

  function segmentAt(x, y) {
    return CORE.segmentWall({
      W: state.W, H: state.H, lab: state.lab, edge: state.edge,
      seedX: x, seedY: y, tol: state.tol, edgeGuard: state.edgeGuard,
      baseline: state.texBase, tex: state.tex
    });
  }

  function cleanup() {
    if (sceneCtx) sceneCtx.clearRect(0, 0, state.W, state.H);
  }
  window.addEventListener('beforeunload', cleanup);

  /**
   * Post-process a raw flood fill into a production-quality mask:
   *   1. majority despeckle  — clears photographic noise speckle
   *   2. morphological open  — severs thin bridges to bedding / rugs / shelves
   *   3. seed component      — guarantees one contiguous wall surface
   *   4. hole filling        — absorbs texture speckle inside the wall
   */
  function refineSegmentation(seg) {
    var W = state.W, H = state.H;
    var r = Math.max(1, Math.round(W / 700));
    var mask = CORE.despeckle(seg.mask, W, H, 2);
    mask = CORE.openMask(mask, W, H, r);
    mask = CORE.keepComponent(mask, W, H, seg.seedIndex);
    mask = CORE.fillHoles(mask, W, H);
    mask = CORE.despeckle(mask, W, H, 1);
    var count = 0;
    for (var i = 0; i < mask.length; i++) if (mask[i]) count++;
    return { mask: mask, count: count, seedIndex: seg.seedIndex };
  }

  /** Returns the new/selected region, deduping a redundant seed. */
  function addRegion(seedX, seedY, opts) {
    opts = opts || {};
    seedX = Math.max(0, Math.min(state.W - 1, Math.round(seedX)));
    seedY = Math.max(0, Math.min(state.H - 1, Math.round(seedY)));

    var t0 = performance.now();
    var seg = refineSegmentation(segmentAt(seedX, seedY));

    var minArea = Math.max(64, state.W * state.H * 0.0015);
    if (seg.count < minArea) {
      if (!opts.silent) toast('That spot is too small to be a wall — try inside the wall area.', true);
      return null;
    }

    // Already covered? Select the existing region instead of stacking a twin.
    var distinct = opts.distinct === undefined ? 0.82 : opts.distinct;
    for (var i = 0; i < state.regions.length; i++) {
      var r = state.regions[i];
      if (CORE.iou(r.mask, seg.mask) > distinct) {
        if (!opts.silent) {
          selectRegion(r.id);
          toast('That wall is already detected as “' + r.name + '”.');
        }
        return r;
      }
    }
    if (state.regions.length >= MAX_REGIONS) {
      if (!opts.silent) toast('Region limit reached (' + MAX_REGIONS + '). Delete one first.', true);
      return null;
    }

    var region = registerRegion(seg.mask, seg.count, seedX, seedY);
    if (!region) return null;
    state.lastSegmentMs = performance.now() - t0;
    if (!opts.silent) renderRegionList();
    scheduleRender();
    return region;
  }

  /** Build, store and select a region from an already-refined mask. */
  function registerRegion(mask, count, seedX, seedY) {
    if (state.regions.length >= MAX_REGIONS) return null;
    var base = regionLabel(mask, state.W, state.H);
    var region = {
      id: state.nextRegionId++,
      baseName: uniqueName(base),
      name: '',
      seedX: seedX, seedY: seedY,
      mask: mask,
      count: count,
      alphaF: CORE.featherMask(mask, state.W, state.H, featherPx()),
      hex: ''
    };
    region.name = region.baseName;
    state.regions.push(region);
    state.refKey = '';
    selectRegion(region.id);
    return region;
  }

  /**
   * "This region" mode: clicking re-seeds the selected wall in place, so a
   * seed that landed on the wrong surface can be corrected without losing the
   * region's place in the list.
   */
  function reseedActiveRegion(x, y) {
    var region = state.regions.find(function (r) { return r.id === state.activeRegionId; });
    if (!region) { addRegion(x, y); return; }
    x = Math.max(0, Math.min(state.W - 1, Math.round(x)));
    y = Math.max(0, Math.min(state.H - 1, Math.round(y)));
    var t0 = performance.now();
    var seg = refineSegmentation(segmentAt(x, y));
    var minArea = Math.max(64, state.W * state.H * 0.0015);
    if (seg.count < minArea) {
      toast('Too small to be a wall — pick a spot inside the wall area.', true);
      return;
    }
    region.seedX = x;
    region.seedY = y;
    region.mask = seg.mask;
    region.count = seg.count;
    region.alphaF = CORE.featherMask(seg.mask, state.W, state.H, featherPx());
    state.lastSegmentMs = performance.now() - t0;
    state.refKey = '';
    renderRegionList();
    scheduleRender();
  }

  function featherPx() {
    // Keep the visual feather consistent across image resolutions.
    return state.feather * Math.max(1, state.W / 1400);
  }

  function selectRegion(id) {
    state.activeRegionId = id;
    renderRegionList();
    updateModeHint();
  }

  function removeRegion(id) {
    state.regions = state.regions.filter(function (r) { return r.id !== id; });
    if (state.activeRegionId === id) {
      state.activeRegionId = state.regions.length ? state.regions[state.regions.length - 1].id : null;
    }
    state.refKey = '';
    renderRegionList();
    updateModeHint();
    scheduleRender();
  }

  function renderRegionList() {
    el.regionList.innerHTML = '';
    el.regionCount.textContent = state.regions.length + '/' + MAX_REGIONS;
    if (!state.regions.length) {
      var p = document.createElement('div');
      p.className = 'empty-note';
      p.textContent = 'No regions yet — click the wall in the photo.';
      el.regionList.appendChild(p);
      return;
    }
    state.regions.forEach(function (r) {
      var row = document.createElement('div');
      row.className = 'region';
      row.dataset.active = String(r.id === state.activeRegionId);

      var dot = document.createElement('span');
      dot.className = 'region-dot';
      dot.style.background = state.color.hex;

      var main = document.createElement('button');
      main.type = 'button';
      main.className = 'region-main';
      main.title = 'Isolate ' + r.name;
      main.innerHTML = '<div class="region-name"></div><div class="region-meta"></div>';
      main.querySelector('.region-name').textContent = r.name;
      main.querySelector('.region-meta').textContent =
        ((r.count / (state.W * state.H)) * 100).toFixed(1) + '% · seed ' +
        Math.round(r.seedX) + ',' + Math.round(r.seedY);
      main.addEventListener('click', function () {
        selectRegion(r.id);
        if (state.paintMode === 'all') setPaintMode('isolate');
        scheduleRender();
      });

      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'region-del';
      del.title = 'Remove region';
      del.setAttribute('aria-label', 'Remove ' + r.name);
      del.innerHTML = '&times;';
      del.addEventListener('click', function (e) {
        e.stopPropagation();
        removeRegion(r.id);
      });

      row.appendChild(dot); row.appendChild(main); row.appendChild(del);
      el.regionList.appendChild(row);
    });
  }

  /**
   * Auto-detect: probe a grid, keep the largest segmentations that are
   * genuinely different surfaces, and add up to three of them. Two probes on
   * the same wall produce near-identical masks (high IoU) and collapse into a
   * single region; a side wall seen in perspective produces a different mask
   * and is kept.
   */
  function autoDetectWalls() {
    var t0 = performance.now();
    var cands = [];
    var gx, gy;
    for (gy = 1; gy <= 4; gy++) {
      for (gx = 1; gx <= 8; gx++) {
        var x = (state.W * gx) / 9;
        var y = (state.H * gy) / 5;
        var seg = segmentAt(x, y);
        if (seg.count < state.W * state.H * 0.012) continue;   // ignore slivers
        // Skip anything that is essentially the existing regions.
        var dup = false;
        for (var i = 0; i < state.regions.length && !dup; i++) {
          if (CORE.iou(state.regions[i].mask, seg.mask) > 0.55) dup = true;
        }
        for (var j = 0; j < cands.length && !dup; j++) {
          if (CORE.iou(cands[j].mask, seg.mask) > 0.5) dup = true;
        }
        if (dup) continue;
        cands.push(seg);
      }
    }
    cands.sort(function (a, b) { return b.count - a.count; });
    cands = cands.slice(0, Math.max(0, Math.min(3, MAX_REGIONS - state.regions.length)));

    var added = 0;
    cands.forEach(function (seg) {
      var region = registerRegion(seg.mask, seg.count, seg.seedX, seg.seedY);
      if (region) added++;
    });
    state.lastSegmentMs = performance.now() - t0;
    renderRegionList();
    updateModeHint();
    scheduleRender();
    if (added) {
      toast('Detected ' + added + ' new wall region' + (added === 1 ? '' : 's') + '.');
      announce(added + ' wall regions detected');
    } else if (!state.regions.length) {
      toast('No walls detected — try clicking the wall directly.', true);
    } else {
      toast('No additional wall surfaces found.');
    }
  }

  /* --------------------------- rendering --------------------------- */
  function computeRef(painted) {
    var key = state.paintMode + ':' + painted.map(function (r) { return r.id; }).join(',') + ':' + state.W;
    if (key === state.refKey) return state.refPix;
    var m = CORE.meanColour(state.srcImage.data, state.W, state.H, painted);
    state.refPix = m;
    state.refKey = key;
    return m;
  }

  function render() {
    if (!state.ready) return;
    var t0 = performance.now();
    try {
      if (state.compare) {
        sceneCtx.putImageData(state.srcImage, 0, 0);
        state.coverage = 0;
        drawMarks();
        updateStats(performance.now() - t0);
        return;
      }

      var painted = state.paintMode === 'all'
        ? state.regions.slice()
        : state.regions.filter(function (r) { return r.id === state.activeRegionId; });

      state.outImage.data.set(state.srcImage.data);

      if (!painted.length) {
        sceneCtx.putImageData(state.srcImage, 0, 0);
        state.coverage = 0;
        drawMarks();
        updateStats(performance.now() - t0);
        return;
      }

      // Union the feathered region alphas (single paint colour -> max blend).
      state.alpha.fill(0);
      var alpha = state.alpha;
      for (var r = 0; r < painted.length; r++) {
        var af = painted[r].alphaF;
        for (var i = 0; i < af.length; i++) {
          var v = af[i];
          if (v > alpha[i]) alpha[i] = v;
        }
      }

      var ref = computeRef(painted);
      var soft = Math.max(1.5, state.W * 0.0018);
      var wins = CORE.windows(state.W, state.H, state.height, state.spanMin, state.spanMax, soft);

      var res = CORE.composite({
        src: state.srcImage.data,
        dst: state.outImage.data,
        alpha: alpha,
        W: state.W, H: state.H,
        colWin: wins.colWin, rowWin: wins.rowWin,
        color: state.color.rgb,
        ref: ref,
        light: state.light,
        sheen: state.sheen
      });

      sceneCtx.putImageData(state.outImage, 0, 0);
      state.coverage = (res.painted + res.partial * 0.5) / (state.W * state.H);
      drawMarks();
      updateStats(performance.now() - t0);
    } catch (e) {
      fail('render', e);
    }
  }

  /**
   * Size the canvas to the stage while preserving the photo's aspect ratio.
   * Done in JS so the overlay canvas stays pixel-aligned with the photo at
   * every viewport size (percentage heights on an auto-height wrapper are
   * indefinite, and would letterbox the two layers apart).
   */
  function fitCanvas() {
    if (!state.W || !state.H || !el.canvasWrap) return;
    var availW = el.canvasWrap.clientWidth - 26;
    var availH = el.canvasWrap.clientHeight - 26;
    // A hidden or unlaid-out stage reports 0; fall back to a sensible box and
    // let the ResizeObserver correct it once the stage has real dimensions.
    if (availW <= 0) availW = 900;
    if (availH <= 0) availH = 560;
    var ar = state.W / state.H;
    var w = Math.min(availW, availH * ar);
    var h = w / ar;
    if (!isFinite(w) || w <= 0) return;
    scene.style.width = Math.round(w) + 'px';
    scene.style.height = Math.round(h) + 'px';
    if (el.canvasHolder) {
      el.canvasHolder.style.width = Math.round(w) + 'px';
      el.canvasHolder.style.height = Math.round(h) + 'px';
    }
  }

  function drawMarks() {
    if (!marksCtx) return;
    marksCtx.clearRect(0, 0, state.W, state.H);

    if (state.showMask && !state.compare && state.alpha) {
      if (!markOverlay || markOverlay.width !== state.W) {
        markOverlay = marksCtx.createImageData(state.W, state.H);
      }
      var d = markOverlay.data, a = state.alpha;
      for (var i = 0, p = 0; i < a.length; i++, p += 4) {
        var v = a[i];
        if (v <= 0.02) { d[p + 3] = 0; continue; }
        d[p] = 111; d[p + 1] = 211; d[p + 2] = 196;
        d[p + 3] = Math.round(52 * (v > 1 ? 1 : v));
      }
      marksCtx.putImageData(markOverlay, 0, 0);
    }

    if (!state.showSeeds) return;

    var scale = Math.max(1, state.W / 900);
    state.regions.forEach(function (r) {
      var active = r.id === state.activeRegionId;
      var x = r.seedX, y = r.seedY;
      var rad = (active ? 9 : 7) * scale;

      marksCtx.beginPath();
      marksCtx.arc(x, y, rad + 5 * scale, 0, Math.PI * 2);
      marksCtx.fillStyle = 'rgba(6,9,13,.55)';
      marksCtx.fill();

      marksCtx.beginPath();
      marksCtx.arc(x, y, rad, 0, Math.PI * 2);
      marksCtx.fillStyle = state.color.hex;
      marksCtx.fill();
      marksCtx.lineWidth = 2 * scale;
      marksCtx.strokeStyle = active ? 'rgba(255,255,255,.95)' : 'rgba(255,255,255,.45)';
      marksCtx.stroke();

      if (active) {
        marksCtx.beginPath();
        marksCtx.arc(x, y, rad + 9 * scale, 0, Math.PI * 2);
        marksCtx.lineWidth = 1.5 * scale;
        marksCtx.strokeStyle = 'rgba(243,169,93,.9)';
        marksCtx.stroke();
      }
    });
  }

  function updateStats(ms) {
    state.lastRenderMs = ms;
    if (el.stageStat) {
      el.stageStat.textContent = state.compare
        ? 'ORIGINAL · ' + Math.round(ms) + 'ms'
        : state.W + '×' + state.H + ' · ' + state.regions.length + ' region' +
          (state.regions.length === 1 ? '' : 's') + ' · ' + Math.round(ms) + 'ms';
    }
    if (el.coverageBadge) el.coverageBadge.textContent = (state.coverage * 100).toFixed(1) + '% wall';
    if (el.perfLegend) {
      el.perfLegend.textContent = 'segment ' + state.lastSegmentMs.toFixed(0) + 'ms · render ' + state.lastRenderMs.toFixed(0) + 'ms';
    }
  }

  /* ------------------------- image loading ------------------------- */
  function decodeImage(src) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () {
        reject(new Error('The image could not be decoded. Use a JPEG, PNG, WebP or AVIF photo.'));
      };
      img.decoding = 'async';
      img.src = src;
    });
  }

  function loadImage(src, title, isUpload) {
    setBusy(true);
    return decodeImage(src).then(function (img) {
      var w = img.naturalWidth || img.width;
      var h = img.naturalHeight || img.height;

      if (!w || !h) throw new Error('The image has no readable dimensions.');
      if (w < 240 || h < 160) throw new Error('That image is too small (' + w + '×' + h + '). Use at least 240×160 so wall regions can be detected.');

      // Keep pixel buffers bounded without visible quality loss.
      var scale = Math.min(1, Math.sqrt(MAX_PIXELS / (w * h)));
      var W = Math.max(1, Math.round(w * scale));
      var H = Math.max(1, Math.round(h * scale));

      var c = document.createElement('canvas');
      c.width = W; c.height = H;
      var ctx = c.getContext('2d', { willReadFrequently: true });
      if (!ctx) throw new Error('Canvas 2D is unavailable in this browser.');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, W, H);

      var data;
      try {
        data = ctx.getImageData(0, 0, W, H);
      } catch (e) {
        throw new Error('Pixel access was blocked. If the photo is served from another domain it needs CORS approval — upload the file instead.');
      }

      state.W = W; state.H = H;
      state.srcImage = data;
      state.outImage = new ImageData(new Uint8ClampedArray(data.data), W, H);
      state.alpha = new Float32Array(W * H);
      marks.width = W; marks.height = H;
      scene.width = W; scene.height = H;
      if (sceneCtx) { sceneCtx.imageSmoothingEnabled = true; }

      // Buffer precomputation has its own boundary — it is the most
      // memory-hungry step and the most likely to fail on mobile Safari.
      try {
        state.lab = CORE.buildLab(data.data, W, H);
        state.edge = CORE.consolidateGradient(CORE.sobel(state.lab.L, W, H), W, H, 1);
        state.texBase = CORE.textureBaseline(state.edge, W, H);
        state.tex = CORE.textureMap(state.lab.L, W, H, 2);
      } catch (e) {
        state.lab = null; state.edge = null;
        throw new Error('Could not build the perceptual buffers — the image may be too large for this device. Try a smaller photo.');
      }

      state.regions = [];
      state.activeRegionId = null;
      state.refKey = '';
      state.imageTitle = title || (isUpload ? 'Uploaded room' : 'Bedroom · natural daylight');
      state.ready = true;
      el.stageTitle.textContent = state.imageTitle;

      // Default seed: a broad, central wall region.
      addRegion(W * 0.62, H * 0.40, { silent: true });
      renderRegionList();
      updateModeHint();
      fitCanvas();
      setBusy(false);
      scheduleRender();
      return true;
    }).catch(function (e) {
      setBusy(false);
      fail(isUpload ? 'image upload' : 'image load', e);
      return false;
    });
  }

  /* ------------------------------ UI ------------------------------ */
  function setPaintMode(mode) {
    state.paintMode = mode;
    Array.prototype.forEach.call(el.paintMode.children, function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
    });
    updateModeHint();
    scheduleRender();
  }

  function updateModeHint() {
    var sel = state.regions.find(function (r) { return r.id === state.activeRegionId; });
    if (state.paintMode === 'all') {
      el.modeHint.textContent = state.regions.length
        ? 'All ' + state.regions.length + ' detected wall region' + (state.regions.length === 1 ? '' : 's') +
          ' get the active paint. Click the photo to add another.'
        : 'Click the photo to add wall regions.';
    } else if (state.paintMode === 'isolate') {
      el.modeHint.textContent = sel
        ? 'Only “' + sel.name + '” is painted. Clicking the photo re-seeds this region; pick another in the list to switch.'
        : 'Select a region below to isolate it.';
    } else {
      el.modeHint.textContent = 'Click the photo to drop a new seed point. Each new region is painted on its own.';
    }
    if (el.regionToleranceBadge) el.regionToleranceBadge.textContent = 'ΔE ' + state.tol;
  }

  function setSwitch(node, on) {
    if (!node) return;
    node.setAttribute('aria-checked', String(!!on));
  }

  function syncSliders() {
    el.tolRange.value = state.tol;
    el.tolVal.textContent = state.tol;
    el.edgeRange.value = state.edgeGuard;
    el.edgeVal.textContent = state.edgeGuard.toFixed(2);
    el.lightRange.value = state.light;
    el.lightVal.textContent = Math.round(state.light * 100) + '%';
    el.heightRange.value = state.height * 100;
    el.heightVal.textContent = Math.round(state.height * 100) + '%';
    el.spanMinRange.value = state.spanMin * 100;
    el.spanMaxRange.value = state.spanMax * 100;
    el.spanVal.textContent = Math.round(state.spanMin * 100) + '% – ' + Math.round(state.spanMax * 100) + '%';
    el.spanBadge.textContent = Math.round(state.spanMin * 100) + '–' + Math.round(state.spanMax * 100) + '%';
    el.spanFill.style.left = (state.spanMin * 100) + '%';
    el.spanFill.style.width = ((state.spanMax - state.spanMin) * 100) + '%';
    el.featherRange.value = state.feather;
    el.featherVal.textContent = state.feather.toFixed(1) + 'px';
    setSwitch(el.maskToggle, state.showMask);
    setSwitch(el.seedToggle, state.showSeeds);
    setSwitch(el.sheenToggle, state.sheen);
  }

  function setCompare(on) {
    state.compare = !!on;
    el.compareBtn.setAttribute('aria-pressed', String(state.compare));
    el.compareLabel.textContent = state.compare ? 'Showing Original' : 'Compare Original';
    scene.classList.toggle('compare', state.compare);
    scheduleRender();
  }

  /* ---------------- mask invalidation on tuning change ---------------- */
  var segTimer = null;
  function resegmentAll() {
    if (!state.ready) return;
    clearTimeout(segTimer);
    setBusy(true);
    segTimer = setTimeout(function () {
      try {
        var t0 = performance.now();
        // Re-seed from each region's original seed point so the tuning
        // sliders refine existing walls instead of destroying them.
        state.regions = state.regions.map(function (r) {
          var seg = refineSegmentation(segmentAt(r.seedX, r.seedY));
          r.mask = seg.mask;
          r.count = seg.count;
          r.alphaF = CORE.featherMask(seg.mask, state.W, state.H, featherPx());
          return r;
        });
        state.refKey = '';
        state.lastSegmentMs = performance.now() - t0;
        renderRegionList();
        setBusy(false);
        scheduleRender();
      } catch (e) {
        setBusy(false);
        fail('segmentation', e);
      }
    }, 90);
  }

  function debounceRender() {
    scheduleRender();
  }

  /* ------------------------------ reset ------------------------------ */
  function resetAll(opts) {
    opts = opts || {};
    try {
      state.tol = DEFAULTS.tol;
      state.edgeGuard = DEFAULTS.edgeGuard;
      state.light = DEFAULTS.light / 100;
      state.height = DEFAULTS.height / 100;
      state.spanMin = DEFAULTS.spanMin / 100;
      state.spanMax = DEFAULTS.spanMax / 100;
      state.feather = DEFAULTS.feather;
      state.showMask = DEFAULTS.mask;
      state.showSeeds = DEFAULTS.seeds;
      state.sheen = DEFAULTS.sheen;
      state.paintMode = DEFAULTS.paintMode;
      state.compare = false;
      state.cat = 'all';
      state.query = '';
      el.searchInput.value = '';
      el.searchClear.classList.remove('show');
      Array.prototype.forEach.call(el.tabs.children, function (t) {
        t.setAttribute('aria-selected', String(t.dataset.cat === 'all'));
      });
      Array.prototype.forEach.call(el.paintMode.children, function (b) {
        b.setAttribute('aria-pressed', String(b.dataset.mode === DEFAULTS.paintMode));
      });
      el.compareBtn.setAttribute('aria-pressed', 'false');
      el.compareLabel.textContent = 'Compare Original';
      scene.classList.remove('compare');
      setColor(DEFAULTS.code, { silent: true });
      renderPalette();
      syncSliders();
      if (el.errorOverlay) el.errorOverlay.classList.remove('show');

      var finish = function () {
        state.regions = [];
        state.activeRegionId = null;
        state.refKey = '';
        state.ready = state.ready && true;
        if (state.ready) {
          addRegion(state.W * 0.62, state.H * 0.40, { silent: true });
          renderRegionList();
          updateModeHint();
          scheduleRender();
        }
        el.hint.classList.remove('gone');
        fitCanvas();
        toast('Simulator reset to defaults.');
      };

      if (opts.reloadImage) {
        loadImage(EMBEDDED_ROOM, 'Bedroom · natural daylight', false).then(function (ok) {
          if (!ok) return;
          el.hint.classList.remove('gone');
        });
      } else {
        finish();
      }
    } catch (e) {
      fail('reset', e);
    }
  }

  /* --------------------------- upload flow --------------------------- */
  function handleFile(file) {
    if (!file) return;
    if (!/^image\//.test(file.type)) {
      fail('image upload', new Error('“' + file.name + '” is not an image file. Choose a JPEG, PNG, WebP or AVIF.'));
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      fail('image upload', new Error('“' + file.name + '” is ' + (file.size / 1048576).toFixed(1) +
        ' MB — the limit is ' + (MAX_UPLOAD_BYTES / 1048576).toFixed(0) + ' MB.'));
      return;
    }
    var url = URL.createObjectURL(file);
    loadImage(url, file.name.replace(/\.[^.]+$/, '') + ' · uploaded', true).then(function (ok) {
      URL.revokeObjectURL(url);
      if (ok) {
        el.hint.classList.add('gone');
        toast('Room uploaded — click the wall to seed a region.');
      }
    });
  }

  /* ------------------------------ boot ------------------------------ */
  function cacheDom() {
    el = {
      app: $('app'),
      topSwatch: $('topSwatch'), topName: $('topName'), topCode: $('topCode'),
      heroSwatch: $('heroSwatch'), heroName: $('heroName'), heroCode: $('heroCode'), heroHex: $('heroHex'),
      coverageBadge: $('coverageBadge'), paletteCount: $('paletteCount'),
      paletteGrid: $('paletteGrid'), paletteEmpty: $('paletteEmpty'),
      searchInput: $('searchInput'), searchClear: $('searchClear'),
      tabs: $('tabs'), regionList: $('regionList'), regionCount: $('regionCount'),
      paintMode: $('paintMode'), modeHint: $('modeHint'),
      tolRange: $('tolRange'), tolVal: $('tolVal'),
      edgeRange: $('edgeRange'), edgeVal: $('edgeVal'),
      lightRange: $('lightRange'), lightVal: $('lightVal'),
      heightRange: $('heightRange'), heightVal: $('heightVal'),
      spanMinRange: $('spanMinRange'), spanMaxRange: $('spanMaxRange'),
      spanVal: $('spanVal'), spanFill: $('spanFill'), spanBadge: $('spanBadge'),
      featherRange: $('featherRange'), featherVal: $('featherVal'),
      maskToggle: $('maskToggle'), seedToggle: $('seedToggle'), sheenToggle: $('sheenToggle'),
      compareBtn: $('compareBtn'), compareLabel: $('compareLabel'),
      uploadBtn: $('uploadBtn'), resetBtn: $('resetBtn'), fileInput: $('fileInput'),
      canvasWrap: $('canvasWrap'), canvasHolder: $('canvasHolder'), scene: $('scene'), marks: $('marks'),
      hint: $('hint'), busy: $('busy'),
      stageTitle: $('stageTitle'), stageStat: $('stageStat'),
      perfLegend: $('perfLegend'), regionToleranceBadge: $('regionToleranceBadge'),
      errorOverlay: $('errorOverlay'), errTitle: $('errTitle'), errCtx: $('errCtx'),
      errMsg: $('errMsg'), errDismiss: $('errDismiss'), errReset: $('errReset'),
      toast: $('toast'), live: $('liveRegion'),
      sampleWallsBtn: $('sampleWallsBtn'), clearRegionsBtn: $('clearRegionsBtn')
    };
    scene = el.scene;
    marks = el.marks;
  }

  function bind() {
    sceneCtx = scene.getContext('2d', { willReadFrequently: true });
    marksCtx = marks.getContext('2d');
    if (!sceneCtx) { fail('canvas init', new Error('Your browser could not create a 2D canvas context.')); return; }

    /* palette interactions */
    el.paletteGrid.addEventListener('click', function (e) {
      var card = e.target.closest('.pcard');
      if (!card) return;
      setColor(card.dataset.code);
      announce('Paint set to ' + state.color.name);
    });

    el.searchInput.addEventListener('input', function () {
      state.query = el.searchInput.value;
      el.searchClear.classList.toggle('show', !!state.query);
      renderPalette();
    });
    el.searchClear.addEventListener('click', function () {
      state.query = '';
      el.searchInput.value = '';
      el.searchClear.classList.remove('show');
      el.searchInput.focus();
      renderPalette();
    });
    el.tabs.addEventListener('click', function (e) {
      var t = e.target.closest('.tab');
      if (!t) return;
      state.cat = t.dataset.cat;
      Array.prototype.forEach.call(el.tabs.children, function (b) {
        b.setAttribute('aria-selected', String(b === t));
      });
      renderPalette();
    });

    /* paint mode */
    el.paintMode.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-mode]');
      if (!b) return;
      setPaintMode(b.dataset.mode);
    });

    /* canvas seed placement */
    scene.addEventListener('click', function (e) {
      if (!state.ready || state.compare) return;
      var rect = scene.getBoundingClientRect();
      var x = (e.clientX - rect.left) * (state.W / rect.width);
      var y = (e.clientY - rect.top) * (state.H / rect.height);
      guard('segmentation', function () {
        if (state.paintMode === 'isolate' && state.activeRegionId != null) {
          reseedActiveRegion(x, y);
        } else {
          addRegion(x, y);
        }
        el.hint.classList.add('gone');
      });
    });

    /* drag + drop */
    ['dragenter', 'dragover'].forEach(function (ev) {
      el.canvasWrap.addEventListener(ev, function (e) {
        e.preventDefault();
        el.canvasWrap.classList.add('dragover');
      });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      el.canvasWrap.addEventListener(ev, function (e) {
        e.preventDefault();
        el.canvasWrap.classList.remove('dragover');
      });
    });
    el.canvasWrap.addEventListener('drop', function (e) {
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) handleFile(f);
    });

    /* sliders */
    el.tolRange.addEventListener('input', function () {
      state.tol = +el.tolRange.value;
      el.tolVal.textContent = state.tol;
      if (el.regionToleranceBadge) el.regionToleranceBadge.textContent = 'ΔE ' + state.tol;
      resegmentAll();
    });
    el.edgeRange.addEventListener('input', function () {
      state.edgeGuard = +el.edgeRange.value;
      el.edgeVal.textContent = state.edgeGuard.toFixed(2);
      resegmentAll();
    });
    el.lightRange.addEventListener('input', function () {
      state.light = +el.lightRange.value / 100;
      el.lightVal.textContent = el.lightRange.value + '%';
      debounceRender();
    });
    el.heightRange.addEventListener('input', function () {
      state.height = +el.heightRange.value / 100;
      el.heightVal.textContent = el.heightRange.value + '%';
      debounceRender();
    });
    function onSpan() {
      var a = +el.spanMinRange.value, b = +el.spanMaxRange.value;
      if (a > b) { if (document.activeElement === el.spanMinRange) { b = a; el.spanMaxRange.value = a; } else { a = b; el.spanMinRange.value = b; } }
      state.spanMin = a / 100;
      state.spanMax = b / 100;
      el.spanVal.textContent = a + '% – ' + b + '%';
      el.spanBadge.textContent = a + '–' + b + '%';
      el.spanFill.style.left = a + '%';
      el.spanFill.style.width = (b - a) + '%';
      debounceRender();
    }
    el.spanMinRange.addEventListener('input', onSpan);
    el.spanMaxRange.addEventListener('input', onSpan);
    el.featherRange.addEventListener('input', function () {
      state.feather = +el.featherRange.value;
      el.featherVal.textContent = state.feather.toFixed(1) + 'px';
      resegmentAll();
    });

    /* switches */
    function toggleSwitch(node, key, after) {
      node.addEventListener('click', function () {
        state[key] = !state[key];
        setSwitch(node, state[key]);
        if (after) after();
        scheduleRender();
      });
    }
    toggleSwitch(el.maskToggle, 'showMask');
    toggleSwitch(el.seedToggle, 'showSeeds');
    toggleSwitch(el.sheenToggle, 'sheen');
    document.querySelector('label[for="maskToggle"]').addEventListener('click', function (e) {
      e.preventDefault();
      el.maskToggle.click();
    });
    document.querySelector('label[for="seedToggle"]').addEventListener('click', function (e) {
      e.preventDefault();
      el.seedToggle.click();
    });
    document.querySelector('label[for="sheenToggle"]').addEventListener('click', function (e) {
      e.preventDefault();
      el.sheenToggle.click();
    });

    /* toolbar */
    el.compareBtn.addEventListener('click', function () { setCompare(!state.compare); });
    el.uploadBtn.addEventListener('click', function () { el.fileInput.click(); });
    el.fileInput.addEventListener('change', function () {
      handleFile(el.fileInput.files && el.fileInput.files[0]);
      el.fileInput.value = '';
    });
    el.resetBtn.addEventListener('click', function () { resetAll({ reloadImage: false }); });

    el.sampleWallsBtn.addEventListener('click', function () {
      guard('auto-detect', function () {
        if (!state.ready) return;
        setBusy(true);
        setTimeout(function () {
          try {
            autoDetectWalls();
            setBusy(false);
          } catch (e) {
            setBusy(false);
            fail('auto-detect', e);
          }
        }, 24);
      });
    });

    el.clearRegionsBtn.addEventListener('click', function () {
      state.regions = [];
      state.activeRegionId = null;
      state.refKey = '';
      renderRegionList();
      updateModeHint();
      scheduleRender();
      toast('Regions cleared — click the wall to start again.');
    });

    /* error modal */
    el.errDismiss.addEventListener('click', function () {
      el.errorOverlay.classList.remove('show');
    });
    el.errReset.addEventListener('click', function () {
      el.errorOverlay.classList.remove('show');
      resetAll({ reloadImage: true });
    });
    el.errorOverlay.addEventListener('click', function (e) {
      if (e.target === el.errorOverlay) el.errorOverlay.classList.remove('show');
    });

    /* keyboard */
    document.addEventListener('keydown', function (e) {
      var tag = (e.target && e.target.tagName) || '';
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag)) return;
      if (e.key === 'Escape') { el.errorOverlay.classList.remove('show'); return; }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'o' || e.key === 'O') { e.preventDefault(); setCompare(!state.compare); }
      if (e.key === 'r' || e.key === 'R') { e.preventDefault(); resetAll({ reloadImage: false }); }
    });

    /* global safety nets */
    window.addEventListener('error', function (e) {
      fail('runtime', e.error || new Error(e.message || 'Script error'));
    });
    window.addEventListener('unhandledrejection', function (e) {
      fail('promise', e.reason || new Error('Unhandled promise rejection'));
    });
    var resizeTimer = null;
    function onResize() {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        fitCanvas();
        scheduleRender();
      }, 90);
    }
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    if (window.ResizeObserver && el.canvasWrap) {
      try { new ResizeObserver(onResize).observe(el.canvasWrap); } catch (e) { /* non-fatal */ }
    }
  }

  function boot() {
    try {
      cacheDom();
      bind();
      renderPalette();
      setColor(DEFAULTS.code, { silent: true });
      state.light = DEFAULTS.light / 100;
      state.height = DEFAULTS.height / 100;
      state.spanMin = DEFAULTS.spanMin / 100;
      state.spanMax = DEFAULTS.spanMax / 100;
      syncSliders();
      renderRegionList();
      updateModeHint();
      setPaintMode(DEFAULTS.paintMode);

      // Expose a small surface for testing / debugging.
      window.ColortrendSim = {
        state: state,
        core: CORE,
        addRegion: addRegion,
        reset: resetAll,
        fitCanvas: fitCanvas,
        setColor: function (code) { setColor(code); },
        render: render
      };

      loadImage(EMBEDDED_ROOM, 'Bedroom · natural daylight', false).then(function (ok) {
        if (ok) announce('Simulator ready. Click a wall to paint it.');
      });
    } catch (e) {
      fail('startup', e);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
