// Syncs plugin-provided dialects into the test-workbench component folder, so
// the (unchanged) language parser can load them.
//
// Direction of truth: <plugin-repo>/dialect/  ==canonical==>  test-workbench/public/components/<id>/
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
  .filter(e => e.isDirectory()).map(e => e.name);
fs.writeFileSync(path.join(componentsDir, 'index.json'),
  JSON.stringify({ components: existing.sort() }, null, 2) + '\n');
console.log(`index.json: [${existing.sort().join(', ')}]`);
