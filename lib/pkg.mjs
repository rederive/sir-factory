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
export function loadRealExport(installDir, name, exportName) {
  const req = createRequire(join(installDir, '__resolve.js'));
  const mod = req(name);
  const pick = (m) => (exportName ? m?.[exportName] : m);
  let fn = pick(mod);
  if (typeof fn !== 'function' && mod && mod.default != null) fn = pick(mod.default) ?? mod.default;
  if (typeof fn !== 'function' && typeof mod === 'function') fn = mod;
  return fn;
}

export function cleanup(dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
