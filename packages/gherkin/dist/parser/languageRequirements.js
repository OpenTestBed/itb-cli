// What a .feature file says it was written against.
//
// Extensions already declare compatibility (component.yml `language:` →
// LanguageDecl with base/baseVersion). This is the other half of that contract:
// the file declares the core spec and the plugin dialects it targets, so drift
// between a file and the loaded catalog is reported once and by name, instead
// of as N anonymous "no mapping for step" errors.
//
// Carried on Gherkin @tags — legal Gherkin, ignored by Cucumber and by every
// other tool, and already collected feature-wide by the parser:
//
//   @lang:itb-core-en@^1.4
//   @dialect:fhir-validator@^1.2
//
// One comparator per tag: satisfiesRange() ANDs space-separated parts, but a
// Gherkin tag cannot contain a space, so two-sided ranges (">=1.3 <1.6") are
// not expressible here. `^` and `~` cover the realistic cases.
import { languageDecl, satisfiesRange } from './languageCatalog.js';
const LANG_TAG = /^lang:(.+)$/;
const DIALECT_TAG = /^dialect:(.+)$/;
/**
 * Split `<id>@<range>` on the LAST `@`, so ids may contain one (they don't
 * today, but a scoped id like `@otb/core@^1.4` should not break).
 */
function splitRef(spec) {
    const at = spec.lastIndexOf('@');
    if (at <= 0)
        return { id: spec };
    return { id: spec.slice(0, at), range: spec.slice(at + 1) || undefined };
}
/**
 * Ids compare case-insensitively. The parser lowercases every tag on the way
 * in, so a manifest id with capitals would otherwise never match its own tag.
 */
const sameId = (a, b) => a.toLowerCase() === b.toLowerCase();
/** Read `@lang:` / `@dialect:` out of the feature-wide tag list. */
export function parseRequirements(featureTags) {
    const req = { dialects: [] };
    for (const tag of featureTags) {
        const lang = LANG_TAG.exec(tag);
        if (lang) {
            req.base = splitRef(lang[1]);
            continue;
        }
        const dialect = DIALECT_TAG.exec(tag);
        if (dialect)
            req.dialects.push(splitRef(dialect[1]));
    }
    return req;
}
/**
 * Compare what the file asked for against what is loaded.
 *
 * Always warnings, never errors: a version mismatch does not necessarily stop
 * the file compiling, and any step that genuinely failed to match already
 * reports itself. These explain *why* those errors are there.
 *
 * `unmatchedSteps` is folded into the message when present — it turns
 * "versions differ" into "versions differ, and here is the damage".
 */
export function checkRequirements(req, core, components, unmatchedSteps = 0) {
    const issues = [];
    const damage = unmatchedSteps > 0
        ? ` — ${unmatchedSteps} step${unmatchedSteps === 1 ? '' : 's'} unmatched`
        : '';
    // ── Core language spec ──────────────────────────────────────────
    if (req.base && core) {
        const coreId = core.id ?? 'itb-core-en';
        const coreVer = core.specVersion ?? String(core.version ?? '1');
        if (!sameId(req.base.id, coreId)) {
            issues.push({
                severity: 'warning',
                message: `This file targets language "${req.base.id}" — the loaded core language is "${coreId}"${damage}`,
            });
        }
        else if (req.base.range && !satisfiesRange(coreVer, req.base.range)) {
            issues.push({
                severity: 'warning',
                message: `This file targets ${coreId} ${req.base.range} — ${coreVer} is loaded${damage}`,
            });
        }
    }
    // ── Plugin dialects ─────────────────────────────────────────────
    for (const want of req.dialects) {
        const comp = components.find(c => sameId(c.manifest.id, want.id));
        if (!comp) {
            issues.push({
                severity: 'warning',
                message: `This file requires dialect "${want.id}", which is not loaded — add it in Language › Dialects${damage}`,
            });
            continue;
        }
        if (!comp.enabled) {
            issues.push({
                severity: 'warning',
                message: `This file requires dialect "${want.id}", which is loaded but disabled — enable it in Environment`,
            });
            continue;
        }
        if (!want.range)
            continue;
        const have = languageDecl(comp.manifest)?.version;
        if (!have)
            continue; // legacy manifest with no version — nothing to compare
        if (!satisfiesRange(have, want.range)) {
            issues.push({
                severity: 'warning',
                message: `This file targets ${want.id} ${want.range} — ${have} is loaded${damage}`,
            });
        }
    }
    return issues;
}
