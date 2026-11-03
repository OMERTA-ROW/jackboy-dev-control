import type { SupabaseClient } from "@supabase/supabase-js";
/** Tables/RPCs from migrations not yet applied (0036–0038) are missing from generated types.
 * Use only where those objects are referenced; queries still fail at runtime until the migrations run. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const untyped = (c: unknown) => c as SupabaseClient<any, "public", any>;
