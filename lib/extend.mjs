// EXTEND a shipped package's held-out oracle from the UPSTREAM ORIGINAL — the oracle-hardening path (QA gate ②).
//
// The QA finding: shipped oracles under-cover the SIR's load-bearing edges (throw paths, coercion, boundaries,
// garbage inputs). The fix does NOT re-emit anything: new INPUTS (agent- or human-authored — inputs only, never
// expecteds) are stamped against the upstream original exactly like stampOracle does, appended to the HELD-OUT
// set (disjointness-guarded), and the EXISTING verified src is re-graded against the fattened oracle.
//   pass → a stronger shipped contract, same src.
//   fail → a REAL divergence the thin oracle had missed → the caller quarantines/flags; never ship the fail.
import { pathToFileURL } from 'node:url';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { installPackage, loadRealExport, cleanup } from './pkg.mjs';
import { encode, decode } from './codec.mjs';

const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

// REBALANCE a shipped package's HELD-OUT set to be output-stratified (QA gate ② backfill). A held-out with a
// single output class cannot kill a constant stub — the resynth risk. This regenerates a stratified held-out by:
//   1. running the package's OWN inputs generator (if present) OR agent-supplied candidate inputs, at scale;
//   2. executing the UPSTREAM ORIGINAL to LABEL each candidate by output class (expecteds never hand-authored);
//   3. sampling a balanced held-out — up to `perClass` per output class — so every class the function can
//      produce is represented; frozen set is left untouched (it stays the teaching slice).
// Disjointness (vs frozen AND the old held-out's args) is preserved. Returns a report; writes on success.
// candidatesPath: a module exporting `candidates` (array of args-tuples) — the minority-class inputs the agent
// found (e.g. actual Buffers for is-buffer). We stratify over frozen ∪ old-heldout ∪ candidates, all re-labeled.
export async function rebalanceHeldout({ pkgDir, candidatesPath, perClass = 4, minClasses = 2, dryRun = false, seam }) {
  const { readFileSync: rf, writeFileSync: wf } = await import('node:fs');
  const manifest = JSON.parse(rf(join(pkgDir, 'sir.manifest.json'), 'utf8'));
  if ((manifest.units || []).length !== 1) throw new Error('rebalance supports single-unit packages');
  const u = manifest.units[0];
  const oraclePath = join(pkgDir, u.oracle);
  const oracle = JSON.parse(rf(oraclePath, 'utf-8'));
  if (oracle.mode && oracle.mode !== 'vectors') throw new Error(`rebalance supports value-mode oracles (got ${oracle.mode})`);

  const source = manifest.provenance?.source || '';
  const at = source.lastIndexOf('@');
  if (at <= 0) throw new Error(`cannot parse provenance.source: "${source}"`);
  const upName = source.slice(0, at), upVersion = source.slice(at + 1);

  const clsOf = (e) => JSON.stringify(e && typeof e === 'object' && e.__throw !== undefined ? { __throw: true } : e);
  const frozen = oracle.vectors || [];
  const oldHeld = oracle.heldout || [];

  // candidate args pool: existing frozen + old-heldout args, PLUS agent-supplied minority-class inputs
  let extra = [];
  if (candidatesPath) {
    const mod = await import(pathToFileURL(candidatesPath).href);
    extra = (typeof mod.candidates === 'function' ? mod.candidates() : mod.candidates) || [];
    if (!Array.isArray(extra)) throw new Error('candidates module must export `candidates`: an array of args-tuples');
  }
  const FROZEN_MIN = 8;
  // Normalize the candidate pool to LIVE arg-tuples. Pool = old-heldout ∪ candidates ∪ frozen — frozen IS
  // included, because for single-value-domain predicates (isNull: only `null` returns true) the sole
  // minority-class input already lives in frozen, and a disjoint held-out true is otherwise unreachable. We
  // resolve the tension with MOVE semantics: a frozen case selected into held-out is REMOVED from frozen, so
  // train/test disjointness is preserved and frozen keeps its majority (guarded at ≥FROZEN_MIN).
  const liveExtra = extra.map((tuple) => tuple.map(decode));
  const liveOld = oldHeld.map((v) => v.args.map(decode));
  const liveFrozen = frozen.map((v) => v.args.map(decode));
  const pool = [...liveExtra, ...liveOld, ...liveFrozen]; // candidates first → preferred over frozen in ties

  const inst = installPackage(upName, upVersion);
  try {
    const realFn = loadRealExport(inst.installDir, upName, oracle.exportName ?? null, seam);
    if (typeof realFn !== 'function') throw new Error('could not load upstream export');
    const isState = oracle.observe === 'result+post';

    // label the pool by executing the original; dedupe by encoded args
    const seenArgs = new Set();
    const labeled = [];
    for (const liveArgs of pool) {
      const encArgs = encode(liveArgs);
      const key = JSON.stringify(encArgs);
      if (seenArgs.has(key)) continue;
      seenArgs.add(key);
      let expected, thrown = null;
      try { const r = realFn(...liveArgs); expected = isState ? { result: r, post: liveArgs } : r; } catch (e) { thrown = String(e.message); }
      labeled.push({ args: encArgs, expected: thrown ? { __throw: thrown } : encode(expected) });
    }

    // stratify: bucket by output class, round-robin up to perClass per class (guarantees balance), THEN fill
    // from the remaining pool up to targetN so n≥10 even when the minority class is tiny (isNull: 1 true + falls).
    const targetN = Math.max(12, minClasses * 2);
    const buckets = {};
    for (const v of labeled) { const c = clsOf(v.expected); (buckets[c] = buckets[c] || []).push(v); }
    const classes = Object.keys(buckets);
    const picked = [];
    const pickedKeys = new Set();
    const take = (v) => { const k = JSON.stringify(v.args); if (!pickedKeys.has(k)) { pickedKeys.add(k); picked.push(v); } };
    for (let round = 0; round < perClass; round++) for (const c of classes) if (buckets[c][round]) take(buckets[c][round]);
    // fill pass: keep adding any remaining labeled item until targetN (majority classes carry the fill)
    for (const v of labeled) { if (picked.length >= targetN) break; take(v); }

    const newHeld = picked.map((v, i) => ({ name: 'bal' + i, args: v.args, expected: v.expected }));
    const newHeldKeys = new Set(newHeld.map((v) => JSON.stringify(v.args)));
    // MOVE semantics: frozen loses any case now in held-out; disjointness preserved by construction
    const newFrozen = frozen.filter((v) => !newHeldKeys.has(JSON.stringify(v.args)));
    const moved = frozen.length - newFrozen.length;
    const newClasses = new Set(newHeld.map((v) => clsOf(v.expected))).size;
    const report = { upstream: `${upName}@${inst.version}`, oldHeldout: oldHeld.length, newHeldout: newHeld.length,
      oldClasses: new Set(oldHeld.map((v) => clsOf(v.expected))).size, newClasses, poolLabeled: labeled.length,
      candidatesUsed: extra.length, frozenMoved: moved, frozenNow: newFrozen.length };
    if (newClasses < minClasses) { report.status = 'INSUFFICIENT'; report.note = `only ${newClasses} output class(es) reachable — supply minority-class candidates`; return report; }
    if (newFrozen.length < FROZEN_MIN) { report.status = 'INSUFFICIENT'; report.note = `frozen would drop to ${newFrozen.length} (<${FROZEN_MIN}) — supply candidates so the true case need not move out of frozen`; return report; }

    if (!dryRun) {
      oracle.vectors = newFrozen;
      oracle.heldout = newHeld;
      wf(oraclePath, JSON.stringify(oracle, null, 2) + '\n');
      if (u.oracleSha256) u.oracleSha256 = createHash('sha256').update(rf(oraclePath)).digest('hex');
      for (const v of Object.values(u.variants || {})) if (v.oracle === u.oracle && v.oracleSha256) v.oracleSha256 = u.oracleSha256;
      manifest.units[0] = u;
      wf(join(pkgDir, 'sir.manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    }
    report.status = 'OK';
    return report;
  } finally { cleanup(inst.installDir); }
}

// pkgDir: a shipped packages/<name> dir. inputsPath: a module exporting `newInputs` — an ARRAY of args-tuples
// (codec-tagged forms allowed), or a function (rnd) => array. Returns a report; writes oracle + manifest on success.
export async function extendOracle({ pkgDir, inputsPath, dryRun = false }) {
  const manifest = JSON.parse(readFileSync(join(pkgDir, 'sir.manifest.json'), 'utf8'));
  if ((manifest.units || []).length !== 1) throw new Error('extend supports single-unit packages (got ' + (manifest.units || []).length + ')');
  const u = manifest.units[0];
  const oraclePath = join(pkgDir, u.oracle);
  const oracle = JSON.parse(readFileSync(oraclePath, 'utf-8'));
  if (oracle.mode && oracle.mode !== 'vectors') throw new Error(`extend supports value-mode oracles (got ${oracle.mode})`);

  // the upstream original = the stamping authority
  const source = manifest.provenance?.source || '';
  const at = source.lastIndexOf('@');
  if (at <= 0) throw new Error(`cannot parse provenance.source: "${source}"`);
  const upName = source.slice(0, at), upVersion = source.slice(at + 1);

  const mod = await import(pathToFileURL(inputsPath).href);
  const raw = typeof mod.newInputs === 'function' ? mod.newInputs() : mod.newInputs;
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('inputs module must export newInputs: a non-empty array of args-tuples');

  const inst = installPackage(upName, upVersion);
  try {
    const realFn = loadRealExport(inst.installDir, upName, oracle.exportName ?? null, mod.seam);
    if (typeof realFn !== 'function') throw new Error('could not load the real upstream export');

    // disjointness vs EVERYTHING already shipped (frozen stays frozen; heldout grows)
    const seen = new Set([...(oracle.vectors || []), ...(oracle.heldout || [])].map((v) => JSON.stringify(v.args)));
    const isState = oracle.observe === 'result+post';
    const added = [], skipped = [];
    let n = (oracle.heldout || []).length;
    for (const args of raw) {
      const key = JSON.stringify(encode(args));
      if (seen.has(key)) { skipped.push(key.slice(0, 60)); continue; }
      seen.add(key);
      const decoded = args.map(decode);
      let expected, thrown = null;
      try { const r = realFn(...decoded); expected = isState ? { result: r, post: decoded } : r; } catch (e) { thrown = String(e.message); }
      added.push({ name: 'ext' + n++, args: encode(args), expected: thrown ? { __throw: thrown } : encode(expected) });
    }
    if (!added.length) return { added: 0, skipped: skipped.length, note: 'every input was already in the oracle' };

    if (!dryRun) {
      oracle.heldout = [...(oracle.heldout || []), ...added];
      writeFileSync(oraclePath, JSON.stringify(oracle, null, 2) + '\n');
      // the manifest pins the oracle by hash — update it, or rdv correctly refuses the extended file
      if (u.oracleSha256) { u.oracleSha256 = sha256(oraclePath); }
      if (manifest.units) manifest.units[0] = u;
      // variants model: if a variants block also pins this oracle, keep it in lockstep
      for (const v of Object.values(u.variants || {})) if (v.oracle === u.oracle && v.oracleSha256) v.oracleSha256 = u.oracleSha256;
      writeFileSync(join(pkgDir, 'sir.manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    }
    return { added: added.length, skipped: skipped.length, heldoutNow: (oracle.heldout || []).length, upstream: `${upName}@${inst.version}` };
  } finally { cleanup(inst.installDir); }
}
