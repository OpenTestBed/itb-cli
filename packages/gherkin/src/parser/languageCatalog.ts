import yaml from 'js-yaml';
import { compileStepText, ParamSpec } from './stepText.js';

export type CatalogAction =
  | { call: { path: string; output?: string; inputs?: Record<string,string> } }
  | { verify: { handler: string; desc?: string; inputs: Record<string,string> } }
  | { process: { handler: string; operation: string; output?: string; inputs: Record<string,string>; hidden?: boolean } }
  | { assign: { to: string; value: string; append?: boolean } }
  | { listAppend: { list: string; item: Record<string,string> } }
  | { foreach: { from: string; do: CatalogAction[] } }
  | { send: { id?: string; desc?: string; handler: string; from?: string; to?: string; txnId?: string; inputs: Record<string,string> } }
  | { declareActor: { id: string; name?: string; role?: string; endpoint?: string; canonical?: string } }
  | { declareVariable: { name: string; varType?: string; value?: string } }
  | { interact: { id?: string; desc?: string; title?: string; inputTitle?: string; with?: string; instructions?: { desc: string; name?: string; value?: string }[]; requests?: { desc: string; name?: string; inputType?: string; required?: boolean; variable: string }[] } }
  | { receive: { id?: string; desc?: string; handler: string; from?: string; to?: string; txnId?: string; inputs?: Record<string,string> } }
  | { btxn: { txnId: string; from: string; to: string; handler: string } }
  | { etxn: { txnId: string } }
  | { log: string };

export interface CatalogRequirement {
  service: string;
  version?: string;
}

export interface CatalogStep {
  /** Anchored regex. For a v2 entry this is COMPILED from `text`. */
  match: string;
  /** v2: the typed step text this entry was written as. */
  text?: string;
  /** v2: the type of every capture group, in order. */
  params?: ParamSpec[];
  /** One-line description for catalogs and completions. */
  doc?: string;
  table?: { required: string[] };
  actions: CatalogAction[];
  requires?: CatalogRequirement | CatalogRequirement[];
  /** v2: the step's actions come from a registry looked up at expand time —
   *  the subject's value type (`path`), the target's dialect (`conforms`) —
   *  or the step only records a type (`type`). */
  dispatch?: 'path' | 'conforms' | 'type';
  /** v2: the value type bound to the step's LAST {var} capture. */
  output?: { type: string };
  /** v2: extra named values for the action templates, computed from the
   *  captures with the same `$N` substitution (`bind: { ignore: '$4' }`). */
  bind?: Record<string, string>;
  /** v2 `dispatch: path`: 1-based capture that names the output variable;
   *  default writes to $pathValue. */
  pathOutput?: number;
  /** Which component provided this step (undefined = core language) */
  _source?: { componentId: string; componentName: string; enabled: boolean };
}

/** A value type a dialect knows how to read: its display name for
 *  `$x is a <name>`, and how to evaluate a path on it. */
export interface TypeDecl {
  name?: string;
  /** Path evaluator: actions that read $subject at $path into $pathVar.
   *  `kind` names which of the dialect's actor kinds serves it, when the
   *  dialect declares more than one. */
  path?: { actions: CatalogAction[]; outputType?: string; kind?: string };
  /** Filled in at merge time. */
  componentId?: string;
}

/** A conformance handler: actions that check $subject against $profile on
 *  $target, honouring $ignore and $opt.<name>. */
export interface ConformsDecl {
  actions: CatalogAction[];
  /** Which of the dialect's actor kinds checks conformance (optional). */
  kind?: string;
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
  /** v2: well-known dotted references ($response.status → TDL path). */
  refs?: Record<string, string>;
  /** v2: path evaluators that need no dialect (JSON pointer). */
  pathEvaluators?: Record<string, { actions: CatalogAction[] }>;
  /** v2, merged: actor kind → component id ('core' for the core language). */
  kinds?: Record<string, string>;
  /** v2, merged: value type key → declaration. */
  types?: Record<string, TypeDecl>;
  /** v2, merged: component id → conformance handler. */
  conforms?: Record<string, ConformsDecl>;
  /** Scriptlets the core language calls, read from lang/scriptlets/.
   *  Declared in the language file as a list of file names. */
  scriptlets?: ComponentScriptlet[];
}

/** Extension catalog loaded from a component's steps.yml */
export interface ExtensionCatalog {
  id: string;
  name: string;
  description?: string;
  steps: CatalogStep[];
  /** v2: actor kinds this dialect's actors are declared as. */
  kinds?: string[];
  types?: Record<string, TypeDecl>;
  conforms?: ConformsDecl;
}

/**
 * Read a language file — core or extension — in either schema.
 *
 * v1: `steps:` with `match:` regexes.
 * v2: `verbs:` with `text:` placeholders (plus kinds/types/conforms/refs).
 * A file may carry both; v1 entries stay ahead of v2 ones, in file order.
 */
export function normalizeLanguageFile(raw: any): any {
  if (!raw || typeof raw !== 'object') return raw;
  const steps: CatalogStep[] = [];
  // Both must be lists. A mapping is valid YAML and used to throw "object is
  // not iterable" from inside the parser; an empty list plus a named warning is
  // a far better way to learn you wrote `verbs:` as a mapping.
  const asList = (v: any, key: string): any[] => {
    if (v === undefined || v === null) return [];
    if (Array.isArray(v)) return v;
    console.warn(`${key}: must be a list of entries, not a ${typeof v === 'object' ? 'mapping' : typeof v} — ignoring it, so none of its steps will exist`);
    return [];
  };
  for (const s of asList(raw.steps, 'steps')) steps.push({ ...s, actions: flattenActions(s.actions) });
  for (const v of asList(raw.verbs, 'verbs')) {
    if (!v || typeof v.text !== 'string') continue;
    const { text, ...rest } = v;
    steps.push({ ...rest, text, match: rest.match ?? '', actions: flattenActions(rest.actions) });
  }
  const out = { ...raw, steps };
  delete out.verbs;
  for (const t of Object.values(out.types ?? {}) as any[]) {
    if (t?.path?.actions) t.path.actions = flattenActions(t.path.actions);
  }
  if (out.conforms?.actions) out.conforms.actions = flattenActions(out.conforms.actions);
  for (const e of Object.values(out.pathEvaluators ?? {}) as any[]) {
    if (e?.actions) e.actions = flattenActions(e.actions);
  }
  // Top-level keys starting with `x-` are anchor definitions, not language.
  for (const k of Object.keys(out)) if (k.startsWith('x-')) delete out[k];
  return out;
}

/**
 * A YAML alias to a LIST of actions (`- *headers`) lands as a nested array.
 * Splice such items in place so shared action blocks can be reused, and do
 * the same inside foreach/repeat bodies.
 */
export function flattenActions(actions: any): CatalogAction[] {
  if (!Array.isArray(actions)) return [];
  const out: any[] = [];
  for (const a of actions) {
    if (Array.isArray(a)) { out.push(...flattenActions(a)); continue; }
    if (a && typeof a === 'object') {
      if (a.foreach?.do) a.foreach.do = flattenActions(a.foreach.do);
      if (a.repeat?.do) a.repeat.do = flattenActions(a.repeat.do);
    }
    out.push(a);
  }
  return out;
}

/** Compile every v2 `text` to its regex, given the registered type names. */
export function compileCatalogSteps(steps: CatalogStep[], types: Record<string, TypeDecl> = {}): void {
  const typeNames = Object.entries(types).map(([k, t]) => t.name ?? k);
  for (const s of steps) {
    if (!s.text) continue;
    const c = compileStepText(s.text, typeNames);
    s.match = c.match;
    s.params = c.params;
  }
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
  /** Steps file for the 1.x core language (regex `match:` entries), used
   *  when a feature declares `@lang:itb-core-en@^1`. Absent = the dialect
   *  has no 1.x form and is skipped for such files. */
  legacy?: string;
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

export interface BrowserSourceOptions {
  /**
   * Assets bundled into the caller rather than served over HTTP, keyed by the
   * path they would otherwise be fetched from ("lang/en.yml"). A request whose
   * URL ends with a key is answered from here and never hits the network.
   *
   * This is how the workbench supplies the core language: it imports en.yml
   * from this package with Vite's `?raw`, so there is exactly one copy — the
   * one inside the package — instead of a duplicate in the app's public/
   * folder that had to be edited in lockstep and could silently drift.
   */
  assets?: Record<string, string>;
}

/** fetch + localStorage — the browser default, used when nothing is injected
 *  so a browser caller needs no configuration at all. */
export function createBrowserSource(opts: BrowserSourceOptions = {}): CatalogSource {
  const assets = opts.assets ?? {};
  const bundled = (url: string): string | null => {
    for (const [key, value] of Object.entries(assets)) {
      if (url === key || url.endsWith('/' + key.replace(/^\/+/, ''))) return value;
    }
    return null;
  };
  const text = async (url: string) => {
    const hit = bundled(url);
    if (hit !== null) return hit;
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

const src = (): CatalogSource => (catalogSource ??= createBrowserSource());

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
    if (etext !== null) extension = normalizeLanguageFile(yaml.load(etext)) as ExtensionCatalog;

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

export interface LoadOptions {
  /** Load the 1.x core language (`lang/<locale>-1.yml`) instead of the
   *  current one. Chosen per feature file from its `@lang:` tag. */
  legacy?: boolean;
}

/** Asset path of the core language file. */
export function coreLanguagePath(locale = 'en', legacy = false): string {
  return `lang/${locale}${legacy ? '-1' : ''}.yml`;
}

/** Load the core language catalog */
export async function loadCatalog(locale = 'en', opts: LoadOptions = {}): Promise<Catalog> {
  const url = `${base()}${coreLanguagePath(locale, opts.legacy)}`;
  const text = await src().read(url);
  if (text === null) {
    throw new Error(`Failed to load catalog: ${url}`);
  }
  const core = normalizeLanguageFile(yaml.load(text)) as Catalog;
  compileCatalogSteps(core.steps, core.types);
  core.scriptlets = await loadCoreScriptlets(core);
  return core;
}

/**
 * Scriptlets the core language itself calls, shipped beside the language file
 * in `lang/scriptlets/`.
 *
 * The core must not depend on a dialect for these. `serializeJsonObject` used
 * to be supplied by smart-helper and `instructUser` by nothing at all, which
 * made `posts … N times, paced manually` fail to compile for anyone who did
 * not happen to have a copy beside their feature files.
 *
 * A name that cannot be read is skipped rather than fatal: the catalog still
 * loads, and the author gets the ordinary "Scriptlet not found" diagnostic
 * pointing at the step that needs it.
 */
async function loadCoreScriptlets(core: Catalog): Promise<ComponentScriptlet[]> {
  const names = (core as unknown as { scriptlets?: unknown }).scriptlets;
  if (!Array.isArray(names)) return [];
  const dir = `${base()}lang/scriptlets/`;
  const out: ComponentScriptlet[] = [];
  for (const entry of names) {
    if (typeof entry !== 'string' || !entry) continue;
    const xml = await src().read(`${dir}${entry}`);
    if (xml !== null) out.push({ path: `scriptlets/${entry}`, xml });
  }
  return out;
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
    return normalizeLanguageFile(yaml.load(text)) as ExtensionCatalog;
  } catch {
    return null;
  }
}

/** Load all components and their extensions.
 *  Pass the core catalog when you have it (so base-compatibility is judged
 *  against the right locale); otherwise the default core is fetched here. */
export async function loadAllComponents(core?: Catalog, opts: LoadOptions = {}): Promise<ComponentInfo[]> {
  if (!core) {
    try { core = await loadCatalog('en', opts); } catch { core = undefined; }
  }
  const ids = await discoverComponents();
  const results: ComponentInfo[] = [];

  for (const id of ids) {
    const manifest = await loadComponentManifest(id);
    if (!manifest) continue;

    let extension: ExtensionCatalog | null = null;
    const decl = languageDecl(manifest);
    // A 1.x feature file gets the dialect's 1.x steps, or nothing: mixing a
    // 2.x dialect into a 1.x core would shadow steps in ways nobody wrote.
    const langFile = opts.legacy ? decl?.legacy : decl?.steps;
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
  const kinds: Record<string, string> = { ...(core.kinds ?? {}) };
  const types: Record<string, TypeDecl> = {};
  for (const [k, t] of Object.entries(core.types ?? {})) types[k] = { ...t, componentId: t.componentId ?? 'core' };
  const conforms: Record<string, ConformsDecl> = { ...(core.conforms ?? {}) };

  for (const comp of components) {
    if (comp.compat && !comp.compat.ok) {
      console.warn(`dialect "${comp.manifest.id}" not merged: ${comp.compat.message}`);
      continue;
    }
    const ext = comp.extension;
    if (!ext) continue;
    const id = comp.manifest.id;
    if (ext.steps) {
      // Tag each extension step with its source component and enabled status
      const tagged = ext.steps.map(s => ({
        ...s,
        _source: {
          componentId: id,
          componentName: comp.manifest.name,
          enabled: comp.enabled,
        },
      }));
      merged.push(...tagged);
    }
    // `kinds:` must be a list. Written as a mapping it is still valid YAML, and
    // a bare `for…of` over it threw "object is not iterable" from here — with no
    // file, no line and no field name, which is the least useful place for a
    // dialect author to meet their own typo. Take the keys and say so instead;
    // `otb-gherkin dialects` rejects the shape up front, so this is the net.
    const extKinds: string[] = Array.isArray(ext.kinds)
      ? ext.kinds
      : (ext.kinds && typeof ext.kinds === 'object'
          ? (console.warn(`${id}: kinds: is a mapping, but it must be a list — write "kinds: [${Object.keys(ext.kinds).join(', ')}]". Reading its keys for now.`), Object.keys(ext.kinds))
          : []);
    for (const k of extKinds) {
      if (kinds[k] && kinds[k] !== id) console.warn(`actor kind "${k}" is declared by both ${kinds[k]} and ${id}; keeping ${kinds[k]}`);
      else kinds[k] = id;
    }
    for (const [k, t] of Object.entries(ext.types ?? {})) {
      if (types[k]) { console.warn(`value type "${k}" is declared by both ${types[k].componentId} and ${id}; keeping ${types[k].componentId}`); continue; }
      types[k] = { ...t, componentId: id };
    }
    if (ext.conforms) conforms[id] = ext.conforms;
  }

  // `{type}` placeholders need the full registry, so compile once more now.
  compileCatalogSteps(merged, types);

  return { ...core, steps: merged, kinds, types, conforms };
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
