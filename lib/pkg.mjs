// Install the ORIGINAL package into an isolated dir and load its real export (the node-1 oracle).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

export function installPackage(name, version) {
  const installDir = mkdtempSync(join(tmpdir(), `rdv-orig-${name.replace(/[^\w]/g, '_')}-`));
  execFileSync('npm', ['init', '-y'], { cwd: installDir, stdio: 'ignore' });
  execFileSync('npm', ['i', `${name}@${version}`, '--no-audit', '--no-fund', '--loglevel=error'],
    { cwd: installDir, stdio: 'ignore' });
  const pkgDir = join(installDir, 'node_modules', name);
  const realVersion = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).version;
  return { installDir, pkgDir, version: realVersion };
}

// Resolve the function to call on the real package. exportName=null -> the default/main export.
// `seam` (optional, declared in the SIR as `SEAM index|builder`) adapts a NON-callable export into the
// genuine callable observable the oracle/grader drives. Each seam contains ZERO domain knowledge — it only
// navigates + invokes the REAL package, so it can only ever return the real package's own outputs and cannot
// rescue a wrong reconstruction. A non-callable export with NO declared seam still quarantines (the default).
//   'index'   -> the real export is a PURE DATA OBJECT whose observable contract is property access (e.g.
//                cli-boxes: a consumer does `cliBoxes[styleName]`). Expose it as `k => obj[k]`.
//   'builder' -> the real export is a CONSTRUCTOR whose contract is "construct, walk a property/call chain,
//                then invoke" (e.g. chalk: `new Chalk({level}).red.bold('x')`, `.hex('#f0f')('x')`). Expose
//                the genuine method-call observable as a positional adapter `(opts, chain, input) => value`,
//                where a STRING step is a property access and an ARRAY step `[name, ...args]` is access-then-call.
//                The reconstruction must export a function of the SAME positional signature (the SIR's SIG pins it).
export function loadRealExport(installDir, name, exportName, seam) {
  const req = createRequire(join(installDir, '__resolve.js'));
  const mod = req(name);
  const pick = (m) => (exportName ? m?.[exportName] : m);
  let fn = pick(mod);
  if (typeof fn !== 'function' && mod && mod.default != null) fn = pick(mod.default) ?? mod.default;
  if (typeof fn !== 'function' && typeof mod === 'function') fn = mod;
  if (typeof fn !== 'function' && seam === 'index' && fn && typeof fn === 'object') {
    const obj = fn;
    return (k) => obj[k];
  }
  if (typeof fn === 'function' && seam === 'builder') {
    const Ctor = fn;
    return (opts, chain, input) => {
      let cur = new Ctor(opts);
      for (const step of (chain || [])) cur = Array.isArray(step) ? cur[step[0]](...step.slice(1)) : cur[step];
      return cur(input);
    };
  }
  return fn;
}

export function cleanup(dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
