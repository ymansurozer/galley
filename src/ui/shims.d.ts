import type { Store } from "./types";

// Alpine core ships no first-party types; @types/alpinejs (DefinitelyTyped) supplies
// them. We only need to register Galley's single global store so that
// `Alpine.store("g", S)` and `$store.g` are typed against our Store shape.
declare module "alpinejs" {
  interface Stores {
    g: Store;
  }
}

// Shiki's per-language grammars are deep-imported by file path (no typed export
// map). Each default-exports a grammar (LanguageRegistration[]).
declare module "shiki/dist/langs/*" {
  const grammar: unknown;
  export default grammar;
}
