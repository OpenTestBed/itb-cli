// Syncs plugin-provided dialects into the apps that compile features, so the
// (unchanged) language parser can load them.
//
// Direction of truth: <plugin-repo>/dialect/  ==canonical==>  test-workbench/public/components/<id>/
//
// The workbench's components/ is then the assembled set — plugin dialects plus
// the ones that have no plugin of their own (fhir-terminology, archimate) — and
// it is mirrored into every other app that compiles: the ITB manager has its own
// public/components, and a dialect missing there fails as "No mapping for step"
// in that app alone, which is a confusing way to find out.
//
// Each plugin's itb-plugin.yaml declares `dialect: { path, namespace }`; the
// dialect folder holds the parser-format files (component.yml, steps.yml,
// scriptlets/). This script copies them over and refreshes components/index.json.
//
// Usage: node src/sync-dialects.mjs [pluginDir ...]   (default: the sibling
//        itb-plugin-* folders of the itb-ecosystem checkout)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
/**
 * Locate the workbench. Unlike the hunts this repo used to run, this one is
 * legitimate: sync-dialects WRITES into the app's public/components, so it
 * genuinely has to find that folder. It no longer looks for parser SOURCE —
 * the marker is the components directory it is about to write to.
 */
function findWorkbench(fromDir) {
  const candidates = [
    process.env.ITB_WORKBENCH_PATH,
    path.resolve(fromDir, '../itb-plugin-authoring/app'),
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(path.join(c, 'public', 'components'))) return c;
  throw new Error('workbench not found — expected itb-plugin-authoring/app beside this repo, or set ITB_WORKBENCH_PATH');
}
const WB = findWorkbench(ROOT);

const pluginDirs = process.argv.slice(2).length
  ? process.argv.slice(2).map(p => path.resolve(p))
  : fs.readdirSync(path.resolve(ROOT, '..'))
      .filter(d => d.startsWith('itb-plugin-'))
      .map(d => path.resolve(ROOT, '..', d));

const componentsDir = path.join(WB, 'public', 'components');
const synced = [];

for (const dir of pluginDirs) {
  const manifestPath = path.join(dir, 'itb-plugin.yaml');
  if (!fs.existsSync(manifestPath)) continue;
  const manifest = yaml.load(fs.readFileSync(manifestPath, 'utf8'));
  const dialect = manifest.dialect;
  if (!dialect) { console.log(`- ${manifest.name}: no dialect declared, skipping`); continue; }
  const src = path.join(dir, typeof dialect.path === 'string' ? dialect.path.replace(/steps\.yml$/, '') : 'dialect/');
  if (!fs.existsSync(path.join(src, 'steps.yml'))) {
    console.warn(`! ${manifest.name}: dialect declared but ${src}/steps.yml missing`); continue;
  }
  const dest = path.join(componentsDir, manifest.name);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true });
  synced.push(manifest.name);
  console.log(`+ ${manifest.name}: dialect -> ${path.relative(WB, dest)}`);
}

// refresh index.json (keep components that exist but weren't synced this run)
const existing = fs.readdirSync(componentsDir, { withFileTypes: true })
  .filter(e => e.isDirectory()).map(e => e.name).sort();
fs.writeFileSync(path.join(componentsDir, 'index.json'),
  JSON.stringify({ components: existing }, null, 2) + '\n');
console.log(`index.json: [${existing.join(', ')}]`);

/**
 * Mirror the assembled set into the other apps that compile features. Each one
 * is a checkout beside this repo with its own public/components; an app that
 * is not checked out is skipped, not an error.
 */
const mirrors = (process.env.ITB_DIALECT_MIRRORS
  ? process.env.ITB_DIALECT_MIRRORS.split(path.delimiter)
  : [path.resolve(ROOT, '..', 'itb-manager')])
  .map(p => path.resolve(p))
  .filter(p => p !== WB && fs.existsSync(path.join(p, 'public', 'components')));

for (const app of mirrors) {
  const dest = path.join(app, 'public', 'components');
  for (const name of existing) {
    const to = path.join(dest, name);
    fs.rmSync(to, { recursive: true, force: true });
    fs.cpSync(path.join(componentsDir, name), to, { recursive: true });
  }
  // Components the mirror holds and the workbench does not are left in place,
  // but they still belong in its index.
  const all = fs.readdirSync(dest, { withFileTypes: true })
    .filter(e => e.isDirectory()).map(e => e.name).sort();
  fs.writeFileSync(path.join(dest, 'index.json'), JSON.stringify({ components: all }, null, 2) + '\n');
  console.log(`mirrored ${existing.length} dialect(s) -> ${path.relative(path.resolve(ROOT, '..'), dest)} [${all.join(', ')}]`);
}
