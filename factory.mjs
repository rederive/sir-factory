#!/usr/bin/env node
// Mechanical CLI for the AGENT-DRIVEN verified-package factory. No claude -p, no API key.
//
// The orchestrating AGENT drives the loop, spawning the two roles via the Agent tool (in-session):
//   factory install <name> <ver>   → install original, scaffold workdir            (Bash)
//   [agent spawns SIGHTED decomposer subagent → writes sir/<unit>.sir + .inputs.mjs] (Agent tool, Read)
//   factory stamp <workdir>        → stamp oracle from the real pkg, print frozen    (Bash)
//   [agent spawns N BLIND sir-reemitter subagents → write runs/emit_<i>.mjs]         (Agent tool, Write-only)
//   factory grade <workdir>        → held-out quorum + saturation differential       (Bash)
//
// See PROTOCOL.md for the exact agent sequence.
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, copyFileSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installPackage, loadRealExport, cleanup } from './lib/pkg.mjs';
import { stampOracle, stampTraceOracle } from './lib/oracle.mjs';
import { grade } from './lib/grade.mjs';
import { display, encode } from './lib/codec.mjs';
import { packPackage } from './lib/pack.mjs';
import { extractConsts, writeDataModule, runAuthority } from './lib/extract.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const cmd = argv[0];
const pos = argv.slice(1).filter((a) => !a.startsWith('--'));
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const mulberry = (a) => () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const safe = (s) => s.replace(/[^\w.-]/g, '_');
const fail = (m) => { console.error(m); process.exitCode = 1; };

function stateOps(root) {
  const p = join(root, 'state.json');
  const load = () => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : { packages: {} });
  const set = (name, patch) => { const s = load(); s.packages[name] = { ...(s.packages[name] || {}), ...patch }; writeFileSync(p, JSON.stringify(s, null, 2) + '\n'); };
  return { load, set };
}

if (cmd === 'install') doInstall();
else if (cmd === 'stamp') await doStamp();
else if (cmd === 'grade') await doGrade();
else if (cmd === 'status') doStatus();
else if (cmd === 'extract') doExtract();
else if (cmd === 'stage-reemit') doStageReemit();
else if (cmd === 'pack') doPack();
else { console.error('usage: factory.mjs <install|decompose*|extract|stamp|grade|pack|status> ...'); process.exit(2); }

function doInstall() {
  const [name, version] = pos;
  const root = resolve(opt('--out', join(__dir, 'out')));
  const unit = opt('--unit', name);
  const exportName = opt('--export', null);
  const hint = opt('--hint', '');
  const wd = join(root, safe(name));
  mkdirSync(join(wd, 'sir'), { recursive: true });
  mkdirSync(join(wd, 'runs'), { recursive: true });
  const { installDir, pkgDir, version: real } = installPackage(name, version);
  const meta = { name, version: real, unit, exportName, hint, pkgDir, installDir, sir: `sir/${unit}.sir`, inputs: `sir/${unit}.inputs.mjs` };
  writeFileSync(join(wd, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');
  stateOps(root).set(name, { status: 'decomposing', version: real, workdir: wd });
  console.log(JSON.stringify({ ok: true, workdir: wd, pkgDir, unit, exportName,
    sirPath: join(wd, 'sir', `${unit}.sir`), inputsPath: join(wd, 'sir', `${unit}.inputs.mjs`),
    next: `spawn the SIGHTED decomposer (Agent tool, Read access to ${pkgDir}); it writes the SIR + input-generator to the two paths above` }, null, 2));
}

async function doStamp() {
  const wd = resolve(pos[0]);
  const root = resolve(opt('--out', dirname(wd)));
  const st = stateOps(root);
  const meta = JSON.parse(readFileSync(join(wd, 'meta.json'), 'utf8'));
  const sirPath = join(wd, meta.sir), inputsPath = join(wd, meta.inputs);
  if (!existsSync(sirPath) || !existsSync(inputsPath)) { st.set(meta.name, { status: 'quarantined', reason: 'decomposer did not produce SIR + inputs' }); return fail('decomposer did not produce SIR + inputs'); }
  const sirText = readFileSync(sirPath, 'utf8');
  // TRACE-MODE: the unit performs an EFFECT across an INJECTABLE boundary (declared `TRACE-SEAM <kind>` or
  // `ORACLE-CLASS trace`). It IS non-deterministic at the boundary, but injectably so — stamp it under a fake
  // boundary ({emitted,result}) rather than quarantining. A non-deterministic seam with NO injection point is
  // still a quarantine (the decomposer must NOT declare TRACE-SEAM for one).
  const traceMode = /ORACLE-CLASS\s+trace|TRACE-SEAM/i.test(sirText);
  const ndm = sirText.match(/ORACLE-CLASS\s+non-deterministic[^\n]*/i);
  if (!traceMode && ndm) { st.set(meta.name, { status: 'quarantined', reason: ndm[0].trim() }); return fail('QUARANTINE: ' + ndm[0].trim() + ' — needs an injected-seam oracle (trace mode), not value mode'); }
  const realFn = loadRealExport(meta.installDir, meta.name, meta.exportName);
  if (typeof realFn !== 'function') { st.set(meta.name, { status: 'quarantined', reason: 'could not load real export' }); return fail('could not load real export'); }
  const frozenN = Number(opt('--frozen', 16)), heldoutN = Number(opt('--heldout', 13)), seed = Number(opt('--seed', 0x9e3779b9));
  let stamped;
  const kind = (sirText.match(/^KIND\s+(\w+)/m)?.[1]) || 'FUNCTIONAL';  // STATE → {result,post} oracle (SIR v0.2 §11)
  try { stamped = await (traceMode ? stampTraceOracle : stampOracle)({ inputsPath, realFn, frozenN, heldoutN, rnd: mulberry(seed), kind }); }
  catch (e) { st.set(meta.name, { status: 'quarantined', reason: 'stamp failed: ' + e.message }); return fail('stamp failed: ' + e.message); }
  if (stamped.leak > 0) { st.set(meta.name, { status: 'quarantined', reason: `held-out leakage ${stamped.leak}` }); return fail(`held-out leakage ${stamped.leak} — train/test not disjoint`); }
  const oracle = stamped.oracle;
  writeFileSync(join(wd, 'oracle.json'), JSON.stringify(oracle, null, 2) + '\n');
  st.set(meta.name, { status: 'reemitting' });
  const frozenBlock = oracle.frozen.map((v) => `  ${oracle.exportName || 'fn'}(${v.args.map(display).join(', ')}) => ${display(v.expected)}`).join('\n');
  console.log(`OK stamped: ${oracle.frozen.length} frozen / ${oracle.heldout.length} held-out (leak 0). exportName=${JSON.stringify(oracle.exportName)}`);
  console.log('SIR_PATH: ' + sirPath);
  console.log('--- FROZEN ORACLE (inline into each blind re-emitter prompt) ---');
  console.log(frozenBlock);
  console.log(`--- now spawn ${opt('--emitters', '3')} BLIND sir-reemitters; each writes ${join(wd, 'runs', 'emit_<i>.mjs')} ---`);
}

async function doGrade() {
  const wd = resolve(pos[0]);
  const root = resolve(opt('--out', dirname(wd)));
  const round = Number(opt('--round', 1)), cap = Number(opt('--cap', 3));
  const st = stateOps(root);
  const meta = JSON.parse(readFileSync(join(wd, 'meta.json'), 'utf8'));
  const oracle = JSON.parse(readFileSync(join(wd, 'oracle.json'), 'utf8'));
  const inputsPath = join(wd, meta.inputs);
  const kind = (existsSync(join(wd, meta.sir)) && readFileSync(join(wd, meta.sir), 'utf8').match(/^KIND\s+(\w+)/m)?.[1]) || 'FUNCTIONAL'; // STATE-aware, aliasing-free differential
  const realFn = loadRealExport(meta.installDir, meta.name, meta.exportName);
  const emissionPaths = readdirSync(join(wd, 'runs')).filter((f) => /^emit_.*\.mjs$/.test(f)).map((f) => join(wd, 'runs', f));
  if (emissionPaths.length < 2) { st.set(meta.name, { status: 'quarantined', reason: `only ${emissionPaths.length} emission(s)` }); return fail(`only ${emissionPaths.length} emission(s) — cannot reach quorum`); }
  const diffN = Number(opt('--differential', 400)), seed = Number(opt('--seed', 0x9e3779b9));
  const g = await grade({ emissionPaths, oracle, realFn, inputsPath, differentialN: diffN, rnd: mulberry(seed ^ 0x1234), kind });

  if (g.verdict === 'verified') {
    mkdirSync(join(wd, 'src'), { recursive: true });
    const header = `// @rederive/${meta.unit} — verified-recompose of ${meta.name}@${meta.version}. quorum ${g.fullCount}/${g.emitted}, differential ${g.differential.agree}/${g.differential.n}, round ${round}. SIR: ${meta.sir}\n`;
    writeFileSync(join(wd, 'src', `${meta.unit}.js`), header + readFileSync(g.winner, 'utf8'));
    st.set(meta.name, { status: 'verified', round, quorum: `${g.fullCount}/${g.emitted}`, differential: `${g.differential.agree}/${g.differential.n}`, reason: null, lastDivergence: null });
    cleanup(meta.installDir);
    console.log(`VERIFIED ✓  round ${round}  quorum ${g.fullCount}/${g.emitted}, differential ${g.differential.agree}/${g.differential.n}  ->  ${join(wd, 'src', meta.unit + '.js')}`);
    return;
  }

  // FAILURE => the SIR is inadequate (independent blind engineers diverged). Record the divergence and KICK
  // BACK to the decomposer to HARDEN the definition. Quarantine only after the round cap.
  const divergence = {
    round, verdict: g.verdict,
    quorum: `${g.fullCount}/${g.emitted}`,
    differential: g.differential ? `${g.differential.agree}/${g.differential.n}` : 'not run (no quorum)',
    heldoutDisagreements: g.heldoutDisagree,            // held-out vectors independent emitters split on
    differentialDivergences: (g.differential?.div ?? []).map((d) => ({ args: encode(d.args), real: encode(d.real), got: encode(d.win) })), // vs the real package (encode: divergence values may carry bigint/NaN/etc.)
  };
  writeFileSync(join(wd, 'divergence.json'), JSON.stringify(divergence, null, 2) + '\n');
  const summary = !g.quorum
    ? `no quorum (${g.fullCount}/${g.emitted}); ${g.heldoutDisagree.length} held-out vectors split`
    : `differential ${g.differential.agree}/${g.differential.n}`;

  if (round >= cap) {
    st.set(meta.name, { status: 'quarantined', round, quorum: `${g.fullCount}/${g.emitted}`, reason: `SIR not hardened to convergence in ${cap} rounds — ${summary}` });
    console.log(`QUARANTINE (cap ${cap} reached): ${summary} — see ${join(wd, 'divergence.json')} (escalate to human)`);
    process.exitCode = 1;
    return;
  }
  st.set(meta.name, { status: 'hardening', round, quorum: `${g.fullCount}/${g.emitted}`, lastDivergence: summary });
  console.log(`KICK BACK SIR (round ${round}/${cap}): ${summary}`);
  console.log(`divergence -> ${join(wd, 'divergence.json')}`);
  console.log(`next: re-spawn the decomposer in HARDEN mode with ${join(wd, meta.sir)} + divergence.json, then re-stamp, re-emit, and: node factory.mjs grade <wd> --round ${round + 1}`);
  process.exitCode = 2; // 0=verified, 2=needs-hardening (loop), 1=terminal/quarantine
}

function doStatus() {
  const root = resolve(opt('--out', join(__dir, 'out')));
  const s = stateOps(root).load();
  for (const [n, p] of Object.entries(s.packages)) {
    const icon = p.status === 'verified' ? '✓' : p.status === 'quarantined' ? '⊘' : '…';
    console.log(`${icon} ${n}@${p.version || '?'}  ${p.status}${p.quorum ? ` q=${p.quorum}` : ''}${p.differential ? ` d=${p.differential}` : ''}${p.reason ? `  (${p.reason})` : ''}`);
  }
}

function doPack() {
  const wd = resolve(pos[0]);
  const root = resolve(opt('--out', dirname(wd)));
  const scope = opt('--scope', '@rederive');
  const packagesDir = resolve(opt('--packages', join(root, 'packages')));
  let r;
  try { r = packPackage({ wd, root, scope, packagesDir }); } catch (e) { return fail(e.message); }
  console.log(`packed ${r.pkgName} -> ${r.dir}`);
  console.log('  ' + r.files.join('  '));
  console.log(`  verify:  rdv check ${r.dir}   (or: npx tsx <rederive>/cli/rdv.mts check ${r.dir})`);
}

// Mechanical carried-data step: extract byte-exact constants the decomposer declared, run the re-runnable
// independent-authority check, and apply the (a)/(b) gate. Writes src/<unit>.data.js (+ a runs/ copy for
// blind re-emit) and annotates the carried.json with the authority result.
function doExtract() {
  const wd = resolve(pos[0]);
  const root = resolve(opt('--out', dirname(wd)));
  const allowUnattested = argv.includes('--allow-unattested-data');
  const st = stateOps(root);
  const meta = JSON.parse(readFileSync(join(wd, 'meta.json'), 'utf8'));
  const carriedPath = join(wd, 'sir', `${meta.unit}.carried.json`);
  if (!existsSync(carriedPath)) { console.log(`no carried-data declaration (sir/${meta.unit}.carried.json) — nothing to extract`); return; }
  const carried = JSON.parse(readFileSync(carriedPath, 'utf8'));
  const consts = extractConsts(carried.sourceFile, carried.consts);
  const dataRel = carried.dataModule || `src/${meta.unit}.data.js`;
  const prov = carried.sourceProvenance || carried.sourceFile;
  mkdirSync(join(wd, dirname(dataRel)), { recursive: true });
  writeDataModule(join(wd, dataRel), consts, prov);                 // canonical location (src/)
  mkdirSync(join(wd, 'runs'), { recursive: true });
  writeDataModule(join(wd, 'runs', basename(dataRel)), consts, prov); // copy so blind re-emitters can import it
  const auth = runAuthority(consts, carried.authority?.assertions);
  carried.authority = { ...(carried.authority || {}), independentlyVerified: auth.passed, results: auth.results, checkedAt: new Date().toISOString().slice(0, 10) };
  writeFileSync(carriedPath, JSON.stringify(carried, null, 2) + '\n');
  console.log(`extracted ${carried.consts.length} consts -> ${dataRel} (+ runs/${basename(dataRel)}); authority ${auth.passed ? `VERIFIED (${auth.results.length} assertions vs published standard)` : 'UNATTESTED'}`);
  if (!auth.passed) {
    for (const r of auth.results.filter((x) => !x.ok)) console.log(`   assertion FAILED: ${r.expr} -> got ${JSON.stringify(r.got)} want ${JSON.stringify(r.expected)}`);
    if (!allowUnattested) { st.set(meta.name, { status: 'quarantined', reason: 'carried data not independently attested; use --allow-unattested-data for opt-in (b)' }); return fail('QUARANTINE (default a): carried data unattested — refused. Re-run with --allow-unattested-data to opt in (b).'); }
    carried.allowUnattested = true; writeFileSync(carriedPath, JSON.stringify(carried, null, 2) + '\n');
    console.log('   shipping unattested carried data under --allow-unattested-data (opt-in b)');
  }
}

// Stage a CLEAN ROOM for blind re-emit of large SIRs: a dir with ONLY the SIR + a rendered frozen oracle
// (no meta.json / carried.json / source paths to leak). A `sir-reemitter-cr` agent (Read+Write only, no
// search/net) reads these from file — so a 28 KB SIR needs no hand-inline — and writes the emission to runs/.
function doStageReemit() {
  const wd = resolve(pos[0]);
  const meta = JSON.parse(readFileSync(join(wd, 'meta.json'), 'utf8'));
  const unit = meta.unit;
  const oracle = JSON.parse(readFileSync(join(wd, 'oracle.json'), 'utf8'));
  const cr = join(wd, 'reemit');
  mkdirSync(cr, { recursive: true });
  copyFileSync(join(wd, meta.sir), join(cr, `${unit}.sir`));
  const frozenBlock = oracle.frozen.map((v) => `  ${oracle.exportName || 'fn'}(${v.args.map(display).join(', ')}) => ${display(v.expected)}`).join('\n');
  writeFileSync(join(cr, 'frozen.md'), `# Frozen oracle for ${unit} — worked input -> output; reproduce EXACTLY.\n${frozenBlock}\n`);
  let carriedImport = null;
  const carriedPath = join(wd, 'sir', `${unit}.carried.json`);
  if (existsSync(carriedPath)) {
    const carried = JSON.parse(readFileSync(carriedPath, 'utf8'));
    carriedImport = `import { ${carried.consts.join(', ')} } from './${unit}.data.js';  // provided in runs/ next to your emission — import, do NOT transcribe`;
  }
  console.log(JSON.stringify({
    ok: true, cleanRoom: cr,
    sirPath: join(cr, `${unit}.sir`), frozenPath: join(cr, 'frozen.md'),
    exportName: oracle.exportName, emitTo: join(wd, 'runs', 'emit_<i>.mjs'), carriedImport,
    next: `spawn N sir-reemitter-cr agents (subagent_type 'sir-reemitter-cr'): each READS the two paths above${carriedImport ? ' and imports the carried constants' : ''}, reconstructs ${unit}, and writes ${join(wd, 'runs', 'emit_<i>.mjs')} (distinct i). Then: node factory.mjs grade ${wd} --round <r>`,
  }, null, 2));
}
