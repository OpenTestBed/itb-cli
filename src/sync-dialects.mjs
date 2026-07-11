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
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
function findWorkbench(fromDir) {
  const candidates = [
    process.env.ITB_WORKBENCH_PATH,
    path.resolve(fromDir, '../itb-plugin-authoring/app'), // in-ecosystem authoring plugin (canonical)
    path.resolve(fromDir, '../../test-workbench'),   // legacy sibling checkout
    path.resolve(fromDir, '../test-workbench'),      // flat clone layout
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(path.join(c, 'src/parser/gherkinParser.ts'))) return c;
  throw new Error('workbench sources not found — expected itb-plugin-authoring/app next to itb-cli, or set ITB_WORKBENCH_PATH');
}
const WB = findWorkbench(ROOT);
const DEPS = fs.existsSync(path.join(WB, 'node_modules', 'js-yaml')) ? WB : path.resolve(ROOT, 'vendor');
const yaml = createRequire(path.join(DEPS, 'package.json'))('js-yaml');

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
