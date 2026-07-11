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
    .replaceAll('require("../types")', 'require("../types.cjs")');
  const outPath = path.join(ROOT, 'dist', outRel);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, txt);
  console.log('transpiled', srcRel, '->', path.relative(ROOT, outPath));
}

// js-yaml must be resolvable from dist/wb/parser — link/copy it into our node_modules.
const nm = path.join(ROOT, 'node_modules');
fs.mkdirSync(nm, { recursive: true });
const link = path.join(nm, 'js-yaml');
if (!fs.existsSync(link)) {
  try { fs.symlinkSync(path.join(WB, 'node_modules/js-yaml'), link, 'junction'); }
  catch { fs.cpSync(path.join(WB, 'node_modules/js-yaml'), link, { recursive: true }); }
}
console.log('done');
