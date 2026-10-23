export type RuntimeState = "starting" | "idle" | "running" | "waiting_approval" | "waiting_input" | "pausing" | "recovering" | "failed" | "stopped";
export type ExternalHoldCode = "runtime-version-changed" | "runtime-version-unsupported" | "runtime-unavailable" | "identity-unverified" | "attachment-inconsistent" | "rebind-interrupted" | "runtime-failed";
export type ExternalHoldReason = { code: ExternalHoldCode; message: string; at: string };
export type RuntimeRef = { kind: "codex"; backend?: "herdr-tui" | "external-current-session"; held?: boolean; threadId?: string; activeTurnId?: string; state: RuntimeState; hostInstanceId: string; generation: number; binaryVersion: string; model?: string; effort?: string; lastHeartbeatAt?: string; external?: { socketPath: string; binary: string; bridge: string; detachedAt?: string; holdReason?: ExternalHoldReason; rebind?: { binary: string; binaryVersion: string } } };
export type Goal = { status: string; objective: string; tokenBudget: number | null };
export type RuntimeSnapshot = { threadId: string; state: RuntimeState; activeTurnId?: string; goal: Goal | null };
export type RuntimeControl = {
  inspect(key: string): Promise<RuntimeSnapshot>;
  input(key: string, text: string, operationId: string): Promise<{ turnId: string }>;
  hold(key: string, origin: "user" | "automatic"): Promise<RuntimeSnapshot>;
  release(key: string, origin: "user" | "automatic"): Promise<RuntimeSnapshot>;
  stop(key: string): Promise<void>;
};
