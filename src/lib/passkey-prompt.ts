// One shared, on-screen passkey window for every confirmation in the app.
// Why: browsers (Safari/iOS especially) only open the device passkey sheet when the WebAuthn call
// starts directly inside a tap. So the challenge is fetched first; if the original tap is still
// "fresh" the device sheet opens straight away, otherwise one tap on the named method opens it.
// Every step has a time limit and a visible result, so the window never hangs.
import type { SavedKey } from "./passkey-method";

export type PasskeyKind = "auth" | "register";
export type Prepared = { kind: PasskeyKind; challengeId: string; options: unknown; keys?: SavedKey[] };
export type PasskeyJob<V, T = V> = {
  title: string;
  description?: string;
  /** e.g. "Passkey 2 of 3 · OMNI" when several confirmations run in a row. */
  step?: string;
  /** Server call that creates a fresh single-use challenge. Runs before the tap. */
  prepare: () => Promise<Prepared>;
  /** Server call that verifies the device response. Runs after the device sheet closes. */
  finish: (challengeId: string, response: unknown) => Promise<V>;
  /** Optional follow-up that uses the verified result (e.g. the grant) to make the change, shown in the same window. */
  apply?: (verified: V) => Promise<T>;
  applyingText?: string;
  successText?: (result: T) => string;
};
export type ActiveJob = PasskeyJob<unknown, unknown> & { id: number; resolve: (v: unknown) => void; reject: (e: Error) => void };

let active: ActiveJob | null = null;
let seq = 0;
const listeners = new Set<(j: ActiveJob | null) => void>();
const emit = () => listeners.forEach((l) => l(active));

export function subscribePasskeyJob(fn: (j: ActiveJob | null) => void): () => void {
  listeners.add(fn);
  fn(active);
  return () => { listeners.delete(fn); };
}

/** Opens the passkey window and resolves with the final result (apply's result when given), or rejects with a plain reason. */
export function requestPasskey<V, T = V>(job: PasskeyJob<V, T>): Promise<T> {
  if (listeners.size === 0) return Promise.reject(new Error("The passkey window isn't ready yet. Reload the page and try again."));
  if (active) return Promise.reject(new Error("Another passkey check is already open. Finish or cancel it first."));
  return new Promise<T>((resolve, reject) => {
    const id = ++seq;
    const done = () => { if (active?.id === id) { active = null; emit(); } };
    active = {
      ...(job as unknown as PasskeyJob<unknown, unknown>), id,
      resolve: (v) => { done(); resolve(v as T); },
      reject: (e) => { done(); reject(e); },
    };
    emit();
  });
}

export const PASSKEY_CANCELLED = "Passkey confirmation cancelled. Nothing was changed.";

/** Time limits per step (ms). The device sheet gets the WebAuthn timeout plus a margin. */
export const PASSKEY_LIMITS = { prepare: 20_000, device: 75_000, verify: 20_000 } as const;
