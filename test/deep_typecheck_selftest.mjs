// Deep type-checker verification test: prove the extended codec lets the gates GRADE the edge inputs
// (undefined/NaN/boxed) that define a type-checker's contract — so a bug on the boxed-primitive path is CAUGHT.
import { mkdirSync, writeFileSync } from 'node:fs';
import { stampOracle } from '../lib/oracle.mjs';
import { grade } from '../lib/grade.mjs';
const WD = '/tmp/tc-test'; mkdirSync(WD + '/runs', { recursive: true });

const CORRECT = `export function isNum(v){ return typeof v==='number' || v instanceof Number; }`;
const BUGGY   = `export function isNum(v){ return typeof v==='number'; }`; // misses boxed Number -> only caught if boxed is graded
writeFileSync(WD + '/runs/emit_1.mjs', CORRECT);
writeFileSync(WD + '/runs/emit_2.mjs', CORRECT);
writeFileSync(WD + '/runs/emit_3.mjs', BUGGY);
writeFileSync(WD + '/inputs.mjs', `export const exportName='isNum';
export function genInputs(n, rnd){
  const base=[[1],[0],[-5],[NaN],[Infinity],[-Infinity],[3.14],[new Number(5)],[new Number(NaN)],['3'],[new String('3')],[true],[null],[undefined],[{}],[[1]]];
  const out=base.slice(); let i=0;
  while(out.length<n){ const r=(rnd?rnd():Math.random()); out.push([ r<0.4 ? r*1000 : r<0.7 ? new Number(i) : r<0.85 ? String(i) : (i%2?undefined:NaN) ]); i++; }
  return out;
}`);
const real = (v) => typeof v === 'number' || v instanceof Number;
const mb = (a) => () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

const s = await stampOracle({ inputsPath: WD + '/inputs.mjs', realFn: real, frozenN: 8, heldoutN: 12, rnd: mb(1) });
const g = await grade({ emissionPaths: [WD + '/runs/emit_1.mjs', WD + '/runs/emit_2.mjs', WD + '/runs/emit_3.mjs'], oracle: s.oracle, realFn: real, inputsPath: WD + '/inputs.mjs', differentialN: 80, rnd: mb(7) });
console.log('TYPE-CHECKER: leak=' + s.leak + ' verdict=' + g.verdict + ' quorum=' + g.fullCount + '/' + g.emitted + ' differential=' + (g.differential ? g.differential.agree + '/' + g.differential.n : 'n/a'));
console.log('  per-emission full:', g.results.map(r => r.p.split('/').pop() + '=' + r.full).join(' '));
console.log('  boxed-bug caught (held-out split):', g.heldoutDisagree.length > 0);
const ok = s.leak === 0 && g.verdict === 'verified' && g.fullCount === 2 && g.differential.agree === g.differential.n && g.results.find(r => r.p.endsWith('emit_3.mjs')).full === false && g.heldoutDisagree.length > 0;
console.log(ok ? '\n✓ DEEP TYPE-CHECKER TEST PASSED — undefined/NaN/boxed are graded; boxed-primitive bug caught' : '\n✗ FAILED');
process.exit(ok ? 0 : 1);
