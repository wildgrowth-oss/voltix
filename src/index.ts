import { useMemo, useRef, useSyncExternalStore } from 'react'
import type { StoreType } from './vanilla'

export * from './vanilla'

/** Internal view of the store that exposes the equality registry to the hook. */
type InternalStore<T extends object> = StoreType<T> & {
  _eqReg: Record<string, ((prev: any, next: any) => boolean) | undefined> | null;
};

type PrimitiveKey<T extends object> = keyof T;
type CompareFn<V> = (prev: V, next: V) => boolean;

type KeySelector<T extends object> = PrimitiveKey<T>;
type CustomSelector<T extends object> = { [K in keyof T]?: CompareFn<T[K]> };
type SelectorInput<T extends object> = ReadonlyArray<KeySelector<T> | CustomSelector<T>>;

type ExtractSelectorKeys<T extends object, S extends SelectorInput<T>> = {
  [K in S[number] extends infer Item
  ? Item extends keyof T
  ? Item
  : keyof Item
  : never]: T[K];
};

type Picked<T extends object, S extends SelectorInput<T>> = ExtractSelectorKeys<T, S>;

type NormalizedSelector<T extends object> = {
  key: keyof T;
  compare?: CompareFn<T[keyof T]>;
};

function shallowEqualSelector<T extends object>(
  a: SelectorInput<T>,
  b: SelectorInput<T>
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * React hook that subscribes to specific keys in a store with fine-grained re-renders.
 * Only re-renders when the selected keys actually change (using Object.is comparison).
 * 
 * @param store - The store created with createStore
 * @param selector - Array of keys to subscribe to, or objects with custom compare functions
 * @returns Selected state values from the store
 * 
 * @example
 * ```ts
 * // Subscribe to specific keys
 * const { count, name } = useStoreSelector(store, ['count', 'name']);
 * 
 * // Custom comparison for complex objects
 * const { tasks } = useStoreSelector(store, [
 *   { tasks: (prev, next) => prev.length === next.length }
 * ]);
 * ```
 */
export function useStoreSelector<T extends object, S extends SelectorInput<T>>(
  store: StoreType<T>,
  selector: S
): Picked<T, S> {
  const ref = useRef({
    store,
    lastSelected: {} as Partial<T>,
    prevSelector: null as SelectorInput<T> | null,
    normalized: null as NormalizedSelector<T>[] | null,
    keys: null as (keyof T)[] | null,
    isFirstRun: true,
    lastValues: {} as Partial<T>,
    subscribe: null as ((onStoreChange: () => void) => () => void) | null,
    getSnapshot: null as (() => Picked<T, S>) | null,
    serverValue: null as Picked<T, S> | null,
    getServerSnapshot: null as (() => Picked<T, S>) | null,
  });

  const r = ref.current;
  const storeChanged = r.store !== store;
  if (storeChanged) {
    r.store = store;
    r.lastSelected = {};
    r.prevSelector = null;
    r.normalized = null;
    r.keys = null;
    r.isFirstRun = true;
    r.lastValues = {};
    r.subscribe = null;
    r.getSnapshot = null;
    r.serverValue = null;
    r.getServerSnapshot = null;
  }

  if (!r.prevSelector || !shallowEqualSelector(r.prevSelector, selector)) {
    const normalized: NormalizedSelector<T>[] = [];
    const keys: (keyof T)[] = [];

    for (const item of selector) {
      if (typeof item === 'string') {
        const key = item as keyof T;
        normalized.push({ key });
        keys.push(key);
      } else {
        const customSelector = item as CustomSelector<T>;
        for (const key in customSelector) {
          const compare = customSelector[key as keyof typeof customSelector];
          const typedKey = key as keyof T;
          normalized.push({ key: typedKey, compare: compare as CompareFn<T[keyof T]> });
          keys.push(typedKey);
        }
      }
    }

    r.normalized = normalized;
    r.keys = keys;
    r.prevSelector = selector;
    r.subscribe = null;
    r.serverValue = null;
  }

  if (!r.subscribe) {
    r.subscribe = (onStoreChange: () => void) => store.subscribe(r.keys!, onStoreChange);
  }
  if (!r.getSnapshot) {
    // Stores from other libraries may not expose an equality registry.
    const eqReg = (store as InternalStore<T>)._eqReg ?? null;
    r.getSnapshot = (): Picked<T, S> => {
      const normalized = r.normalized!;
      const current = store.get();

      if (r.isFirstRun) {
        r.isFirstRun = false;
        const result = {} as Partial<T>;
        for (const { key } of normalized) {
          const value = current[key];
          r.lastValues[key] = value;
          result[key] = value;
        }
        r.lastSelected = result;
        return result as Picked<T, S>;
      }

      let result: Partial<T> | null = null;
      for (let i = 0; i < normalized.length; i++) {
        const { key, compare } = normalized[i];
        const prevVal = r.lastValues[key]!;
        const nextVal = current[key];
        if (!Object.is(prevVal, nextVal)) {
          const cmp = compare || (eqReg !== null ? eqReg[key as string] : undefined);
          if (!cmp || !cmp(prevVal, nextVal)) {
            if (!result) {
              result = {} as Partial<T>;
              for (let j = 0; j < i; j++) result[normalized[j].key] = r.lastValues[normalized[j].key];
            }
            r.lastValues[key] = nextVal;
            result[key] = nextVal;
            continue;
          }
        }
        if (result) result[key] = prevVal;
      }

      if (!result) return r.lastSelected as Picked<T, S>;

      r.lastSelected = result;
      return result as Picked<T, S>;
    };
  }

  // Server snapshot: a cached value (must be referentially stable across calls),
  // rebuilt only when the selected keys or the store change.
  if (!r.serverValue) {
    const current = store.get();
    const result = {} as Partial<T>;
    for (const key of r.keys ?? []) {
      result[key] = current[key];
    }
    r.serverValue = result as Picked<T, S>;
  }
  if (!r.getServerSnapshot) {
    r.getServerSnapshot = () => r.serverValue!;
  }

  return useSyncExternalStore(r.subscribe, r.getSnapshot, r.getServerSnapshot);
}

/**
 * React hook that subscribes to a single key and returns its value directly —
 * the lean path for the common one-key case. Re-renders only when that key
 * changes (Object.is, plus any store-level equality from options.equals).
 * No wrapper object is allocated.
 *
 * @example
 * ```ts
 * const count = useStoreKey(store, 'count');
 * ```
 */
export function useStoreKey<T extends object, K extends keyof T>(
  store: StoreType<T>,
  key: K
): T[K] {
  const [subscribe, getSnapshot] = useMemo(() => {
    const sub = (onStoreChange: () => void) => store.subscribe([key], onStoreChange);
    const get = () => store.getKey(key);
    return [sub, get] as const;
  }, [store, key]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Creates a pre-bound selector hook for a specific store instance.
 * Infers the state type from the store — no manual generics needed.
 * 
 * @param store - The store created with createStore
 * @returns A React hook with the same API as useStoreSelector, but with the store already bound
 * 
 * @example
 * ```ts
 * const useWorkspace = createStoreHook(workspace);
 * 
 * // In a component:
 * const { name, syncing } = useWorkspace(['name', 'syncing']);
 * ```
 */
export function createStoreHook<T extends object>(store: StoreType<T>) {
  return function useStore<S extends SelectorInput<T>>(selector: S): Picked<T, S> {
    return useStoreSelector(store, selector);
  };
}
