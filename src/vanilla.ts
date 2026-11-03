const MULTI_SUBSCRIPTION = Symbol('multi-subscription');
type StoreListener = (() => void) & { [MULTI_SUBSCRIPTION]?: true };

/**
 * A write interceptor. Runs before an update commits: return a partial to replace
 * the update, `false` to veto it, or nothing to pass it through unchanged.
 */
type Interceptor<T extends object> = (
  update: Partial<T>,
  state: T
) => Partial<T> | false | void;

// Replaced with a literal by consumer bundlers in production builds. Declared locally
// so the check needs no @types/node and never leaks into the emitted declarations.
declare const process: { env: Record<string, string | undefined> } | undefined;
const __DEV__ = typeof process === 'undefined' || process.env.NODE_ENV !== 'production';

/** One validation failure reported by a Standard Schema. */
export interface StandardSchemaIssue {
  readonly message: string;
  readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> | undefined;
}

/** A successful Standard Schema validation: the (possibly transformed) value to use. */
export interface StandardSchemaSuccess<Output> {
  readonly value: Output;
  readonly issues?: undefined;
}

/** A failed Standard Schema validation. */
export interface StandardSchemaFailure {
  readonly issues: ReadonlyArray<StandardSchemaIssue>;
}

/**
 * The Standard Schema interface (standardschema.dev) — the common contract implemented
 * by zod (>=3.24), valibot (>=1.0), arktype (>=2.0), and others. Vendored as types only,
 * so any conforming library plugs into {@link StoreOptions.schema} with no dependency here.
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown
    ) => StandardSchemaSuccess<Output> | StandardSchemaFailure | Promise<unknown>;
    readonly types?: { readonly input: Input; readonly output: Output } | undefined;
  };
}

type SchemaProps = StandardSchemaV1<any, any>['~standard'];

function formatIssuePath(path: StandardSchemaIssue['path']): string {
  if (!path || path.length === 0) return '';
  return path.map((p) => (typeof p === 'object' && p !== null ? String(p.key) : String(p))).join('.');
}

/** A rejected write, handed to handlers registered with {@link StoreType.onSchemaError}. */
export interface SchemaError<T extends object = any> {
  /** The key whose write was vetoed. */
  readonly key: keyof T;
  /** What the schema objected to. */
  readonly issues: ReadonlyArray<StandardSchemaIssue>;
  /** The value that was rejected. */
  readonly value: unknown;
  /** The node that rejected it — for a lookup, the store at that id, not its parent. */
  readonly store: StoreType<T>;
}

const VETO = Symbol('veto');

// Shared, frozen listener table for stores nobody has subscribed to yet. A lookup on it
// returns undefined like any other miss, so the notify path needs no null check, and a
// store that never gets a subscriber never allocates a table of its own.
const NO_LISTENERS: Record<string, never> = Object.freeze(Object.create(null));

/**
 * A copy of a key's listeners that keeps its tags and slots, so every listener array has one shape.
 * The original points at the copy, so a notify that collected it reaches the current listeners.
 */
function copyListeners(fns: Listeners): Listeners {
  const copy = fns.slice() as Listeners;
  copy.e = fns.e;
  copy.q = fns.q;
  copy.s = fns.s;
  copy.x = null;
  fns.x = copy;
  return copy;
}

/** One subscription's slot under one key: its index in that key's listener array. */
interface Slot {
  i: number;
  k: string;
  s: Slot[];
}

/**
 * A key's listeners. `e` is the batch that last collected the key, so a batch records each key once.
 * `q` is set while the key waits in the drain queue, so it is queued once. `s` holds each
 * subscription's slot, in the same order as the listeners. `x` is the copy that replaced this array.
 */
type Listeners = StoreListener[] & { e: number; q: boolean; s: Slot[]; x: Listeners | null };

// Returns the value to commit, or VETO to drop the write for that key.
function runSchema<V>(std: SchemaProps, key: string, value: V, owner: SchemaReporter): V | typeof VETO {
  let result;
  try {
    result = std.validate(value);
  } catch (error) {
    console.error(`[voltix] schema for "${key}" threw; write vetoed.`, error);
    return VETO;
  }
  if (isThenable(result)) {
    console.error(`[voltix] schema for "${key}" is async; write vetoed. Store schemas must validate synchronously.`);
    return VETO;
  }
  if (result.issues) {
    owner._reportSchemaError(key, result.issues, value, std.vendor);
    return VETO;
  }
  return result.value;
}

/** The slice of a store that {@link runSchema} needs in order to report a rejection. */
interface SchemaReporter {
  _reportSchemaError(
    key: string,
    issues: ReadonlyArray<StandardSchemaIssue>,
    value: unknown,
    vendor: string
  ): void;
}

/** A rejection queued during a write, dispatched once that write has settled. */
interface PendingSchemaError {
  key: string;
  issues: ReadonlyArray<StandardSchemaIssue>;
  value: unknown;
  vendor: string;
}

/** What a store keeps once schema rejections or their handlers exist. */
interface SchemaErrorState<T extends object> {
  handlers: Set<(error: SchemaError<T>) => void> | null;
  pending: PendingSchemaError[] | null;
  /** Whether handlers are running, so a handler's own rejected write goes to the console instead. */
  reporting: boolean;
}

function logSchemaError(
  key: string,
  issues: ReadonlyArray<StandardSchemaIssue>,
  value: unknown,
  vendor: string,
  what: string
): void {
  if (__DEV__) {
    const lines = issues
      .map((i) => `  • ${formatIssuePath(i.path) ? formatIssuePath(i.path) + ': ' : ''}${i.message}`)
      .join('\n');
    console.error(`[voltix] ${what} "${key}" rejected by schema (${vendor}):\n${lines}\n  received:`, value);
  } else {
    console.error(`[voltix] invalid value for "${key}"`);
  }
}

/** Options for {@link createStore}. */
export interface StoreOptions<T extends object> {
  /**
   * Per-key equality, fixed at creation. When a write would change a key, its
   * function runs with (prev, next); returning `true` treats the values as equal
   * and skips the update for that key.
   */
  equals?: { [K in keyof T]?: (prev: T[K], next: T[K]) => boolean };
  /**
   * Per-key write contracts, as Standard Schemas (zod, valibot, arktype, …). A write
   * to a key runs its schema first: issues veto that key's write (with readable
   * errors in dev), and a transforming schema commits its parsed output. A schema's
   * output type must match the key's type. Keys without a schema are untouched;
   * stores without schemas skip validation entirely. Schemas are locked at creation.
   */
  schema?: { [K in keyof T]?: StandardSchemaV1<any, T[K]> };
}

/** Keys of `T` whose value is a `number`. */
type NumericKeys<T> = { [K in keyof T]: T[K] extends number ? K : never }[keyof T];
/** Keys of `T` whose value is a `boolean`. */
type BooleanKeys<T> = { [K in keyof T]: T[K] extends boolean ? K : never }[keyof T];

/**
 * A reactive store. The value returned by {@link createStore}. Hold it as
 * a field to compose stores (`{ store: StoreType<CartState> }`), or pass it to
 * {@link useStoreSelector} / {@link createStoreHook} to subscribe in React.
 */
export interface StoreType<T extends object> {
  /** Read the whole state (identity-stable until a `set` changes a key). */
  get(): T;
  /** Read one key. */
  getKey<K extends keyof T>(key: K): T[K];
  /** Shallow-merge a partial into state; notifies only the keys that changed. */
  set(update: Partial<T>): void;
  /** Set one key. */
  setKey<K extends keyof T>(key: K, value: T[K]): void;
  /** Set one key from its current value: `setKey(key, updater(prev))`. */
  update<K extends keyof T>(key: K, updater: (prev: T[K]) => T[K]): void;
  /** Add `amount` (default 1) to a numeric key. */
  increment(key: NumericKeys<T>, amount?: number): void;
  /** Flip a boolean key. */
  toggle(key: BooleanKeys<T>): void;
  /** Merge a partial into an object key and write the result. */
  mergeSet<K extends keyof T>(key: K, value: T[K] extends object ? Partial<T[K]> : never): void;
  /**
   * Reset all keys (or the given keys) to the initial state. Stores without child
   * nodes or schemas read from the original input object, which should not be mutated.
   */
  reset(keys?: (keyof T)[]): void;
  /** Coalesce many sets inside `fn` into a single notification per subscription. */
  batch(fn: () => void): void;
  /** Subscribe to specific keys. Each call is independent, even with the same listener. Returns an unsubscribe. */
  subscribe(keys: (keyof T)[], listener: () => void): () => void;
  /** Imperative snapshot of specific keys. */
  pick<K extends keyof T>(keys: K[]): Pick<T, K>;
  /**
   * Intercept writes before they commit. `fn` returns a partial to replace the
   * update, `false` to veto it, or nothing to pass through. With `keys`, it runs
   * only when the update touches one of them. Returns an unsubscribe.
   */
  intercept(fn: Interceptor<T>, keys?: (keyof T)[]): () => void;
  /** React to key changes outside React, with the new and previous values. */
  onChange<K extends keyof T>(
    keys: K[],
    callback: (values: Pick<T, K>, prev: Pick<T, K>) => void
  ): () => void;
  /**
   * Derive `outKey` from `inputs`: `compute` runs inside any `set` that changes an
   * input and commits its result in the same update, so subscribers to `outKey`
   * wake only when the derived value changes. Returns a disposer.
   */
  derive<K extends keyof T, I extends keyof T>(
    outKey: K,
    inputs: I[],
    compute: (values: Pick<T, I>) => T[K]
  ): () => void;
  /**
   * React to a write rejected by a key's schema. Registered after construction, so the
   * handler can reach the finished store and its actions. Returns an unsubscribe.
   * Handlers replace the default console reporting; the write stays vetoed either way.
   */
  onSchemaError(handler: (error: SchemaError<T>) => void): () => void;
}

class Voltix<T extends object> implements StoreType<T> {
  private state: T;
  private readonly _initialState: T;
  private keyListeners: Record<string, Listeners | undefined>;
  private equalityRegistry: Record<string, ((prev: any, next: any) => boolean) | undefined> | null;
  private schemaRegistry: Record<string, SchemaProps | undefined> | null;
  /** Handlers and queued rejections; null until a handler is registered or a write is rejected. */
  private schemaErrors: SchemaErrorState<T> | null;
  private middleware: Array<{ callback: Interceptor<T>; keys: (keyof T)[] | null }> | null;
  /** Listener arrays of the keys written inside the open batch, each once; null outside a batch. */
  private batched: Listeners[] | null;
  /** Counts batches; a key's listener array carries the epoch of the batch that last collected it. */
  private _epoch: number;
  /** True while nothing can intervene in a write: no interceptor, schema, equality, or open batch. */
  private _fast: boolean;
  /** Live subscriptions that span more than one key; while zero, a multi-key notify needs no dedup. */
  private _multi: number;
  /** Notify loops on the stack; while non-zero, a listener array is copied before it changes. */
  private _notifying: number;
  /** Keys that lost their last listener this tick; null when no drain is scheduled. */
  private _drain: string[] | null;
  /** @internal */
  _children: Map<PropertyKey, AnyNode> | null;

  constructor(
    initialState: T,
    options: StoreOptions<T> | undefined,
    owned: boolean,
    children: Map<PropertyKey, AnyNode> | null
  ) {
    let eqReg: Record<string, ((prev: any, next: any) => boolean) | undefined> | null = null;
    if (options?.equals) {
      eqReg = Object.create(null);
      for (const key in options.equals) {
        const fn = options.equals[key as keyof T];
        if (fn) eqReg![key] = fn as (prev: any, next: any) => boolean;
      }
    }
    let schemaReg: Record<string, SchemaProps | undefined> | null = null;
    if (options?.schema) {
      // The loose view sidesteps instantiating StandardSchemaV1<any, T[keyof T]>,
      // which crashes tsc 5.9 (Debug Failure in checkAssertion).
      const src = options.schema as unknown as Record<string, StandardSchemaV1 | undefined>;
      schemaReg = Object.create(null);
      for (const key in src) {
        const sch = src[key];
        if (sch) schemaReg![key] = sch['~standard'];
      }
    }

    // One copy of the shape becomes the live state. The initial values are read back from the
    // object the caller passed, unless the store owns that object already or a schema may
    // rewrite them, in which case they get a copy of their own.
    this._initialState = owned || schemaReg !== null ? { ...initialState } : initialState;
    this.state = owned ? initialState : { ...initialState };
    this.keyListeners = NO_LISTENERS;
    this.equalityRegistry = eqReg;
    this.schemaRegistry = schemaReg;
    this.schemaErrors = null;
    this.middleware = null;
    this.batched = null;
    this._epoch = 0;
    this._fast = eqReg === null && schemaReg === null;
    this._multi = 0;
    this._notifying = 0;
    this._drain = null;
    this._children = children;

    if (schemaReg !== null) {
      // The starting values are validated and transformed too. No handler exists yet, so a
      // rejection goes to the console and the raw value stays, instead of a throw on import.
      const reg = schemaReg;
      const state = this.state as Record<string, unknown>;
      const initial = this._initialState as Record<string, unknown>;
      for (const key in reg) {
        const std = reg[key];
        if (!std || !(key in state)) continue;
        const value = state[key];
        let result;
        try {
          result = std.validate(value);
        } catch (error) {
          console.error(`[voltix] schema for "${key}" threw on the initial value.`, error);
          continue;
        }
        if (isThenable(result)) {
          console.error(`[voltix] schema for "${key}" is async; the initial value was not checked.`);
          continue;
        }
        if (result.issues) {
          logSchemaError(key, result.issues, value, std.vendor, 'initial value for');
          continue;
        }
        state[key] = result.value;
        initial[key] = result.value;
      }
    }
  }

  private _syncFast(): void {
    const mw = this.middleware;
    this._fast =
      (mw === null || mw.length === 0) &&
      this.schemaRegistry === null &&
      this.equalityRegistry === null &&
      this.batched === null;
  }

  /** @internal — exposes the equality registry to the selector hook. */
  get _eqReg(): Record<string, ((prev: any, next: any) => boolean) | undefined> | null {
    return this.equalityRegistry;
  }

  get(): T {
    return this.state;
  }

  getKey<K extends keyof T>(key: K): T[K] {
    return this.state[key];
  }

  private applySingleKey<K extends keyof T>(key: K, value: T[K]): void {
    const schemaReg = this.schemaRegistry;
    if (schemaReg !== null) {
      const std = schemaReg[key as string];
      if (std) {
        const out = runSchema(std, key as string, value, this);
        if (out === VETO) {
          this.flushSchemaErrors();
          return;
        }
        value = out;
      }
    }
    const prev = this.state[key];
    // Object.is, inlined.
    if (prev === value) {
      if ((prev as unknown) !== 0 || 1 / (prev as unknown as number) === 1 / (value as unknown as number)) return;
    } else if (prev !== prev && value !== value) {
      return;
    }
    const eqReg = this.equalityRegistry;
    if (eqReg !== null) {
      const eq = eqReg[key as string];
      if (eq && eq(prev, value)) return;
    }
    this.state[key] = value;
    const listeners = this.keyListeners[key as string];
    if (listeners === undefined) return;
    const batched = this.batched;
    if (batched !== null) {
      if (listeners.e !== this._epoch) {
        listeners.e = this._epoch;
        batched.push(listeners);
      }
      return;
    }
    if (listeners.length === 1) listeners[0]();
    else this.notifyMany(listeners);
  }

  setKey<K extends keyof T>(key: K, value: T[K]): void {
    if (!this._fast) {
      this.setKeyGuarded(key, value);
      return;
    }
    const state = this.state;
    const prev = state[key];
    // Object.is, inlined.
    if (prev === value) {
      if ((prev as unknown) !== 0 || 1 / (prev as unknown as number) === 1 / (value as unknown as number)) return;
    } else if (prev !== prev && value !== value) {
      return;
    }
    state[key] = value;
    const listeners = this.keyListeners[key as string];
    if (listeners !== undefined) {
      // A lone listener can only remove itself or add others, neither of which this
      // call can skip, so it runs without the notify guard.
      if (listeners.length === 1) listeners[0]();
      else this.notifyMany(listeners);
    }
  }

  private setKeyGuarded<K extends keyof T>(key: K, value: T[K]): void {
    const mw = this.middleware;
    if (mw === null || mw.length === 0) {
      this.applySingleKey(key, value);
      return;
    }
    const partial = {} as Partial<T>;
    partial[key] = value;
    this.set(partial);
  }

  update<K extends keyof T>(key: K, updater: (prev: T[K]) => T[K]): void {
    this.setKey(key, updater(this.state[key]));
  }

  increment(key: NumericKeys<T>, amount = 1): void {
    const next = ((this.state[key] as number) + amount) as T[NumericKeys<T>];
    this.setKey(key, next);
  }

  toggle(key: BooleanKeys<T>): void {
    this.setKey(key, (!this.state[key]) as T[BooleanKeys<T>]);
  }

  mergeSet<K extends keyof T>(key: K, value: T[K] extends object ? Partial<T[K]> : never): void {
    this.setKey(key, { ...this.state[key], ...value } as T[K]);
  }

  reset(keys?: (keyof T)[]): void {
    if (!keys) {
      this.set({ ...this._initialState });
    } else {
      const partial = {} as Partial<T>;
      for (const key of keys) {
        partial[key] = this._initialState[key];
      }
      this.set(partial);
    }
  }

  batch(fn: () => void): void {
    if (this.batched !== null) {
      fn();
      return;
    }
    const lists: Listeners[] = [];
    this.batched = lists;
    this._epoch++;
    this._fast = false;
    try {
      fn();
    } finally {
      this.batched = null;
      this._syncFast();
      if (lists.length !== 0) {
        // Only multi-key subscriptions need dedup. Separate subscriptions remain
        // independent even when they use the same callback.
        const notified = this._multi === 0 ? null : new Set<StoreListener>();
        this._notifying++;
        try {
          for (let k = 0; k < lists.length; k++) {
            let listeners = lists[k];
            while (listeners.x !== null) listeners = listeners.x;
            for (let i = 0; i < listeners.length; i++) {
              const listener = listeners[i];
              if (notified === null || listener[MULTI_SUBSCRIPTION] !== true) listener();
              else if (!notified.has(listener)) {
                notified.add(listener);
                listener();
              }
            }
          }
        } finally {
          this._notifying--;
        }
      }
    }
  }

  set(update: Partial<T>): void {
    if (!update) return;

    const mw = this.middleware;
    if (mw === null || mw.length === 0) {
      this.applyUpdate(update);
      return;
    }

    const state = this.state;
    let currentUpdate = update;

    for (let i = 0; i < mw.length; i++) {
      const entry = mw[i];
      const only = entry.keys;
      if (only !== null) {
        let touched = false;
        for (let k = 0; k < only.length; k++) {
          if (only[k] in currentUpdate) { touched = true; break; }
        }
        if (!touched) continue;
      }
      let out: Partial<T> | false | void;
      try {
        out = entry.callback(currentUpdate, state);
      } catch (error) {
        console.error('[voltix] interceptor threw; write blocked.', error);
        return;
      }
      if (out === false) return;
      if (out !== undefined) currentUpdate = out;
    }

    this.applyUpdate(currentUpdate);
  }

  private applyUpdate(processedUpdate: Partial<T>): void {
    const state = this.state;
    const equalityRegistry = this.equalityRegistry;
    const schemaRegistry = this.schemaRegistry;

    let firstKey: string | null = null;
    let changedKeys: string[] | null = null;

    for (const key in processedUpdate) {
      const typedKey = key as keyof T;
      const prevValue = state[typedKey];
      let nextValue = processedUpdate[typedKey];
      if (schemaRegistry !== null) {
        const std = schemaRegistry[key];
        if (std) {
          const out = runSchema(std, key, nextValue, this);
          if (out === VETO) continue;
          nextValue = out;
        }
      }
      if (Object.is(prevValue, nextValue)) continue;
      if (equalityRegistry !== null) {
        const eq = equalityRegistry[key];
        if (eq && eq(prevValue, nextValue)) continue;
      }
      state[typedKey] = nextValue!;
      if (firstKey === null) {
        firstKey = key;
      } else {
        if (!changedKeys) changedKeys = [firstKey];
        changedKeys.push(key);
      }
    }

    // Queued rejections dispatch after this update applies and notifies, so the remaining
    // keys cannot overwrite a handler's writes.
    if (firstKey !== null) {
      const keyListeners = this.keyListeners;
      const batched = this.batched;
      if (batched !== null) {
        const epoch = this._epoch;
        if (changedKeys) {
          for (let k = 0; k < changedKeys.length; k++) {
            const listeners = keyListeners[changedKeys[k]];
            if (listeners !== undefined && listeners.e !== epoch) {
              listeners.e = epoch;
              batched.push(listeners);
            }
          }
        } else {
          const listeners = keyListeners[firstKey];
          if (listeners !== undefined && listeners.e !== epoch) {
            listeners.e = epoch;
            batched.push(listeners);
          }
        }
      } else {
        if (!changedKeys) {
          const listeners = keyListeners[firstKey];
          if (listeners !== undefined) {
            if (listeners.length === 1) listeners[0]();
            else this.notifyMany(listeners);
          }
        } else {
          const notified = this._multi === 0 ? null : new Set<StoreListener>();
          this._notifying++;
          try {
            for (let k = 0; k < changedKeys.length; k++) {
              const listeners = keyListeners[changedKeys[k]];
              if (listeners === undefined) continue;
              for (let i = 0; i < listeners.length; i++) {
                const listener = listeners[i];
                if (notified === null || listener[MULTI_SUBSCRIPTION] !== true) listener();
                else if (!notified.has(listener)) {
                  notified.add(listener);
                  listener();
                }
              }
            }
          } finally {
            this._notifying--;
          }
        }
      }
    }

    if (schemaRegistry !== null && this.schemaErrors !== null && this.schemaErrors.pending !== null) this.flushSchemaErrors();
  }

  intercept(fn: Interceptor<T>, keys?: (keyof T)[]): () => void {
    const entry = { callback: fn, keys: keys ?? null };
    if (!this.middleware) this.middleware = [];
    this.middleware.push(entry);
    this._fast = false;

    return () => {
      if (!this.middleware) return;
      const index = this.middleware.indexOf(entry);
      if (index > -1) {
        this.middleware.splice(index, 1);
        this._syncFast();
      }
    };
  }

  subscribe(keys: (keyof T)[], listener: StoreListener): () => void {
    if (this.keyListeners === NO_LISTENERS) this.keyListeners = Object.create(null);
    const n = keys.length;
    if (n === 1) {
      const slot = this.attach(keys[0] as string, listener);
      return () => {
        if (slot.i !== -1) this.detach(slot);
      };
    }
    const slots: Slot[] = [];
    let callback = listener;
    if (n > 1) {
      // Give each multi-key subscription its own identity for dedup, without
      // wrapping single-key listeners or changing the caller's function.
      callback = () => listener();
      callback[MULTI_SUBSCRIPTION] = true;
      this._multi++;
    }
    for (let i = 0; i < n; i++) slots.push(this.attach(keys[i] as string, callback));
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      if (n > 1) this._multi--;
      for (let i = 0; i < slots.length; i++) if (slots[i].i !== -1) this.detach(slots[i]);
    };
  }

  // A key's listeners are appended to and swap-removed in place, so subscribing and
  // unsubscribing cost the same at any count. While a notify loop is on the stack the
  // array is copied first, so the loop never sees it change.
  private attach(k: string, listener: StoreListener): Slot {
    let fns = this.keyListeners[k];
    let subs: Slot[];
    if (fns === undefined) {
      fns = [] as unknown as Listeners;
      fns.e = 0;
      fns.q = false;
      fns.s = subs = [];
      fns.x = null;
      this.keyListeners[k] = fns;
    } else {
      subs = fns.s;
      if (this._notifying !== 0) this.keyListeners[k] = fns = copyListeners(fns);
    }
    const slot: Slot = { i: fns.length, k, s: subs };
    fns.push(listener);
    subs.push(slot);
    return slot;
  }

  private detach(slot: Slot): void {
    const i = slot.i;
    const subs = slot.s;
    slot.i = -1;
    let fns = this.keyListeners[slot.k]!;
    if (this._notifying !== 0) this.keyListeners[slot.k] = fns = copyListeners(fns);
    const last = fns.length - 1;
    if (i !== last) {
      fns[i] = fns[last];
      const moved = subs[last];
      subs[i] = moved;
      moved.i = i;
    }
    fns.pop();
    subs.pop();
    if (last === 0 && !fns.q) this.queueDrain(fns, slot.k);
  }

  // Kept out of detach: the closure would make every detach allocate a context for `this`.
  private queueDrain(fns: Listeners, k: string): void {
    fns.q = true;
    if (this._drain === null) {
      this._drain = [];
      Promise.resolve().then(() => this.drain());
    }
    this._drain.push(k);
  }

  // Runs once the tick is over, so no notify loop or batch can be holding a deleted array, and a key
  // emptied and reused within one tick keeps its arrays.
  private drain(): void {
    const keys = this._drain!;
    this._drain = null;
    const keyListeners = this.keyListeners;
    for (let i = 0; i < keys.length; i++) {
      const fns = keyListeners[keys[i]]!;
      if (fns.length !== 0) fns.q = false;
      else delete keyListeners[keys[i]];
    }
  }

  private notifyMany(listeners: readonly StoreListener[]): void {
    this._notifying++;
    try {
      const n = listeners.length;
      for (let i = 0; i < n; i++) listeners[i]();
    } finally {
      this._notifying--;
    }
  }

  pick<K extends keyof T>(keys: K[]): Pick<T, K> {
    const result = {} as Pick<T, K>;
    const state = this.state;
    for (const key of keys) {
      result[key] = state[key];
    }
    return result;
  }

  onChange<K extends keyof T>(
    keys: K[],
    callback: (values: Pick<T, K>, prev: Pick<T, K>) => void
  ): () => void {
    const state = this.state;
    let prev = {} as Pick<T, K>;
    for (const key of keys) {
      prev[key] = state[key];
    }

    let scheduled = false;

    const listener = () => {
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        let hasChanges = false;
        for (const key of keys) {
          if (!Object.is(state[key], prev[key])) {
            hasChanges = true;
            break;
          }
        }
        if (!hasChanges) return;
        const next = {} as Pick<T, K>;
        for (const key of keys) {
          next[key] = state[key];
        }
        const snapshot = prev;
        prev = next;
        callback(next, snapshot);
      });
    };

    return this.subscribe(keys, listener);
  }

  derive<K extends keyof T, I extends keyof T>(
    outKey: K,
    inputs: I[],
    compute: (values: Pick<T, I>) => T[K]
  ): () => void {
    const state = this.state;
    const readInputs = (update?: Partial<T>): Pick<T, I> => {
      const values = {} as Pick<T, I>;
      for (const key of inputs) {
        values[key] = update && key in update ? (update[key] as T[I]) : state[key];
      }
      return values;
    };

    this.applySingleKey(outKey, compute(readInputs()));

    return this.intercept(
      (update) => ({ ...update, [outKey]: compute(readInputs(update)) }),
      inputs as (keyof T)[]
    );
  }

  onSchemaError(handler: (error: SchemaError<T>) => void): () => void {
    const state = this.schemaErrors ?? (this.schemaErrors = { handlers: null, pending: null, reporting: false });
    const handlers = state.handlers ?? (state.handlers = new Set());
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
    };
  }

  /** @internal Queues a rejection until the write that caused it settles. */
  _reportSchemaError(
    key: string,
    issues: ReadonlyArray<StandardSchemaIssue>,
    value: unknown,
    vendor: string
  ): void {
    const entry: PendingSchemaError = { key, issues, value, vendor };
    const state = this.schemaErrors ?? (this.schemaErrors = { handlers: null, pending: null, reporting: false });
    if (state.pending === null) state.pending = [entry];
    else state.pending.push(entry);
  }

  /** Dispatch queued rejections. Called once the triggering write has fully settled. */
  private flushSchemaErrors(): void {
    const state = this.schemaErrors;
    if (state === null) return;
    const pending = state.pending;
    if (pending === null) return;
    state.pending = null;

    const handlers = state.handlers;
    // A handler that writes another rejected value would re-enter here forever; while one
    // is running, fall back to the console instead of dispatching again.
    if (handlers === null || handlers.size === 0 || state.reporting) {
      for (const e of pending) logSchemaError(e.key, e.issues, e.value, e.vendor, 'write to');
      return;
    }
    state.reporting = true;
    try {
      for (const e of pending) {
        const error: SchemaError<T> = {
          key: e.key as keyof T,
          issues: e.issues,
          value: e.value,
          store: this,
        };
        for (const handler of handlers) {
          try {
            handler(error);
          } catch (thrown) {
            console.error('[voltix] onSchemaError handler threw:', thrown);
          }
        }
      }
    } finally {
      state.reporting = false;
    }
  }
}

/**
 * Brand marking a value as a navigable node — a {@link Store} or a {@link Lookup} — so a
 * parent `createStore` can tell a nested store from ordinary object state.
 */
const NODE = Symbol('voltix.node');

/** Type-level brand: any value that is a store or a lookup. */
type NodeBrand = { readonly [NODE]: 'store' | 'lookup' };
/** Runtime node: the brand plus one navigation step. */
interface AnyNode extends NodeBrand {
  _step(key: PropertyKey): AnyNode;
}

const isNode = (v: unknown): v is AnyNode =>
  typeof v === 'object' && v !== null && (v as { [NODE]?: unknown })[NODE] !== undefined;

/** Keys of `T` whose value is a nested store or lookup. */
type ChildKey<T> = { [K in keyof T]-?: NonNullable<T[K]> extends NodeBrand ? K : never }[keyof T];
/** Keys of `T` that hold ordinary reactive state. */
type LeafKey<T> = Exclude<keyof T, ChildKey<T>>;
/** The flat reactive state of a composed store (its non-node keys). */
type LeafState<T> = { [K in LeafKey<T>]: T[K] };

/**
 * A store that may hold other nodes. Ordinary keys are reactive leaves driven by the fast
 * mutate-in-place engine; a key whose value is another {@link Store} or {@link Lookup} is a
 * child, reached with {@link Store.select}. Build one with {@link createStore}.
 */
export interface Store<T extends object> extends StoreType<LeafState<T>> {
  readonly [NODE]: 'store';
  /** One structural step: the child node bound at `key` (a nested store or lookup). */
  select<K extends ChildKey<T>>(key: K): T[K];
  /** Names of this store's child keys. */
  children(): ChildKey<T>[];
}

/**
 * A map from id to store, populated lazily: the first {@link Lookup.at} for an id builds the
 * store via the factory passed to {@link createLookup} and memoizes it. `S` is that store's
 * type — exactly what the factory returns when it builds the store itself, or `Store<C>`
 * when it returns a plain state shape.
 */
export interface Lookup<Id extends PropertyKey, S extends object> {
  readonly [NODE]: 'lookup';
  /** The store at `id`, created on first access and memoized. Takes exactly one id. */
  at(id: Id): S;
  /** Whether a store for `id` currently exists. */
  has(id: Id): boolean;
  /** Drop the store at `id`. Returns whether it existed. */
  remove(id: Id): boolean;
  /** Live ids (insertion order). */
  keys(): Id[];
  /** Number of live stores. */
  size(): number;
  /** Drop every store. */
  clear(): void;
}

interface NavStore {
  [NODE]: 'store';
  _children: Map<PropertyKey, AnyNode> | null;
  _step(key: PropertyKey): AnyNode;
  select(key: PropertyKey): AnyNode;
  children(): PropertyKey[];
}
const storeProto = Voltix.prototype as unknown as NavStore;
storeProto[NODE] = 'store';
storeProto._step = function (this: NavStore, key: PropertyKey): AnyNode {
  const child = this._children ? this._children.get(key) : undefined;
  if (child === undefined) throw new RangeError(`no child "${String(key)}"`);
  return child;
};
storeProto.select = function (this: NavStore, key: PropertyKey): AnyNode {
  return this._step(key);
};
storeProto.children = function (this: NavStore): PropertyKey[] {
  return this._children ? [...this._children.keys()] : [];
};

class StoreLookupImpl<Id extends PropertyKey, C extends object> {
  readonly [NODE] = 'lookup' as const;
  private readonly stores = new Map<PropertyKey, AnyNode>();
  private warnedNodeOptions = false;
  private readonly factory: (id: Id) => C;
  private readonly options: StoreOptions<any> | undefined;
  constructor(factory: (id: Id) => C, options?: StoreOptions<any>) {
    this.factory = factory;
    this.options = options;
  }
  _step(key: PropertyKey): AnyNode {
    let store = this.stores.get(key);
    if (store === undefined) {
      const produced: unknown = this.factory(key as Id);
      if (isNode(produced)) {
        if (__DEV__ && this.options !== undefined && !this.warnedNodeOptions) {
          this.warnedNodeOptions = true;
          console.warn(
            '[voltix] lookup factory returned a built store; lookup options are ignored for it — configure the store inside the factory.'
          );
        }
        store = produced;
      } else {
        store = createStore(produced as object, this.options) as unknown as AnyNode;
      }
      this.stores.set(key, store);
    }
    return store;
  }
  at(id: Id): AnyNode {
    return this._step(id);
  }
  has(id: Id): boolean {
    return this.stores.has(id);
  }
  remove(id: Id): boolean {
    return this.stores.delete(id);
  }
  keys(): Id[] {
    return [...this.stores.keys()] as Id[];
  }
  size(): number {
    return this.stores.size;
  }
  clear(): void {
    this.stores.clear();
  }
}

/**
 * Create a store from a state object. Ordinary keys are fast reactive leaves; a key whose
 * value is another store or {@link Lookup} becomes a child, reached with `.select(key)`.
 * The tree is wired once at creation; leaf reads and writes never traverse it, so update
 * and notify throughput are unchanged.
 *
 * @example
 * ```ts
 * const settings = createStore({ theme: 'dark', fontSize: 14 });
 * const workspace = createStore({ name: 'Personal', settings });
 * workspace.setKey('name', 'Team');
 * workspace.select('settings').setKey('fontSize', 16);
 * ```
 */
export function createStore<T extends object>(
  shape: T & { readonly [NODE]?: never },
  options?: StoreOptions<LeafState<T>>
): Store<T>;
export function createStore(
  shape: object,
  options?: object
): unknown {
  if (typeof shape === 'function') {
    throw new TypeError(
      '[voltix] createStore() was given a function. For a store per id, pass the factory to createLookup().'
    );
  }

  if (isNode(shape)) {
    throw new TypeError(
      '[voltix] createStore() was given a store or lookup as the shape. Pass a plain state object, or bind the node under a key: createStore({ child: node }).'
    );
  }

  const source = shape as Record<string, unknown>;
  let leaves: Record<string, unknown> = source;
  let children: Map<PropertyKey, AnyNode> | null = null;
  for (const key in source) {
    const value = source[key];
    if (isNode(value)) {
      if (children === null) children = new Map();
      children.set(key, value);
    }
  }
  if (children !== null) {
    // Copy the leaves over rather than deleting the children out of a clone: a delete
    // can demote the object to a slow dictionary layout, and the store keeps it.
    leaves = {};
    for (const key of Object.keys(source)) {
      if (!children.has(key)) leaves[key] = source[key];
    }
  }

  return new Voltix(
    leaves,
    options as StoreOptions<Record<string, unknown>> | undefined,
    children !== null,
    children
  ) as unknown as NavStore;
}

/**
 * Create a {@link Lookup}: a map from id to store, populated lazily by `factory`.
 *
 * - `createLookup((id) => makeDocument(id))` — the factory builds each store itself
 *   (schema, actions, error handlers already attached); the lookup memoizes exactly
 *   that node.
 * - `createLookup((id) => ({ ... }), options?)` — the factory returns a plain state
 *   shape; the lookup builds a store per id, applying `options` to each one.
 *
 * @example
 * ```ts
 * const documents = createLookup((id: string) => ({ title: 'Untitled', body: '' }));
 * documents.at('readme').setKey('title', 'README');
 * documents.keys(); // ['readme']
 * ```
 */
export function createLookup<Id extends PropertyKey, N extends NodeBrand>(
  factory: (id: Id) => N
): Lookup<Id, N>;
export function createLookup<Id extends PropertyKey, C extends object>(
  factory: (id: Id) => C & { readonly [NODE]?: never },
  options?: StoreOptions<LeafState<C>>
): Lookup<Id, Store<C>>;
export function createLookup(
  factory: (id: PropertyKey) => object,
  options?: object
): unknown {
  return new StoreLookupImpl(factory, options as StoreOptions<any> | undefined);
}

/**
 * Define a set of actions for a store (or any node) and get them back as a plain,
 * standalone object — the store itself is not modified. `define` receives the node,
 * so actions close over it with full inference; since it takes any node, actions can
 * reach across a composed tree with `select(key)` / `at(id)`.
 *
 * Actions are ordinary functions: export them beside the store, and combine sets
 * with object spread when you want them split across files.
 *
 * @example
 * ```ts
 * const counter = createStore({ count: 0 });
 * const counterActions = createActions(counter, (store) => ({
 *   increment: () => store.increment('count'),
 *   reset: () => store.reset(['count']),
 * }));
 * counterActions.increment();
 * ```
 */
export function createActions<S extends object, A extends object>(
  store: S,
  define: (store: S) => A
): A {
  return define(store);
}

/**
 * Shallow-merge helper: `{ ...base, ...patch }`, typed so the patch can only
 * carry keys of the base. A plain function on plain data — pair it with a write
 * when you want the result stored: `store.setKey('user', merge(user, patch))`,
 * or reach for {@link StoreType.mergeSet} which does both in one call.
 */
export function merge<T extends object>(base: T, patch: Partial<T>): T {
  return { ...base, ...patch };
}

/**
 * Interface for synchronous storage (localStorage, sessionStorage, etc.).
 */
export interface StorageSupportingInterface {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Interface for asynchronous storage (React Native AsyncStorage, etc.).
 */
export interface AsyncStorageSupportingInterface {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

type AnyStorage = Storage | StorageSupportingInterface | AsyncStorageSupportingInterface;

function isThenable(value: unknown): value is Promise<unknown> {
  return value != null && typeof (value as any).then === 'function';
}

// Persisted values are wrapped in a tagged form so types JSON can't represent
// (Date, Map, Set, non-finite numbers) survive the round-trip. Plain untagged
// JSON still decodes as itself, so hand-written entries are read fine.
const PERSIST_TAG = '$$voltix';

function encodePersistedValue(value: unknown): unknown {
  if (value === undefined) return { [PERSIST_TAG]: 'undef' };
  if (value instanceof Date) return { [PERSIST_TAG]: 'date', v: value.getTime() };
  if (value instanceof Map) {
    return { [PERSIST_TAG]: 'map', v: Array.from(value, ([k, v]) => [encodePersistedValue(k), encodePersistedValue(v)]) };
  }
  if (value instanceof Set) return { [PERSIST_TAG]: 'set', v: Array.from(value, encodePersistedValue) };
  if (typeof value === 'number' && !Number.isFinite(value)) return { [PERSIST_TAG]: 'num', v: String(value) };
  if (Array.isArray(value)) return value.map(encodePersistedValue);
  if (value !== null && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto === Object.prototype || proto === null) {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value)) {
        const entry = (value as Record<string, unknown>)[key];
        if (entry !== undefined) out[key] = encodePersistedValue(entry);
      }
      // a user object that happens to carry the tag key is escaped, not revived
      return PERSIST_TAG in (value as object) ? { [PERSIST_TAG]: 'obj', v: out } : out;
    }
  }
  return value;
}

function decodePersistedValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodePersistedValue);
  if (value !== null && typeof value === 'object') {
    const tag = (value as Record<string, unknown>)[PERSIST_TAG];
    if (typeof tag === 'string') {
      const v = (value as Record<string, unknown>).v;
      switch (tag) {
        case 'date': return new Date(v as number);
        case 'map': return new Map((v as [unknown, unknown][]).map(([k, val]) => [decodePersistedValue(k), decodePersistedValue(val)]));
        case 'set': return new Set((v as unknown[]).map(decodePersistedValue));
        case 'num': return Number(v);
        case 'undef': return undefined;
        case 'obj': return decodePersistedValue(v);
      }
    }
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      out[key] = decodePersistedValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * Serialization used by {@link persist} and {@link loadPersistedState}.
 * Any object with `stringify`/`parse` fits — `JSON` and superjson both do.
 * Use the same parser on both sides.
 */
export interface PersistParser {
  stringify(value: any): string;
  parse(text: string): any;
}

const defaultPersistParser: PersistParser = {
  stringify: (value) => JSON.stringify(encodePersistedValue(value)),
  parse: (text) => decodePersistedValue(JSON.parse(text)),
};

/**
 * Persist selected keys of a store: each key is written to storage as it changes,
 * under `${persistKey}:${keyName}`. Works with synchronous storage (localStorage,
 * sessionStorage) and asynchronous storage (React Native AsyncStorage) — async
 * writes are fire-and-forget, so a slow write never blocks the state update.
 * Returns an unsubscribe that stops persisting.
 *
 * Seed the initial state with {@link loadPersistedState}, which reads the same keys.
 *
 * @example
 * ```ts
 * const persisted = loadPersistedState<State>(localStorage, 'myapp', ['theme']);
 * const store = createStore<State>({ theme: 'light', ...persisted });
 * persist(store, localStorage, 'myapp', ['theme']);
 * ```
 */
export function persist<T extends object>(
  store: StoreType<T>,
  storage: AnyStorage,
  persistKey: string,
  keys: (keyof T)[],
  parser: PersistParser = defaultPersistParser
): () => void {
  return store.intercept((update) => {
    for (const key of keys) {
      if (!(key in update)) continue;
      try {
        const storageKey = `${persistKey}:${String(key)}`;
        const result = storage.setItem(storageKey, parser.stringify(update[key]));
        if (isThenable(result)) {
          result.catch((error) => {
            console.warn(`Failed to persist key ${String(key)}:`, error);
          });
        }
      } catch (error) {
        console.warn(`Failed to persist key ${String(key)}:`, error);
      }
    }
  }, keys);
}

/**
 * Loads persisted state from individual key storage during store initialization.
 * Reads keys saved by {@link persist} and returns them as partial state.
 * 
 * Returns synchronously for sync storage and a Promise for async storage.
 * 
 * @param storage - Storage interface to read from (same as passed to persist)
 * @param persistKey - Base key prefix used for storage (same as passed to persist)
 * @param keys - Array of keys to restore (should match the persisted keys)
 * @returns Partial state object (sync) or Promise of partial state (async)
 * 
 * @example
 * ```ts
 * // Sync — localStorage
 * const persisted = loadPersistedState(localStorage, 'myapp', ['theme']);
 * const store = createStore({ theme: 'light', ...persisted });
 * 
 * // Async — React Native AsyncStorage
 * const persisted = await loadPersistedState(AsyncStorage, 'myapp', ['theme']);
 * const store = createStore({ theme: 'light', ...persisted });
 * ```
 */
export function loadPersistedState<T extends object>(
  storage: Storage | StorageSupportingInterface,
  persistKey: string,
  keys: (keyof T)[],
  parser?: PersistParser
): Partial<T>;
export function loadPersistedState<T extends object>(
  storage: AsyncStorageSupportingInterface,
  persistKey: string,
  keys: (keyof T)[],
  parser?: PersistParser
): Promise<Partial<T>>;
export function loadPersistedState<T extends object>(
  storage: AnyStorage,
  persistKey: string,
  keys: (keyof T)[],
  parser: PersistParser = defaultPersistParser
): Partial<T> | Promise<Partial<T>> {
  const result: Partial<T> = {};
  const pending: Promise<void>[] = [];

  for (const key of keys) {
    const storageKey = `${persistKey}:${String(key)}`;
    try {
      const stored = storage.getItem(storageKey);
      if (isThenable(stored)) {
        pending.push(
          stored.then(value => {
            if (value !== null) result[key] = parser.parse(value as string) as T[keyof T];
          }).catch(error => {
            console.warn(`Failed to load persisted key ${String(key)}:`, error);
          })
        );
      } else if (stored !== null) {
        result[key] = parser.parse(stored as string) as T[keyof T];
      }
    } catch (error) {
      console.warn(`Failed to load persisted key ${String(key)}:`, error);
    }
  }

  if (pending.length > 0) {
    return Promise.all(pending).then(() => result);
  }

  return result;
}
