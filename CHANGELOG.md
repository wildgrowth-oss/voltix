# Changelog

## 1.1.0

- `@wildgrowth/voltix/vanilla` has every export except the React hooks `useStoreKey`, `useStoreSelector` and `createStoreHook`, and imports nothing from React. Use it in code that runs without React, such as a Node service, a worker or a package that a non-React app also uses.

  ```ts
  import { createStore } from '@wildgrowth/voltix/vanilla';
  ```

  It is the same engine as the main entry: `createStore`, `createLookup` and every type are the same values from both paths, so a store from one entry nests in a store from the other. The main entry is unchanged. The subpath also resolves in tools that ignore `exports`, such as TypeScript with `moduleResolution: "node"` and Metro before React Native 0.79.
- `react` is an optional peer dependency. npm no longer installs React into a project that only uses `/vanilla`. The main entry still needs React 18 or later.
- Fix: a store kept an empty listener entry, about 0.5 KB, for every key that ever had a subscriber. A store keyed by row id grew for as long as rows mounted and unmounted. A key's entry is now freed at the end of the tick in which its last listener leaves. A key that gets a listener again in the same tick keeps its entry.
- One subscribe plus unsubscribe runs 1.16x as fast on V8, and as fast as before on JavaScriptCore and Hermes. Each key now has one table entry instead of two.
- A `batch` that writes 50 keys runs 1.11x as fast on V8 and 1.19x as fast on JavaScriptCore, and as fast as before on Hermes. The batch keeps each written key's listeners, so its flush looks nothing up again.

5.2 KB gzipped.

## 1.0.0

First release of `@wildgrowth/voltix`.
