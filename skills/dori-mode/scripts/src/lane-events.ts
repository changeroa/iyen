import { statusOf, type Registry } from "./registry.ts";

export type LaneEvent = { lane: string; terminal: string; kind: "created" | "status" | "lost" | "restarted" | "finished" | "removed"; status?: string | null; reason?: string | null };
export type LaneEventSink = (event: LaneEvent) => void | Promise<void>;
export type LaneEventSource = { readonly live: boolean; tracks(terminal: string): boolean; start(sink: LaneEventSink): Promise<void>; stop(): void };
export type HcTransport = { lines: AsyncIterable<string>; write(line: string): void; close(): void };
type Terminal = { address: string; labels?: Record<string, string>; state: string; status?: string | null; reason?: string | null };
/** hc reports the root status as an object carrying its state word. */
const statusWord = (value: unknown): string | null => (value && typeof value === "object" ? (value as { state?: string }).state ?? null : (value as string | null | undefined) ?? null);
type Known = { lane: string; finished: boolean; status: string | null };

export const LANE_LABEL = "dori.lane";
export const MANAGED_LABEL = "dori.managed";

/** Turns hc's snapshot + event stream into at-most-once lifecycle events per terminal transition. */
export class LaneEventTracker {
  private known = new Map<string, Known>();
  tracks(terminal: string): boolean { const k = this.known.get(terminal); return Boolean(k && !k.finished); }
  private seq = -1;
  /** seq restarts with each core process, and a snapshot supersedes everything before it. */
  reconcile(terminals: Terminal[], seq: number): LaneEvent[] {
    this.seq = seq;
    const out: LaneEvent[] = [], seen = new Set<string>();
    for (const t of terminals) {
      const lane = t.labels?.[LANE_LABEL];
      if (!lane) continue;
      seen.add(t.address);
      const prev = this.known.get(t.address), finished = t.state === "finished", status = statusWord(t.status);
      if (!prev && !finished) out.push({ lane, terminal: t.address, kind: "created" });
      if (finished && !prev?.finished) out.push({ lane, terminal: t.address, kind: "finished", reason: t.reason ?? null });
      else if (!finished && (prev ? prev.status !== status : status !== null)) out.push({ lane, terminal: t.address, kind: "status", status });
      this.known.set(t.address, { lane, finished, status });
    }
    for (const [terminal, k] of this.known) if (!seen.has(terminal)) { this.known.delete(terminal); out.push({ lane: k.lane, terminal, kind: "removed" }); }
    return out;
  }
  /** Filtered subscribers legitimately see seq jumps, so only seq <= last is treated as a repeat; loss arrives as `missed`. */
  apply(p: { seq: number; type: string; terminal?: string; data?: any }): LaneEvent[] {
    if (p.seq <= this.seq) return [];
    this.seq = p.seq;
    const terminal = p.terminal;
    if (!terminal) return [];
    if (p.type === "created" || p.type === "restarted") {
      const lane = p.data?.labels?.[LANE_LABEL];
      if (!lane) return [];
      this.known.set(terminal, { lane, finished: false, status: statusWord(p.data.status) });
      return [{ lane, terminal, kind: p.type }];
    }
    const k = this.known.get(terminal);
    if (!k) return [];
    const base = { lane: k.lane, terminal };
    switch (p.type) {
      case "status": { const status = statusWord(p.data?.status); if (status === k.status) return []; k.status = status; return [{ ...base, kind: "status", status }]; }
      case "lost": return [{ ...base, kind: "lost", reason: p.data?.reason ?? null }];
      case "finished": if (k.finished) return []; k.finished = true; return [{ ...base, kind: "finished", reason: p.data?.reason ?? null }];
      case "removed": this.known.delete(terminal); return [{ ...base, kind: "removed" }];
      default: return [];
    }
  }
}

export type HcOptions = { heartbeatTimeoutMs?: number; retryMs?: number; onSync?: () => void | Promise<void> };
export class HcLaneEvents implements LaneEventSource {
  live = false;
  private stopped = false;
  private transport?: HcTransport;
  private tracker = new LaneEventTracker();
  constructor(private connect: () => HcTransport | Promise<HcTransport>, private opts: HcOptions = {}) {}
  /** Rejects when the first subscription cannot be established, so the service can fail fast. */
  start(sink: LaneEventSink): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      void (async () => {
        let first = true;
        while (!this.stopped) {
          try { await this.session(sink, () => { if (first) { first = false; resolve(); } }); } catch (error) { if (first) { this.stopped = true; reject(error); return; } }
          this.live = false;
          if (first) { this.stopped = true; reject(new Error("hc closed before subscribing")); return; }
          if (!this.stopped) await new Promise(r => setTimeout(r, this.opts.retryMs ?? 5000));
        }
      })();
    });
  }
  tracks(terminal: string): boolean { return this.live && this.tracker.tracks(terminal); }
  stop(): void { this.stopped = true; this.live = false; this.transport?.close(); }
  private async session(sink: LaneEventSink, ready: () => void): Promise<void> {
    const transport = this.transport = await this.connect();
    const emit = async (events: LaneEvent[]) => { for (const e of events) { try { await sink(e); } catch { console.error(`LANE_EVENT_ERROR ${e.lane} ${e.kind}`); } } };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => { clearTimeout(timer); timer = setTimeout(() => transport.close(), this.opts.heartbeatTimeoutMs ?? 45_000); };
    try {
      arm();
      transport.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "events.subscribe", params: { labels: { [MANAGED_LABEL]: "1" } } }) + "\n");
      for await (const line of transport.lines) {
        arm();
        const message = JSON.parse(line);
        if (message.id === 1) {
          if (message.error) throw new Error("hc events.subscribe failed");
          await emit(this.tracker.reconcile(message.result.terminals, message.result.seq));
          this.live = true;
          await this.opts.onSync?.();
          ready();
        } else if (message.method === "event") await emit(this.tracker.apply(message.params));
        else if (message.method === "missed") { await emit(this.tracker.reconcile(message.params.terminals, message.params.seq)); await this.opts.onSync?.(); }
      }
    } finally { clearTimeout(timer); transport.close(); }
  }
}

/** `herdr-core connect` resolves the core endpoint itself (HC_SOCKET and config included). */
export const spawnHcTransport = (binary = "herdr-core"): HcTransport => {
  const child = Bun.spawn([binary, "connect"], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  async function* lines() {
    const decoder = new TextDecoder(); let pending = "";
    for await (const chunk of child.stdout as ReadableStream<Uint8Array>) {
      pending += decoder.decode(chunk, { stream: true });
      for (let at; (at = pending.indexOf("\n")) >= 0; pending = pending.slice(at + 1)) if (at) yield pending.slice(0, at);
    }
  }
  return { lines: lines(), write: line => { child.stdin.write(line); child.stdin.flush(); }, close: () => child.kill() };
};

/** A death is reported only while the lane is open and still bound to that terminal, then the binding clears: one report across finished+removed, reconnects and service restarts. */
export const laneEventSink = (registry: Registry, log: (line: string) => void): LaneEventSink => async e => {
  const lane = await registry.read(e.lane);
  if (!lane || statusOf(lane) === "closed" || lane.retirement) return;
  if (e.kind === "created" || e.kind === "restarted") await registry.update(e.lane, l => ({ ...l, hcTerminal: e.terminal }));
  else if (e.kind === "lost") log(`LANE_LOST ${e.lane} ${e.terminal}`);
  else if (e.kind === "finished" || e.kind === "removed") {
    if (lane.hcTerminal !== e.terminal) return;
    await registry.update(e.lane, l => ({ ...l, hcTerminal: undefined }));
    log(`DEAD_PANE ${e.lane} ${e.terminal}`);
  } else if (e.status === "blocked" || e.status === "error") log(`LANE_STATUS ${e.lane} ${e.status}`);
};

/** herdr-core is required: the service refuses to start without a working event subscription. */
export const startLaneEvents = async (registry: Registry, connect: () => HcTransport | Promise<HcTransport> = () => spawnHcTransport(), log: (line: string) => void = console.log): Promise<LaneEventSource> => {
  const source: HcLaneEvents = new HcLaneEvents(connect, { onSync: async () => {
    for (const lane of await registry.open()) if (lane.hcTerminal && !source.tracks(lane.hcTerminal)) {
      const dead = lane.hcTerminal;
      await registry.update(lane.key, l => ({ ...l, hcTerminal: undefined }));
      log(`DEAD_PANE ${lane.key} ${dead}`);
    }
  } });
  try { await source.start(laneEventSink(registry, log)); return source; }
  catch (error) { throw new Error(`herdr-core is required for lane events and is unavailable: ${error instanceof Error ? error.message : String(error)}. Install it from https://herdr.dev/core/`); }
};
