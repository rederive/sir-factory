// Assemble a VERIFIED workdir into a publishable @rederive/* package — the canonical rederive layout that
// `rdv check` verifies and `npm publish` ships. Refuses anything not in `verified` state.
import { mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';

const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const grab = (text, re) => (text.match(re)?.[1] ?? '').trim();

// The SIR spec version a bundle TARGETS = the minimum version whose feature set it actually uses. rdv asserts
// this, and a trust-nothing consumer refuses a format it can't fully understand — so UNDER-stamping is a
// soundness hole: a bundle that uses a v0.3 feature but stamps 0.2 would be accepted by a 0.2-only rdv that
// lacks that feature's gate, which then silently skips it (e.g. the carried-data authority check).
// Feature → version (SIR_SCHEMA): carried-data authority, ENVELOPE, and TRACE-SEAM/trace-oracle are §§15–18 =
// v0.3; a plain vectors/functional bundle is the v0.2 bundle contract (§14). Concurrency (v0.4 §§19–22) is not
// emittable by the factory, so it never arises here — do NOT stamp 0.4 until the factory can produce+verify it.
export const specVersionFor = ({ carriedData, envelope, mode }) =>
  (carriedData || envelope || mode === 'trace') ? '0.3' : '0.2';

function sigFromSir(text) {
  const noComments = text.replace(/#[^\n]*|\/\/[^\n]*/g, ''); // SIR comments are '#'; tolerate legacy '//'
  const m = noComments.match(/^SIG\b([\s\S]*?)->\s*(\w+)/m);
  return m ? `${m[1].replace(/\s+/g, ' ').trim()} -> ${m[2]}` : '';
}

export function packPackage({ wd, root, scope = '@rederive', packagesDir }) {
  const meta = JSON.parse(readFileSync(join(wd, 'meta.json'), 'utf8'));
  const state = existsSync(join(root, 'state.json')) ? JSON.parse(readFileSync(join(root, 'state.json'), 'utf8')) : { packages: {} };
  const ps = state.packages[meta.name];
  if (!ps || ps.status !== 'verified') throw new Error(`refuse to pack ${meta.name}: status is ${ps?.status || 'unknown'} (only verified packages are packable)`);

  const unit = meta.unit;
  const verifiedSrc = join(wd, 'src', `${unit}.js`);
  const sirSrc = join(wd, meta.sir);
  if (!existsSync(verifiedSrc) || !existsSync(sirSrc)) throw new Error('missing verified src/ or sir/ in workdir');
  const sirText = readFileSync(sirSrc, 'utf8');
  const oracle = JSON.parse(readFileSync(join(wd, 'oracle.json'), 'utf8'));

  const pkgName = `${scope}/${meta.name}`;
  const dir = join(packagesDir, meta.name);
  // LINT: refuse a self-nested duplicate (packages/<name>/<name>/) — a publish-from-wrong-dir hazard: the inner
  // copy carries the SAME name@version and can silently ship a divergent artifact (QA finding, 3/219 occurrences).
  if (existsSync(join(dir, meta.name, 'package.json'))) {
    throw new Error(`refuse to pack ${meta.name}: self-nested duplicate at ${join(dir, meta.name)} — remove it first (publish-from-wrong-dir hazard)`);
  }
  for (const d of ['src', 'sir', 'oracles']) mkdirSync(join(dir, d), { recursive: true });

  const srcRel = `src/${unit}.js`, sirRel = `sir/${unit}.sir`, oracleRel = `oracles/${unit}.json`;
  copyFileSync(verifiedSrc, join(dir, srcRel));
  copyFileSync(sirSrc, join(dir, sirRel));
  // rdv check grades `oracle.heldout || oracle.vectors`; our stamp names the teaching slice `frozen`.
  const packedOracle = { mode: oracle.mode, exportName: oracle.exportName, unit, vectors: oracle.frozen ?? oracle.vectors ?? [], heldout: oracle.heldout ?? [], ...(oracle.observe ? { observe: oracle.observe } : {}) };
  writeFileSync(join(dir, oracleRel), JSON.stringify(packedOracle, null, 2) + '\n');
  // Barrel must match the unit's real export shape. `export *` surfaces NAMED exports; a `default` re-export is
  // valid ONLY when the reconstructed src ACTUALLY has a default export. Emitting `export { default }` for a
  // named-only unit (e.g. marshall, sign, valid, v4) throws at import — the index-barrel bug. Detect the default
  // export from the SRC itself (not via meta.exportName), so a unit with BOTH a default AND named exports — e.g.
  // chalk (default instance + named `Chalk`) — surfaces both. `export *` never re-exports `default`, so the
  // explicit `export { default }` line is what carries it when present.
  const verifiedSrcText = readFileSync(verifiedSrc, 'utf8');
  const hasDefaultExport = /(^|\n)\s*export\s+default\b/.test(verifiedSrcText) || /\bas\s+default\b/.test(verifiedSrcText);
  const idx = (hasDefaultExport ? `export { default } from './${unit}.js';\n` : '') + `export * from './${unit}.js';\n`;
  writeFileSync(join(dir, 'src', 'index.js'), idx);

  const repo = grab(sirText, /repo:\s*(\S+)/);
  const source = grab(sirText, /source:\s*(\S+)/);
  const license = meta.upstreamLicense || grab(sirText, /license:\s*(\S+)/) || 'MIT';
  // F5: the verified ENVELOPE — the input scope this unit is verified FOR. When the SIR declares an
  // `ENVELOPE:` line (a unit verified for a subset, e.g. "del's glob patterns", not a general drop-in),
  // carry it to the manifest + README so a consumer reusing the unit knows its bounds. Omitted if absent.
  // (Distinct from the multi-line internal `SCOPE` field, which classifies in/carried/out-of-contract behavior.)
  const envelope = grab(sirText, /(?:^|\n)\s*ENVELOPE:?\s+([^\n]+)/);
  const at = new Date().toISOString().slice(0, 10);

  writeFileSync(join(dir, 'README.md'), readme(pkgName, meta, ps, repo, envelope));
  writeFileSync(join(dir, 'LICENSE'), licenseText(meta));

  // carried data (constant tables shipped verbatim, hash-pinned, independent-authority-attested)
  let carriedData;
  const carriedPath = join(wd, 'sir', `${unit}.carried.json`);
  if (existsSync(carriedPath)) {
    const carried = JSON.parse(readFileSync(carriedPath, 'utf8'));
    const dataRel = carried.dataModule || `src/${unit}.data.js`;
    const dataSrc = join(wd, dataRel);
    if (!existsSync(dataSrc)) throw new Error(`carried.json present but data module missing: ${dataRel} — run \`factory extract\` first`);
    if (carried.authority?.independentlyVerified !== true && !carried.allowUnattested)
      throw new Error('refuse to pack: carried data not independently attested (extract gate refused it; opt in with --allow-unattested-data at extract time)');
    copyFileSync(dataSrc, join(dir, dataRel));
    carriedData = [{ file: dataRel, sha256: sha256(join(dir, dataRel)), source: carried.sourceProvenance || carried.sourceFile,
      authority: { kind: carried.authority?.kind, independentlyVerified: carried.authority?.independentlyVerified === true, assertions: carried.authority?.assertions || [] } }];
  }

  const manifest = {
    name: pkgName, version: '0.1.0', zeroDep: true, specVersion: specVersionFor({ carriedData, envelope, mode: packedOracle.mode }), // min SIR spec version whose features this bundle uses; rdv asserts it
    provenance: { source: `${meta.name}@${meta.version}`, sourceRepo: repo, sourceFile: source, license, decompiledBy: 'factory orchestrator — agent-driven SIR-hardening loop', capturedAt: at },
    units: [{
      name: unit, kind: grab(sirText, /^KIND\s+(\w+)/m) || 'FUNCTIONAL', sig: sigFromSir(sirText),
      sir: sirRel, sirSha256: sha256(join(dir, sirRel)),
      oracle: oracleRel, oracleSha256: sha256(join(dir, oracleRel)),
      src: srcRel, srcSha256: sha256(join(dir, srcRel)),
      verified: { mode: packedOracle.mode, vectors: packedOracle.vectors.length, heldout: packedOracle.heldout.length, quorum: ps.quorum, differential: ps.differential, at },
      ...(envelope ? { envelope } : {}),
      ...(carriedData ? { carriedData } : {}),
    }],
  };
  writeFileSync(join(dir, 'sir.manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  writeFileSync(join(dir, 'package.json'), JSON.stringify(packageJson(pkgName, meta, repo), null, 2) + '\n');
  const files = ['package.json', 'sir.manifest.json', srcRel, 'src/index.js', sirRel, oracleRel, 'README.md', 'LICENSE'];
  if (carriedData) files.splice(3, 0, carriedData[0].file);
  return { dir, pkgName, files };
}

function packageJson(pkgName, meta, repo) {
  return {
    name: pkgName, version: '0.1.0',
    description: `Re-derived ${meta.name}@${meta.version} — zero-dependency, behavior-locked to a held-out oracle. Ships its contract (SIR + oracle); verify or re-derive locally with the rdv CLI.`,
    keywords: [meta.name, 'rederive', 'verified', 'zero-dependency', 'supply-chain'],
    homepage: 'https://rederive.ai',
    repository: { type: 'git', url: 'git+https://github.com/rederive/rederive.git', directory: `packages/${meta.name}` },
    license: 'MIT', type: 'module', main: 'src/index.js', exports: { '.': './src/index.js' },
    files: ['src/', 'sir/', 'oracles/', 'sir.manifest.json', 'README.md', 'LICENSE'],
    engines: { node: '>=18' }, publishConfig: { access: 'public' }, dependencies: {},
    sir: 'sir.manifest.json',
    provenance: `see sir.manifest.json — re-derived from ${meta.name}@${meta.version}${repo ? ` (${repo})` : ''}`,
  };
}

function readme(pkgName, meta, ps, repo, envelope) {
  return `# ${pkgName}

Zero-dependency, verified re-derivation of \`${meta.name}@${meta.version}\`${repo ? ` (${repo})` : ''}.

**Trust nothing.** This package ships its **contract** — a SIR specification (\`sir/\`) and a held-out oracle
(\`oracles/\`) — not just bytes you have to trust. The \`src/\` implementation was reconstructed
**original-deleted** by independent blind workers and accepted only on quorum + a saturation differential
against the real package.

\`\`\`
npx rdv check .     # re-verify src/ against the held-out oracle + content hashes (no tokens)
\`\`\`

- **Verified:** quorum ${ps.quorum}, differential ${ps.differential} (coverage-audited held-out).${envelope ? `
- **Verified envelope:** ${envelope} — verified-equivalent to the original **within this input scope only**; not a general drop-in beyond it.` : ''}
- **Claim:** verified-equivalent to the original on a coverage-audited held-out set — testing, not proof.
- **Provenance & full contract:** \`sir.manifest.json\`.
`;
}

// A verified-recompose derivative is distributed under the ORIGINAL package's license, with the upstream
// copyright notice RETAINED unmodified (MIT/ISC/BSD all require this). We never re-label the license or drop
// the original author's copyright — the original LICENSE text is captured at install time and carried verbatim
// under a derivative notice. This replaces the old hardcoded "MIT / Copyright rederive" text that both stripped
// the upstream author and mislabeled non-MIT packages (e.g. WTFPL-licensed left-pad).
function licenseText(meta) {
  const src = `${meta.name}@${meta.upstreamVersion || meta.version}`;
  const header =
`This package is a VERIFIED-RECOMPOSE DERIVATIVE of ${src}, produced by rederive (https://rederive.ai) —
a clean-room reconstruction from a behavioral contract, not a copy of the original source. It is distributed
under the ORIGINAL package's license, whose full text and copyright notice are RETAINED BELOW, UNMODIFIED, as
that license requires. rederive asserts no rights over, and does not alter, the original author's copyright.

--------------------------------------------------------------------------------

`;
  if (meta.upstreamLicenseText && meta.upstreamLicenseText.trim()) {
    return header + meta.upstreamLicenseText.replace(/\r\n/g, '\n').trimEnd() + '\n';
  }
  // Fallback (should not occur once install-time capture runs): mark the gap loudly rather than fabricate a notice.
  return header +
`[The original license text for ${src} was not captured at build time. Refer to
${meta.upstreamRepo || 'the upstream repository'} for the authoritative ${meta.upstreamLicense || 'license'} text
and copyright notice. THIS PACKAGE MUST NOT BE PUBLISHED until the upstream license + copyright are retained here.]
`;
}
