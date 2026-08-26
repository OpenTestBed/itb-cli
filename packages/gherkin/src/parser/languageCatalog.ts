import yaml from 'js-yaml';

export type CatalogAction =
  | { call: { path: string; output?: string; inputs?: Record<string,string> } }
  | { verify: { handler: string; desc?: string; inputs: Record<string,string> } }
  | { process: { handler: string; operation: string; output?: string; inputs: Record<string,string>; hidden?: boolean } }
  | { assign: { to: string; value: string; append?: boolean } }
  | { listAppend: { list: string; item: Record<string,string> } }
  | { foreach: { from: string; do: CatalogAction[] } }
  | { send: { id?: string; desc?: string; handler: string; from?: string; to?: string; inputs: Record<string,string> } }
  | { declareActor: { id: string; name?: string; role?: string; endpoint?: string; canonical?: string } }
  | { declareVariable: { name: string; varType?: string; value?: string } }
  | { interact: { id?: string; desc?: string; title?: string; inputTitle?: string; with?: string; instructions?: { desc: string; name?: string; value?: string }[]; requests?: { desc: string; name?: string; inputType?: string; required?: boolean; variable: string }[] } }
  | { receive: { id?: string; desc?: string; handler: string; from?: string; to?: string; inputs?: Record<string,string> } }
  | { log: string };

export interface CatalogRequirement {
  service: string;
  version?: string;
}

export interface CatalogStep {
  match: string;
  table?: { required: string[] };
  actions: CatalogAction[];
  requires?: CatalogRequirement | CatalogRequirement[];
  /** Which component provided this step (undefined = core language) */
  _source?: { componentId: string; componentName: string; enabled: boolean };
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
    expect?: { status: number };
  };
  actors?: { id: string; description?: string }[];
  services?: { handler: string; path: string }[];
  /** Dialect spec range this app build satisfies (optional). The dialect
   *  spec (language.version) is authoritative: if it falls outside this
   *  range, the APP is out of date — diagnostics point at the app, never
   *  at the dialect. Same semver-lite syntax as language.baseVersion. */
  implementsDialect?: string;
  /** Path to steps.yml (legacy string form) or a versioned LanguageDecl */
  language?: string | LanguageDecl;
  scriptlets?: string[]; // list of scriptlet XML files shipped with this component
}

/** Normalize the manifest's language field to a LanguageDecl (or null). */
export function languageDecl(manifest: ComponentManifest): LanguageDecl | null {
  const lang = manifest?.language;
  if (!lang) return null;
  if (typeof lang === 'string') return { steps: lang };
  return { ...lang, steps: lang.steps || 'steps.yml' };
}

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
export function checkDialectImplementation(manifest: ComponentManifest): BaseCompat | undefined {
  const range = manifest?.implementsDialect;
  if (!range || typeof range !== 'string') return undefined;
  const specVer = languageDecl(manifest)?.version;
  if (!specVer) return undefined;
  if (!parseVer(specVer) || !range.trim().split(/\s+/).every(p => /^(>=|<=|>|<|=|\^|~)?\s*v?\d+(\.\d+){0,2}$/.test(p))) {
    return undefined; // cannot judge — skip silently
  }
  if (satisfiesRange(specVer, range)) return { ok: true };
  return {
    ok: false,
    message: `app (v${manifest.version}) declares implementsDialect ${range}, but the loaded dialect spec is ${specVer} — the app is out of date with its dialect`,
  };
}

// ── Semver-lite ──────────────────────────────────────────────────────
// Minimal semver range check (no dependency): supports space-separated
// AND comparators with >=, <=, >, <, =, ^, ~ and bare versions.

function parseVer(v: string): number[] | null {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(v.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

function cmpVer(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

/** Does `version` satisfy `range`? Unparseable input → false (fail closed). */
export function satisfiesRange(version: string, range: string): boolean {
  const v = parseVer(version);
  if (!v) return false;
  const parts = range.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return true;
  for (const part of parts) {
    const m = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/.exec(part);
    if (!m) return false;
    const op = m[1] || '=';
    const bounds = parseVer(m[2]);
    if (!bounds) return false;
    const c = cmpVer(v, bounds);
    let ok: boolean;
    switch (op) {
      case '>=': ok = c >= 0; break;
      case '<=': ok = c <= 0; break;
      case '>': ok = c > 0; break;
      case '<': ok = c < 0; break;
      case '^': ok = c >= 0 && v[0] === bounds[0]; break;
      case '~': ok = c >= 0 && v[0] === bounds[0] && v[1] === bounds[1]; break;
      default: ok = c === 0;
    }
    if (!ok) return false;
  }
  return true;
}

/** Check an extension's declared base language/version against the core
 *  catalog. Returns undefined for legacy manifests with no declaration
 *  (treated as compatible, but flagged nowhere — first-match merge rules
 *  apply as before). */
export function checkBaseCompatibility(core: Catalog | undefined, manifest: ComponentManifest): BaseCompat | undefined {
  const lang = languageDecl(manifest);
  if (!lang || (!lang.base && !lang.baseVersion)) return undefined;
  if (!core) return undefined; // core spec unknown — cannot judge, don't block
  const coreId = core.id ?? 'itb-core-en';
  const coreVer = core.specVersion ?? String(core.version ?? '1');
  if (lang.base && lang.base !== coreId) {
    return { ok: false, message: `targets base language "${lang.base}" — core is "${coreId}"` };
  }
  if (lang.baseVersion && !satisfiesRange(coreVer, lang.baseVersion)) {
    return { ok: false, message: `requires base ${lang.baseVersion} — core spec is ${coreVer}` };
  }
  return { ok: true };
}

// Asset base path. This was `import.meta.env.BASE_URL`, which only exists
// under Vite — it made the whole parser unbuildable outside a bundler, and
// is why itb-cli had to transpile the sources itself with a 93-line
// hand-rolled build. The base is now an injected value with a sane default:
// the browser app sets it from import.meta.env.BASE_URL at startup, Node
// callers leave it alone or point it at a folder.
let assetBase = '/';

/** Set the base path that lang/ and components/ are resolved against. */
export function setAssetBase(b: string): void {
  assetBase = b || '/';
}

const base = () => assetBase;

/**
 * Where the catalog reads its assets and its enablement state.
 *
 * The parser used to call `fetch` and `localStorage` directly, which is why
 * every Node caller had to monkey-patch globalThis before importing it. Those
 * are browser APIs, not compiler concerns: the compiler needs to READ some
 * text and know WHICH dialects are on. That is this interface.
 *
 * Persistence stays with the caller. The library never writes anything unless
 * a source explicitly offers a setter — the browser app owns its localStorage,
 * Node owns its filesystem.
 */
export interface CatalogSource {
  /** Read an asset by app-relative path, e.g. "/lang/en.yml". null = absent. */
  read(path: string): Promise<string | null>;
  /** Read an absolute URL — remote plugin dialects. null = unavailable. */
  readUrl?(url: string): Promise<string | null>;
  /** Is a component's dialect enabled? Default: yes. */
  isEnabled?(componentId: string): boolean;
  /** Dialect URLs the user has added. */
  storedDialectUrls?(): string[];
  /** Persist that list. Omit to make the source read-only. */
  saveStoredDialectUrls?(urls: string[]): void;
}

/** The historical behaviour: fetch + localStorage. Used when nothing is
 *  injected, so a browser caller needs no configuration at all. */
function browserSource(): CatalogSource {
  const text = async (url: string) => {
    try {
      const res = await fetch(url);
      return res.ok ? await res.text() : null;
    } catch { return null; }
  };
  return {
    read: text,
    readUrl: text,
    isEnabled(id) {
      try {
        if (typeof localStorage === 'undefined') return true;
        const stored = localStorage.getItem(`component:${id}:enabled`);
        return stored !== null ? stored === 'true' : true;
      } catch { return true; }
    },
    storedDialectUrls() {
      try {
        if (typeof localStorage === 'undefined') return [];
        const stored = localStorage.getItem(DIALECT_URLS_KEY);
        const parsed = stored ? (JSON.parse(stored) as string[]) : [];
        return Array.isArray(parsed) ? parsed : [];
      } catch { return []; }
    },
    saveStoredDialectUrls(urls) {
      try { localStorage.setItem(DIALECT_URLS_KEY, JSON.stringify(urls)); } catch { /* ignore */ }
    },
  };
}

let catalogSource: CatalogSource | null = null;

/** Inject the source. Call once at startup; omit to keep browser behaviour. */
export function setCatalogSource(s: CatalogSource): void {
  catalogSource = s;
}

const src = (): CatalogSource => (catalogSource ??= browserSource());

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
export const DIALECT_URLS_KEY = 'plugin-dialect-urls';

const normalizeDialectUrl = (u: string) => u.trim().replace(/\/+$/, '');

/** Dialect URLs passed via ?dialects= (session-only, not persisted). */
export function queryDialectUrls(): string[] {
  try {
    if (typeof window !== 'undefined' && window.location?.search) {
      const q = new URLSearchParams(window.location.search).get('dialects');
      if (q) return q.split(',').map(normalizeDialectUrl).filter(Boolean);
    }
  } catch { /* malformed config — ignore */ }
  return [];
}

/** Dialect URLs added by the user (persisted in localStorage). */
export function getStoredDialectUrls(): string[] {
  try {
    return (src().storedDialectUrls?.() ?? []).map(normalizeDialectUrl).filter(Boolean);
  } catch { return []; }
}

/** Persist a new dialect URL; returns the updated list. */
export function addStoredDialectUrl(url: string): string[] {
  const urls = [...new Set([...getStoredDialectUrls(), normalizeDialectUrl(url)])].filter(Boolean);
  src().saveStoredDialectUrls?.(urls);
  return urls;
}

/** Remove a persisted dialect URL; returns the updated list. */
export function removeStoredDialectUrl(url: string): string[] {
  const target = normalizeDialectUrl(url);
  const urls = getStoredDialectUrls().filter(u => u !== target);
  src().saveStoredDialectUrls?.(urls);
  return urls;
}

export function pluginDialectUrls(): string[] {
  return [...new Set([...queryDialectUrls(), ...getStoredDialectUrls()])];
}

/** Well-known path under which a *deployed plugin service* serves its own
 *  dialect (self-describing services): <service-base>/gherkin-dialect/…
 *  Deliberately unversioned — it means "the dialect this running instance
 *  speaks"; all version info lives in component.yml. */
export const GHERKIN_DIALECT_PATH = 'gherkin-dialect';

/** Load a component (manifest + language extension + scriptlets) from an
 *  absolute base URL. Accepts either a dialect folder itself (a plugin
 *  repo's dialect/ served over HTTP) or a deployed service's base URL —
 *  in the latter case the well-known /gherkin-dialect path is tried. */
export async function loadRemoteComponent(baseUrl: string): Promise<ComponentInfo | null> {
  try {
    // Resolve the effective dialect base: the URL as given, else the
    // service's well-known /gherkin-dialect endpoint.
    let effectiveBase = baseUrl;
    const readUrl = src().readUrl ?? src().read;
    let mtext = await readUrl(`${baseUrl}/component.yml`);
    if (mtext === null) {
      effectiveBase = `${baseUrl}/${GHERKIN_DIALECT_PATH}`;
      mtext = await readUrl(`${effectiveBase}/component.yml`);
    }
    if (mtext === null) return null;
    const manifest = yaml.load(mtext) as ComponentManifest;
    if (!manifest?.id) return null;

    let extension: ExtensionCatalog | null = null;
    const langFile = languageDecl(manifest)?.steps ?? 'steps.yml';
    const etext = await readUrl(`${effectiveBase}/${langFile}`);
    if (etext !== null) extension = yaml.load(etext) as ExtensionCatalog;

    const scriptlets: ComponentScriptlet[] = [];
    for (const file of manifest.scriptlets ?? []) {
      try {
        const stext = await readUrl(`${effectiveBase}/scriptlets/${file}`);
        if (stext !== null) scriptlets.push({ path: `scriptlets/${file}`, xml: stext });
      } catch { /* skip */ }
    }

    const enabled = src().isEnabled?.(manifest.id) ?? true;
    return { manifest, extension: extension ?? undefined, scriptlets: scriptlets.length ? scriptlets : undefined, enabled, status: 'unknown' };
  } catch {
    return null;
  }
}

/** Load the core language catalog */
export async function loadCatalog(locale = 'en'): Promise<Catalog> {
  const url = `${base()}lang/${locale}.yml`;
  const text = await src().read(url);
  if (text === null) {
    throw new Error(`Failed to load catalog: ${url}`);
  }
  return yaml.load(text) as Catalog;
}

/** Discover available components from the index */
export async function discoverComponents(): Promise<string[]> {
  try {
    const url = `${base()}components/index.json`;
    const text = await src().read(url);
    if (text === null) return [];
    return (JSON.parse(text) as { components?: string[] }).components || [];
  } catch {
    return [];
  }
}

/** Load a single component manifest */
export async function loadComponentManifest(componentId: string): Promise<ComponentManifest | null> {
  try {
    const url = `${base()}components/${componentId}/component.yml`;
    const text = await src().read(url);
    if (text === null) return null;
    return yaml.load(text) as ComponentManifest;
  } catch {
    return null;
  }
}

/** Load a component's language extension */
export async function loadComponentExtension(componentId: string, languageFile: string): Promise<ExtensionCatalog | null> {
  try {
    const url = `${base()}components/${componentId}/${languageFile}`;
    const text = await src().read(url);
    if (text === null) return null;
    return yaml.load(text) as ExtensionCatalog;
  } catch {
    return null;
  }
}

/** Load all components and their extensions.
 *  Pass the core catalog when you have it (so base-compatibility is judged
 *  against the right locale); otherwise the default core is fetched here. */
export async function loadAllComponents(core?: Catalog): Promise<ComponentInfo[]> {
  if (!core) {
    try { core = await loadCatalog(); } catch { core = undefined; }
  }
  const ids = await discoverComponents();
  const results: ComponentInfo[] = [];

  for (const id of ids) {
    const manifest = await loadComponentManifest(id);
    if (!manifest) continue;

    let extension: ExtensionCatalog | null = null;
    const langFile = languageDecl(manifest)?.steps;
    if (langFile) {
      extension = await loadComponentExtension(id, langFile);
    }

    // Load scriptlet XML files shipped with this component
    const scriptlets: ComponentScriptlet[] = [];
    if (manifest.scriptlets) {
      for (const file of manifest.scriptlets) {
        try {
          const url = `${base()}components/${id}/scriptlets/${file}`;
          const xml = await src().read(url);
          if (xml !== null) scriptlets.push({ path: `scriptlets/${file}`, xml });
        } catch { /* skip unavailable scriptlets */ }
      }
    }

    // Enablement comes from the source (default: enabled).
    const enabled = src().isEnabled?.(id) ?? true;

    results.push({
      manifest,
      extension: extension ?? undefined,
      scriptlets: scriptlets.length > 0 ? scriptlets : undefined,
      enabled,
      status: 'unknown',
      compat: checkBaseCompatibility(core, manifest),
      dialectDrift: checkDialectImplementation(manifest),
    });
  }

  // Plugin-provided dialects (remote base URLs) — canonical, so they replace
  // any bundled component with the same id.
  for (const url of pluginDialectUrls()) {
    const remote = await loadRemoteComponent(url);
    if (!remote) { console.warn(`plugin dialect not loadable: ${url}`); continue; }
    remote.compat = checkBaseCompatibility(core, remote.manifest);
    remote.dialectDrift = checkDialectImplementation(remote.manifest);
    const idx = results.findIndex(r => r.manifest.id === remote.manifest.id);
    if (idx >= 0) results[idx] = remote; else results.push(remote);
  }

  return results;
}

/**
 * Merge component extensions into the core catalog.
 * Extension steps are appended after core steps so that
 * core patterns take precedence (first match wins).
 * Extensions whose declared base language is INCOMPATIBLE with the core
 * spec are refused (skipped) — merging them could silently shadow or
 * un-shadow steps. The Components panel surfaces the reason.
 */
export function mergeCatalog(core: Catalog, components: ComponentInfo[]): Catalog {
  const merged: CatalogStep[] = [...core.steps];

  for (const comp of components) {
    if (comp.compat && !comp.compat.ok) {
      console.warn(`dialect "${comp.manifest.id}" not merged: ${comp.compat.message}`);
      continue;
    }
    if (comp.extension?.steps) {
      // Tag each extension step with its source component and enabled status
      const tagged = comp.extension.steps.map(s => ({
        ...s,
        _source: {
          componentId: comp.manifest.id,
          componentName: comp.manifest.name,
          enabled: comp.enabled,
        },
      }));
      merged.push(...tagged);
    }
  }

  return { ...core, steps: merged };
}

/** Check health of a component.
 *  In dev mode, routes through /api/health-proxy to avoid CORS. */
export async function checkComponentHealth(
  manifest: ComponentManifest,
  endpointOverride?: string
): Promise<'healthy' | 'unhealthy'> {
  if (!manifest.healthCheck) return 'unknown' as any;

  const baseUrl = endpointOverride || `http://localhost:${manifest.docker?.ports?.[0]?.split(':')[0] || '8080'}`;
  const targetUrl = `${baseUrl}${manifest.healthCheck.path}`;
  const method = manifest.healthCheck.method || 'GET';
  const expected = manifest.healthCheck.expect?.status || 200;

  try {
    // Use server-side proxy to bypass CORS in dev mode
    const proxyUrl = `/api/health-proxy?url=${encodeURIComponent(targetUrl)}&method=${method}`;
    const res = await fetch(proxyUrl, { signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const data = await res.json();
      return data.status === expected ? 'healthy' : 'unhealthy';
    }
    // Proxy not available (production) — try direct fetch
    const direct = await fetch(targetUrl, { method, signal: AbortSignal.timeout(5000) });
    return direct.status === expected ? 'healthy' : 'unhealthy';
  } catch {
    return 'unhealthy';
  }
}
