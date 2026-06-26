// Self-test for TRACE-MODE: prove (1) correct emissions verify under the injected-boundary oracle, and
// (2) the {emitted} check catches a bug that value-mode (return-only) would miss — an emission that returns
// the right result but writes the WRONG bytes across the boundary.
import { mkdirSync, writeFileSync } from 'node:fs';
import { stampTraceOracle } from '../lib/oracle.mjs';
import { grade } from '../lib/grade.mjs';

const WD = '/tmp/trace-selftest';
mkdirSync(WD + '/runs', { recursive: true });

// The "real" unit: POST params.body across the injected http transport; result is built from the SCRIPTED
// response (not from what was written) — so a wrong written body changes `emitted` but NOT `result`.
const CORRECT = `export function echoPost(params, opts, http) {
  return new Promise((resolve) => {
    const req = http.request({ method: 'POST', path: params.path, headers: { 'x-tag': params.tag } }, (res) => {
      let data = ''; res.setEncoding('utf8');
      res.on('data', (c) => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.write(params.body);
    req.end();
  });
}`;
// Bug: writes the body UPPER-CASED. Same result (result derives from scripted chunks), DIFFERENT emitted bytes.
const BUGGY = CORRECT.replace('req.write(params.body);', 'req.write(params.body.toUpperCase());');

writeFileSync(WD + '/real.mjs', CORRECT);
writeFileSync(WD + '/runs/emit_1.mjs', CORRECT);
writeFileSync(WD + '/runs/emit_2.mjs', CORRECT);
writeFileSync(WD + '/runs/emit_3.mjs', BUGGY);   // returns-right-result, writes-wrong-bytes

writeFileSync(WD + '/inputs.mjs', `export const exportName = 'echoPost';
export function genInputs(n, rnd) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const j = Math.floor((rnd ? rnd() : Math.random()) * 1e6) + i;
    out.push([
      { path: '/op' + j, tag: 't' + (j % 7), body: JSON.stringify({ k: j, v: 'x'.repeat(j % 5) }) }, // a0
      {},                                                                                              // a1
      { statusCode: 200, chunks: ['{"ok":', String(j), '}'] },                                         // script (last)
    ]);
  }
  return out;
}`);

const { pathToFileURL } = await import('node:url');
const real = (await import(pathToFileURL(WD + '/real.mjs').href)).echoPost;
const mulberry = (a) => () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

const stamped = await stampTraceOracle({ inputsPath: WD + '/inputs.mjs', realFn: real, frozenN: 6, heldoutN: 8, rnd: mulberry(1) });
console.log('STAMP: mode=' + stamped.oracle.mode + '  frozen=' + stamped.oracle.frozen.length + '  heldout=' + stamped.oracle.heldout.length + '  leak=' + stamped.leak);
console.log('  sample expected:', JSON.stringify(stamped.oracle.frozen[0].expected));

const g = await grade({
  emissionPaths: [WD + '/runs/emit_1.mjs', WD + '/runs/emit_2.mjs', WD + '/runs/emit_3.mjs'],
  oracle: stamped.oracle, realFn: real, inputsPath: WD + '/inputs.mjs', differentialN: 50, rnd: mulberry(99),
});
console.log('GRADE: verdict=' + g.verdict + '  quorum=' + g.fullCount + '/' + g.emitted + '  differential=' + (g.differential ? g.differential.agree + '/' + g.differential.n : 'n/a'));
console.log('  per-emission full-pass:', g.results.map((r) => (r.p.split('/').pop()) + '=' + r.full).join('  '));
console.log('  heldout vectors split (bug detection):', g.heldoutDisagree.length, g.heldoutDisagree.length ? '(emit_3 writes wrong bytes -> caught by {emitted})' : '');

// Assertions
const ok =
  stamped.oracle.mode === 'trace' &&
  stamped.leak === 0 &&
  g.verdict === 'verified' &&
  g.fullCount === 2 &&                                  // the 2 correct emissions
  g.differential.agree === g.differential.n &&          // winner matches real on fresh inputs
  g.results.find((r) => r.p.endsWith('emit_3.mjs')).full === false &&  // buggy emission NOT a full-passer
  g.heldoutDisagree.length > 0;                         // {emitted} divergence detected
console.log(ok ? '\n✓ TRACE-MODE SELF-TEST PASSED — correct emissions verify; wrong-bytes bug caught by emitted-trace.' : '\n✗ SELF-TEST FAILED');
process.exit(ok ? 0 : 1);
