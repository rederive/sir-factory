// Assemble a VERIFIED workdir into a publishable @rederive/* package — the canonical rederive layout that
// `rdv check` verifies and `npm publish` ships. Refuses anything not in `verified` state.
import { mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';

const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const grab = (text, re) => (text.match(re)?.[1] ?? '').trim();

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
  for (const d of ['src', 'sir', 'oracles']) mkdirSync(join(dir, d), { recursive: true });

  const srcRel = `src/${unit}.js`, sirRel = `sir/${unit}.sir`, oracleRel = `oracles/${unit}.json`;
  copyFileSync(verifiedSrc, join(dir, srcRel));
  copyFileSync(sirSrc, join(dir, sirRel));
  // rdv check grades `oracle.heldout || oracle.vectors`; our stamp names the teaching slice `frozen`.
  const packedOracle = { mode: oracle.mode, exportName: oracle.exportName, unit, vectors: oracle.frozen ?? oracle.vectors ?? [], heldout: oracle.heldout ?? [], ...(oracle.observe ? { observe: oracle.observe } : {}) };
  writeFileSync(join(dir, oracleRel), JSON.stringify(packedOracle, null, 2) + '\n');
  // Barrel must match the unit's real export shape. `export *` surfaces NAMED exports; a `default` re-export is
  // valid ONLY for a default-export package (meta.exportName == null). Emitting `export { default }` for a
  // named-only unit (e.g. marshall, sign, valid, v4) throws at import — the index-barrel bug. Gate it.
  const idx = meta.exportName
    ? `export * from './${unit}.js';\n`
    : `export { default } from './${unit}.js';\nexport * from './${unit}.js';\n`;
  writeFileSync(join(dir, 'src', 'index.js'), idx);

  const repo = grab(sirText, /repo:\s*(\S+)/);
  const source = grab(sirText, /source:\s*(\S+)/);
  const license = grab(sirText, /license:\s*(\S+)/) || 'MIT';
  const at = new Date().toISOString().slice(0, 10);

  writeFileSync(join(dir, 'README.md'), readme(pkgName, meta, ps, repo));
  writeFileSync(join(dir, 'LICENSE'), mit(meta));

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
    name: pkgName, version: '0.1.0', zeroDep: true, specVersion: '0.2', // SIR Schema version this bundle targets; rdv asserts it
    provenance: { source: `${meta.name}@${meta.version}`, sourceRepo: repo, sourceFile: source, license, decompiledBy: 'factory orchestrator — agent-driven SIR-hardening loop', capturedAt: at },
    units: [{
      name: unit, kind: grab(sirText, /^KIND\s+(\w+)/m) || 'FUNCTIONAL', sig: sigFromSir(sirText),
      sir: sirRel, sirSha256: sha256(join(dir, sirRel)),
      oracle: oracleRel, oracleSha256: sha256(join(dir, oracleRel)),
      src: srcRel, srcSha256: sha256(join(dir, srcRel)),
      verified: { mode: packedOracle.mode, vectors: packedOracle.vectors.length, heldout: packedOracle.heldout.length, quorum: ps.quorum, differential: ps.differential, at },
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

function readme(pkgName, meta, ps, repo) {
  return `# ${pkgName}

Zero-dependency, verified re-derivation of \`${meta.name}@${meta.version}\`${repo ? ` (${repo})` : ''}.

**Trust nothing.** This package ships its **contract** — a SIR specification (\`sir/\`) and a held-out oracle
(\`oracles/\`) — not just bytes you have to trust. The \`src/\` implementation was reconstructed
**original-deleted** by independent blind workers and accepted only on quorum + a saturation differential
against the real package.

\`\`\`
npx rdv check .     # re-verify src/ against the held-out oracle + content hashes (no tokens)
\`\`\`

- **Verified:** quorum ${ps.quorum}, differential ${ps.differential} (coverage-audited held-out).
- **Claim:** verified-equivalent to the original on a coverage-audited held-out set — testing, not proof.
- **Provenance & full contract:** \`sir.manifest.json\`.
`;
}

function mit(meta) {
  return `MIT License

Copyright (c) ${new Date().getFullYear()} rederive
Re-derived from ${meta.name} (originally licensed MIT by its authors).

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;
}
