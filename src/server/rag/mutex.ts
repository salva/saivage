/**
 * F02 B04 — Single-flight control mutex for `rag_register`/`rag_drop`/`rag_admin`.
 *
 * `tryRunExclusive` returns `{ ok: false }` immediately when the slot is
 * busy. On `{ ok: true }` it returns a Promise that resolves with the
 * function's result; the busy flag is always released on completion, even
 * if `fn` throws synchronously, because `fn` is invoked inside a
 * `Promise.resolve().then(...)` chain.
 */

export interface ControlState {
  busy: boolean;
}

export type TryRunExclusiveResult<T> =
  | { ok: true; value: Promise<T> }
  | { ok: false };

export function tryRunExclusive<T>(
  state: ControlState,
  fn: () => Promise<T> | T,
): TryRunExclusiveResult<T> {
  if (state.busy) return { ok: false };
  state.busy = true;
  const value = Promise.resolve()
    .then(fn)
    .finally(() => {
      state.busy = false;
    });
  return { ok: true, value };
}
