import type { Ran, RunOptions, Runner } from "../run.ts";

export const HC_BINARY = "herdr-core";
export const isHcTerminal = (pane: unknown): pane is string => typeof pane === "string" && /^t\d+[a-z0-9]*$/.test(pane);
const SHELLS = new Set(["sh", "bash", "zsh", "fish", "dash", "nu", "login"]);
const ok = (result: unknown): Ran => ({ code: 0, out: JSON.stringify({ result }), err: "" });
const shellQuote = (arg: string) => `'${arg.replace(/'/g, `'\\''`)}'`;
const statusWord = (value: any): string | null => (value && typeof value === "object" ? value.state ?? null : value ?? null);

/** Creates the labelled hc terminal a lane lives in. A failure here is fatal: there is no herdr fallback. */
export const createLaneTerminal = async (run: Runner, key: string, cwd: string): Promise<string> => {
  const made = await run([HC_BINARY, "run", "--bg", "--json", "--no-parent", "--outlive-parent", "--no-notify", "--cwd", cwd, "--label", "dori.managed=1", "--label", `dori.lane=${key}`]);
  if (made.code !== 0) throw new Error(`herdr-core is required to launch lanes and is unavailable: ${made.err || made.out || "hc run failed"}`);
  return JSON.parse(made.out).address as string;
};

/** Serves the herdr pane/agent verbs the Codex session host uses when its pane is an hc terminal. */
export const withHcPanes = (run: Runner): Runner => async (argv, opts) => {
  const [bin, group, action, ...rest] = argv;
  if (bin !== "herdr" || !group || !action) return run(argv, opts);
  const flag = (name: string) => { const at = rest.indexOf(name); return at >= 0 ? rest[at + 1] : undefined; };
  const target = group === "agent" && action === "start" ? flag("--pane") : rest[0];
  if (!isHcTerminal(target)) return run(argv, opts);
  const hc = (...args: string[]) => run([HC_BINARY, ...args], opts);
  const describe = async () => {
    const got = await hc("get", "--json", target);
    if (got.code !== 0) return null;
    const t = JSON.parse(got.out), fg = t.foreground?.name, running = t.state === "live" && Boolean(fg) && !SHELLS.has(fg);
    return { t, kind: running ? t.labels?.["dori.agent-kind"] as string | undefined : undefined };
  };
  // Codex reports idle over OSC 7501 only once its composer is up; sign-in and dialogs report nothing.
  const ready = (d: { t: any; kind?: string }) => Boolean(d.kind) && d.t.reported === true && statusWord(d.t.status) === "idle";
  // Input sent before a fresh login shell draws its prompt can be lost.
  const shellPainted = async () => {
    for (const deadline = Date.now() + 15_000; Date.now() < deadline; await Bun.sleep(50)) {
      const screen = await hc("read", target, "--lines", "0");
      if (screen.code === 0 && screen.out.trim()) return true;
    }
    return false;
  };
  const key = `${group} ${action}`;
  switch (key) {
    case "pane get": case "agent get": {
      const d = await describe();
      if (!d) return { code: 1, out: "", err: JSON.stringify({ error: { code: "pane_not_found" } }) };
      const base = { pane_id: target, terminal_id: target, tab_id: target, workspace_id: "hc", cwd: d.t.foreground?.cwd ?? d.t.cwd, agent: d.kind };
      if (key === "pane get") return ok({ pane: base });
      const session = d.t.labels?.["dori.agent-session"];
      return ok({ agent: { ...base, name: d.t.labels?.["dori.agent-name"], interactive_ready: ready(d), launch_pending: !ready(d), agent_status: statusWord(d.t.status) ?? "idle", ...(session ? { agent_session: { agent: d.kind, kind: "id", value: session } } : {}) } });
    }
    case "pane run": { if (!(await shellPainted())) return { code: 1, out: "", err: JSON.stringify({ error: { code: "shell_not_ready" } }) }; return hc("send", target, "--", rest[1]!); }
    case "agent prompt": return hc("send", target, "--", rest[1]!);
    case "agent send-keys": return hc("keys", target, ...rest.slice(1));
    case "agent read": { const r = await hc("read", target, "--lines", flag("--lines") ?? "20"); return r.code === 0 ? { ...r, out: r.out } : r; }
    case "pane report-agent-session": { const r = await hc("label", target, `dori.agent-session=${flag("--agent-session-id")}`); return r.code === 0 ? ok({}) : r; }
    case "pane close": { await hc("kill", target); const removed = await hc("rm", target); return removed.code === 3 ? ok({}) : removed; }
    case "agent start": {
      const split = rest.indexOf("--"), kind = flag("--kind")!, name = rest[0]!;
      const labelled = await hc("label", target, `dori.agent-kind=${kind}`, `dori.agent-name=${name}`);
      if (labelled.code !== 0) return labelled;
      const program = Bun.which(flag("--binary") ?? kind) ?? kind; // A bare name can resolve to a different install in the login shell.
      const sent = await hc("send", target, "--", [program, ...rest.slice(split + 1)].map(shellQuote).join(" "));
      if (sent.code !== 0) return sent;
      const deadline = Date.now() + Number(flag("--timeout") ?? 30000);
      for (;;) {
        const d = await describe();
        if (d && ready(d)) return ok({});
        if (Date.now() >= deadline) return { code: 1, out: "", err: JSON.stringify({ error: { code: "agent_not_ready" } }) };
        await Bun.sleep(100);
      }
    }
    default: return { code: 1, out: "", err: JSON.stringify({ error: { code: "hc_unsupported" } }) };
  }
};
