// Pure rule: which link-config check failed. Names the check only — never a value or a derived hint.
import { UUID } from "./omni-session";

export type LinkRefusal =
  | "link_switch_off"
  | "client_id_invalid"
  | "project_id_invalid"
  | "owner_id_invalid"
  | "approval_id_invalid"
  | "approval_expiry_invalid"
  | "approval_expired"
  | "approval_expiry_too_far"
  | "bootstrap_key_invalid"
  | "hmac_secret_invalid"
  | "keys_identical";

export const REFUSAL_TEXT: Record<LinkRefusal, string> = {
  link_switch_off: "link switch OMNI_LINK_ENABLED is not true",
  client_id_invalid: "client ID not set or invalid",
  project_id_invalid: "project ID not set or invalid",
  owner_id_invalid: "owner ID not set or invalid",
  approval_id_invalid: "approval ID not set or invalid",
  approval_expiry_invalid: "approval expiry not set or not a date",
  approval_expired: "approval expired",
  approval_expiry_too_far: "approval expiry more than 24 hours ahead",
  bootstrap_key_invalid: "bootstrap key not set or invalid",
  hmac_secret_invalid: "signing secret not set or too short",
  keys_identical: "bootstrap key and signing secret are the same",
};

/** Mirrors `linkConfig()` check order; returns the first failing check, or null when the config is valid. */
export function linkRefusal(env: Record<string, string | undefined>, now = Date.now()): LinkRefusal | null {
  if (env["OMNI_LINK_ENABLED"] !== "true") return "link_switch_off";
  const v = (k: string) => env[k] || "";
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(v("OMNI_LINK_CLIENT_ID"))) return "client_id_invalid";
  if (!UUID.test(v("OMNI_LINK_PROJECT_ID"))) return "project_id_invalid";
  if (!UUID.test(v("OMNI_LINK_OWNER_ID"))) return "owner_id_invalid";
  if (!UUID.test(v("OMNI_LINK_APPROVAL_ID"))) return "approval_id_invalid";
  const t = Date.parse(v("OMNI_LINK_APPROVAL_EXPIRES_AT"));
  if (!Number.isFinite(t)) return "approval_expiry_invalid";
  if (t <= now) return "approval_expired";
  if (t > now + 86_400_000) return "approval_expiry_too_far";
  const boot = v("OMNI_LINK_BOOTSTRAP_KEY"), secret = v("OMNI_LINK_HMAC_SECRET");
  if (!/^[-_a-zA-Z0-9]{32,256}$/.test(boot)) return "bootstrap_key_invalid";
  if (secret.length < 32) return "hmac_secret_invalid";
  if (boot === secret) return "keys_identical";
  return null;
}

/** One Site Log line per reason per window, so repeated OMNI retries don't flood the log. */
export const REFUSAL_LOG_WINDOW_MS = 10 * 60_000;
