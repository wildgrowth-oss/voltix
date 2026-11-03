# Comparison

Where Voltix fits, and how it performs. If you already know you want per-key subscriptions in a single store, skip to [Getting started](./getting-started.md).

- [Getting started](./getting-started.md)
- [Core concepts](./core-concepts.md)
- [Composition](./composition.md)
- [Patterns](./patterns.md)

## The model

Voltix keeps state in stores of keys, with listeners per key. A component names the keys it reads, and a write re-renders the readers of the keys that changed.

```tsx
// Voltix: subscribe to a key
const name = useStoreKey(user, 'name');

// Zustand: subscribe with a selector function
const name = useUserStore((state) => state.name);
```

For a single field the two behave the same. The difference shows as reads widen. For several keys Voltix still takes an array, `useStoreSelector(user, ['name', 'plan'])`, while a Zustand selector that returns an object needs an equality strategy (`useShallow`, memoized selectors) to avoid re-rendering on every write.

| Library | Subscription unit |
|---|---|
| **Voltix** | A key in a shared store |
| Zustand | A selector function over one store |
| Jotai | An atom in a dependency graph |
| Valtio | Properties touched on a proxy |
| nanostores | An individual atom or map |
| Preact Signals | A signal read inside an effect |
| Solid | A signal read inside a computation |
| Legend-State | A node of an observable tree |

## Performance

Store-engine microbenchmarks (store engines without React), in operations per second, higher is faster. Every library runs its production code. Each case runs in its own process and reports the median of 40 runs of about 10 ms each, and the table keeps each case's best of five passes (Node 26, Apple M4 Pro). Reproduce with `npm run bench` ([`bench/vs.ts`](https://github.com/wildgrowth-oss/voltix/blob/main/bench/vs.ts)).

| operation | **Voltix** | Preact Signals | Zustand | nanostores | Solid | Valtio | Jotai | Legend-State |
|---|---|---|---|---|---|---|---|---|
| update a value + notify | **188.7M** | 51.0M | 38.8M | 32.9M | 12.8M | 6.7M | 2.9M | 2.8M |
| functional update (`x => x + 1`) | **200.0M** | 50.5M | 38.8M | 32.9M | 13.1M | 6.4M | 2.4M | 2.8M |
| fine-grained update (1 of 1000) | **185.2M** | 49.0M | 38.0M † | 32.8M | 11.8M | 171K ‡ | 2.9M | 1.3M |
| notify 1000 subscribers | **1.0M** | 62K | 254K | 108K | 22K | — ‡ | 71K | 39K |
| update 50 keys as one transaction | 655K | **828K** | 527K | 542K | 264K | — ‡ | 55K | 28K |
| subscribe + unsubscribe | **50.0M** | 30.0M | 34.5M | 40.7M | 9.2M | 15.8M | 3.2M | 28.1M |
| create 1,000 units | 49K | **208K** | 44K | 8K | 92K | 1K | 51K | 16K |

<sub>† Zustand's fine-grained row uses separate stores; its single-store selector pattern is O(N) in the number of subscribers. ‡ Valtio batches notifications asynchronously and its per-key subscribe is O(N). The transaction row uses each library's batch where it has one; a signal is a smaller unit than a keyed store, which is what the creation row shows.</sub>

Every library here re-renders only the components whose data changed. The throughput gap shows up under a high rate of writes: drags, streaming data, animation, large grids of independently updating cells.

## Where Voltix fits

Pick Voltix for views made of many independent values where each write should re-render only its readers: grids and tables with per-row state, editors with many fields, dashboards with live numbers, anything written at high frequency. Stores [compose](./composition.md) into a tree (nested stores with `select(key)`, a store per id with `at(id)`), so a large app stays one tree. The [Patterns](./patterns.md) page shows the request, polling, and live-table shapes end to end.

Cases where another shape fits better:

- Deep mutation of one big nested object: a proxy store (Valtio) tracks nested writes for you; Voltix updates by key.
- State as an async dependency graph, where values derive from other async values: an atom library (Jotai).
- Caching server data (queries, retries, invalidation): a fetching layer such as React Query owns that; Voltix holds the app state beside it.

See [Getting started](./getting-started.md) to try it, or the [API reference](./api-reference.md) for the full surface.
