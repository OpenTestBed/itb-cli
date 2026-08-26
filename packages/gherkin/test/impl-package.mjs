// Corpus adapter for the EXTRACTED package.
//
// Same contract as src/compile.mjs's compileFeature(), but driving
// @opentestbed/otb-gherkin's built output instead of the transpiled copy in
// dist/wb. Pointing the corpus at this file replays the pre-move snapshots
// against the post-move code — which is the proof the extraction is faithful.
//
// Nothing is shimmed: the source is injected exactly as src/compile.mjs does
// it. Passing the pre-move snapshots through this path is the proof that
// neither the move nor the CatalogSource refactor changed the output.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GherkinParser, XMLGenerator, setCatalogSource, parseITBHeader, scriptletSearchPaths } from '../dist/index.js';
import { createNodeSource } from '../dist/node.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUB = process.env.ITB_ASSET_ROOT ? path.resolve(process.env.ITB_ASSET_ROOT) : path.join(here, 'corpus');

// No globalThis patching: the source is injected, which is the whole point
// of phase 02. If this still passes the pre-move snapshots, the refactor
// changed nothing observable.
setCatalogSource(createNodeSource(PUB, {
  components: (process.env.ITB_COMPONENTS ?? '').split(',').map(x => x.trim()).filter(Boolean),
}));

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
