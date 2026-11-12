import { readGlobalPause } from "./global-pause.server";
import { logSiteStrict } from "./site-log.server";

export async function assertOmniV3SubmitAllowed(
  actor: string,
  jobId: string,
  action: "submit" | "status" | "cancel",
) {
  if (action !== "submit" || !(await readGlobalPause())) return;
  const message = "Kill Switch is on — nothing was sent to OMNI.";
  try {
    await logSiteStrict({
      actor,
      action: "omni.dispatch.v3.blocked_kill_switch",
      category: "delivery",
      status: "blocked",
      summary: message,
      detail: { jobId },
    });
  } catch {
    throw new Error(`${message} The refusal could not be logged.`);
  }
  throw new Error(message);
}
