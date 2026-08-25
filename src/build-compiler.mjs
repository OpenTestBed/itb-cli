// Transpiles the test-workbench compiler (Gherkin parser + XML generator) to
// CommonJS (.cjs) for Node use, via the TypeScript compiler API (pure JS —
// works on any platform, unlike the platform-specific esbuild binary).
// Dependencies (typescript, js-yaml) are resolved from the sibling
// test-workbench install, so itb-cli itself needs no npm install.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
function findWorkbench(fromDir) {
  // build-compiler transpiles TS, so it needs a checkout WITH node_modules
  // (typescript). The plugin's app/ qualifies after `npm install` there.
  const candidates = [
    process.env.ITB_WORKBENCH_PATH,
    path.resolve(fromDir, '../itb-plugin-authoring/app'), // in-ecosystem authoring plugin
    path.resolve(fromDir, '../../test-workbench'),   // legacy sibling checkout
    path.resolve(fromDir, '../test-workbench'),      // flat clone layout
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'src/parser/gherkinParser.ts'))
        && fs.existsSync(path.join(c, 'node_modules', 'typescript'))) return c;
  }
  throw new Error('no workbench checkout with node_modules found — run `npm install` in itb-plugin-authoring/app (or set ITB_WORKBENCH_PATH)');
}
const WB = findWorkbench(ROOT);
const req = createRequire(path.join(WB, 'package.json'));
const ts = req('typescript');

const files = [
  ['src/types.ts', 'wb/types.cjs'],
  ['src/parser/languageCatalog.ts', 'wb/parser/languageCatalog.cjs'],
  // gherkinParser imports this for the `# itb:` header block — omitting it
  // makes the transpiled parser throw MODULE_NOT_FOUND at require time.
  ['src/parser/itbHeader.ts', 'wb/parser/itbHeader.cjs'],
  ['src/parser/gherkinParser.ts', 'wb/parser/gherkinParser.cjs'],
  ['src/parser/xmlGenerator.ts', 'wb/parser/xmlGenerator.cjs'],
];

for (const [srcRel, outRel] of files) {
  let src = fs.readFileSync(path.join(WB, srcRel), 'utf8');
  // import.meta is illegal in CJS; the catalog loader only uses BASE_URL.
  src = src.replaceAll('import.meta.env.BASE_URL', 'process.env.WB_BASE_URL');
  const out = ts.transpileModule(src, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: srcRel,
  });
  // itb-cli is type:module, so plain .js would load as ESM — emit .cjs and
  // point the transpiled require() calls at the .cjs siblings.
  let txt = out.outputText
    .replaceAll('require("./languageCatalog")', 'require("./languageCatalog.cjs")')
    .replaceAll('require("./gherkinParser")', 'require("./gherkinParser.cjs")')
    .replaceAll('require("./itbHeader")', 'require("./itbHeader.cjs")')
    .replaceAll('require("../types")', 'require("../types.cjs")');
  const outPath = path.join(ROOT, 'dist', outRel);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, txt);
  console.log('transpiled', srcRel, '->', path.relative(ROOT, outPath));
}

// js-yaml must be resolvable from dist/wb/parser. If this repo's own deps are
// installed, npm has already provided it — do NOT touch node_modules.
//
// WHY THE GUARD: this fallback used to run unconditionally when the path was
// absent. Symlinking js-yaml into node_modules and *then* running `npm install`
// makes npm record the link in package-lock.json as
//   "node_modules/js-yaml": { "resolved": "../itb-plugin-authoring/app/node_modules/js-yaml", "link": true }
// which resolves to nothing on any machine without a sibling workbench — so
// `npm ci` in CI installs no js-yaml and the parser dies with MODULE_NOT_FOUND.
// Deferring to a real install keeps the lockfile registry-resolved; the link is
// only for the standalone case where `npm install` has never been run here.
// NB: `req` above is rooted at the WORKBENCH package.json, which always has
// js-yaml — it would answer the wrong question. Resolve from THIS repo.
const ownReq = createRequire(path.join(ROOT, 'package.json'));
let jsYamlResolvable = true;
try { ownReq.resolve('js-yaml'); } catch { jsYamlResolvable = false; }
if (!jsYamlResolvable && WB) {
  const nm = path.join(ROOT, 'node_modules');
  fs.mkdirSync(nm, { recursive: true });
  const link = path.join(nm, 'js-yaml');
  if (!fs.existsSync(link)) {
    try { fs.symlinkSync(path.join(WB, 'node_modules/js-yaml'), link, 'junction'); }
    catch { fs.cpSync(path.join(WB, 'node_modules/js-yaml'), link, { recursive: true }); }
    console.log('linked js-yaml from the workbench — run `npm install` here before `npm install`/`npm ci` regenerates the lockfile');
  }
}
console.log('done');
