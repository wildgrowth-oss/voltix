# Guides

The store features, one section each. For nesting and lookups see [Composition](./composition.md); for end-to-end recipes (fetching, polling, live tables) see [Patterns](./patterns.md).

- [Organizing actions](#organizing-actions)
- [Contracts with zod](#contracts-with-zod)
- [Derived keys](#derived-keys)
- [Middleware](#middleware)
- [Persistence](#persistence)
- [Reacting outside React](#reacting-outside-react)
- [Custom equality](#custom-equality)
- [Batching](#batching)
- [Server rendering](#server-rendering)

See also [Core concepts](./core-concepts.md) and the [API reference](./api-reference.md).

## Organizing actions

[`createActions`](./api-reference.md#createactions) collects the functions that write to a store and returns them as a plain object. The store is untouched; actions are normal functions that use it.

```tsx
import { createStore, createActions } from '@wildgrowth/voltix';

export const counter = createStore({ count: 0 });

export const counterActions = createActions(counter, (store) => ({
  increment: () => store.increment('count'),
  add: (amount: number) => store.increment('count', amount),
  reset: () => store.reset(['count']),
}));
```

Call an action from anywhere, and use the store's own methods and hooks as usual:

```tsx
import { counter, counterActions } from './counter';
import { useStoreKey } from '@wildgrowth/voltix';

function Counter() {
  const count = useStoreKey(counter, 'count');
  return <button onClick={counterActions.increment}>{count}</button>;
}
```

The function you pass to `createActions` receives the store, so an action can write several keys in one update:

```tsx
export const canvas = createStore({ x: 0, y: 0, dirty: false });

export const canvasActions = createActions(canvas, (store) => ({
  moveTo: (x: number, y: number) => store.set({ x, y, dirty: true }),
  reset: () => store.reset(),
}));
```

`store.set({ x, y, dirty: true })` writes all three keys in one update, so a component reading them re-renders once.

`createActions` also works on a lookup. Actions over a lookup take the id as their first argument:

```tsx
import { createLookup, createActions } from '@wildgrowth/voltix';

export const todos = createLookup((id: string) => ({ text: '', done: false }));

export const todoActions = createActions(todos, (lookup) => ({
  add: (id: string, text: string) => lookup.at(id).set({ text }),
  toggle: (id: string) => lookup.at(id).toggle('done'),
}));

todoActions.add('t1', 'buy milk');
```

Merge several action objects with object spread (`{ ...baseActions, ...extraActions }`). For a one-off writer, a plain function that uses the store works too.

## Contracts with zod

TypeScript can't check data that arrives at runtime: fetch responses, `localStorage`, URL params, forms. `options.schema` validates writes per key, so bad data is rejected at the store instead of reaching the UI. See [Schema contracts](./api-reference.md#schema-contracts) for the full rules.

```tsx
import { z } from 'zod';
import { createStore } from '@wildgrowth/voltix';

export const profile = createStore(
  { email: '', age: 0, plan: 'free' as 'free' | 'pro' },
  {
    schema: {
      email: z.string().email().or(z.literal('')),
      age: z.number().int().min(0).max(130),
      plan: z.enum(['free', 'pro']),
    },
  }
);
```

An invalid write is dropped and the previous value stands, so a component reading the key never sees a bad state:

```tsx
const data = await res.json();
profile.set(data); // any key failing its schema is skipped; the valid ones land
```

By default a rejection is logged with the key and the issues:

```
[voltix] write to "email" rejected by schema (zod):
  • Invalid email address
  received: not-an-email
```

To show a rejection in the UI instead, register a handler with [`onSchemaError`](./api-reference.md#onschemaerror). It registers after construction, so it can use the finished store and its actions:

```tsx
const profile = createStore(
  { email: 'a@b.co', emailError: '' },
  { schema: { email: z.string().email() } }
);
const profileActions = createActions(profile, (store) => ({
  flagEmail: (message: string) => store.setKey('emailError', message),
}));

profile.onSchemaError((error) => profileActions.flagEmail(error.issues[0].message));

profile.setKey('email', 'nope');
profile.getKey('email');      // 'a@b.co': the write was rejected
profile.getKey('emailError'); // 'Invalid email address'
```

The handler gets the failing store as `error.store`, so a store inside a lookup reports itself. While a handler is registered the console logging is off; the returned disposer turns it back on.

Initial values are checked too. A bad one is logged and kept, and construction never throws. Transforms apply to initial values the same as to writes.

Schemas can also normalize values on the way in:

```tsx
const form = createStore(
  { email: '' },
  { schema: { email: z.string().trim().toLowerCase() } }
);

form.setKey('email', '  Ada@Example.COM ');
form.getKey('email'); // 'ada@example.com'
```

Validation is synchronous, so keep schemas to shape and range checks. Anything async (a uniqueness check against a server) belongs in the action that performs the request, before it writes.

A key typed `T | undefined` can hold `undefined`, and writing it commits and notifies like any other value. `null` and `undefined` are both fine, so pick whichever your types already use and make the schema match:

```tsx
const session = createStore(
  { user: null as { id: string } | null },
  { schema: { user: z.object({ id: z.string() }).nullable() } }
);

const draft = createStore(
  { title: undefined as string | undefined },
  { schema: { title: z.string().min(1).optional() } }
);
```

## Derived keys

[`derive`](./api-reference.md#derive) computes one key from other keys. The computation runs once immediately to set the starting value, then runs again inside any write that changes an input, committing its result in the same update. Subscribers to the derived key wake only when the computed value changes.

```tsx
const store = createStore({ first: 'Ada', last: 'Lovelace', full: '' });

const stop = store.derive('full', ['first', 'last'], ({ first, last }) => `${first} ${last}`);

store.setKey('first', 'Grace');
store.getKey('full'); // 'Grace Lovelace', already committed

stop(); // stop deriving
```

The derived value commits in the same update as its inputs, so a component reading `full` sees both change in one render. `compute` runs on every write that touches an input; keep it cheap.

Derived keys chain. A key derived from another derived key updates in the same pass, as long as you declare them in dependency order:

```tsx
const cart = createStore({ items: [] as { price: number }[], subtotal: 0, total: 0 });

cart.derive('subtotal', ['items'], ({ items }) =>
  items.reduce((sum, i) => sum + i.price, 0)
);
cart.derive('total', ['subtotal'], ({ subtotal }) => Math.round(subtotal * 1.2));

cart.setKey('items', [{ price: 10 }, { price: 5 }]);
cart.getKey('total'); // 18
```

## Middleware

[`intercept`](./api-reference.md#intercept) runs your function before a write commits. It receives `(update, state)` and answers with its return value: a partial replaces the update, `false` vetoes it, nothing passes it through. Scope it with a second `keys` argument so it only runs for relevant writes.

### Validation (veto a write)

```tsx
const account = createStore({ balance: 100 });

account.intercept((update) => {
  if (typeof update.balance === 'number' && update.balance < 0) {
    return false; // reject: balance may not go negative
  }
}, ['balance']);

account.setKey('balance', -20); // blocked, balance stays 100
account.setKey('balance', 40);  // allowed
```

For one key with a shape or range rule, use a [contract](#contracts-with-zod). Use `intercept` for rules that involve several keys or depend on current state.

### Transform (rewrite the update)

```tsx
const form = createStore({ email: '' });

form.intercept((update) => {
  if (typeof update.email === 'string') {
    return { ...update, email: update.email.trim().toLowerCase() };
  }
}, ['email']);

form.setKey('email', '  Ada@Example.COM ');
form.getKey('email'); // 'ada@example.com'
```

### Logging (observe and pass through)

`intercept` returns a function. Keep it, and call it later when you want the interceptor gone:

```tsx
const stopLogging = account.intercept((update) => {
  console.log('writing', update);
});

account.setKey('balance', 60);   // logs: writing { balance: 60 }
account.setKey('balance', 80);   // logs: writing { balance: 80 }

stopLogging();                   // interceptor removed
account.setKey('balance', 90);   // logs nothing
```

Once any interceptor is registered, writes through `setKey`, `update`, `increment`, `toggle`, `mergeSet`, and `reset` all run through your interceptors. They run in registration order, a replacement feeds the next one, and one that throws blocks the write and logs the error.

## Persistence

[`persist`](./api-reference.md#persist) writes selected keys to storage as they change, and [`loadPersistedState`](./api-reference.md#loadpersistedstate) reads them back. Each key is stored under `` `${persistKey}:${keyName}` ``, so keys are written independently and only when they change.

### Sync storage (`localStorage`)

Seed the initial state from storage at creation, then start persisting:

```tsx
import { createStore, persist, loadPersistedState } from '@wildgrowth/voltix';

type State = { theme: 'light' | 'dark'; isLoggedIn: boolean };

const persisted = loadPersistedState<State>(localStorage, 'myapp', ['theme', 'isLoggedIn']);

const store = createStore<State>({
  theme: 'light',
  isLoggedIn: false,
  ...persisted,
});

persist<State>(store, localStorage, 'myapp', ['theme', 'isLoggedIn']);

store.setKey('theme', 'dark'); // persisted immediately
```

A key you write as `undefined` persists as `undefined` and comes back that way, so it overrides the default it is spread over rather than falling back to it. Guard the seed if a cleared key should return to its default:

```tsx
const persisted = loadPersistedState<State>(localStorage, 'myapp', ['theme']);
if (persisted.theme === undefined) delete persisted.theme;
```

### Async storage (React Native `AsyncStorage`)

`loadPersistedState` returns a `Promise` for async storage. Create the store with defaults, start persisting, then hydrate when the read resolves:

```tsx
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createStore, persist, loadPersistedState } from '@wildgrowth/voltix';

type State = { theme: 'light' | 'dark' };

const store = createStore<State>({ theme: 'light' });

persist<State>(store, AsyncStorage, 'myapp', ['theme']);

loadPersistedState<State>(AsyncStorage, 'myapp', ['theme']).then((persisted) => {
  store.set(persisted); // apply saved values once loaded
});
```

Async writes are fire-and-forget, so state updates are never blocked by a slow write. Read failures and write failures are caught and logged rather than thrown.

### What survives storage

The default format is JSON plus the common non-JSON types: `Date`, `Map`, `Set`, and `undefined` come back as what they were, nesting included. Plain JSON values, such as ones written by hand, load unchanged.

```ts
const filters = createStore({ tags: new Set<string>(), since: new Date(0) });
persist(filters, localStorage, 'filters', ['tags', 'since']);

// after a reload:
loadPersistedState(localStorage, 'filters', ['tags', 'since']); // { tags: Set, since: Date }
```

For anything beyond that (BigInt, RegExp, class instances), pass a parser (an object with `stringify` and `parse`) as the last argument to both `persist` and `loadPersistedState`. [superjson](https://github.com/flightcontrolhq/superjson) has exactly that shape:

```ts
import superjson from 'superjson';

persist(store, localStorage, 'myapp', ['snapshot'], superjson);
const persisted = loadPersistedState(localStorage, 'myapp', ['snapshot'], superjson);
```

Writing your own is two functions: `stringify` gets a value and returns the string to store, `parse` gets that string back and returns the value. The `PersistParser` type is exported. One that keeps `BigInt`:

```ts
import { createStore, persist, loadPersistedState, type PersistParser } from '@wildgrowth/voltix';

const wallet = createStore({ balance: 0n });

const bigintParser: PersistParser = {
  stringify: (value) => JSON.stringify(value, (key, v) =>
    typeof v === 'bigint' ? { $bigint: v.toString() } : v
  ),
  parse: (text) => JSON.parse(text, (key, v) =>
    v && typeof v === 'object' && '$bigint' in v ? BigInt(v.$bigint) : v
  ),
};

persist(wallet, localStorage, 'wallet', ['balance'], bigintParser);
const persisted = loadPersistedState(localStorage, 'wallet', ['balance'], bigintParser);
```

Use the same parser on both sides. Switching parsers changes the stored format, so treat it like any shape change: bump the prefix.

Storage contents can be anything: users edit `localStorage`, old deploys leave old shapes behind. A [contract](#contracts-with-zod) with `.catch()` repairs a corrupt value at construction:

```tsx
type PlanState = { plan: 'free' | 'pro' };

const persisted = loadPersistedState<PlanState>(localStorage, 'myapp', ['plan']);

const store = createStore<PlanState>(
  { plan: 'free', ...persisted },
  { schema: { plan: z.enum(['free', 'pro']).catch('free') } }
);

// storage held plan: "EVIL", so the store starts with 'free'
```

When the persisted shape changes between releases, change the prefix (`'myapp-v2'`): old keys are never read again and the store starts from defaults.

## Reacting outside React

[`onChange`](./api-reference.md#onchange) runs a callback when keys change, with the new and previous values. Use it for work outside React: analytics, syncing to a server, driving a non-React view. Several writes in the same tick collapse into one callback with the final values, delivered on a microtask.

```tsx
const store = createStore({ query: '', page: 1 });

const off = store.onChange(['query', 'page'], (values, prev) => {
  console.log(`query ${prev.query} -> ${values.query}, page ${prev.page} -> ${values.page}`);
  fetchResults(values.query, values.page);
});

store.batch(() => {
  store.setKey('query', 'voltix');
  store.setKey('page', 1);
});
// one callback runs with the final values

off(); // stop reacting
```

For a plain notification with no values, [`subscribe`](./api-reference.md#subscribe) runs a listener synchronously whenever a key changes and returns an unsubscribe function.

Code that runs where React is not installed, such as a Node service or a worker, imports the same API from `@wildgrowth/voltix/vanilla`.

## Custom equality

A write commits when the new value differs from the current one (`Object.is`). When that test is wrong for a key, declare an equality function in `options.equals`: return `true` to count two values as equal and skip the write. Equality is fixed at creation, like [contracts](#contracts-with-zod).

```tsx
const store = createStore(
  { user: { id: 1, name: 'Ada' } },
  { equals: { user: (prev, next) => prev.id === next.id } }
);

store.setKey('user', { id: 1, name: 'Ada Lovelace' }); // same id, skipped
store.setKey('user', { id: 2, name: 'Grace Hopper' }); // new id, committed
```

To guard one component instead of the store, pass a compare function inside its [`useStoreSelector`](./api-reference.md#usestoreselector) selector:

```tsx
const { tasks } = useStoreSelector(store, [
  { tasks: (prev, next) => prev.length === next.length },
]);
```

## Batching

When you know the keys, [`set`](./api-reference.md#set) writes them all in one update: `set({ x: 10, y: 20, label: 'moved' })` re-renders a component reading all three exactly once. Reach for [`batch`](./api-reference.md#batch) when several *separate* writes should still notify together, such as a loop, or a call to functions that each write on their own.

```tsx
const board = createStore({
  selected: {} as Record<string, boolean>,
  filter: '',
  results: [] as string[],
});

function selectMany(ids: string[]) {
  board.batch(() => {
    for (const id of ids) {
      board.setKey('selected', { ...board.getKey('selected'), [id]: true });
    }
  });
}
// a component reading `selected` re-renders once
```

Batching composes with [actions](#organizing-actions). Each action writes on its own; wrap two of them in a `batch` and their writes notify together:

```tsx
const boardActions = createActions(board, (store) => ({
  clearFilters: () => store.set({ filter: '', selected: {} }),
  clearResults: () => store.setKey('results', []),
}));

board.batch(() => {
  boardActions.clearFilters();
  boardActions.clearResults();
});
// two actions, three keys written, one notification round
```

Nested `batch` calls join the outer batch and flush once at the end.

## Server rendering

`useStoreKey` and `useStoreSelector` are SSR-safe: on the server they render the store's current values, and the page hydrates cleanly.

On the server, a module-scope store is **one object shared by every request**: two users hitting the same server share it. Write user data into it during server rendering and one user's data can end up in another user's HTML.

So split your state in two:

- State that is the same for everyone (theme default, feature flags, UI state) is safe in stores anywhere.
- Per-user state (profile, cart, permissions) is fetched on the server, passed down as props, and written into the store **on the client**.

```tsx
// profile.ts
export const profile = createStore({ name: '', plan: 'free', synced: false });

export const profileActions = createActions(profile, (store) => ({
  sync: (user: { name: string; plan: string }) => store.set({ ...user, synced: true }),
}));
```

```tsx
// server: one fetch; the data travels in the page response
async function Page() {
  const user = await fetchUser();
  return <Profile user={user} />;
}
```

```tsx
// client: first paint from props; the store takes over after mount
'use client';
import { profile, profileActions } from './profile';

function Profile({ user }: { user: { name: string; plan: string } }) {
  useEffect(() => { profileActions.sync(user); }, [user]);
  const { name, synced } = useStoreSelector(profile, ['name', 'synced']);
  // both sides show the same data; `synced` says which one holds it
  return <h1>{synced ? name : user.name}</h1>;
}
```

One round trip: the server fetches, the props carry the data into the first paint, and after mount the store holds it. Mutations and polling go through the store from then on. Keep the store write in the effect. Client components also render on the server, so a write during render lands in the shared server store, where one user's data can reach another user's page.

Use server actions for writes. Calling one from a mount effect costs a second round trip for data the page could have carried as props. For a mutation, a store action calls the server action and writes the result back into the store.
