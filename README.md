<div align="center">

<img src="https://voltix.wildgrowth.io/logo.svg" alt="" width="80" height="44">

# Voltix

**Fastest React state library.**

[![CI](https://github.com/wildgrowth-oss/voltix/actions/workflows/ci.yml/badge.svg)](https://github.com/wildgrowth-oss/voltix/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@wildgrowth/voltix?color=8b5cf6)](https://www.npmjs.com/package/@wildgrowth/voltix)
[![gzip](https://img.shields.io/badge/gzip-5.2%20KB-06b6d4)](https://bundlephobia.com/package/@wildgrowth/voltix)
[![types](https://img.shields.io/npm/types/@wildgrowth/voltix?color=3178c6)](https://www.npmjs.com/package/@wildgrowth/voltix)
[![license](https://img.shields.io/badge/license-MIT-64748b)](./LICENSE)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-22d3ee)](https://github.com/wildgrowth-oss/voltix/pulls)

[Website](https://voltix.wildgrowth.io) · [npm](https://www.npmjs.com/package/@wildgrowth/voltix) · [GitHub](https://github.com/wildgrowth-oss/voltix) · [Docs](./docs) · [Benchmarks](#benchmarks)

</div>

Voltix is a **~5.2 KB** global store for React with per-key subscriptions: set one field and only the components reading that field re-render. Stores live at module scope with no provider, and components read keys by name. Stores compose into a tree of nested stores and per-id lookups. Types are inferred from the store, the package has no dependencies, and its update throughput leads every library in the [benchmarks](#benchmarks).

```tsx
import { createStore, useStoreKey } from '@wildgrowth/voltix';

const store = createStore({ count: 0 });

function Counter() {
  const count = useStoreKey(store, 'count');
  return <button onClick={() => store.increment('count')}>{count}</button>;
}
```

## Why Voltix

- Subscriptions are per key. A write to key `a` never re-renders a component that reads only key `b`, even in the same store.
- `useStoreKey(store, 'count')` returns the value itself.
- A key can hold another store or a lookup (a store per id). `select(key)` steps into a child store and `at(id)` into a lookup. Composition adds no cost to reads or writes.
- `get()` returns the same state object across writes: a write replaces one key's value inside that object.
- Keys, values, selectors and equality functions are inferred from your store. Selecting a key that does not exist is a compile error.
- A key can carry a zod, valibot or arktype schema. The store rejects invalid writes and invalid initial state, and `onSchemaError` passes each rejection to your code. Voltix reads schemas through the [Standard Schema](https://standardschema.dev) interface, so it needs none of those packages.
- Action helpers, derived keys, write interceptors, persistence (sync and async) and an ESLint rule ship in the package.
- ~5.2 KB gzipped and tree-shakeable. The hooks need `react` 18 or later; `@wildgrowth/voltix/vanilla` runs without it.

## Benchmarks

Update throughput vs the latest Preact Signals, Zustand, nanostores, Solid, Valtio, Jotai and Legend-State (store engines without React, ops/sec, higher is faster). Every library runs its production code. Each case runs in its own process and reports the median of 40 runs, and the table keeps each case's best of five passes:

| operation | **Voltix** | Preact Signals | Zustand | nanostores | Solid | Valtio | Jotai | Legend-State |
|---|---|---|---|---|---|---|---|---|
| update a value + notify | **188.7M** | 51.0M | 38.8M | 32.9M | 12.8M | 6.7M | 2.9M | 2.8M |
| functional update (`x => x + 1`) | **200.0M** | 50.5M | 38.8M | 32.9M | 13.1M | 6.4M | 2.4M | 2.8M |
| fine-grained update (1 of 1000) | **185.2M** | 49.0M | 38.0M † | 32.8M | 11.8M | 171K ‡ | 2.9M | 1.3M |
| notify 1000 subscribers | **1.0M** | 62K | 254K | 108K | 22K | — ‡ | 71K | 39K |

<sub>† Zustand's fine-grained row uses separate stores; its single-store selector pattern is O(N) in the number of subscribers. ‡ Valtio batches notifications asynchronously and its per-key subscribe is O(N).</sub>

Run `npm run bench` to reproduce ([`bench/vs.ts`](bench/vs.ts); Node 26, Apple M4 Pro). The gap matters under high write rates: drag interactions, streaming data, animation, and large grids of independently updating cells.

## Install

```bash
npm i @wildgrowth/voltix
```

Code that runs without React imports from `@wildgrowth/voltix/vanilla`. It has everything except the React hooks `useStoreKey`, `useStoreSelector` and `createStoreHook`.

## The idea: fine-grained by key

You subscribe to **keys**. A write to a key notifies exactly the components reading it, and leaves the rest untouched.

```tsx
const store = createStore({ user: { name: 'Ada' }, theme: 'dark', unread: 3 });

function Unread() {
  const unread = useStoreKey(store, 'unread'); // re-renders only when `unread` changes
  return <span>{unread}</span>;
}

store.setKey('theme', 'light'); // <Unread /> does not re-render
store.increment('unread');       // <Unread /> re-renders, nothing else does
```

`useStoreSelector` subscribes to several keys and returns them as one object:

```tsx
const { user, theme } = useStoreSelector(store, ['user', 'theme']);
```

## Composition: nesting and lookups

A key holding another store becomes a child, reached with `select(key)`. `createLookup(factory)` makes a **lookup**: a store per id, created on first use. A write to one store re-renders only that store's readers. The factory can also return a store it built itself, with its own schema and `onSchemaError` handler, and the lookup keeps that exact store.

```tsx
const app = createStore({
  theme: 'dark',
  profile: createStore({ name: 'Ada', age: 30 }),                   // nested store
  todos: createLookup((id: string) => ({ text: '', done: false })), // lookup
});

app.setKey('theme', 'light');
app.select('profile').setKey('age', 31);
app.select('todos').at('t1').toggle('done');
app.select('todos').keys(); // ['t1']
```

`select` takes one child key, `at` takes one id, and they chain for depth. See [Composition](./docs/composition.md).

## Derived state

`derive` computes a key from other keys in the same update; subscribers wake only when the result changes:

```tsx
const store = createStore({ first: 'Ada', last: 'Lovelace', full: '' });
store.derive('full', ['first', 'last'], ({ first, last }) => `${first} ${last}`);
```

## API at a glance

| | |
|---|---|
| `createStore(shape, options?)` | Create a store |
| `createLookup(factory, options?)` | A map from id to store, populated lazily |
| `select(key)` · `at(id)` | Step into a child · step into a lookup by id |
| `createActions(store, define)` | Define a store's actions in one block, returned as a plain object |
| `options.schema` | Per-key runtime contracts (zod, valibot, arktype) |
| `onSchemaError(handler)` | Handle a write that a schema rejected |
| `useStoreKey(store, key)` | Subscribe to one key, get the value directly |
| `useStoreSelector(store, [keys])` | Subscribe to several keys, get them as one object |
| `createStoreHook(store)` | Pre-bind a typed hook to a store |
| `set` · `setKey` · `update` · `increment` · `toggle` | Write helpers |
| `mergeSet` · `batch` · `reset` · `derive` · `pick` | Object updates, batching, reset, computed keys, snapshots |
| `subscribe` · `onChange` · `intercept` | Outside-React reactions and interception |
| `options.equals` | Per-key custom equality (compare by `.id`, etc.) |

Full reference in the [docs](./docs).

## ESLint rule

The package includes an ESLint rule (at `@wildgrowth/voltix/eslint`) that flags selector keys you never use. Requires ESLint 9+ (flat config):

```js
// eslint.config.js
import voltix from '@wildgrowth/voltix/eslint';

export default [{
  plugins: { voltix },
  rules: { 'voltix/no-unused-selector-keys': 'warn' },
}];
```

## Documentation

- [Getting started](./docs/getting-started.md)
- [Walkthrough](./docs/walkthrough.md): one app, from a single store to a composed tree
- [Core concepts](./docs/core-concepts.md)
- [Composition](./docs/composition.md): nesting stores and per-id lookups
- [API reference](./docs/api-reference.md)
- [Guides](./docs/guides.md): actions, contracts, derived state, middleware, persistence
- [Patterns](./docs/patterns.md): sending requests, polled live updates, live tables
- [Comparison](./docs/comparison.md)

## License

MIT © WILDGROWTH LTD
