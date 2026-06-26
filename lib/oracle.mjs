// Stamp a value-mode oracle by executing the REAL package (node-1). Expecteds are never hand-authored.
import { pathToFileURL } from 'node:url';
import { encode, decode } from './codec.mjs';
import { runTrace } from './trace.mjs';

export async function stampOracle({ inputsPath, realFn, frozenN, heldoutN, rnd, kind }) {
  const inputs = await import(pathToFileURL(inputsPath).href);
  if (typeof inputs.genInputs !== 'function') throw new Error('inputs module missing genInputs(n, rnd)');
  const exportName = inputs.exportName ?? null;
  const isState = kind === 'STATE';   // SIR v0.2 §11: a STATE unit's observable is { result, post } (post = the mutated args)

  // generate, dedupe, stamp from the real fn
  const want = frozenN + heldoutN;
  const seen = new Set();
  const uniq = [];
  let guard = 0;
  while (uniq.length < want && guard++ < want * 50) {
    for (const args of inputs.genInputs(want, rnd)) {
      const k = JSON.stringify(encode(args));
      if (!seen.has(k)) { seen.add(k); uniq.push(args); }
      if (uniq.length >= want) break;
    }
  }
  const stamp = (args, i) => {
    let expected, thrown = null;
    // DECODE at use-time: genInputs may emit codec-tagged forms ({__t:'undef'|'num'|'bigint'|'regex'|
    // 'boxed'|'set'|'map'|'u8'}) so values that don't survive JSON (undefined/NaN/±Infinity/bigint/RegExp/
    // Set/Map/boxed) can cross the persisted oracle. The REAL fn must see the live value, not the tag object.
    // decode() is idempotent on live values, so raw genInputs (real RegExp / trace scripts) pass through too.
    // Symmetric with grade()'s held-out side, which decodes before calling the emitter.
    const decoded = args.map(decode);   // keep a ref so STATE can read the post-mutation state
    try { const r = realFn(...decoded); expected = isState ? { result: r, post: decoded } : r; } catch (e) { thrown = String(e.message); }
    // Encode `expected` symmetrically with `args` so the persisted oracle survives JSON.stringify
    // (a return value can itself carry bigint / NaN / RegExp / Set / boxed primitives — e.g. a unit
    // that returns elements of its input). grade() decodes both sides before comparing.
    return { name: 'v' + i, args: encode(args), expected: thrown ? { __throw: thrown } : encode(expected) };
  };
  const vecs = uniq.slice(0, want).map(stamp);
  const frozen = vecs.slice(0, frozenN);
  const heldout = vecs.slice(frozenN, want);

  const frozenKeys = new Set(frozen.map((v) => JSON.stringify(v.args)));
  const leak = heldout.filter((v) => frozenKeys.has(JSON.stringify(v.args))).length;

  return { oracle: { mode: 'vectors', exportName, frozen, heldout, ...(isState ? { observe: 'result+post' } : {}) }, leak, generated: vecs.length };
}

// Stamp a TRACE-MODE oracle: the unit performs an EFFECT across an injected boundary (the HTTP transport). For
// each generated input [a0, a1, script], run the REAL fn under a fake boundary built from `script` and record
// the observable contract = { emitted (bytes pushed across the boundary), result (return value) }. Same dedup +
// disjoint-split + leak guard as value mode; expecteds are still execution-derived, never hand-authored.
export async function stampTraceOracle({ inputsPath, realFn, frozenN, heldoutN, rnd }) {
  const inputs = await import(pathToFileURL(inputsPath).href);
  if (typeof inputs.genInputs !== 'function') throw new Error('inputs module missing genInputs(n, rnd)');
  const exportName = inputs.exportName ?? null;

  const want = frozenN + heldoutN;
  const seen = new Set();
  const uniq = [];
  let guard = 0;
  while (uniq.length < want && guard++ < want * 50) {
    for (const args of inputs.genInputs(want, rnd)) {
      const k = JSON.stringify(encode(args));
      if (!seen.has(k)) { seen.add(k); uniq.push(args); }
      if (uniq.length >= want) break;
    }
  }

  const vecs = [];
  for (let i = 0; i < Math.min(uniq.length, want); i++) {
    const out = await runTrace(realFn, uniq[i]);                 // { emitted, result } — the trace contract
    vecs.push({ name: 'v' + i, args: encode(uniq[i]), expected: out });
  }
  const frozen = vecs.slice(0, frozenN);
  const heldout = vecs.slice(frozenN, want);

  const frozenKeys = new Set(frozen.map((v) => JSON.stringify(v.args)));
  const leak = heldout.filter((v) => frozenKeys.has(JSON.stringify(v.args))).length;

  return { oracle: { mode: 'trace', exportName, frozen, heldout }, leak, generated: vecs.length };
}
