// Gherkin -> ITB test suite compiler (Node).
//
// The compiler itself is @opentestbed/otb-gherkin — an ordinary dependency.
// This file is the Node adapter around it: it injects a CatalogSource that
// reads assets from disk, then runs the pipeline
// ensureCatalog -> parse -> expandScenarioToIR -> XMLGenerator.generate.
//
// What used to be here: a sibling-path hunt for a workbench checkout, plus
// build-compiler.mjs transpiling that checkout's TypeScript into dist/wb so
// this file could require() it. That arrangement produced two outages — a
// dist/ that could not be rebuilt, and a js-yaml symlink baked into the
// lockfile as an out-of-tree link. Both are gone with it.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import JSZip from 'jszip';
import {
  GherkinParser,
  XMLGenerator,
  parseITBHeader,
  scriptletSearchPaths,
  setCatalogSource,
} from '@opentestbed/otb-gherkin';
import { createNodeSource } from '@opentestbed/otb-gherkin/node';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');

/**
 * Where lang/ and components/ are read from, in precedence order:
 *   1. ITB_ASSET_ROOT — an explicit folder. The golden corpus pins its frozen
 *      fixtures this way, so a snapshot mismatch always means the compiler
 *      changed rather than that a dialect moved under it.
 *   2. the authoring app's public/ — where sync-dialects.mjs writes the
 *      plugin dialects, so it is the live source for components/.
 *
 * This is still a lookup rather than an injected CatalogSource; that is
 * phase 02. It is no longer a hunt for source code to compile, though — only
 * for data.
 */
function findAssets() {
  if (process.env.ITB_ASSET_ROOT) return path.resolve(process.env.ITB_ASSET_ROOT);
  for (const c of [
    process.env.ITB_WORKBENCH_PATH,
    path.resolve(ROOT, '../itb-plugin-authoring/app'),
  ].filter(Boolean)) {
    const pub = path.join(c, 'public');
    if (fs.existsSync(path.join(pub, 'lang', 'en.yml'))) return pub;
  }
  return null;
}

/**
 * Resolved on first compile, not at import.
 *
 * This used to run at module scope and throw when no assets were found, which
 * meant merely IMPORTING this file could kill a process that was never going
 * to compile anything — test/e2e.mjs crashed with exit 1 before reaching its
 * own "no config, skip" check, turning a skip into a red build.
 *
 * A missing asset root is a compile-time problem. Report it then.
 */
let assetsReady = false;
function ensureAssets() {
  if (assetsReady) return PUB_CACHE;
  const root = findAssets();
  if (!root) {
    throw new Error(
      'no asset root found — set ITB_ASSET_ROOT to a folder containing lang/en.yml and components/, ' +
      'or keep an itb-plugin-authoring checkout beside this repo'
    );
  }
  // The parser reads its assets and its enablement through a CatalogSource.
  // This used to be two globalThis patches installed before the parser was
  // imported. Same behaviour, declared instead of monkey-patched.
  setCatalogSource(createNodeSource(root, {
    components: (process.env.ITB_COMPONENTS ?? '').split(',').map(s => s.trim()).filter(Boolean),
  }));
  PUB_CACHE = root;
  assetsReady = true;
  return root;
}

let PUB_CACHE = null;
/** The resolved asset root, or null before the first compile. */
export const PUB = findAssets();

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
  ensureAssets();
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
  const zip = new JSZip();
  for (const f of files) zip.file(f.filename, f.xml);
  const buf = await zip.generateAsync({ type: 'nodebuffer' });
  const zipPath = path.join(outDir, zipName);
  fs.writeFileSync(zipPath, buf);
  return zipPath;
}
