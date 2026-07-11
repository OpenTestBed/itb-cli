"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.pluginDialectUrls = pluginDialectUrls;
exports.loadRemoteComponent = loadRemoteComponent;
exports.loadCatalog = loadCatalog;
exports.discoverComponents = discoverComponents;
exports.loadComponentManifest = loadComponentManifest;
exports.loadComponentExtension = loadComponentExtension;
exports.loadAllComponents = loadAllComponents;
exports.mergeCatalog = mergeCatalog;
exports.checkComponentHealth = checkComponentHealth;
const js_yaml_1 = __importDefault(require("js-yaml"));
const base = () => process.env.WB_BASE_URL || '/';
/**
 * Plugin dialect sources: absolute base URLs of a plugin repo's dialect/
 * folder (must contain component.yml + steps.yml [+ scriptlets/]).
 * Two ways to provide them:
 *   1. URL query param:   ?dialects=https://raw.githubusercontent.com/OpenTestBed/itb-plugin-fhir-validator/main/dialect,https://...
 *   2. localStorage key:  plugin-dialect-urls = JSON array of base URLs
 * Remote plugin dialects OVERRIDE a bundled component with the same id —
 * the plugin repo is the canonical home of its language extension.
 */
function pluginDialectUrls() {
    const urls = [];
    try {
        if (typeof window !== 'undefined' && window.location?.search) {
            const q = new URLSearchParams(window.location.search).get('dialects');
            if (q)
                urls.push(...q.split(',').map(s => s.trim()).filter(Boolean));
        }
        if (typeof localStorage !== 'undefined') {
            const stored = localStorage.getItem('plugin-dialect-urls');
            if (stored)
                urls.push(...JSON.parse(stored));
        }
    }
    catch { /* malformed config — ignore */ }
    return [...new Set(urls.map(u => u.replace(/\/+$/, '')))];
}
/** Load a component (manifest + language extension + scriptlets) from an
 *  absolute base URL — a plugin repo's dialect/ folder served over HTTP. */
async function loadRemoteComponent(baseUrl) {
    try {
        const mres = await fetch(`${baseUrl}/component.yml`);
        if (!mres.ok)
            return null;
        const manifest = js_yaml_1.default.load(await mres.text());
        if (!manifest?.id)
            return null;
        let extension = null;
        const langFile = manifest.language ?? 'steps.yml';
        const eres = await fetch(`${baseUrl}/${langFile}`);
        if (eres.ok)
            extension = js_yaml_1.default.load(await eres.text());
        const scriptlets = [];
        for (const file of manifest.scriptlets ?? []) {
            try {
                const sres = await fetch(`${baseUrl}/scriptlets/${file}`);
                if (sres.ok)
                    scriptlets.push({ path: `scriptlets/${file}`, xml: await sres.text() });
            }
            catch { /* skip */ }
        }
        const stored = typeof localStorage !== 'undefined' ? localStorage.getItem(`component:${manifest.id}:enabled`) : null;
        const enabled = stored !== null ? stored === 'true' : true;
        return { manifest, extension: extension ?? undefined, scriptlets: scriptlets.length ? scriptlets : undefined, enabled, status: 'unknown' };
    }
    catch {
        return null;
    }
}
/** Load the core language catalog */
async function loadCatalog(locale = 'en') {
    const url = `${base()}lang/${locale}.yml`;
    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`Failed to load catalog: ${url} (${res.status})`);
    }
    const text = await res.text();
    return js_yaml_1.default.load(text);
}
/** Discover available components from the index */
async function discoverComponents() {
    try {
        const url = `${base()}components/index.json`;
        const res = await fetch(url);
        if (!res.ok)
            return [];
        const data = await res.json();
        return data.components || [];
    }
    catch {
        return [];
    }
}
/** Load a single component manifest */
async function loadComponentManifest(componentId) {
    try {
        const url = `${base()}components/${componentId}/component.yml`;
        const res = await fetch(url);
        if (!res.ok)
            return null;
        const text = await res.text();
        return js_yaml_1.default.load(text);
    }
    catch {
        return null;
    }
}
/** Load a component's language extension */
async function loadComponentExtension(componentId, languageFile) {
    try {
        const url = `${base()}components/${componentId}/${languageFile}`;
        const res = await fetch(url);
        if (!res.ok)
            return null;
        const text = await res.text();
        return js_yaml_1.default.load(text);
    }
    catch {
        return null;
    }
}
/** Load all components and their extensions */
async function loadAllComponents() {
    const ids = await discoverComponents();
    const results = [];
    for (const id of ids) {
        const manifest = await loadComponentManifest(id);
        if (!manifest)
            continue;
        let extension = null;
        if (manifest.language) {
            extension = await loadComponentExtension(id, manifest.language);
        }
        // Load scriptlet XML files shipped with this component
        const scriptlets = [];
        if (manifest.scriptlets) {
            for (const file of manifest.scriptlets) {
                try {
                    const url = `${base()}components/${id}/scriptlets/${file}`;
                    const res = await fetch(url);
                    if (res.ok) {
                        const xml = await res.text();
                        scriptlets.push({ path: `scriptlets/${file}`, xml });
                    }
                }
                catch { /* skip unavailable scriptlets */ }
            }
        }
        // Check localStorage for enabled state (default: enabled)
        const stored = localStorage.getItem(`component:${id}:enabled`);
        const enabled = stored !== null ? stored === 'true' : true;
        results.push({ manifest, extension: extension ?? undefined, scriptlets: scriptlets.length > 0 ? scriptlets : undefined, enabled, status: 'unknown' });
    }
    // Plugin-provided dialects (remote base URLs) — canonical, so they replace
    // any bundled component with the same id.
    for (const url of pluginDialectUrls()) {
        const remote = await loadRemoteComponent(url);
        if (!remote) {
            console.warn(`plugin dialect not loadable: ${url}`);
            continue;
        }
        const idx = results.findIndex(r => r.manifest.id === remote.manifest.id);
        if (idx >= 0)
            results[idx] = remote;
        else
            results.push(remote);
    }
    return results;
}
/**
 * Merge component extensions into the core catalog.
 * Extension steps are appended after core steps so that
 * core patterns take precedence (first match wins).
 */
function mergeCatalog(core, components) {
    const merged = [...core.steps];
    for (const comp of components) {
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
async function checkComponentHealth(manifest, endpointOverride) {
    if (!manifest.healthCheck)
        return 'unknown';
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
    }
    catch {
        return 'unhealthy';
    }
}
