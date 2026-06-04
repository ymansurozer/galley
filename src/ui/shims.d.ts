import type { Store } from "./types";

// Alpine core ships no first-party types; @types/alpinejs (DefinitelyTyped) supplies
// them. We only need to register Galley's single global store so that
// `Alpine.store("g", S)` and `$store.g` are typed against our Store shape.
declare module "alpinejs" {
  interface Stores {
    g: Store;
  }
}
