#!/usr/bin/env node
/*
 * Block Blast bot for Android (over ADB).
 *
 *   node bot.js shot   - save the current phone screen to screen.png (for calibration)
 *   node bot.js dry    - recognise the screen and print the best moves, without touching
 *   node bot.js play   - play automatically (Ctrl+C to stop)
 *   node bot.js once   - make a single move and check where the piece landed
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { PNG } = require('pngjs');
const S = require('../solver');
const D = require('../detect');

const CFG_PATH = path.join(__dirname, 'config.json');
if (!fs.existsSync(CFG_PATH)) {
  console.error('Нет файла bot/config.json. Скопируйте config.example.json в config.json и подставьте свои рамки (см. README).');
  process.exit(1);
}
const cfg = Object.assign(
  { adb: 'adb', device: '', liftCells: 2.0, offsetX: 0, swipeMode: 'swipe', swipeMs: 450, afterMoveMs: 900, autoCorrect: true },
  JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'))
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function adb(args, opts) {
  const full = (cfg.device ? ['-s', cfg.device] : []).concat(args);
  return execFileSync(cfg.adb, full, Object.assign({ maxBuffer: 64 * 1024 * 1024 }, opts));
}

function screenshot() {
  const buf = adb(['exec-out', 'screencap', '-p']);
  return { png: PNG.sync.read(buf), raw: buf };
}

// Scale calibration rectangles if the screenshot size differs from the one used for calibration.
function calibFor(img) {
  const sx = cfg.screen ? img.width / cfg.screen.width : 1;
  const sy = cfg.screen ? img.height / cfg.screen.height : 1;
  const sc = (r) => ({ x: r.x * sx, y: r.y * sy, w: r.w * sx, h: r.h * sy });
  return { grid: sc(cfg.grid), tray: sc(cfg.tray), trayCellRatio: cfg.trayCellRatio };
}

function printBoard(board, marks) {
  const lines = [];
  for (let r = 0; r < 8; r++) {
    let s = '';
    for (let c = 0; c < 8; c++) {
      const i = r * 8 + c;
      s += marks && marks[i] ? marks[i] + ' ' : board[i] ? '■ ' : '· ';
    }
    lines.push('  ' + s);
  }
  console.log(lines.join('\n'));
}
function shapeStr(cells) {
  if (!cells) return '  (пусто)';
  const [h, w] = S.dims(cells);
  const set = new Set(cells.map(([r, c]) => r + ',' + c));
  const out = [];
  for (let r = 0; r < h; r++) { let s = '  '; for (let c = 0; c < w; c++) s += set.has(r + ',' + c) ? '■ ' : '  '; out.push(s); }
  return out.join('\n');
}
const SLOT = ['левая', 'средняя', 'правая'];

function readState() {
  const { png } = screenshot();
  const calib = calibFor(png);
  const det = D.detect(png, calib);
  // Learn the tray cell size while all three pieces are visible; with one piece left it is ambiguous.
  if (!cfg.trayCellRatio && det.pieces.filter(Boolean).length === 3 && det.trayCellSize) {
    cfg.trayCellRatio = Math.round((det.trayCellSize / (calib.grid.w / 8)) * 1000) / 1000;
    const disk = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
    disk.trayCellRatio = cfg.trayCellRatio;
    fs.writeFileSync(CFG_PATH, JSON.stringify(disk, null, 2) + '\n');
    console.log(`Запомнил размер клеток фигур: trayCellRatio=${cfg.trayCellRatio}`);
    return { png, calib: calibFor(png), det: D.detect(png, calibFor(png)) };
  }
  return { png, calib, det };
}

async function drag(x1, y1, x2, y2) {
  const r = (v) => String(Math.round(v));
  if (cfg.swipeMode === 'motionevent') {
    // Android 11+: finer control - press, hold, move in steps, release.
    adb(['shell', 'input', 'motionevent', 'DOWN', r(x1), r(y1)]);
    await sleep(80);
    const steps = 8;
    for (let k = 1; k <= steps; k++) {
      adb(['shell', 'input', 'motionevent', 'MOVE', r(x1 + ((x2 - x1) * k) / steps), r(y1 + ((y2 - y1) * k) / steps)]);
    }
    await sleep(80);
    adb(['shell', 'input', 'motionevent', 'UP', r(x2), r(y2)]);
  } else {
    adb(['shell', 'input', 'swipe', r(x1), r(y1), r(x2), r(y2), String(cfg.swipeMs)]);
  }
}

// Perform one move: drag piece from its tray slot so it lands at (move.r, move.c).
async function doMove(det, calib, move, pieces) {
  const slot = det.slots[move.piece];
  const cell = calib.grid.w / 8;
  const [h, w] = S.dims(S.normalize(pieces[move.piece]));
  const sx = slot.x + slot.w / 2, sy = slot.y + slot.h / 2;
  const tx = calib.grid.x + (move.c + w / 2) * cell;
  const ty = calib.grid.y + (move.r + h / 2) * cell;
  const ex = tx + cfg.offsetX, ey = ty + cfg.liftCells * cell;
  await drag(sx, sy, ex, ey);
}

// After a move without line clears, find where the piece really landed and correct the drag offset.
function checkLanding(before, after, move, piece) {
  const added = [];
  for (let i = 0; i < 64; i++) if (!before[i] && after[i]) added.push(i);
  const removed = before.some((v, i) => v && !after[i]);
  if (removed) return null; // lines were cleared, cannot compare reliably
  const norm = S.normalize(piece);
  if (added.length !== norm.length) return { landed: false };
  const set = new Set(added);
  const [h, w] = S.dims(norm);
  for (let r0 = 0; r0 + h <= 8; r0++) {
    for (let c0 = 0; c0 + w <= 8; c0++) {
      if (norm.every(([r, c]) => set.has((r0 + r) * 8 + c0 + c))) return { landed: true, dr: r0 - move.r, dc: c0 - move.c };
    }
  }
  return { landed: false };
}

function saveTuning() {
  const disk = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
  disk.liftCells = Math.round(cfg.liftCells * 100) / 100;
  disk.offsetX = Math.round(cfg.offsetX);
  fs.writeFileSync(CFG_PATH, JSON.stringify(disk, null, 2) + '\n');
}

function sameBoard(a, b) { return a.every((v, i) => v === b[i]); }

async function main() {
  const cmd = process.argv[2] || 'dry';

  if (cmd === 'shot') {
    const { raw, png } = screenshot();
    const out = path.join(__dirname, 'screen.png');
    fs.writeFileSync(out, raw);
    console.log(`Сохранено ${out} (${png.width}×${png.height}). Загрузите его на страницу подсказчика, подгоните рамки и нажмите «Копировать настройки для бота».`);
    return;
  }

  let game = { combo: 0, since: 0 };
  let moves = 0, lines = 0, misses = 0, baseLift = cfg.liftCells;

  for (;;) {
    let st = readState();
    let pieces = st.det.pieces;
    let tries = 0;
    while (!pieces.some(Boolean) && tries < 5) { await sleep(700); st = readState(); pieces = st.det.pieces; tries++; }
    if (!pieces.some(Boolean)) { console.log('Не вижу фигур внизу. Проверьте рамку tray в config.json (или игра закончилась).'); return; }

    const res = S.solve(st.det.board, pieces, { state: game });
    console.log(`\nПоле:`);
    printBoard(st.det.board);
    pieces.forEach((p, i) => console.log(`${SLOT[i]}:\n${shapeStr(p)}`));
    if (!res.moves.length) { console.log('\nНи одна фигура не помещается — конец игры.'); return; }
    const m = res.moves[0];
    const marks = {};
    m.cells.forEach(([r, c]) => { marks[r * 8 + c] = '1'; });
    console.log(`\nХод: ${SLOT[m.piece]} фигура → ряд ${m.r + 1}, колонка ${m.c + 1}${m.lines ? ` (+${m.lines} лин.)` : ''}`);
    printBoard(st.det.board, marks);
    if (res.moves.length > 1) console.log(`Дальше: ${res.moves.slice(1).map((x) => `${SLOT[x.piece]} → ряд ${x.r + 1}, кол. ${x.c + 1}`).join('; ')}`);

    if (cmd === 'dry') return;

    await doMove(st.det, st.calib, m, pieces);
    await sleep(cfg.afterMoveMs);
    const after = readState().det.board;
    const expected = m.boardAfter;

    if (sameBoard(after, expected)) {
      if (misses) saveTuning();
      misses = 0; moves++; lines += m.lines;
      game = updateCombo(game, m.lines);
    } else {
      const chk = checkLanding(st.det.board, after, m, pieces[m.piece]);
      if (chk && chk.landed && (chk.dr || chk.dc)) {
        const cell = st.calib.grid.w / 8;
        console.log(`Фигура встала со сдвигом (ряд ${chk.dr > 0 ? '+' : ''}${chk.dr}, кол. ${chk.dc > 0 ? '+' : ''}${chk.dc}).`);
        if (cfg.autoCorrect) {
          cfg.liftCells -= chk.dr;
          cfg.offsetX -= chk.dc * cell;
          saveTuning();
          console.log(`Исправил и сохранил в config.json: liftCells=${cfg.liftCells}, offsetX=${Math.round(cfg.offsetX)}.`);
        }
        misses = 0; moves++;
        game = { combo: 0, since: 0 };
      } else if (chk && !chk.landed) {
        // Piece did not land: probably dropped outside the grid. Probe other lift values.
        const deltas = [1, -1, 2, -2, 3, -0.5, 0.5];
        if (misses === 0) baseLift = cfg.liftCells;
        misses++;
        if (misses > deltas.length) {
          console.log('Фигура так и не поставилась. Попробуйте "swipeMode": "motionevent" или увеличьте "swipeMs" в config.json.');
          return;
        }
        cfg.liftCells = baseLift + deltas[misses - 1];
        console.log(`Фигура не поставилась. Пробую liftCells=${cfg.liftCells}.`);
      } else {
        // lines cleared but board differs: fine, just resync from the next screenshot
        moves++; lines += m.lines; game = updateCombo(game, m.lines);
      }
    }
    console.log(`Ходов: ${moves}, линий: ${lines}`);
    if (cmd === 'once') return;
  }
}

function updateCombo(g, n) {
  if (n > 0) return { combo: g.combo + 1, since: 0 };
  const since = g.since + 1;
  return { combo: since >= 3 ? 0 : g.combo, since };
}

main().catch((e) => {
  if (e && e.code === 'ENOENT') console.error('Не найден adb. Установите Android platform-tools и добавьте adb в PATH (или укажите путь в config.json → "adb").');
  else console.error(e && e.stderr ? e.stderr.toString() : e);
  process.exit(1);
});
