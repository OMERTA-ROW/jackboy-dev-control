// Live check: spoken command → guarded shared tool → real backend result for OMNI. Run: bun scripts/voice-omni-e2e.ts
import { supabaseAdmin } from "../src/integrations/supabase/client.server.ts";
import { buildJackboyTools, guardTools } from "../src/lib/jackboy-tools.server.ts";
import { decideTool, liveMessagesForGuard, PRIVILEGED_TOOLS } from "../src/lib/voice-guard.ts";
const { data: r } = await supabaseAdmin.from("user_roles").select("user_id").eq("role", "owner").single();
const uid = r!.user_id as string;
const run = async (turns: string[], name: string, input: unknown) => {
  const g = liveMessagesForGuard(turns.map((t, i) => ({ role: i % 2 ? "assistant" : "user", content: t })));
  const tools = guardTools(buildJackboyTools(uid) as any, uid, (n) => decideTool(n, g), PRIVILEGED_TOOLS) as any;
  const out = await tools[name].execute(input, {});
  console.log(`\n### voice: "${turns.at(-1)}" → ${name}\n`, JSON.stringify(out).slice(0, 700));
};
await run(["what's the connection status for OMNI internal build"], "connectionStatus", { project: "OMNI internal build" });
await run(["what's in OMNI's queue"], "foundryQueue", { project: "OMNI internal build" });
await run(["inspect OMNI"], "foundryInspect", { project: "OMNI internal build" });
await run(["inspect OMNI", "I'll run a Code Foundry inspection on OMNI internal build. Say confirm.", "confirm"], "foundryInspect", { project: "OMNI internal build" });
await run(["turn on background work for OMNI", "Say confirm.", "confirm"], "setDevEnabled", { project: "OMNI internal build", on: false });
await run(["check OMNI's site"], "checkSite", { project: "OMNI internal build" });
