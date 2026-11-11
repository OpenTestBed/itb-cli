#!/usr/bin/env node
// Which dialects apply to what you are testing?
//
//   otb-gherkin applies [--spec <id>]... [<sample file>...] [--json]
//
// Reads every dialect under $ITB_ASSET_ROOT/components (build it with
// `otb-gherkin dialects`) and evaluates its component.yml `appliesWhen:`
// against the facts you give: the specification identifiers (a canonical URL,
// an IG package id, a CELEX number — repeat --spec) and sample documents.
// Each dialect is reported as applies / does not apply / declares nothing,
// with the reason, and the dialects it `requires:`.
//
// Advice, not a gate: exit 0 unless a manifest's appliesWhen is malformed
// (exit 1) or the inputs are missing (exit 2). A dialect that declares no
// appliesWhen is listed as such, never guessed.

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { dialectApplies, describeDocument, dialectDependencies } from '../dist/index.js';

const argv = process.argv.slice(2);
const specs = [];
const files = [];
let json = false;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--spec' && argv[i + 1]) specs.push(argv[++i]);
  else if (argv[i] === '--json') json = true;
  else if (!argv[i].startsWith('--')) files.push(argv[i]);
}

const ROOT = process.env.ITB_ASSET_ROOT;
const die = (m) => { console.error(m); process.exit(2); };
if (!ROOT || !fs.existsSync(path.join(ROOT, 'components'))) {
  die('ITB_ASSET_ROOT must point at a directory containing components/. Build one with: otb-gherkin dialects --out assets');
}
if (specs.length === 0 && files.length === 0) die('Usage: otb-gherkin applies [--spec <id>]... [<sample file>...] [--json]');

const documents = files.map(f => {
  if (!fs.existsSync(f) || !fs.statSync(f).isFile()) die(`Not a file: ${f} — give sample documents one by one`);
  return describeDocument(path.basename(f), fs.readFileSync(f, 'utf8'));
});
const facts = { specifications: specs, documents };

const dir = path.join(ROOT, 'components');
const ids = fs.readdirSync(dir, { withFileTypes: true })
  .filter(e => e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'component.yml')))
  .map(e => e.name).sort();

const rows = [];
let malformed = 0;
for (const id of ids) {
  const manifest = yaml.load(fs.readFileSync(path.join(dir, id, 'component.yml'), 'utf8')) ?? {};
  const requires = dialectDependencies(manifest).map(d => d.id + (d.range ? '@' + d.range : ''));
  try {
    const r = dialectApplies(manifest, facts);
    rows.push({ id, verdict: r === undefined ? 'undeclared' : r.applies ? 'applies' : 'does-not-apply', why: r?.why ?? 'no appliesWhen in component.yml', requires });
  } catch (e) {
    malformed++;
    rows.push({ id, verdict: 'error', why: e.message, requires });
  }
}

if (json) {
  console.log(JSON.stringify({ facts: { specifications: specs, documents: documents.map(d => ({ name: d.name, mediaType: d.mediaType })) }, dialects: rows }, null, 2));
} else {
  for (const d of documents) console.log(`  document  ${d.name}: ${d.mediaType}`);
  for (const s of specs) console.log(`  spec      ${s}`);
  console.log('');
  const mark = { applies: 'APPLIES', 'does-not-apply': 'no     ', undeclared: '?      ', error: 'ERROR  ' };
  for (const r of rows) {
    console.log(`  ${mark[r.verdict]} ${r.id.padEnd(20)} ${r.why}`);
    if (r.verdict === 'applies' && r.requires.length) console.log(`          ${''.padEnd(20)} with ${r.requires.join(', ')} (requires)`);
  }
  // One tag per dialect; a range from a `requires:` wins over a bare id.
  const tags = new Map();
  const add = (ref) => {
    const at = ref.lastIndexOf('@');
    const id = at > 0 ? ref.slice(0, at) : ref;
    if (!tags.has(id) || at > 0) tags.set(id, ref);
  };
  for (const r of rows.filter(r => r.verdict === 'applies')) {
    add(r.id);
    r.requires.forEach(add);
  }
  if (tags.size) console.log(`\nTag a feature with:  @lang:itb-core-en@^2 ${[...tags.values()].map(t => '@dialect:' + t).join(' ')}`);
}
process.exit(malformed ? 1 : 0);
