// The two gates: held-out QUORUM + saturation DIFFERENTIAL vs the real package.
import { pathToFileURL } from 'node:url';
import { statSync } from 'node:fs';
import { decode, encode } from './codec.mjs';
import { runTrace } from './trace.mjs';

// Structural equality that is robust to non-JSON-safe values (bigint/NaN/±Infinity/RegExp/Set/Map/boxed):
// encode() maps them to JSON-safe tagged forms first, so e.g. a returned array containing a bigint compares
// faithfully instead of making JSON.stringify throw. {__throw} objects pass through encode unchanged.
const jeq = (a, b) => JSON.stringify(encode(a)) === JSON.stringify(encode(b));
const callOf = (fn, args) => { try { return fn(...args); } catch (e) { return { __throw: String(e.message) }; } };
// Call strategy by oracle. value-mode: the return value (default — every legacy oracle). observe='result+post'
// (SIR v0.2 §11, KIND STATE): { result, post } where post = the (mutated) args — keyed on the ORACLE's contract,
// NOT kind, so the 218 legacy return-only oracles stay byte-identical. trace-mode: injected boundary, {emitted,result}.
const callerFor = (mode, observeRP) =>
  mode === 'trace'
    ? async (fn, args) => { try { return await runTrace(fn, args); } catch (e) { return { __throw: String(e.message) }; } }
    : observeRP
      ? async (fn, args) => { try { const result = fn(...args); return { result, post: args }; } catch (e) { return { __throw: String(e.message) }; } }
      : async (fn, args) => callOf(fn, args);

async function loadFn(path, exportName) {
  const m = await import(pathToFileURL(path).href);
  return (exportName && m[exportName]) || m.default || m[exportName] || Object.values(m).find((x) => typeof x === 'function');
}

export async function grade({ emissionPaths, oracle, realFn, inputsPath, differentialN, rnd, kind }) {
  const held = oracle.heldout;
  const observeRP = oracle.observe === 'result+post';   // {result,post} observation — the oracle declares it (held-out + differential)
  const mutating = (kind ?? oracle.kind) === 'STATE';   // in-place mutation → per-call arg isolation in the differential
  const call = callerFor(oracle.mode, observeRP);
  const results = [];
  for (const p of emissionPaths) {
    let fn;
    try { fn = await loadFn(p, oracle.exportName); } catch (e) { results.push({ p, err: String(e.message), pass: 0, total: held.length, full: false }); continue; }
    if (typeof fn !== 'function') { results.push({ p, err: 'no exported function', pass: 0, total: held.length, full: false }); continue; }
    let pass = 0; const miss = [];
    for (const v of held) { if (jeq(await call(fn, decode(v.args)), decode(v.expected))) pass++; else miss.push(v.name); }
    results.push({ p, fn, pass, total: held.length, full: pass === held.length, miss, size: safeSize(p) });
  }

  const full = results.filter((r) => r.full);
  const quorum = full.length >= 2;

  // GATE 2 only runs if quorum holds. Winner = smallest full-passer.
  let differential = null, winner = null;
  if (quorum) {
    winner = full.slice().sort((a, b) => a.size - b.size)[0];
    const inputs = await import(pathToFileURL(inputsPath).href);
    // A mutating (KIND STATE) unit needs per-call arg ISOLATION or the differential is vacuous: realFn and winner.fn
    // must not share one args object (the first call's in-place mutation poisons the second; decode() passes live
    // values BY REFERENCE, so a second decode does not un-alias — structuredClone does). The OBSERVATION ({result,post}
    // vs return-only) is the `call` contract above (observeRP, oracle-declared). Together: real and winner are observed
    // the same way on independent args. (Necessary — lodash.pullat: a do-nothing mutator scored a vacuous 200/200.)
    // FUNCTIONAL units: mutating=false → raw.map(decode) per call, return-only → the exact prior behavior (non-weakening).
    const freshArgs = (raw) => { const d = raw.map(decode); if (!mutating) return d; try { return structuredClone(d); } catch { return d; } };
    let agree = 0, total = 0; const div = [];
    for (const rawArgs of inputs.genInputs(differentialN, rnd)) {
      total++;
      const r = await call(realFn, freshArgs(rawArgs)), w = await call(winner.fn, freshArgs(rawArgs)); // independent args per call
      if (jeq(r, w)) agree++; else if (div.length < 25) div.push({ args: rawArgs, real: r, win: w });
    }
    // The generator contract is "≥ differentialN" (curated coverage prefix FIRST, then n seeded-random fills), so a
    // generator may legitimately yield total = differentialN + |prefix|. Equivalence must therefore mean EVERY tested
    // tuple agreed (agree === total) AND at least differentialN were tested (coverage floor). The old `agree ===
    // differentialN` was unsound for any total > differentialN: a perfect emitter (agree = total > N) was a FALSE
    // NEGATIVE, and — worse — an emitter with exactly (total − N) real divergences scored agree === N and would have
    // been a FALSE POSITIVE (verified despite divergences). `agree === total` rejects ANY divergence; `total >= N`
    // keeps the minimum-coverage guarantee. For the common total === N generator this is identical to before.
    differential = { n: differentialN, total, agree, equivalent: agree === total && total >= differentialN, div };
  }

  // held-out vectors not passed by ALL emitters — the SIR-ambiguity signal (independent engineers diverged)
  const graded = results.filter((r) => typeof r.fn === 'function');
  const heldoutDisagree = [];
  for (const v of held) {
    let passed = 0;
    for (const r of graded) if (jeq(await call(r.fn, decode(v.args)), decode(v.expected))) passed++;
    if (passed < graded.length) heldoutDisagree.push({ name: v.name, args: v.args, expected: v.expected, passedBy: passed, of: graded.length });
  }

  const verdict = quorum && differential?.equivalent ? 'verified' : 'failed';
  return { quorum, fullCount: full.length, emitted: results.length, results, heldoutDisagree, winner: winner?.p ?? null, differential, verdict };
}

function safeSize(p) { try { return statSync(p).size; } catch { return Infinity; } }
