import { Catalog, ComponentInfo } from './languageCatalog.js';
export interface VersionRef {
    /** Spec or component id, e.g. "itb-core-en" / "fhir-validator". */
    id: string;
    /** Semver range, e.g. "^1.4". Undefined = any version. */
    range?: string;
}
export interface LanguageRequirements {
    base?: VersionRef;
    dialects: VersionRef[];
}
export interface LanguageIssue {
    severity: 'warning';
    message: string;
}
/** Read `@lang:` / `@dialect:` out of the feature-wide tag list. */
export declare function parseRequirements(featureTags: string[]): LanguageRequirements;
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
export declare function checkRequirements(req: LanguageRequirements, core: Catalog | undefined, components: ComponentInfo[], unmatchedSteps?: number): LanguageIssue[];
