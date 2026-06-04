import type { Store } from "./types";

// Alpine core ships no first-party types; @types/alpinejs (DefinitelyTyped) supplies
// them. We only need to register Galley's single global store so that
// `Alpine.store("g", S)` and `$store.g` are typed against our Store shape.
declare module "alpinejs" {
  interface Stores {
    g: Store;
  }
}

// Shiki theme/language grammars are deep-imported by file path (not in the package
// export map, so the ambient declaration applies). Each default-exports a registration.
declare module "shiki/dist/langs/*" {
  const grammar: unknown;
  export default grammar;
}
declare module "shiki/dist/themes/*" {
  const theme: unknown;
  export default theme;
}