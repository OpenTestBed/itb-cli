// Gherkin -> ITB test suite compiler (Node). Wraps the test-workbench pipeline:
// ensureCatalog -> parse -> expandScenarioToIR -> XMLGenerator.generate.
// The workbench loads its step catalog + component dialects over fetch();
// here fetch is shimmed onto the workbench's public/ folder.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

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
  return null; // standalone mode: vendored assets in vendor/ (see below)
}
export const WB = findWorkbench(ROOT);
// Asset root: prefer the workbench sources; dependency root: the workbench
// only if it has node_modules (the plugin's app/ ships without them),
// else the vendored copies committed in this repo.
export const PUB = WB ? path.join(WB, 'public') : path.join(ROOT, 'vendor/public');
const DEPS = (WB && fs.existsSync(path.join(WB, 'node_modules', 'jszip'))) ? WB : path.join(ROOT, 'vendor');
const req = createRequire(path.join(ROOT, 'package.json'));

process.env.WB_BASE_URL = '/';

// Browser localStorage shim: component dialects enabled unless ITB_COMPONENTS
// env narrows them (comma-separated ids).
const enabledIds = (process.env.ITB_COMPONENTS ?? '').split(',').map(s=>s.trim()).filter(Boolean);
globalThis.localStorage = {
  getItem: (k) => {
    const m = /^component:(.+):enabled$/.exec(k);
    if (m) return (enabledIds.length === 0 || enabledIds.includes(m[1])) ? 'true' : 'false';
    return null;
  },
  setItem: () => {}, removeItem: () => {},
};


// fetch shim: '/lang/en.yml', '/components/...' -> test-workbench/public/*
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.startsWith('/') || u.startsWith('file:')) {
    const rel = u.startsWith('file:') ? fileURLToPath(u) : path.join(PUB, u);
    try {
      const text = fs.readFileSync(rel, 'utf8');
      return { ok: true, status: 200, text: async () => text, json: async () => JSON.parse(text) };
    } catch {
      return { ok: false, status: 404, text: async () => '', json: async () => ({}) };
    }
  }
  return realFetch(url, opts);
};

const { GherkinParser } = req('./dist/wb/parser/gherkinParser.cjs');
const { XMLGenerator } = req('./dist/wb/parser/xmlGenerator.cjs');
const { parseITBHeader, scriptletSearchPaths } = req('./dist/wb/parser/itbHeader.cjs');

/**
 * Load scriptlets from the file source, keyed as the generator expects
 * (`scriptlets/<id>.xml`). The browser app does this over fetch(); on Node we
 * read the directories directly.
 *
 * Search order is scriptletSearchPaths(): the `# itb:` header locations first,
 * then the `scriptlets/` convention dir beside the feature — first hit wins,
 * so a declared location overrides the default. Each entry is a directory
 * that DIRECTLY contains `<id>.xml`.
 *
 * Remote (http/https) locations are skipped here: resolving them would make
 * compile a network operation, and compile is meant to be local and instant.
 */
function loadExternalScriptlets(featurePath, text) {
  const featureDir = path.dirname(featurePath);
  const { header } = parseITBHeader(text);
  const found = new Map();
  for (const loc of scriptletSearchPaths(header)) {
    if (/^https?:/i.test(loc)) continue;
    const dir = path.isAbsolute(loc) ? loc : path.resolve(featureDir, loc);
    let entries;
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const name of entries) {
      if (!name.endsWith('.xml')) continue;
      const key = `scriptlets/${name}`;
      if (found.has(key)) continue; // earlier location wins
      try { found.set(key, fs.readFileSync(path.join(dir, name), 'utf8')); } catch { /* skip */ }
    }
  }
  return found;
}

/** Compile a .feature file. Returns { files: [{filename, xml, type, id, name}], issues } */
export async function compileFeature(featurePath) {
  const text = fs.readFileSync(featurePath, 'utf8');
  const parser = new GherkinParser(undefined, { strictRequirements: false });
  await parser.ensureCatalog('en');
  const parsed = parser.parse(text);
  await parser.expandScenarioToIR(parsed);
  const gen = new XMLGenerator(parser);
  gen.setExternalScriptlets(loadExternalScriptlets(featurePath, text));
  const out = gen.generate(parsed);
  // generate() reports its own issues (chiefly unresolved scriptlet ids, which
  // are severity:error). Dropping them let a suite compile "successfully" while
  // referencing a scriptlet file it never emitted.
  return {
    files: out.files,
    issues: [...(parsed.issues ?? []), ...(out.issues ?? [])],
    testcaseName: out.testcaseName,
  };
}

/** Write compiled files to a dir and build the deployable suite zip. */
export async function writeSuite(files, outDir, zipName) {
  fs.mkdirSync(outDir, { recursive: true });
  for (const f of files) {
    const fp = path.join(outDir, f.filename);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, f.xml);
  }
  const reqDeps = createRequire(path.join(DEPS, 'package.json'));
  const JSZip = reqDeps('jszip');
  const zip = new JSZip();
  for (const f of files) zip.file(f.filename, f.xml);
  const buf = await zip.generateAsync({ type: 'nodebuffer' });
  const zipPath = path.join(outDir, zipName);
  fs.writeFileSync(zipPath, buf);
  return zipPath;
}
