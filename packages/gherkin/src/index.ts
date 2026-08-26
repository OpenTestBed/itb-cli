// @opentestbed/otb-gherkin — Gherkin -> GITB TDL.
//
// The surface is the compile pipeline PLUS the catalog API, because the
// workbench is not just a compiler front-end: it browses the loaded dialects,
// checks their versions, and lets the user add remote ones. Exporting only
// parse/generate would have left it reaching into deep paths, which is the
// coupling this package exists to remove.

// ── Compile pipeline ────────────────────────────────────────────────
export { GherkinParser } from './parser/gherkinParser.js';
export type { IRAction } from './parser/gherkinParser.js';
export { XMLGenerator } from './parser/xmlGenerator.js';
export type { GeneratedFile, XMLOutput } from './parser/xmlGenerator.js';

// ── Where assets and enablement come from ───────────────────────────
export { setAssetBase, setCatalogSource } from './parser/languageCatalog.js';
export type { CatalogSource } from './parser/languageCatalog.js';

// ── Catalog: loading, merging, inspecting ───────────────────────────
export {
  loadCatalog,
  loadAllComponents,
  loadRemoteComponent,
  loadComponentManifest,
  loadComponentExtension,
  discoverComponents,
  mergeCatalog,
  languageDecl,
  checkBaseCompatibility,
  checkDialectImplementation,
  checkComponentHealth,
  satisfiesRange,
} from './parser/languageCatalog.js';
export type {
  Catalog,
  CatalogStep,
  CatalogAction,
  CatalogRequirement,
  ComponentInfo,
  ComponentManifest,
  ComponentScriptlet,
  ExtensionCatalog,
  LanguageDecl,
  BaseCompat,
} from './parser/languageCatalog.js';

// ── Remote plugin dialects ──────────────────────────────────────────
export {
  DIALECT_URLS_KEY,
  GHERKIN_DIALECT_PATH,
  queryDialectUrls,
  getStoredDialectUrls,
  addStoredDialectUrl,
  removeStoredDialectUrl,
  pluginDialectUrls,
} from './parser/languageCatalog.js';

// ── The `# itb:` header block ───────────────────────────────────────
export { parseITBHeader, scriptletSearchPaths } from './parser/itbHeader.js';
export type { ITBHeader } from './parser/itbHeader.js';

// ── @lang: / @dialect: version requirements ─────────────────────────
export { parseRequirements, checkRequirements } from './parser/languageRequirements.js';
export type { LanguageRequirements, LanguageIssue, VersionRef } from './parser/languageRequirements.js';

// ── Shared types ────────────────────────────────────────────────────
export type * from './types.js';
