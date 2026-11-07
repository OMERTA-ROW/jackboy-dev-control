// One shared, on-screen passkey window for every confirmation in the app.
// Why: browsers (Safari/iOS especially) only open the device passkey sheet when the WebAuthn call
// starts directly inside a tap. So the challenge is fetched first, then the owner taps
// "Use passkey", and that tap calls the browser immediately — no network wait in between.
export type PasskeyKind = "auth" | "register";
export type Prepared = { kind: PasskeyKind; challengeId: string; options: unknown };
export type PasskeyJob<T> = {
  title: string;
  description?: string;
  /** Server call that creates a fresh single-use challenge. Runs before the tap. */
  prepare: () => Promise<Prepared>;
  /** Server call that verifies the device response. Runs after the device sheet closes. */
  finish: (challengeId: string, response: unknown) => Promise<T>;
  successText?: (result: T) => string;
};
export type ActiveJob = PasskeyJob<unknown> & { id: number; resolve: (v: unknown) => void; reject: (e: Error) => void };

let active: ActiveJob | null = null;
let seq = 0;
const listeners = new Set<(j: ActiveJob | null) => void>();
const emit = () => listeners.forEach((l) => l(active));

export function subscribePasskeyJob(fn: (j: ActiveJob | null) => void): () => void {
  listeners.add(fn);
  fn(active);
  return () => { listeners.delete(fn); };
}

/** Opens the passkey window and resolves with the verified server result, or rejects with a plain reason. */
export function requestPasskey<T>(job: PasskeyJob<T>): Promise<T> {
  if (listeners.size === 0) return Promise.reject(new Error("The passkey window isn't ready yet. Reload the page and try again."));
  if (active) return Promise.reject(new Error("Another passkey check is already open. Finish or cancel it first."));
  return new Promise<T>((resolve, reject) => {
    const id = ++seq;
    const done = () => { if (active?.id === id) { active = null; emit(); } };
    active = {
      ...(job as PasskeyJob<unknown>), id,
      resolve: (v) => { done(); resolve(v as T); },
      reject: (e) => { done(); reject(e); },
    };
    emit();
  });
}

export const PASSKEY_CANCELLED = "Passkey confirmation cancelled. Nothing was changed.";
