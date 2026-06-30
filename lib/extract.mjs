// Mechanical, BYTE-EXACT extraction of carried-data constants from original source. The decomposer (LLM)
// only LOCATES the constants (source file + names); this deterministic step pulls the exact literals — the
// model never transcribes a 1024-entry table. Carried data is COPIED, not re-derived; its trust comes from
// (1) the oracle exercising it, (2) a content hash, and (3) an independent-authority cross-check (below).
import { readFileSync, writeFileSync } from 'node:fs';

// Extract the RHS of `var|let|const <name> = <literal-or-expr>;` by a balanced scan (respects []{}() + strings).
function extractRHS(src, name) {
  const re = new RegExp('(?:var|let|const)\\s+' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*=\\s*');
  const m = re.exec(src);
  if (!m) throw new Error('carried const not found in source: ' + name);
  let i = m.index + m[0].length;
  const start = i;
  let depth = 0, inStr = null;
  for (; i < src.length; i++) {
    const c = src[i];
    if (inStr) { if (c === '\\') { i++; continue; } if (c === inStr) inStr = null; continue; }
    // Skip JS comments so quotes/brackets inside them (e.g. `// 21 isn't supported`, `// Alias of \`x\``)
    // don't open a phantom string and overrun the literal. The comment text stays in the sliced RHS (valid
    // inside the `return (...)` eval); only the SCAN ignores these regions.
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i++; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    else if (c === '[' || c === '{' || c === '(') depth++;
    else if (c === ']' || c === '}' || c === ')') depth--;
    else if (c === ';' && depth === 0) break;
  }
  return src.slice(start, i).trim();
}

// Evaluate a PURE literal/expression RHS (array of numbers, "str".split(''), object literal) in a bare context.
// Only the decomposer-declared constant names are ever evaluated.
function evalLiteral(rhs) {
  return Function('"use strict"; return (' + rhs + ');')();
}

export function extractConsts(sourceFile, names) {
  const src = readFileSync(sourceFile, 'utf8');
  const out = {};
  // Pure-JSON carried-data source (e.g. cli-boxes' boxes.json): the declared names are TOP-LEVEL KEYS, not
  // `const NAME =` declarations. Pick them byte-exact via JSON.parse — strictly more conservative than the
  // JS-eval path (no Function eval), and still a mechanical COPY (never re-derived/transcribed by the model).
  if (sourceFile.endsWith('.json')) {
    const parsed = JSON.parse(src);
    for (const name of names) {
      if (!(name in parsed)) throw new Error('carried const not found in source: ' + name);
      out[name] = parsed[name];
    }
    return out;
  }
  for (const name of names) out[name] = evalLiteral(extractRHS(src, name));
  return out;
}

// Re-runnable INDEPENDENT-AUTHORITY check: evaluate declared assertions over the extracted constants. Trust
// comes from these matching a PUBLISHED standard (not the publisher's bytes), and the check ships in the
// manifest so a consumer re-runs it. Each assertion: { expr: "<JS over the const names>", equals: <value> }.
// `passed` requires >=1 assertion AND all of them passing — so NO assertions => unattested (gate refuses by default).
export function runAuthority(consts, assertions) {
  const names = Object.keys(consts);
  const vals = names.map((n) => consts[n]);
  const results = (assertions || []).map((a) => {
    let got;
    try { got = Function(...names, '"use strict"; return (' + a.expr + ');')(...vals); }
    catch (e) { got = { __error: String(e.message) }; }
    const ok = JSON.stringify(got) === JSON.stringify(a.equals);
    return ok ? { expr: a.expr, ok } : { expr: a.expr, ok, got, expected: a.equals };
  });
  return { passed: results.length > 0 && results.every((r) => r.ok), results };
}

// Load a shipped data module's exported constants (for re-running the authority check at pack/check time).
export async function loadConsts(dataModulePath) {
  const { pathToFileURL } = await import('node:url');
  const m = await import(pathToFileURL(dataModulePath).href);
  const out = {}; for (const k of Object.keys(m)) if (k !== 'default') out[k] = m[k];
  return out;
}

// Emit the carried-data ES module. It's JavaScript (not SIR), so // comments are correct here.
export function writeDataModule(path, consts, provenanceLine) {
  const lines = [
    `// CARRIED DATA — extracted byte-exact (mechanical, not re-derived) from ${provenanceLine}.`,
    `// Shipped verbatim, content-hashed, and exercised by the oracle. See sir.manifest.json carriedData.`,
  ];
  for (const [name, val] of Object.entries(consts)) lines.push(`export const ${name} = ${JSON.stringify(val)};`);
  writeFileSync(path, lines.join('\n') + '\n');
  return path;
}
