// Node 18.17.x lacks a global `File`, which undici (a transitive cheerio dep)
// references at module-load time. Provide a minimal, spec-ish polyfill so the
// scraper runs on Node 18 as well as 20+. No-op when File already exists.
// Imported for its side effect *before* cheerio, since ESM evaluates imports
// in source order.
import { Blob } from 'node:buffer';

if (typeof globalThis.File === 'undefined') {
  globalThis.File = class File extends Blob {
    constructor(parts = [], name = '', options = {}) {
      super(parts, options);
      this.name = String(name);
      this.lastModified = options.lastModified ?? 0;
    }
    get [Symbol.toStringTag]() {
      return 'File';
    }
  };
}
