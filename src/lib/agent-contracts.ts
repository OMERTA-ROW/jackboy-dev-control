// Reusable agent contracts shared later by Jackboy, OMNI, Razoo, JAX, Guardian. Types only; Jackboy is the first implementation.
// Current Jackboy implementations: VoiceGateway → components/ChatVoice.tsx + routes/api/transcribe.ts;
// GuardianPolicy → voice-guard.ts (+ guardian.ts, automation-policy.ts); AuthorizationService → autoconnect*.ts;
// AgentRuntime → chat.server.ts (tool orchestrator) and foundry*.ts (durable jobs).

export type ToolRisk = "read" | "bounded" | "sensitive" | "destructive" | "production" | "physical";
export type InputChannel = "text" | "voice";
export type StepUp = "none" | "session" | "passkey"; // passkey/WebAuthn not implemented yet

export interface VoiceGateway {
  /** Starts only on an explicit user gesture; never listens in the background. */
  start(): Promise<void>;
  stop(): void;               // also interrupts playback (barge-in)
  speak(text: string): void;  // must never speak secrets
  state: "idle" | "listening" | "processing" | "speaking" | "error";
}

export type AgentIdentity = { agent: "jackboy" | "omni" | "razoo" | "jax" | "guardian"; userId: string; projectId: string | null };

export interface GuardianPolicy {
  /** Minimum proof required for a tool risk on a channel. Voice is intent, never identity. */
  requiredStepUp(risk: ToolRisk, channel: InputChannel): StepUp | "forbidden";
}

export type Grant = { capability: string; projectId: string; state: "not_requested" | "awaiting_setup" | "connected" | "paused" | "revoked"; verifiedAt: string | null; expiresAt: string | null };

export interface AuthorizationService {
  /** Approval only requests consent; access exists only after a provider-native flow and a real verification call. */
  request(capability: string, projectId: string): Promise<Grant>;
  verify(capability: string, projectId: string): Promise<Grant>;
  revoke(capability: string, projectId: string): Promise<Grant>;
}

export interface AgentRuntime {
  run(input: { channel: InputChannel; text: string; identity: AgentIdentity }): Promise<{ toolsRun: string[]; blocked: Array<{ tool: string; reason: string }> }>;
  pause(): Promise<void>;
}

/** Reference policy used by Jackboy today. */
export const jackboyPolicy: GuardianPolicy = {
  requiredStepUp(risk, channel) {
    if (risk === "read") return "session";
    if (risk === "bounded") return "session"; // voice additionally needs an explicit spoken confirm (voice-guard.ts)
    if (risk === "sensitive") return channel === "voice" ? "forbidden" : "session";
    return "passkey"; // destructive/production/physical: not available until WebAuthn step-up exists → effectively blocked
  },
};
