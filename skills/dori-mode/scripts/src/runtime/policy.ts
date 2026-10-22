import type { RuntimeConfig } from "../config.ts";
export class PolicyPending extends Error {}

/** Read only the owned rollout; never infer a turn's effective policy from a TUI banner. */
export const verifyTurnPolicy = async (path: string | null, threadId: string, turnId: string, config: RuntimeConfig): Promise<void> => {
  if (!path) throw new Error("Effective runtime policy evidence unavailable");
  let pending = "", identity = false, policy: any;
  const decoder = new TextDecoder();
  for await (const bytes of Bun.file(path).stream()) {
    pending += decoder.decode(bytes, { stream: true });
    if (pending.length > 16 * 1024 * 1024) throw new Error("Rollout policy frame too large");
    while (pending.includes("\n")) {
      const end = pending.indexOf("\n"), line = pending.slice(0, end); pending = pending.slice(end + 1);
      if (!line.trim()) continue;
      const row = JSON.parse(line);
      if (row.type === "session_meta") identity = row.payload?.id === threadId;
      if (row.type === "turn_context" && row.payload?.turn_id === turnId) policy = row.payload;
    }
  }
  if (!identity) throw new Error("Rollout thread identity mismatch");
  if (!policy) throw new PolicyPending("Effective turn policy not materialized yet");
  if (policy.approval_policy !== config.approvalPolicy || policy.sandbox_policy?.type !== config.sandbox) throw new Error("Effective turn sandbox/approval policy mismatch; task dispatch refused");
};
