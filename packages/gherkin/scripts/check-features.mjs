#!/usr/bin/env node
// Compile every feature under a folder and report the errors per file.
//
//   node scripts/check-features.mjs <asset-root> <features-dir> [--verbose] [--xml <feature-name>]
//
// <asset-root> holds components/ (and optionally lang/); the language itself
// comes from this package when the root has none. Exit code is the number of
// files with errors, capped at 1, so it doubles as a CI gate.

import fs from 'node:fs';
import path from 'node:path';
import { GherkinParser, XMLGenerator, setCatalogSource, parseITBHeader, scriptletSearchPaths } from '../dist/index.js';
import { createNodeSource } from '../dist/node.js';

const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const xmlFor = args.includes('--xml') ? args[args.indexOf('--xml') + 1] : null;
const [root, dir] = args.filter(a => !a.startsWith('--') && a !== xmlFor);

const assets = {};
for (const f of ['en.yml', 'en-1.yml']) {
  if (!fs.existsSync(path.join(root, 'lang', f))) {
    assets[`lang/${f}`] = fs.readFileSync(new URL(`../lang/${f}`, import.meta.url), 'utf8');
  }
}
setCatalogSource(createNodeSource(root, { assets }));

/** scriptlets/<id>.xml beside the features, plus `# itb:` header locations. */
function loadExternalScriptlets(featurePath, text) {
  const featureDir = path.dirname(featurePath);
  const { header } = parseITBHeader(text);
  const found = new Map();
  for (const loc of scriptletSearchPaths(header)) {
    if (/^https?:/i.test(loc)) continue;
    const d = path.isAbsolute(loc) ? loc : path.resolve(featureDir, loc);
    let entries;
    try { entries = fs.readdirSync(d); } catch { continue; }
    for (const name of entries) {
      if (!name.endsWith('.xml')) continue;
      const key = `scriptlets/${name}`;
      if (!found.has(key)) found.set(key, fs.readFileSync(path.join(d, name), 'utf8'));
    }
  }
  return found;
}

let bad = 0, clean = 0;
const files = fs.statSync(dir).isDirectory()
  ? fs.readdirSync(dir).filter(x => x.endsWith('.feature')).sort().map(f => path.join(dir, f))
  : [dir];
for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  const parser = new GherkinParser(undefined, { strictRequirements: false });
  const parsed = parser.parse(text);
  await parser.expandScenarioToIR(parsed);
  const gen = new XMLGenerator(parser);
  gen.setExternalScriptlets(loadExternalScriptlets(file, text));
  const out = gen.generate(parsed);
  const errs = [...(parsed.errors ?? []), ...(out.issues ?? [])].filter(e => (e.severity ?? 'error') === 'error');
  const warns = (parsed.errors ?? []).filter(e => e.severity === 'warning');
  if (errs.length) bad++; else clean++;
  const name = path.basename(file);
  console.log(`${String(errs.length).padStart(3)} ${name}${warns.length ? `  (${warns.length} warning${warns.length === 1 ? '' : 's'})` : ''}`);
  const shown = verbose ? [...errs, ...warns] : errs.slice(0, 3);
  for (const e of shown) console.log(`      ${e.severity === 'warning' ? 'warn ' : 'ERROR'} L${e.line ?? '?'}: ${e.message}`);
  if (xmlFor && name.startsWith(xmlFor)) {
    console.log(out.files.filter(f => f.type === 'testcase').map(f => f.xml).join('\n'));
  }
}
console.log(`\nclean: ${clean}, with errors: ${bad}`);
process.exit(bad ? 1 : 0);
