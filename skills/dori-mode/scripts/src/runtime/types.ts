export type RuntimeState = "starting" | "idle" | "running" | "waiting_approval" | "waiting_input" | "pausing" | "recovering" | "failed" | "stopped";
export type RuntimeRef = { kind: "codex"; backend?: "herdr-tui"; held?: boolean; threadId?: string; activeTurnId?: string; state: RuntimeState; hostInstanceId: string; generation: number; binaryVersion: string; model?: string; effort?: string; lastHeartbeatAt?: string };
export type Goal = { status: string; objective: string; tokenBudget: number | null };
export type RuntimeSnapshot = { threadId: string; state: RuntimeState; activeTurnId?: string; goal: Goal | null };
export type RuntimeControl = {
  inspect(key: string): Promise<RuntimeSnapshot>;
  input(key: string, text: string, operationId: string): Promise<{ turnId: string }>;
  hold(key: string, origin: "user" | "automatic"): Promise<RuntimeSnapshot>;
  release(key: string, origin: "user" | "automatic"): Promise<RuntimeSnapshot>;
  stop(key: string): Promise<void>;
};
