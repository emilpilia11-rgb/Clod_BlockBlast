/*
 * Block Blast solver.
 * Works in the browser (window.BlockSolver) and in Node (require('./solver')).
 *
 * Board: 8x8, cell index i = row*8 + col.
 * Stored as two 32-bit masks: lo = rows 0..3, hi = rows 4..7.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BlockSolver = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const N = 8;

  // ---------- shapes ----------
  function normalize(cells) {
    let mr = Infinity, mc = Infinity;
    for (const [r, c] of cells) { if (r < mr) mr = r; if (c < mc) mc = c; }
    return cells.map(([r, c]) => [r - mr, c - mc]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  }
  function parseShape(str) {
    const cells = [];
    str.split('/').forEach((row, r) => {
      [...row].forEach((ch, c) => { if (ch === 'X') cells.push([r, c]); });
    });
    return normalize(cells);
  }
  function shapeKey(cells) { return normalize(cells).map((x) => x[0] + ',' + x[1]).join(';'); }
  function dims(cells) {
    let h = 0, w = 0;
    for (const [r, c] of cells) { if (r + 1 > h) h = r + 1; if (c + 1 > w) w = c + 1; }
    return [h, w];
  }
  function rotate(cells) { return normalize(cells.map(([r, c]) => [c, -r])); }
  function mirror(cells) { return normalize(cells.map(([r, c]) => [r, -c])); }
  function variants(cells, withMirror) {
    const out = new Map();
    let cur = normalize(cells);
    for (let m = 0; m < (withMirror ? 2 : 1); m++) {
      for (let k = 0; k < 4; k++) { out.set(shapeKey(cur), cur); cur = rotate(cur); }
      cur = mirror(cur);
    }
    return [...out.values()];
  }

  // Block Blast piece set (all rotations).
  const BASES = [
    ['X', false], ['XX', false], ['XXX', false], ['XXXX', false], ['XXXXX', false],
    ['XX/XX', false], ['XXX/XXX', false], ['XXX/XXX/XXX', false],
    ['XX/X.', false], ['XXX/X../X..', false],
    ['XXX/X..', true], ['XXX/.X.', false], ['XX./.XX', true],
    ['X./.X', false], ['X../.X./..X', false],
  ];
  const SHAPES = [];
  {
    const seen = new Set();
    for (const [s, mir] of BASES) {
      for (const v of variants(parseShape(s), mir)) {
        const k = shapeKey(v);
        if (!seen.has(k)) { seen.add(k); SHAPES.push(v); }
      }
    }
  }

  // ---------- bit masks ----------
  function cellBit(idx) {
    return idx < 32 ? [(1 << idx) >>> 0, 0] : [0, (1 << (idx - 32)) >>> 0];
  }
  const LINES = [];
  for (let r = 0; r < N; r++) {
    const m = (0xff << (8 * (r % 4))) >>> 0;
    LINES.push(r < 4 ? { lo: m, hi: 0 } : { lo: 0, hi: m });
  }
  for (let c = 0; c < N; c++) {
    const m = (0x01010101 << c) >>> 0;
    LINES.push({ lo: m, hi: m });
  }

  const placementCache = new Map();
  function placementsFor(cells) {
    const key = shapeKey(cells);
    let pl = placementCache.get(key);
    if (pl) return pl;
    const norm = normalize(cells);
    const [h, w] = dims(norm);
    pl = [];
    for (let r0 = 0; r0 + h <= N; r0++) {
      for (let c0 = 0; c0 + w <= N; c0++) {
        let lo = 0, hi = 0;
        for (const [r, c] of norm) {
          const [a, b] = cellBit((r0 + r) * N + c0 + c);
          lo |= a; hi |= b;
        }
        pl.push({ r: r0, c: c0, lo: lo >>> 0, hi: hi >>> 0, n: norm.length });
      }
    }
    placementCache.set(key, pl);
    return pl;
  }

  function boardToMasks(board) {
    if (board && typeof board.lo === 'number') return board;
    let lo = 0, hi = 0;
    for (let i = 0; i < 64; i++) {
      if (board[i]) { const [a, b] = cellBit(i); lo |= a; hi |= b; }
    }
    return { lo: lo >>> 0, hi: hi >>> 0 };
  }
  function masksToBoard(lo, hi) {
    const b = new Array(64);
    for (let i = 0; i < 32; i++) { b[i] = (lo >>> i) & 1; b[32 + i] = (hi >>> i) & 1; }
    return b;
  }

  // Place piece and clear full lines. Result written into OUT to avoid allocations.
  const OUT = { lo: 0, hi: 0, n: 0, clo: 0, chi: 0 };
  function applyPlace(lo, hi, p) {
    lo = (lo | p.lo) >>> 0; hi = (hi | p.hi) >>> 0;
    let clo = 0, chi = 0, n = 0;
    for (let k = 0; k < 16; k++) {
      const L = LINES[k];
      if (((lo & L.lo) >>> 0) === L.lo && ((hi & L.hi) >>> 0) === L.hi) { clo |= L.lo; chi |= L.hi; n++; }
    }
    OUT.lo = (lo & ~clo) >>> 0; OUT.hi = (hi & ~chi) >>> 0; OUT.n = n;
    OUT.clo = clo >>> 0; OUT.chi = chi >>> 0;
    return OUT;
  }

  // ---------- evaluation ----------
  // Tuned with sim.js on random games (avg survival ~103 -> ~124 rounds on held-out seeds).
  const DEFAULT_WEIGHTS = {
    reward: 1.0,   // points for clears/combo during this turn
    empty: 1.0,    // each free cell
    hole: 3.5,     // isolated single free cell
    trans: 3.2,    // filled/empty transitions (roughness)
    fit: 1.5,      // multiplier for "big pieces still fit" bonus
    noFit: 12.5,   // multiplier for penalty when a big piece does not fit anywhere
    combo: 3.0,    // value of keeping an active combo
  };

  // Test pieces: [shape, importance]
  const TESTS = [
    ['XXX/XXX/XXX', 1.5], ['XXXXX', 1.0], ['X/X/X/X/X', 1.0],
    ['XXX/XXX', 0.6], ['XX/XX/XX', 0.6],
    ['XXX/X../X..', 0.5], ['XXX/..X/..X', 0.5], ['X../X../XXX', 0.5], ['..X/..X/XXX', 0.5],
    ['XXXX', 0.4], ['X/X/X/X', 0.4], ['XX/XX', 0.4],
  ].map(([s, w]) => ({ pl: placementsFor(parseShape(s)), w }));

  const G = new Uint8Array(64);
  function cheapEval(lo, hi, W) {
    for (let i = 0; i < 32; i++) { G[i] = (lo >>> i) & 1; G[32 + i] = (hi >>> i) & 1; }
    let empty = 0, holes = 0, trans = 0;
    for (let r = 0; r < N; r++) {
      let prev = 1;
      for (let c = 0; c < N; c++) {
        const v = G[r * N + c];
        if (v !== prev) trans++;
        prev = v;
        if (!v) {
          empty++;
          if ((r === 0 || G[(r - 1) * N + c]) && (r === N - 1 || G[(r + 1) * N + c]) &&
              (c === 0 || G[r * N + c - 1]) && (c === N - 1 || G[r * N + c + 1])) holes++;
        }
      }
      if (prev !== 1) trans++;
    }
    for (let c = 0; c < N; c++) {
      let prev = 1;
      for (let r = 0; r < N; r++) {
        const v = G[r * N + c];
        if (v !== prev) trans++;
        prev = v;
      }
      if (prev !== 1) trans++;
    }
    return W.empty * empty - W.hole * holes - W.trans * trans;
  }
  function fitEval(lo, hi, W) {
    let s = 0;
    for (const t of TESTS) {
      let cnt = 0;
      const pl = t.pl;
      for (let k = 0; k < pl.length; k++) {
        const p = pl[k];
        if (((lo & p.lo) | (hi & p.hi)) === 0) cnt++;
      }
      s += t.w * (W.fit * Math.log2(1 + cnt) - (cnt === 0 ? W.noFit : 0));
    }
    return s;
  }
  function comboValue(combo, since, W) {
    return combo > 0 ? W.combo * combo * (3 - since) / 3 : 0;
  }

  // ---------- search ----------
  /**
   * board: array[64] of 0/1 (or {lo,hi})
   * pieces: array (up to 3) of cell lists [[r,c],...] or null for already-used slots
   * opts.state: {combo, since} carried between turns
   * returns { moves:[{piece,r,c,cells,lines,clearedCells,boardAfter}], placedAll, gameOver, state, lines }
   */
  function solve(board, pieces, opts) {
    opts = opts || {};
    const W = Object.assign({}, DEFAULT_WEIGHTS, opts.weights || {});
    const topK = opts.topK || 2000;
    const st0 = opts.state || { combo: 0, since: 0 };
    const { lo: lo0, hi: hi0 } = boardToMasks(board);

    const idxs = [];
    const PL = [];
    pieces.forEach((p, i) => {
      if (p && p.length) { idxs.push(i); PL[i] = placementsFor(p); }
    });
    if (!idxs.length) return { moves: [], placedAll: true, gameOver: false, state: st0, lines: 0 };

    let remAll = 0;
    for (const i of idxs) remAll |= 1 << i;

    const root = { lo: lo0, hi: hi0, combo: st0.combo, since: st0.since, rem: remAll, reward: 0, parent: null, move: null };
    let cur = [root];
    let deepest = [root];
    const k = idxs.length;

    // Final-level candidates in parallel arrays (no per-candidate objects).
    const fLo = [], fHi = [], fCombo = [], fSince = [], fReward = [], fCheap = [], fParent = [], fPiece = [], fPl = [];

    for (let d = 0; d < k; d++) {
      const isLast = d === k - 1;
      const next = new Map();
      for (const s of cur) {
        for (const i of idxs) {
          if (!((s.rem >> i) & 1)) continue;
          const pls = PL[i];
          for (let pi = 0; pi < pls.length; pi++) {
            const p = pls[pi];
            if ((s.lo & p.lo) | (s.hi & p.hi)) continue;
            const o = applyPlace(s.lo, s.hi, p);
            let combo = s.combo, since = s.since, reward = s.reward + p.n;
            if (o.n > 0) { combo++; since = 0; reward += 10 * (o.n * o.n + o.n * (combo - 1)); }
            else { since++; if (since >= 3) combo = 0; }
            if (isLast) {
              fLo.push(o.lo); fHi.push(o.hi); fCombo.push(combo); fSince.push(since);
              fReward.push(reward); fCheap.push(reward * W.reward + cheapEval(o.lo, o.hi, W) + comboValue(combo, since, W));
              fParent.push(s); fPiece.push(i); fPl.push(pi);
            } else {
              const rem = s.rem & ~(1 << i);
              const key = rem + ':' + o.lo + ':' + o.hi + ':' + combo + ':' + since;
              const ex = next.get(key);
              if (!ex || ex.reward < reward) {
                next.set(key, { lo: o.lo, hi: o.hi, combo, since, rem, reward, parent: s, move: { piece: i, pi } });
              }
            }
          }
        }
      }
      if (isLast) break;
      if (next.size === 0) break;
      cur = [...next.values()];
      deepest = cur;
    }

    let best = null, bestScore = -Infinity;
    if (fLo.length) {
      const order = Array.from(fLo.keys());
      if (order.length > topK) {
        order.sort((a, b) => fCheap[b] - fCheap[a]);
        order.length = topK;
      }
      for (const j of order) {
        const sc = fCheap[j] + fitEval(fLo[j], fHi[j], W);
        if (sc > bestScore) { bestScore = sc; best = j; }
      }
      const leaf = { lo: fLo[best], hi: fHi[best], combo: fCombo[best], since: fSince[best], reward: fReward[best], parent: fParent[best], move: { piece: fPiece[best], pi: fPl[best] } };
      return build(leaf, true, bestScore);
    }

    // Could not place every piece: choose best among the deepest reachable states.
    if (deepest[0] === root) {
      return { moves: [], placedAll: false, gameOver: true, state: st0, lines: 0, score: -Infinity };
    }
    for (const s of deepest) {
      const sc = s.reward * W.reward + cheapEval(s.lo, s.hi, W) + fitEval(s.lo, s.hi, W);
      if (sc > bestScore) { bestScore = sc; best = s; }
    }
    return build(best, false, bestScore);

    function build(leaf, placedAll, score) {
      const chain = [];
      for (let s = leaf; s && s.move; s = s.parent) chain.push(s.move);
      chain.reverse();
      let lo = lo0, hi = hi0, lines = 0;
      const moves = chain.map((m) => {
        const p = PL[m.piece][m.pi];
        const before = masksToBoard(lo, hi);
        const o = applyPlace(lo, hi, p);
        lo = o.lo; hi = o.hi; lines += o.n;
        const cells = normalize(pieces[m.piece]).map(([r, c]) => [p.r + r, p.c + c]);
        const cleared = masksToBoard(o.clo, o.chi);
        return {
          piece: m.piece, r: p.r, c: p.c, cells, lines: o.n,
          clearedCells: cleared.map((v, i) => (v ? i : -1)).filter((i) => i >= 0),
          boardBefore: before, boardAfter: masksToBoard(lo, hi),
        };
      });
      return {
        moves, placedAll, gameOver: !placedAll, lines, score,
        state: { combo: leaf.combo, since: leaf.since },
      };
    }
  }

  return {
    N, SHAPES, solve, parseShape, normalize, shapeKey, dims, placementsFor,
    boardToMasks, masksToBoard, applyPlace, DEFAULT_WEIGHTS,
  };
});
