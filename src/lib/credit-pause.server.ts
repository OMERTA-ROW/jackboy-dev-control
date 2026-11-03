import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { CREDIT_PAUSE, isCreditError } from "./work-policy";
export async function recordCreditPause(error: unknown) {
  if (!isCreditError(error)) return false;
  const { data } = await supabaseAdmin.from("update_writer_settings").select("paused_reason").eq("id", 1).single();
  // Credit recovery must never clear owner/cap/permission pauses.
  if (data && !data.paused_reason) await supabaseAdmin.from("update_writer_settings").update({ paused_reason: CREDIT_PAUSE }).eq("id", 1).is("paused_reason", null);
  const { logSite } = await import("./site-log.server");
  if (data?.paused_reason !== CREDIT_PAUSE) await logSite({ actor: "system", action: "updates.credit_pause", category: "config", status: "blocked", summary: `${CREDIT_PAUSE}. Add credits in Lovable Workspace settings → Plans & credits. Automatic balance verification is not connected; no paid request was replayed.` });
  return true;
}