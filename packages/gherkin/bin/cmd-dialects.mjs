#!/usr/bin/env node
// Assemble a components/ directory — the dialects the compiler needs — from
// whatever source is available, and check the two things that otherwise fail
// silently.
//
//   otb-gherkin dialects --installed      --out <dir>   from installed packages
//   otb-gherkin dialects --from <path>    --out <dir>   copy from a checkout
//   otb-gherkin dialects --from <url>     --out <dir>   fetch over http(s)
//   otb-gherkin dialects --out <dir>                    try the public defaults
//   otb-gherkin dialects --list <a,b>     --out <dir>   only these dialect ids
//
// `--installed` is the one to prefer once the dialects are on npm: it reads
// node_modules for packages carrying an `otbDialect` field, so the set is
// pinned by your lockfile, needs no network at build time and no containers.
//
// `--from` accepts either shape:
//   a components/ directory (or its parent) holding one folder per dialect
//   a single dialect folder holding component.yml
//
// No directory listing is needed anywhere: component.yml names its own steps
// file and its scriptlets, so the fetcher reads that first and then asks for
// exactly the files it names. That is what lets the same code path work
// against a local folder, a raw git host and a served /gherkin-dialect.
//
// Writes <out>/components/<id>/… and <out>/components/index.json, then points
// you at the ITB_ASSET_ROOT to use. Exit 0 if at least one dialect landed and
// none failed a check, 1 otherwise.

import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null; };

const FROM = flag('from');
const OUT = flag('out') ?? 'assets';
const ONLY = (flag('list') ?? '').split(',').map(s => s.trim()).filter(Boolean);
const INSTALLED = argv.includes('--installed');

// Public sources, tried in order when --from is omitted. Each is a base that
// contains one folder per dialect. A plugin repo's own dialect/ folder is a
// single dialect and is handled by --from.
const DEFAULT_SOURCES = [
  'https://raw.githubusercontent.com/OpenTestBed/itb-plugin-authoring/main/app/public/components',
];

// Dialect ids to look for when the source cannot be listed (any http source).
// index.json is tried first; this is the fallback.
const KNOWN = ['fhir-validator', 'hcert-decoder', 'smart-helper', 'tng-certificate', 'archimate', 'fhir-terminology'];

const isUrl = (s) => /^https?:/i.test(s);

async function readFrom(base, rel) {
  if (isUrl(base)) {
    try {
      const r = await fetch(`${base.replace(/\/+$/, '')}/${rel}`);
      return r.ok ? await r.text() : null;
    } catch { return null; }
  }
  try { return fs.readFileSync(path.join(base, rel), 'utf8'); } catch { return null; }
}

/** The ids a source offers: index.json if it has one, else a directory listing, else the known list. */
async function idsOf(base) {
  const idx = await readFrom(base, 'index.json');
  if (idx) {
    try {
      const parsed = JSON.parse(idx);
      if (Array.isArray(parsed?.components)) return parsed.components;
    } catch { /* fall through */ }
  }
  if (!isUrl(base)) {
    try {
      return fs.readdirSync(base, { withFileTypes: true })
        .filter(e => e.isDirectory() && fs.existsSync(path.join(base, e.name, 'component.yml')))
        .map(e => e.name);
    } catch { /* fall through */ }
  }
  return KNOWN;
}

/** Minimal reads from component.yml. Not a YAML parser: five specific keys.
 *
 *  A line scanner rather than regexes over the whole text. The regex form is
 *  where this went wrong once already: `\Z` is not a JavaScript construct, it
 *  is a literal Z, so a block at end-of-file never matched and every scriptlet
 *  was silently dropped. Indentation is unambiguous; use it. */
function peek(yamlText) {
  const lines = yamlText.split(/\r?\n/);
  const out = { id: null, steps: null, legacy: null, baseVersion: null, scriptlets: [] };
  const clean = (v) => v.replace(/#.*$/, '').trim().replace(/^["']|["']$/g, '');

  let section = null;                       // which top-level key we are inside
  for (const raw of lines) {
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue;
    const indented = /^[ \t]/.test(raw);

    if (!indented) {
      section = null;
      const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(raw);
      if (!m) continue;
      const [, key, rest] = m;
      const value = clean(rest);
      if (key === 'id') out.id = value || null;
      else if (key === 'language') {
        if (value) out.steps = value;       // legacy string form: `language: steps.yml`
        else section = 'language';          // block form
      } else if (key === 'scriptlets') {
        if (value.startsWith('[')) {
          out.scriptlets = value.replace(/^\[|\]$/g, '').split(',').map(s => clean(s)).filter(Boolean);
        } else section = 'scriptlets';
      }
      continue;
    }

    if (section === 'language') {
      const m = /^[ \t]+([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(raw);
      if (!m) continue;
      const value = clean(m[2]);
      if (m[1] === 'steps') out.steps = value || null;
      else if (m[1] === 'legacy') out.legacy = value || null;
      else if (m[1] === 'baseVersion') out.baseVersion = value || null;
    } else if (section === 'scriptlets') {
      const m = /^[ \t]+-\s*(.+)$/.exec(raw);
      if (m) out.scriptlets.push(clean(m[1]));
    }
  }
  return out;
}

/**
 * The keys a steps file must give a LIST, and what happens when it gives a
 * mapping instead. `kinds: [weather-service]` is right; writing it as
 *
 *   kinds:
 *     weather-service:
 *       name: Weather service
 *
 * parses as valid YAML and then throws "object is not iterable" out of the
 * middle of the compiler — no file, no line, no field name. Caught here, where
 * the file is in hand and can be named.
 *
 * Line-based on purpose: this script has no YAML dependency, and a scanner is
 * the right tool for "what shape is this key" anyway.
 */
const MUST_BE_LISTS = ['kinds', 'verbs', 'steps'];
function listShapeProblem(text) {
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z_][A-Za-z0-9_-]*):[ \t]*(.*)$/.exec(lines[i]);
    if (!m || !MUST_BE_LISTS.includes(m[1])) continue;
    if (m[2].trim() !== '') continue;            // inline, e.g. `kinds: [a, b]`
    // Look at the first thing nested under it.
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (l.trim() === '' || /^\s*#/.test(l)) continue;
      if (!/^\s/.test(l)) break;                 // next top-level key: empty, fine
      if (/^\s*-/.test(l)) break;                // a list item: correct
      const key = /^\s*([A-Za-z_][A-Za-z0-9_:.-]*):/.exec(l);
      if (key) {
        return `${m[1]}: is a mapping, but it must be a list — write "${m[1]}: [${key[1]}]" or "- ${key[1]}" items. `
             + `As a mapping it parses, then fails deep in the compiler as "object is not iterable" with no file or line.`;
      }
      break;
    }
  }
  return null;
}

async function grab(base, id, outComponents) {
  const prefix = id === null ? '' : id + '/';
  const comp = await readFrom(base, `${prefix}component.yml`);
  if (!comp) return null;
  const meta = peek(comp);
  const realId = meta.id ?? id;
  if (!realId) return { id: id ?? '?', error: 'component.yml has no id:' };
  if (id !== null && realId !== id) {
    // This one is fatal in use and invisible otherwise: the compiler keys
    // actor kinds, value types and @dialect: tags off the id, while the
    // folder name is what gets loaded.
    return { id: realId, error: `folder "${id}" does not match component.yml id "${realId}"` };
  }
  const dir = path.join(outComponents, realId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'component.yml'), comp, 'utf8');
  const wrote = ['component.yml'];

  for (const f of [meta.steps ?? 'steps.yml', meta.legacy].filter(Boolean)) {
    const body = await readFrom(base, `${prefix}${f}`);
    if (body) {
      const problem = listShapeProblem(body);
      if (problem) return { id: realId, error: `${f}: ${problem}` };
      fs.writeFileSync(path.join(dir, f), body, 'utf8');
      wrote.push(f);
    }
    else if (f === (meta.steps ?? 'steps.yml')) return { id: realId, error: `${f} is missing at the source` };
  }
  for (const s of meta.scriptlets) {
    const body = await readFrom(base, `${prefix}scriptlets/${s}`);
    if (body) {
      fs.mkdirSync(path.join(dir, 'scriptlets'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'scriptlets', s), body, 'utf8');
      wrote.push(`scriptlets/${s}`);
    } else {
      return { id: realId, error: `component.yml lists scriptlet ${s}, which is missing at the source` };
    }
  }
  return { id: realId, files: wrote, baseVersion: meta.baseVersion };
}

/** The core language's spec version, so a dialect that will be refused says so now. */
function coreSpecVersion() {
  try {
    const p = new URL('../lang/en.yml', import.meta.url);
    return /^specVersion:\s*["']?([^"'\n]+)/m.exec(fs.readFileSync(p, 'utf8'))?.[1]?.trim() ?? null;
  } catch { return null; }
}

function satisfies(version, range) {
  const pv = (v) => { const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(v).trim()); return m ? [+m[1], +(m[2] ?? 0), +(m[3] ?? 0)] : null; };
  const a = pv(version); if (!a || !range) return true;
  const cmp = (x, y) => { for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1; return 0; };
  for (const part of String(range).trim().split(/\s+/)) {
    const m = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/.exec(part); const b = pv(m[2]); if (!b) return false;
    const c = cmp(a, b); const op = m[1] || '=';
    const ok = op === '>=' ? c >= 0 : op === '<=' ? c <= 0 : op === '>' ? c > 0 : op === '<' ? c < 0
      : op === '^' ? c >= 0 && a[0] === b[0] : op === '~' ? c >= 0 && a[0] === b[0] && a[1] === b[1] : c === 0;
    if (!ok) return false;
  }
  return true;
}

const outComponents = path.resolve(OUT, 'components');
fs.mkdirSync(outComponents, { recursive: true });

/**
 * Dialect packages installed in node_modules.
 *
 * A package declares itself with an `otbDialect: { id }` field rather than by
 * a name prefix, so a dialect published under anyone's scope is found. The
 * package root is the dialect folder: `component.yml` sits directly in it.
 */
function installedDialects() {
  const roots = [];
  let dir = process.cwd();
  for (;;) {
    roots.push(path.join(dir, 'node_modules'));
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  const found = [];
  const seen = new Set();
  for (const root of roots) {
    let entries;
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    const dirs = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith('@')) {
        try {
          for (const s of fs.readdirSync(path.join(root, e.name), { withFileTypes: true })) {
            if (s.isDirectory()) dirs.push(path.join(root, e.name, s.name));
          }
        } catch { /* unreadable scope */ }
      } else dirs.push(path.join(root, e.name));
    }
    for (const d of dirs) {
      let pkg;
      try { pkg = JSON.parse(fs.readFileSync(path.join(d, 'package.json'), 'utf8')); } catch { continue; }
      const id = pkg?.otbDialect?.id;
      if (!id || seen.has(id)) continue;
      if (!fs.existsSync(path.join(d, 'component.yml'))) continue;
      seen.add(id);
      found.push({ id, dir: d, pkg: pkg.name, version: pkg.version });
    }
  }
  return found;
}

const got = [];
const failed = [];

if (INSTALLED) {
  const found = installedDialects().filter(f => ONLY.length === 0 || ONLY.includes(f.id));
  if (found.length === 0) {
    console.error('No installed dialect packages found.');
    console.error('  Install one, e.g. npm install @opentestbed/dialect-fhir-validator');
    console.error('  A dialect package declares itself with an "otbDialect": { "id": … } field.');
    process.exit(1);
  }
  for (const f of found) {
    const r = await grab(f.dir, null, outComponents);
    if (r?.error) failed.push(r);
    else if (r) got.push({ ...r, from: `${f.pkg}@${f.version}` });
  }
}

const sources = FROM ? [FROM] : (INSTALLED ? [] : DEFAULT_SOURCES);

for (const src of sources) {
  // A single dialect folder: component.yml sits directly in it.
  const single = !isUrl(src) && fs.existsSync(path.join(src, 'component.yml'));
  if (single) {
    const r = await grab(src, null, outComponents);
    if (r?.error) failed.push(r); else if (r) got.push(r);
    continue;
  }
  // Otherwise a components/ directory, or its parent.
  let base = src;
  if (!isUrl(src) && fs.existsSync(path.join(src, 'components'))) base = path.join(src, 'components');
  const ids = (await idsOf(base)).filter(id => ONLY.length === 0 || ONLY.includes(id));
  for (const id of ids) {
    if (got.some(g => g.id === id)) continue;
    const r = await grab(base, id, outComponents);
    if (r?.error) failed.push(r);
    else if (r) got.push(r);
    else if (ONLY.includes(id)) failed.push({ id, error: 'not available at this source' });
  }
}

if (got.length === 0) {
  console.error('No dialects obtained.');
  // The reasons are printed further down, which this early exit never reached:
  // someone whose only dialect was rejected got "No dialects obtained" and not
  // one word about why. Say it here, first, because it is the whole answer.
  for (const f of failed) console.error(`  FAIL ${f.id.padEnd(18)} ${f.error}`);
  console.error(FROM ? `  source: ${FROM}` : `  tried: ${DEFAULT_SOURCES.join(', ')}`);
  if (failed.length === 0) {
    console.error('  Point --from at a checkout: the workbench\'s app/public/components, or one plugin repo\'s dialect/ folder.');
  }
  process.exit(1);
}

// A dialect sitting in the output folder that this run did not fetch is almost
// always one the author wrote by hand — the supported way to have a dialect of
// your own without publishing anything. Listing only what was fetched would
// unlist it, and the failure then surfaces as "No mapping for step" against the
// FEATURE FILE, which points at the wrong thing entirely. So keep it, and say
// so, because a silently preserved file is nearly as confusing as a lost one.
const fetched = new Set(got.map(g => g.id));
let kept = [];
try {
  kept = fs.readdirSync(outComponents, { withFileTypes: true })
    .filter(e => e.isDirectory() && !fetched.has(e.name)
      && fs.existsSync(path.join(outComponents, e.name, 'component.yml')))
    .map(e => e.name);
} catch { /* first run — nothing to keep */ }

fs.writeFileSync(path.join(outComponents, 'index.json'),
  JSON.stringify({ components: [...fetched, ...kept].sort() }, null, 2) + '\n', 'utf8');

const core = coreSpecVersion();
for (const g of got) {
  const bad = core && g.baseVersion && !satisfies(core, g.baseVersion);
  console.log(`  ${bad ? 'WARN' : 'ok  '} ${g.id.padEnd(18)} ${g.files.length} file${g.files.length === 1 ? '' : 's'}${g.from ? `  ${g.from}` : ''}${bad ? `  — wants core ${g.baseVersion}, installed core is ${core}: this dialect will be REFUSED at load and every one of its steps will report "No mapping for step"` : ''}`);
}
for (const k of kept) console.log(`  kept ${k.padEnd(18)} already in ${path.join(OUT, 'components')}, not from this source`);
for (const f of failed) console.log(`  FAIL ${f.id.padEnd(18)} ${f.error}`);

console.log(`\n${got.length} dialect${got.length === 1 ? '' : 's'} in ${outComponents}${kept.length ? ` (+${kept.length} kept)` : ''}`);
console.log(`Use it with:  ITB_ASSET_ROOT=${path.resolve(OUT)}`);
process.exit(failed.length ? 1 : 0);
