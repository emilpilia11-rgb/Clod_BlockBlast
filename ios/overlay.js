/*
 * Draws the best moves on top of a Block Blast screenshot.
 * Runs in a browser / WKWebView (used by the Scriptable script for iPhone).
 * Needs BlockSolver (solver.js) and BlockDetect (detect.js) loaded first.
 *
 * BBOverlay.run(imageSrc, calib) -> Promise<{ img (jpeg data URL), text, learnedRatio, ok }>
 * calib: { screen?: {width,height}, grid: {x,y,w,h}, tray: {x,y,w,h}, trayCellRatio? }
 */
(function (root) {
  'use strict';
  const S = root.BlockSolver, D = root.BlockDetect;
  const COLORS = ['#ffa94d', '#4fd1e8', '#c38bff'];
  const SLOT = ['Левую', 'Среднюю', 'Правую'];
  const FONT = '-apple-system, "SF Pro Display", system-ui, "Helvetica Neue", sans-serif';

  function scaleCalib(c, w, h) {
    const sx = c.screen ? w / c.screen.width : 1, sy = c.screen ? h / c.screen.height : 1;
    const sc = (r) => ({ x: r.x * sx, y: r.y * sy, w: r.w * sx, h: r.h * sy });
    return { grid: sc(c.grid), tray: sc(c.tray), trayCellRatio: c.trayCellRatio };
  }
  function loadImg(src) {
    return new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error('image')); im.src = src; });
  }
  function roundRect(g, x, y, w, h, r) {
    g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
  }
  function badge(g, x, y, r, color, txt) {
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fillStyle = color; g.fill();
    g.lineWidth = r * 0.18; g.strokeStyle = '#0b1026'; g.stroke();
    g.fillStyle = '#0b1026'; g.font = `800 ${Math.round(r * 1.25)}px ${FONT}`;
    g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(txt, x, y + r * 0.06);
  }

  async function run(src, calibIn) {
    const im = await loadImg(src);
    const W = im.naturalWidth, H = im.naturalHeight;
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const g = cv.getContext('2d');
    g.drawImage(im, 0, 0);
    const calib = scaleCalib(calibIn, W, H);
    const det = D.detect(g.getImageData(0, 0, W, H), calib);
    const nPieces = det.pieces.filter(Boolean).length;
    const learnedRatio = !calib.trayCellRatio && nPieces === 3 && det.trayCellSize ? det.trayCellSize / (calib.grid.w / 8) : null;
    const res = nPieces ? S.solve(det.board, det.pieces) : null;

    const { grid, tray } = calib;
    const cell = grid.w / 8;

    // Dim everything except the board and the tray.
    g.fillStyle = 'rgba(5, 8, 22, 0.55)'; g.fillRect(0, 0, W, H);
    g.drawImage(im, grid.x, grid.y, grid.w, grid.h, grid.x, grid.y, grid.w, grid.h);
    g.drawImage(im, tray.x, tray.y, tray.w, tray.h, tray.x, tray.y, tray.w, tray.h);

    // Banner above the board.
    const bannerH = Math.min(cell * 2.3, grid.y * 0.9);
    const by = Math.max(4, grid.y - bannerH - cell * 0.2);
    const pad = cell * 0.2;
    const lines = [];

    if (!res || !res.moves.length) {
      const msg = !nPieces ? 'Не вижу фигур внизу. Проверьте рамки в настройках.' : 'Ни одна фигура не помещается.';
      lines.push(msg);
      g.fillStyle = 'rgba(11,16,38,0.92)'; roundRect(g, pad, by, W - pad * 2, bannerH, cell * 0.25); g.fill();
      g.fillStyle = '#ff7a8a'; g.font = `700 ${Math.round(cell * 0.38)}px ${FONT}`;
      g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(msg, W / 2, by + bannerH / 2);
      return { img: cv.toDataURL('image/jpeg', 0.88), text: msg, learnedRatio, ok: false };
    }

    // Move overlays on the board.
    res.moves.forEach((m, k) => {
      g.save();
      for (const [r, c] of m.cells) {
        const x = grid.x + c * cell, y = grid.y + r * cell;
        g.globalAlpha = 0.82; g.fillStyle = COLORS[k];
        roundRect(g, x + cell * 0.06, y + cell * 0.06, cell * 0.88, cell * 0.88, cell * 0.14); g.fill();
        g.globalAlpha = 1; g.lineWidth = cell * 0.06; g.strokeStyle = '#ffffff'; g.stroke();
      }
      g.restore();
    });
    const taken = new Set();
    res.moves.forEach((m, k) => {
      // Badge on the piece cell closest to its centre, avoiding cells that later moves cover
      // (after a line clear a later piece can sit on the same cells) and other badges.
      const later = new Set();
      res.moves.slice(k + 1).forEach((x) => x.cells.forEach(([r, c]) => later.add(r * 8 + c)));
      const cr = m.cells.reduce((s, x) => s + x[0], 0) / m.cells.length;
      const cc = m.cells.reduce((s, x) => s + x[1], 0) / m.cells.length;
      const byDist = m.cells.slice().sort((a, b) => ((a[0] - cr) ** 2 + (a[1] - cc) ** 2) - ((b[0] - cr) ** 2 + (b[1] - cc) ** 2));
      const key = (x) => x[0] * 8 + x[1];
      const best = byDist.find((x) => !later.has(key(x)) && !taken.has(key(x))) || byDist.find((x) => !taken.has(key(x))) || byDist[0];
      taken.add(key(best));
      badge(g, grid.x + (best[1] + 0.5) * cell, grid.y + (best[0] + 0.5) * cell, cell * 0.36, COLORS[k], String(k + 1));
      // Same number on the piece in the tray.
      const s = det.slots[m.piece];
      if (s) {
        g.lineWidth = cell * 0.08; g.strokeStyle = COLORS[k];
        roundRect(g, s.x - cell * 0.15, s.y - cell * 0.15, s.w + cell * 0.3, s.h + cell * 0.3, cell * 0.2); g.stroke();
        badge(g, s.x + s.w / 2, Math.max(s.y - cell * 0.5, tray.y + cell * 0.3), cell * 0.34, COLORS[k], String(k + 1));
      }
      lines.push(`${k + 1}. ${SLOT[m.piece]} → ряд ${m.r + 1}, кол. ${m.c + 1}${m.lines ? ` (+${m.lines})` : ''}`);
    });

    // Banner with mini boards: state before each move, piece in colour, cleared lines outlined.
    g.fillStyle = 'rgba(11,16,38,0.94)'; roundRect(g, pad, by, W - pad * 2, bannerH, cell * 0.25); g.fill();
    const n = res.moves.length;
    const colW = (W - pad * 2) / 3;
    const mini = Math.min(bannerH - pad * 2, colW - pad * 2);
    const mc = mini / 8;
    res.moves.forEach((m, k) => {
      const ox = pad + colW * k + (colW - mini) / 2, oy = by + (bannerH - mini) / 2;
      const pc = new Set(m.cells.map(([r, c]) => r * 8 + c)), clr = new Set(m.clearedCells);
      g.fillStyle = '#070a1a'; g.fillRect(ox - 2, oy - 2, mini + 4, mini + 4);
      for (let i = 0; i < 64; i++) {
        const x = ox + (i % 8) * mc, y = oy + Math.floor(i / 8) * mc;
        g.fillStyle = pc.has(i) ? COLORS[k] : m.boardBefore[i] ? '#56649f' : '#1c2550';
        g.fillRect(x + 0.5, y + 0.5, mc - 1, mc - 1);
        if (clr.has(i)) { g.strokeStyle = '#fff27a'; g.lineWidth = Math.max(1, mc * 0.12); g.strokeRect(x + 1, y + 1, mc - 2, mc - 2); }
      }
      badge(g, ox, oy, mc * 1.5, COLORS[k], String(k + 1));
    });
    if (!res.placedAll) {
      g.fillStyle = '#ff7a8a'; g.font = `700 ${Math.round(cell * 0.3)}px ${FONT}`;
      g.textAlign = 'center'; g.textBaseline = 'top';
      g.fillText('Все три не влезут — лучшее из возможного', W / 2, by + bannerH + cell * 0.05);
      lines.push('Все три фигуры не влезут.');
    }
    return { img: cv.toDataURL('image/jpeg', 0.88), text: lines.join('\n'), learnedRatio, ok: true };
  }

  root.BBOverlay = { run };
})(typeof self !== 'undefined' ? self : this);
