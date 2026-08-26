// Node entry point: @opentestbed/otb-gherkin/node
//
// Kept behind a subpath export so the browser bundle never pulls in `fs`.
// The core entry stays environment-free.

import fs from 'node:fs';
import path from 'node:path';
import type { CatalogSource } from './parser/languageCatalog.js';

export interface NodeSourceOptions {
  /** Component ids to enable. Empty/omitted = all enabled, matching the
   *  browser default where an unset localStorage key means "on". */
  components?: string[];
  /** Allow absolute http(s) reads for remote plugin dialects. Off by default:
   *  compiling is meant to be local and instant, and a build that silently
   *  reaches the network is a build that fails differently on every machine. */
  allowRemote?: boolean;
  /**
   * Assets supplied directly rather than read from `root`, keyed by the path
   * they would otherwise be read from ("lang/en.yml"). Mirrors
   * BrowserSourceOptions.assets.
   *
   * The CLI uses this for the core language: en.yml ships inside this package,
   * while components/ still comes off disk from the workbench where
   * sync-dialects writes it. Without it the CLI would need a copy of the
   * language somewhere on the filesystem — which is the duplication the
   * package exists to remove.
   */
  assets?: Record<string, string>;
}

/**
 * Read assets from a directory holding `lang/` and `components/`.
 *
 * This replaces the globalThis.fetch and globalThis.localStorage patches every
 * Node caller used to install before importing the parser. Same behaviour,
 * declared instead of monkey-patched.
 */
export function createNodeSource(root: string, opts: NodeSourceOptions = {}): CatalogSource {
  const abs = path.resolve(root);
  const enabled = (opts.components ?? []).filter(Boolean);
  const assets = opts.assets ?? {};

  return {
    async read(p) {
      // Paths arrive app-relative ("/lang/en.yml"); resolve them under root.
      const rel = p.replace(/^\/+/, '');
      for (const [key, value] of Object.entries(assets)) {
        if (rel === key.replace(/^\/+/, '')) return value;
      }
      try {
        return fs.readFileSync(path.join(abs, rel), 'utf8');
      } catch {
        return null; // absent is a normal answer, not an error
      }
    },

    async readUrl(url) {
      if (/^https?:/i.test(url)) {
        if (!opts.allowRemote) return null;
        try {
          const res = await fetch(url);
          return res.ok ? await res.text() : null;
        } catch { return null; }
      }
      return this.read(url);
    },

    isEnabled(id) {
      return enabled.length === 0 || enabled.includes(id);
    },

    // Dialect URLs are a browser-app affordance; on Node there is nothing to
    // persist. Omitting the setter makes the source read-only by construction.
    storedDialectUrls: () => [],
  };
}
