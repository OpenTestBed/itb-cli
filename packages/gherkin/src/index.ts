// @opentestbed/otb-gherkin — Gherkin -> GITB TDL.
//
// The public surface is deliberately small: parse a feature, expand it to IR,
// generate the suite. Everything else is an implementation detail of that
// pipeline and is not exported.
export { GherkinParser } from './parser/gherkinParser.js';
export type { IRAction } from './parser/gherkinParser.js';
export { XMLGenerator } from './parser/xmlGenerator.js';
export type { GeneratedFile, XMLOutput } from './parser/xmlGenerator.js';
export { setAssetBase } from './parser/languageCatalog.js';
export type { Catalog, CatalogStep, ComponentInfo, ComponentScriptlet } from './parser/languageCatalog.js';
export { parseITBHeader, scriptletSearchPaths } from './parser/itbHeader.js';
export type { ITBHeader } from './parser/itbHeader.js';
export { parseRequirements, checkRequirements } from './parser/languageRequirements.js';
export type * from './types.js';
