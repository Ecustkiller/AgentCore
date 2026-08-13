import { useCallback, useRef } from "react";
import { useSearchParams } from "react-router-dom";

/**
 * Filter state lives in the URL so a filtered view can be bookmarked, shared with
 * another operator, and survive a reload — the whole point of an admin console being
 * a web app rather than the desktop client.
 *
 * Conventions this encodes, so every list page behaves the same:
 *
 * - **Param names mirror the backend query fields** (`q`, `role`, `since`, …). One
 *   vocabulary end to end; no translation table to keep in sync.
 * - **Defaults are omitted.** A value equal to its fallback deletes the param, so an
 *   unfiltered page is a bare `/users` and a shared link carries only what was
 *   actually narrowed. Clearing filters leaves no residue.
 * - **Unparseable values fall back** rather than throwing or rendering an empty table.
 *   A hand-edited `?role=banana` degrades to "all"; a stale link never hard-fails.
 * - **Writes replace, not push.** A debounced search box that pushes per keystroke
 *   buries the previous page under a dozen history entries, so Back stops working as
 *   an escape hatch. Same choice `useAdminListPage` already makes for `?page=`.
 * - **Changing a filter drops `page`.** Page 4 of the old result set is meaningless
 *   under a new filter, and the two params must move in a single navigation — writing
 *   them separately renders an intermediate state (old page + new filter) that fires a
 *   wasted request and can land out of order.
 *
 * `schema` must be a module-level constant: it is read on every render, and rebuilding
 * it inline would be wasted work, not a correctness bug.
 */
export type Codec<T> = {
  parse: (raw: string | null) => T;
  /** Return null to omit the param entirely (value is at its default). */
  encode: (value: T) => string | null;
};

/**
 * `Codec<T>` is invariant in T (T sits in `encode`'s parameter), so no single concrete
 * codec type can bound a heterogeneous schema. This is the one escape hatch; call
 * sites still get exact types back through `Values<S>`.
 */
// biome-ignore lint/suspicious/noExplicitAny: see above
type AnyCodec = Codec<any>;

type Values<S> = { [K in keyof S]: S[K] extends Codec<infer T> ? T : never };

/** Free text. Empty string is the default and stays out of the URL. */
export function str(fallback = ""): Codec<string> {
  return {
    parse: (raw) => raw ?? fallback,
    encode: (v) => (v === fallback ? null : v),
  };
}

/** Flag written as `1`/`0`; anything else parses as the fallback. */
export function bool(fallback: boolean): Codec<boolean> {
  return {
    parse: (raw) => {
      if (raw === "1") return true;
      if (raw === "0") return false;
      return fallback;
    },
    encode: (v) => (v === fallback ? null : v ? "1" : "0"),
  };
}

/** Closed set — the guard against a hand-edited value reaching the API. */
export function oneOf<T extends string>(
  allowed: readonly T[],
  fallback: T,
): Codec<T> {
  return {
    parse: (raw) =>
      raw !== null && (allowed as readonly string[]).includes(raw)
        ? (raw as T)
        : fallback,
    encode: (v) => (v === fallback ? null : v),
  };
}

/** `YYYY-MM-DD` as produced by `<input type="date">`; junk degrades to unset. */
export function date(): Codec<string> {
  return {
    parse: (raw) => (raw && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : ""),
    encode: (v) => v || null,
  };
}

export function useUrlFilters<S extends Record<string, AnyCodec>>(
  schema: S,
): {
  values: Values<S>;
  set: (patch: Partial<Values<S>>) => void;
  reset: () => void;
} {
  const [searchParams, setSearchParams] = useSearchParams();

  // RR hands back a fresh setter whenever the search string changes; holding it in a
  // ref keeps `set`/`reset` identity stable so they are safe in effect deps.
  const setSearchParamsRef = useRef(setSearchParams);
  setSearchParamsRef.current = setSearchParams;
  const schemaRef = useRef(schema);
  schemaRef.current = schema;

  const values = {} as Values<S>;
  for (const key of Object.keys(schemaRef.current) as (keyof S)[]) {
    (values as Record<keyof S, unknown>)[key] = schemaRef.current[key].parse(
      searchParams.get(key as string),
    );
  }

  const set = useCallback((patch: Partial<Values<S>>) => {
    setSearchParamsRef.current(
      (prev) => {
        const sp = new URLSearchParams(prev);
        for (const [key, value] of Object.entries(patch)) {
          const codec = schemaRef.current[key];
          if (!codec) continue;
          const encoded = codec.encode(value);
          if (encoded === null) sp.delete(key);
          else sp.set(key, encoded);
        }
        sp.delete("page");
        return sp;
      },
      { replace: true },
    );
  }, []);

  // Only the keys this page owns: sibling params (a `user_id` scope, a tab segment)
  // are somebody else's state and must survive a filter reset.
  const reset = useCallback(() => {
    setSearchParamsRef.current(
      (prev) => {
        const sp = new URLSearchParams(prev);
        for (const key of Object.keys(schemaRef.current)) sp.delete(key);
        sp.delete("page");
        return sp;
      },
      { replace: true },
    );
  }, []);

  return { values, set, reset };
}
