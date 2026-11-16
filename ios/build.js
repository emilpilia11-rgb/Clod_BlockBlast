// Builds ios/BlockBlast.js (a single self-contained Scriptable script).
// Usage: node ios/build.js
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const html = '<!doctype html><html><head><meta charset="utf-8"></head><body>' +
  ['solver.js', 'detect.js', 'ios/overlay.js'].map((f) => '<script>\n' + read(f) + '\n</script>').join('\n') +
  '</body></html>';
const out = read('ios/template.js').replace('__HTML__', () => JSON.stringify(html));
fs.writeFileSync(path.join(__dirname, 'BlockBlast.js'), out);
console.log('ios/BlockBlast.js', out.length, 'bytes');
