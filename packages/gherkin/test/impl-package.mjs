// Corpus adapter for the EXTRACTED package.
//
// Same contract as src/compile.mjs's compileFeature(), but driving
// @opentestbed/otb-gherkin's built output instead of the transpiled copy in
// dist/wb. Pointing the corpus at this file replays the pre-move snapshots
// against the post-move code — which is the proof the extraction is faithful.
//
// The three browser couplings are still shimmed here rather than injected:
// that is phase 02's job. What matters at this phase is that the code MOVED
// without changing behaviour, so the shims stay byte-compatible with the ones
// in src/compile.mjs.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GherkinParser, XMLGenerator, setAssetBase, parseITBHeader, scriptletSearchPaths } from '../dist/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUB = process.env.ITB_ASSET_ROOT ? path.resolve(process.env.ITB_ASSET_ROOT) : path.join(here, 'corpus');

setAssetBase('/');

const enabledIds = (process.env.ITB_COMPONENTS ?? '').split(',').map(s => s.trim()).filter(Boolean);
globalThis.localStorage = {
  getItem: (k) => {
    const m = /^component:(.+):enabled$/.exec(k);
    if (m) return (enabledIds.length === 0 || enabledIds.includes(m[1])) ? 'true' : 'false';
    return null;
  },
  setItem: () => {}, removeItem: () => {},
};

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

/** Mirror of src/compile.mjs loadExternalScriptlets(). */
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
      if (found.has(key)) continue;
      try { found.set(key, fs.readFileSync(path.join(dir, name), 'utf8')); } catch { /* skip */ }
    }
  }
  return found;
}

export async function compileFeature(featurePath) {
  const text = fs.readFileSync(featurePath, 'utf8');
  const parser = new GherkinParser(undefined, { strictRequirements: false });
  await parser.ensureCatalog('en');
  const parsed = parser.parse(text);
  await parser.expandScenarioToIR(parsed);
  const gen = new XMLGenerator(parser);
  gen.setExternalScriptlets(loadExternalScriptlets(featurePath, text));
  const out = gen.generate(parsed);
  return {
    files: out.files,
    issues: [...(parsed.issues ?? []), ...(out.issues ?? [])],
    testcaseName: out.testcaseName,
  };
}
