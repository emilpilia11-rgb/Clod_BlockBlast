// Simulates random Block Blast games to measure/tune the solver.
// Usage: node sim.js [games=30] [maxTurns=300] [seed=1]
const S = require('./solver');

const games = +process.argv[2] || 30;
const maxTurns = +process.argv[3] || 300;
let seed = +process.argv[4] || 1;
function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x80000000; }

function play(weights) {
  let board = new Array(64).fill(0);
  let state = { combo: 0, since: 0 };
  let score = 0, turns = 0, lines = 0;
  for (; turns < maxTurns; turns++) {
    const pieces = [0, 1, 2].map(() => S.SHAPES[Math.floor(rnd() * S.SHAPES.length)]);
    const res = S.solve(board, pieces, { state, weights });
    for (const m of res.moves) score += m.cells.length;
    // replay to compute game-like score
    if (!res.placedAll) break;
    for (const m of res.moves) if (m.lines) score += 10 * m.lines * m.lines;
    lines += res.lines;
    board = res.moves[res.moves.length - 1].boardAfter;
    state = res.state;
  }
  return { turns, score, lines };
}

const t0 = Date.now();
let sumT = 0, sumS = 0, full = 0;
for (let g = 0; g < games; g++) {
  const r = play();
  sumT += r.turns; sumS += r.score; if (r.turns >= maxTurns) full++;
  process.stdout.write(`game ${g + 1}: turns=${r.turns} lines=${r.lines} score=${r.score}\n`);
}
console.log(`avg turns=${(sumT / games).toFixed(1)}  avg score=${(sumS / games).toFixed(0)}  survived ${maxTurns} turns: ${full}/${games}`);
console.log(`time per turn: ${((Date.now() - t0) / sumT).toFixed(1)} ms`);
