import type { FlowDeps } from "./done-flow.ts";
import { statusOf } from "./registry.ts";

type Agent = { agent?: string; pane_id?: string; agent_status?: string; agent_session?: { agent?: string; kind?: string; value?: string } };
type ProgressStatus = "working" | "blocked" | "idle";

const status = (value: string | undefined): ProgressStatus | null =>
  value === "done" || value === "idle" ? "idle" : value === "working" || value === "blocked" ? value : null;

const message = (key: string, value: ProgressStatus): string => value === "working"
  ? `${key === "lead" ? "이연" : `작업자 ${key}`}: 작업 진행 중입니다.`
  : value === "blocked" ? `${key === "lead" ? "이연" : `작업자 ${key}`}: 입력 또는 승인을 기다리고 있습니다.`
  : `${key === "lead" ? "이연" : `작업자 ${key}`}: 현재 응답을 마쳤습니다.`;

const activeLead = (lead: Awaited<ReturnType<FlowDeps["registry"]["read"]>>): boolean =>
  lead?.runtime?.backend === "external-current-session" && !lead.dispatchBlocked && !lead.runtime.held &&
  !lead.runtime.external?.detachedAt && ["idle", "running"].includes(lead.runtime.state);

/** Herdr is observed only while an Iyen lead is attached. */
export const herdrProgressTick = async (deps: FlowDeps, leadThreadForTurn: (turnId: string, instance: string) => string | undefined = () => undefined): Promise<void> => {
  const lead = await deps.registry.read("lead");
  if (!activeLead(lead)) return;
  const hook = deps.config.hooks.threadReply;
  if (!hook || !deps.post) return;
  const result = await deps.run(["herdr", "agent", "list"]);
  if (result.code !== 0) throw new Error("Herdr agent list unavailable");
  const agents = (JSON.parse(result.out) as { result?: { agents?: Agent[] } }).result?.agents;
  if (!Array.isArray(agents)) throw new Error("Herdr agent list invalid");
  const byPane = new Map(agents.map(agent => [agent.pane_id, agent]));
  for (const lane of await deps.registry.open()) {
    const runtime = lane.runtime;
    if (statusOf(lane) !== "working" || lane.dispatchBlocked ||
        !lane.pane || !runtime?.threadId || !runtime.hostInstanceId) continue;
    const agent = byPane.get(lane.pane);
    if (agent?.agent !== "codex" || agent.pane_id !== lane.pane || agent.agent_session?.agent !== "codex" ||
        agent.agent_session.kind !== "id" || agent.agent_session.value !== runtime.threadId) continue;
    const observed = status(agent.agent_status);
    if (!observed) continue;
    const previousProgress = lane.herdrProgress?.instance === runtime.hostInstanceId ? lane.herdrProgress : undefined;
    const previous = previousProgress?.status;
    const turnId = observed === "idle" ? previousProgress?.turnId : runtime.activeTurnId;
    const thread = lane.role === "lead" ? observed === "idle" ? previousProgress?.thread : turnId ? leadThreadForTurn(turnId, runtime.hostInstanceId) : undefined : lane.thread;
    if (!thread || thread === "none" || (lane.role === "lead" && observed !== "idle" && !turnId)) continue;
    if (previous === observed && previousProgress?.turnId === turnId && previousProgress?.thread === thread) continue;
    const sequence = (lane.herdrProgress?.sequence ?? 0) + 1;
    const updated = await deps.registry.update(lane.key, current =>
      current.runtime?.hostInstanceId !== runtime.hostInstanceId || current.runtime?.threadId !== runtime.threadId ||
      current.pane !== lane.pane || current.dispatchBlocked || statusOf(current) !== "working" ||
      current.thread !== lane.thread ? current :
        { ...current, herdrProgress: { instance: runtime.hostInstanceId, status: observed, sequence, turnId, thread } });
    if (updated.herdrProgress?.instance !== runtime.hostInstanceId || updated.herdrProgress.sequence !== sequence) continue;
    if (observed === "idle" && !previous) continue;
    const currentLead = await deps.registry.read("lead");
    if (!activeLead(currentLead) || currentLead?.runtime?.hostInstanceId !== lead?.runtime?.hostInstanceId) return;
    const currentLane = await deps.registry.read(lane.key);
    if (currentLane?.runtime?.hostInstanceId !== runtime.hostInstanceId || currentLane.thread !== lane.thread ||
        currentLane.dispatchBlocked || statusOf(currentLane) !== "working") continue;
    await deps.post(`herdr-progress:${lane.key}:${runtime.hostInstanceId}:${sequence}`, hook,
      { key: lane.key, thread, text: message(lane.key, observed) });
    await deps.registry.update(lane.key, current => current.herdrProgress?.instance === runtime.hostInstanceId &&
      current.herdrProgress.sequence === sequence ? { ...current, lastReplyAt: deps.clock.now(), lastAutoReplyAt: deps.clock.now() } : current);
  }
};
