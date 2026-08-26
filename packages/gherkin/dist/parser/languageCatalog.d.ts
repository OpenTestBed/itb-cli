export type CatalogAction = {
    call: {
        path: string;
        output?: string;
        inputs?: Record<string, string>;
    };
} | {
    verify: {
        handler: string;
        desc?: string;
        inputs: Record<string, string>;
    };
} | {
    process: {
        handler: string;
        operation: string;
        output?: string;
        inputs: Record<string, string>;
        hidden?: boolean;
    };
} | {
    assign: {
        to: string;
        value: string;
        append?: boolean;
    };
} | {
    listAppend: {
        list: string;
        item: Record<string, string>;
    };
} | {
    foreach: {
        from: string;
        do: CatalogAction[];
    };
} | {
    send: {
        id?: string;
        desc?: string;
        handler: string;
        from?: string;
        to?: string;
        inputs: Record<string, string>;
    };
} | {
    declareActor: {
        id: string;
        name?: string;
        role?: string;
        endpoint?: string;
        canonical?: string;
    };
} | {
    declareVariable: {
        name: string;
        varType?: string;
        value?: string;
    };
} | {
    interact: {
        id?: string;
        desc?: string;
        title?: string;
        inputTitle?: string;
        with?: string;
        instructions?: {
            desc: string;
            name?: string;
            value?: string;
        }[];
        requests?: {
            desc: string;
            name?: string;
            inputType?: string;
            required?: boolean;
            variable: string;
        }[];
    };
} | {
    receive: {
        id?: string;
        desc?: string;
        handler: string;
        from?: string;
        to?: string;
        inputs?: Record<string, string>;
    };
} | {
    log: string;
};
export interface CatalogRequirement {
    service: string;
    version?: string;
}
export interface CatalogStep {
    match: string;
    table?: {
        required: string[];
    };
    actions: CatalogAction[];
    requires?: CatalogRequirement | CatalogRequirement[];
    /** Which component provided this step (undefined = core language) */
    _source?: {
        componentId: string;
        componentName: string;
        enabled: boolean;
    };
}
export interface Catalog {
    version: number;
    locale: string;
    /** Core language spec identity (e.g. "itb-core-en") — extensions declare
     *  their base against this id. */
    id?: string;
    /** Core language spec version (semver) — extensions declare a compatible
     *  range via language.baseVersion. */
    specVersion?: string;
    steps: CatalogStep[];
}
/** Extension catalog loaded from a component's steps.yml */
export interface ExtensionCatalog {
    id: string;
    name: string;
    description?: string;
    steps: CatalogStep[];
}
/** Versioned language declaration (component.yml `language:` object form).
 *  The legacy string form (`language: steps.yml`) is still accepted and
 *  normalized via languageDecl(). Everything is versioned: the extension
 *  itself, and the base language spec it is written against. */
export interface LanguageDecl {
    /** Relative path to the steps file (default steps.yml) */
    steps: string;
    /** This extension's own language version (semver) */
    version?: string;
    /** Id of the base language this extension extends (e.g. "itb-core-en") */
    base?: string;
    /** Semver range of compatible base specVersions (e.g. ">=1 <2") */
    baseVersion?: string;
}
/** Component manifest loaded from component.yml */
export interface ComponentManifest {
    id: string;
    name: string;
    version: string;
    description?: string;
    docker?: {
        image: string;
        ports?: string[];
        environment?: string[];
        volumes?: string[];
    };
    healthCheck?: {
        method: string;
        path: string;
        expect?: {
            status: number;
        };
    };
    actors?: {
        id: string;
        description?: string;
    }[];
    services?: {
        handler: string;
        path: string;
    }[];
    /** Dialect spec range this app build satisfies (optional). The dialect
     *  spec (language.version) is authoritative: if it falls outside this
     *  range, the APP is out of date — diagnostics point at the app, never
     *  at the dialect. Same semver-lite syntax as language.baseVersion. */
    implementsDialect?: string;
    /** Path to steps.yml (legacy string form) or a versioned LanguageDecl */
    language?: string | LanguageDecl;
    scriptlets?: string[];
}
/** Normalize the manifest's language field to a LanguageDecl (or null). */
export declare function languageDecl(manifest: ComponentManifest): LanguageDecl | null;
/** A scriptlet XML file shipped with a component */
export interface ComponentScriptlet {
    /** Path relative to the test suite root, e.g. "scriptlets/buildJsonBody.xml" */
    path: string;
    /** Raw XML content */
    xml: string;
}
/** Result of checking an extension's declared base against the core spec. */
export interface BaseCompat {
    ok: boolean;
    message?: string;
}
export interface ComponentInfo {
    manifest: ComponentManifest;
    extension?: ExtensionCatalog;
    scriptlets?: ComponentScriptlet[];
    enabled: boolean;
    status: 'unknown' | 'healthy' | 'unhealthy' | 'checking';
    /** Base-language compatibility (undefined = legacy manifest, no declaration) */
    compat?: BaseCompat;
    /** App → dialect-spec drift (implementsDialect vs language.version).
     *  Report-only: the dialect stays authoritative and keeps loading;
     *  undefined = no declaration or cannot judge. */
    dialectDrift?: BaseCompat;
}
/** Check the app→dialect direction: does the app build (implementsDialect)
 *  cover the loaded dialect spec (language.version)?
 *
 *  Three independent version axes — don't confuse them:
 *    - manifest.version            the app/component build
 *    - language.version            the dialect spec itself
 *    - language.baseVersion        dialect → core spec compatibility
 *  implementsDialect adds the missing app → dialect-spec direction.
 *
 *  Optional and never blocking: returns undefined when the field is absent,
 *  the dialect spec version is unknown, or either side is unparseable
 *  ("cannot judge" — silent skip, mirroring checkBaseCompatibility for
 *  legacy manifests). On mismatch, the message points at the APP: the
 *  dialect spec is authoritative. */
export declare function checkDialectImplementation(manifest: ComponentManifest): BaseCompat | undefined;
/** Does `version` satisfy `range`? Unparseable input → false (fail closed). */
export declare function satisfiesRange(version: string, range: string): boolean;
/** Check an extension's declared base language/version against the core
 *  catalog. Returns undefined for legacy manifests with no declaration
 *  (treated as compatible, but flagged nowhere — first-match merge rules
 *  apply as before). */
export declare function checkBaseCompatibility(core: Catalog | undefined, manifest: ComponentManifest): BaseCompat | undefined;
/** Set the base path that lang/ and components/ are resolved against. */
export declare function setAssetBase(b: string): void;
/**
 * Plugin dialect sources: absolute base URLs of a plugin repo's dialect/
 * folder (must contain component.yml + steps.yml [+ scriptlets/]) — OR a
 * deployed plugin service's base URL, which serves its own dialect at the
 * well-known /gherkin-dialect path (self-describing services).
 * Two ways to provide them:
 *   1. URL query param:   ?dialects=https://raw.githubusercontent.com/OpenTestBed/itb-plugin-fhir-validator/main/dialect,https://...
 *   2. localStorage key:  plugin-dialect-urls = JSON array of base URLs
 *      (managed from the Components panel — "Plugin dialects" section)
 * Remote plugin dialects OVERRIDE a bundled component with the same id —
 * the plugin repo is the canonical home of its language extension.
 */
export declare const DIALECT_URLS_KEY = "plugin-dialect-urls";
/** Dialect URLs passed via ?dialects= (session-only, not persisted). */
export declare function queryDialectUrls(): string[];
/** Dialect URLs added by the user (persisted in localStorage). */
export declare function getStoredDialectUrls(): string[];
/** Persist a new dialect URL; returns the updated list. */
export declare function addStoredDialectUrl(url: string): string[];
/** Remove a persisted dialect URL; returns the updated list. */
export declare function removeStoredDialectUrl(url: string): string[];
export declare function pluginDialectUrls(): string[];
/** Well-known path under which a *deployed plugin service* serves its own
 *  dialect (self-describing services): <service-base>/gherkin-dialect/…
 *  Deliberately unversioned — it means "the dialect this running instance
 *  speaks"; all version info lives in component.yml. */
export declare const GHERKIN_DIALECT_PATH = "gherkin-dialect";
/** Load a component (manifest + language extension + scriptlets) from an
 *  absolute base URL. Accepts either a dialect folder itself (a plugin
 *  repo's dialect/ served over HTTP) or a deployed service's base URL —
 *  in the latter case the well-known /gherkin-dialect path is tried. */
export declare function loadRemoteComponent(baseUrl: string): Promise<ComponentInfo | null>;
/** Load the core language catalog */
export declare function loadCatalog(locale?: string): Promise<Catalog>;
/** Discover available components from the index */
export declare function discoverComponents(): Promise<string[]>;
/** Load a single component manifest */
export declare function loadComponentManifest(componentId: string): Promise<ComponentManifest | null>;
/** Load a component's language extension */
export declare function loadComponentExtension(componentId: string, languageFile: string): Promise<ExtensionCatalog | null>;
/** Load all components and their extensions.
 *  Pass the core catalog when you have it (so base-compatibility is judged
 *  against the right locale); otherwise the default core is fetched here. */
export declare function loadAllComponents(core?: Catalog): Promise<ComponentInfo[]>;
/**
 * Merge component extensions into the core catalog.
 * Extension steps are appended after core steps so that
 * core patterns take precedence (first match wins).
 * Extensions whose declared base language is INCOMPATIBLE with the core
 * spec are refused (skipped) — merging them could silently shadow or
 * un-shadow steps. The Components panel surfaces the reason.
 */
export declare function mergeCatalog(core: Catalog, components: ComponentInfo[]): Catalog;
/** Check health of a component.
 *  In dev mode, routes through /api/health-proxy to avoid CORS. */
export declare function checkComponentHealth(manifest: ComponentManifest, endpointOverride?: string): Promise<'healthy' | 'unhealthy'>;
