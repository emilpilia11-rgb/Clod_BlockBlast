/*
 * Screenshot recognition for Block Blast.
 * img: { width, height, data } with RGBA bytes (browser ImageData or pngjs PNG).
 * calib: { grid: {x,y,w,h}, tray: {x,y,w,h}, trayCellRatio?: number }  (pixel coordinates)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BlockDetect = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function avgColor(img, x0, y0, x1, y1) {
    x0 = Math.max(0, Math.round(x0)); y0 = Math.max(0, Math.round(y0));
    x1 = Math.min(img.width, Math.round(x1)); y1 = Math.min(img.height, Math.round(y1));
    let r = 0, g = 0, b = 0, n = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * img.width + x) * 4;
        r += img.data[i]; g += img.data[i + 1]; b += img.data[i + 2]; n++;
      }
    }
    return n ? [r / n, g / n, b / n] : [0, 0, 0];
  }
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const lum = (c) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];

  function detectBoard(img, grid, threshold) {
    threshold = threshold || 60;
    const cw = grid.w / 8, ch = grid.h / 8;
    const colors = [];
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const cx = grid.x + (c + 0.5) * cw, cy = grid.y + (r + 0.5) * ch;
        colors.push(avgColor(img, cx - cw * 0.2, cy - ch * 0.2, cx + cw * 0.2, cy + ch * 0.2));
      }
    }
    // Empty reference: median of the darkest quarter of cells.
    const sorted = colors.slice().sort((a, b) => lum(a) - lum(b));
    const dark = sorted.slice(0, 8);
    const ref = [0, 1, 2].map((k) => dark.map((c) => c[k]).sort((a, b) => a - b)[4]);
    const board = colors.map((c) => (dist(c, ref) > threshold && lum(c) > lum(ref) ? 1 : 0));
    return { board, emptyRef: ref };
  }

  function detectTray(img, tray, gridCell, opts) {
    opts = opts || {};
    const threshold = opts.threshold || 70;
    const step = Math.max(1, Math.round(Math.min(tray.w, tray.h) / 200));
    // Background reference from the tray's corners.
    const pw = tray.w * 0.04, ph = tray.h * 0.08;
    const corners = [
      avgColor(img, tray.x, tray.y, tray.x + pw, tray.y + ph),
      avgColor(img, tray.x + tray.w - pw, tray.y, tray.x + tray.w, tray.y + ph),
      avgColor(img, tray.x, tray.y + tray.h - ph, tray.x + pw, tray.y + tray.h),
      avgColor(img, tray.x + tray.w - pw, tray.y + tray.h - ph, tray.x + tray.w, tray.y + tray.h),
    ];
    const bg = [0, 1, 2].map((k) => corners.map((c) => c[k]).sort((a, b) => a - b)[1]);

    const isPiece = (x, y) => {
      const i = (y * img.width + x) * 4;
      const c = [img.data[i], img.data[i + 1], img.data[i + 2]];
      return dist(c, bg) > threshold;
    };

    // Bounding box of piece pixels in each third of the tray.
    const slots = [];
    for (let s = 0; s < 3; s++) {
      const x0 = Math.round(tray.x + (tray.w * s) / 3), x1 = Math.round(tray.x + (tray.w * (s + 1)) / 3);
      let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1, cnt = 0;
      for (let y = Math.round(tray.y); y < tray.y + tray.h; y += step) {
        for (let x = x0; x < x1; x += step) {
          if (isPiece(x, y)) {
            cnt++;
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
          }
        }
      }
      const minPixels = ((gridCell * 0.25) / step) ** 2;
      slots.push(cnt > minPixels ? { x: minX, y: minY, w: maxX - minX + step, h: maxY - minY + step } : null);
    }

    // Common cell size for all tray pieces.
    let size;
    if (opts.trayCellRatio) size = gridCell * opts.trayCellRatio;
    else {
      const boxes = slots.filter(Boolean);
      if (!boxes.length) return { pieces: [null, null, null], slots, cellSize: 0, bg };
      let bestErr = Infinity;
      const cands = [];
      for (let s = gridCell * 0.3; s <= gridCell * 1.05; s += 0.5) {
        let err = 0, ok = true;
        for (const b of boxes) {
          const nw = Math.round(b.w / s), nh = Math.round(b.h / s);
          if (nw < 1 || nh < 1 || nw > 5 || nh > 5) { ok = false; break; }
          err += Math.abs(b.w - nw * s) / s + Math.abs(b.h - nh * s) / s;
        }
        if (!ok) continue;
        cands.push([s, err]);
        if (err < bestErr) bestErr = err;
      }
      if (!cands.length) return { pieces: [null, null, null], slots, cellSize: 0, bg };
      // Prefer the largest size whose error is close to the best one.
      size = cands.filter(([, e]) => e <= bestErr + 0.15 * boxes.length).sort((a, b) => b[0] - a[0])[0][0];
    }

    const pieces = slots.map((b) => {
      if (!b) return null;
      const nw = Math.max(1, Math.min(5, Math.round(b.w / size)));
      const nh = Math.max(1, Math.min(5, Math.round(b.h / size)));
      const cw = b.w / nw, chh = b.h / nh;
      const cells = [];
      for (let r = 0; r < nh; r++) {
        for (let c = 0; c < nw; c++) {
          const cx = b.x + (c + 0.5) * cw, cy = b.y + (r + 0.5) * chh;
          const col = avgColor(img, cx - cw * 0.2, cy - chh * 0.2, cx + cw * 0.2, cy + chh * 0.2);
          if (dist(col, bg) > threshold) cells.push([r, c]);
        }
      }
      return cells.length ? cells : null;
    });
    return { pieces, slots, cellSize: size, bg };
  }

  function detect(img, calib) {
    const b = detectBoard(img, calib.grid, calib.boardThreshold);
    const t = detectTray(img, calib.tray, calib.grid.w / 8, {
      trayCellRatio: calib.trayCellRatio, threshold: calib.trayThreshold,
    });
    return { board: b.board, pieces: t.pieces, slots: t.slots, trayCellSize: t.cellSize };
  }

  return { detect, detectBoard, detectTray };
});
