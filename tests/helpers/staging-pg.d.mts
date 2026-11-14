// Types for the isolated database helpers when imported from TypeScript tests.
export const supabaseStubs: string;
export function migrationFiles(): Promise<string[]>;
export function waitForLock(
  db: { query: (sql: string, params: number[]) => Promise<{ rows: { wait_event_type: string }[] }> },
  pid: number,
  timeoutMs?: number,
): Promise<void>;
