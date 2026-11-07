// Server-only: reads the global Kill Switch for every background and owner-started work path.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { globalPauseReason } from "./global-pause";

export async function readGlobalPause(): Promise<string | null> {
  try {
    const { data, error } = await supabaseAdmin.from("automation_policy").select("paused").eq("id", 1).maybeSingle();
    return globalPauseReason(data, Boolean(error));
  } catch {
    return globalPauseReason(null, true);
  }
}

/** Throws the plain-language reason when work must not start. */
export async function assertWorkAllowed(): Promise<void> {
  const reason = await readGlobalPause();
  if (reason) throw new Error(reason);
}
