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
