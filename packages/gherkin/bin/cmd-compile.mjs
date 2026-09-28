#!/usr/bin/env node
// Compile Gherkin feature files to GITB TDL, report every diagnostic, and
// optionally write the suite and a deployable zip.
//
//   otb-gherkin compile <file-or-dir> [...]      check only
//   otb-gherkin compile <file> --out <dir>       also write the TDL files
//   otb-gherkin compile <file> --out <dir> --zip suite.zip
//   otb-gherkin compile <file> --json            machine-readable diagnostics
//
// Exit code is 0 when every file compiled with no errors, 1 otherwise, so it
// works as a gate. Warnings never fail the run but are always printed.
//
// Depends only on the published package `@opentestbed/otb-gherkin`, so it runs
// anywhere that package installs. It deliberately does NOT need the itb-cli
// repository. The zip writer is stored-only (no compression) so there is no
// dependency for that either.
//
// ITB_ASSET_ROOT must point at a directory containing `components/` — the
// dialects. Build one with `otb-gherkin dialects`.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { GherkinParser, XMLGenerator, setCatalogSource, parseITBHeader, scriptletSearchPaths } from '../dist/index.js';
import { createNodeSource } from '../dist/node.js';

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
};
const has = (name) => argv.includes('--' + name);
const targets = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--') && flag(argv[i - 1].slice(2)) === a));

const ROOT = process.env.ITB_ASSET_ROOT;
const OUT = flag('out');
const ZIP = flag('zip');
const JSON_OUT = has('json');

if (!ROOT) {
  die([
    'ITB_ASSET_ROOT is not set. It must point at a directory containing components/ (the dialects).',
    '  Build one with:  otb-gherkin dialects --installed --out assets',
    '  Then:            ITB_ASSET_ROOT=./assets otb-gherkin compile <file>',
  ].join('\n'));
}
if (!fs.existsSync(path.join(ROOT, 'components'))) {
  die([
    `No components/ under ITB_ASSET_ROOT (${ROOT}).`,
    `  Build one with:  otb-gherkin dialects --installed --out ${ROOT}`,
  ].join('\n'));
}
if (targets.length === 0) die('Usage: otb-gherkin compile <file-or-dir> [...] [--out <dir>] [--zip <name>] [--json]');

function die(msg) { console.error(msg); process.exit(2); }

// The core language comes from the package unless the asset root ships its own.
const pkgLang = new URL('../lang/', import.meta.url);
const assets = {};
for (const f of ['en.yml', 'en-1.yml']) {
  if (!fs.existsSync(path.join(ROOT, 'lang', f))) {
    assets[`lang/${f}`] = fs.readFileSync(new URL(f, pkgLang), 'utf8');
  }
}
// …and so do the scriptlets the core language itself calls. Without these,
// a core step such as `posts … N times, paced manually` fails to compile with
// "Scriptlet not found" for anyone who has no copy beside their features.
try {
  const dir = fileURLToPath(new URL('scriptlets/', pkgLang));
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.xml')) continue;
    const key = `lang/scriptlets/${f}`;
    if (!fs.existsSync(path.join(ROOT, key))) {
      assets[key] = fs.readFileSync(path.join(dir, f), 'utf8');
    }
  }
} catch { /* an older package ships none; the step-level diagnostic still applies */ }
setCatalogSource(createNodeSource(ROOT, { assets }));

/** scriptlets/<id>.xml beside the feature, plus any `# itb:` header locations. */
function externalScriptlets(featurePath, text) {
  const dir = path.dirname(featurePath);
  const { header } = parseITBHeader(text);
  const found = new Map();
  for (const loc of scriptletSearchPaths(header)) {
    if (/^https?:/i.test(loc)) continue;
    const d = path.isAbsolute(loc) ? loc : path.resolve(dir, loc);
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

function expand(t) {
  if (!fs.existsSync(t)) die(`No such file or directory: ${t}`);
  if (!fs.statSync(t).isDirectory()) return [t];
  return fs.readdirSync(t).filter(f => f.endsWith('.feature')).sort().map(f => path.join(t, f));
}

const files = targets.flatMap(expand);
const report = [];
let failed = 0;
let lastOut = null;

for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  const entry = { file, errors: [], warnings: [], testCases: [] };
  try {
    const parser = new GherkinParser(undefined, { strictRequirements: false });
    const parsed = parser.parse(text);
    await parser.expandScenarioToIR(parsed);
    const gen = new XMLGenerator(parser);
    gen.setExternalScriptlets(externalScriptlets(file, text));
    const out = gen.generate(parsed);
    lastOut = out;
    for (const i of [...(parsed.errors ?? []), ...(out.issues ?? [])]) {
      (i.severity === 'warning' ? entry.warnings : entry.errors).push(i);
    }
    entry.testCases = out.files.filter(f => f.type === 'testcase').map(f => f.id);
    entry.suite = out.files.find(f => f.type === 'testsuite')?.id ?? null;
    if (entry.errors.length === 0 && OUT) writeSuite(out, OUT);
  } catch (e) {
    // A malformed step pattern in ANY loaded dialect throws here rather than
    // producing a diagnostic, and it takes every feature down with it.
    entry.errors.push({ severity: 'error', message: `compiler threw: ${e.message}`, from: 'catalog' });
  }
  if (entry.errors.length) failed++;
  report.push(entry);
}

function writeSuite(out, dir) {
  for (const f of out.files) {
    const p = path.join(dir, f.filename);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, f.xml, 'utf8');
  }
}

// ── a stored-entry zip, so packaging needs no dependency ─────────────
function zipOf(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const dosTime = () => { const d = new Date(); return [
    ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff,
    (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff]; };
  const [time, date] = dosTime();
  for (const [name, content] of entries) {
    const data = Buffer.from(content, 'utf8');
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = zlib.crc32 ? zlib.crc32(data) : crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8); local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, data);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8); cd.writeUInt16LE(0, 10); cd.writeUInt16LE(time, 12); cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28); cd.writeUInt16LE(0, 30); cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34); cd.writeUInt16LE(0, 36); cd.writeUInt32LE(0, 38); cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdBuf.length, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, cdBuf, end]);
}

let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c; }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

if (ZIP && failed === 0 && lastOut) {
  const target = OUT ? path.join(OUT, ZIP) : ZIP;
  fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
  fs.writeFileSync(target, zipOf(lastOut.files.map(f => [f.filename, f.xml])));
  if (!JSON_OUT) console.log(`zip: ${target}`);
}

if (JSON_OUT) {
  console.log(JSON.stringify({ ok: failed === 0, files: report }, null, 2));
} else {
  for (const e of report) {
    const name = path.basename(e.file);
    console.log(`${String(e.errors.length).padStart(3)} ${name}${e.warnings.length ? `  (${e.warnings.length} warning${e.warnings.length === 1 ? '' : 's'})` : ''}${e.testCases.length ? `  [${e.testCases.length} test case${e.testCases.length === 1 ? '' : 's'}]` : ''}`);
    // Every diagnostic, not the first few: a truncated list is how a real
    // cause hides behind a symptom.
    for (const i of e.errors) console.log(`      ERROR ${i.line ? 'L' + i.line : '     '} ${i.message}`);
    for (const i of e.warnings) console.log(`      warn  ${i.line ? 'L' + i.line : '     '} ${i.message}`);
  }
  console.log(`\nclean: ${report.length - failed}, with errors: ${failed}`);
}
process.exit(failed ? 1 : 0);
