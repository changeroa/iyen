import { isatty } from "node:tty";
import { ownedFencePids } from "../binding-fence.ts";
import { ownedServicePids } from "./service.ts";
import type { Runner } from "../run.ts";

export type TerminalLaunch = {
  pid: number;
  isTTY: boolean;
  start: (argv: string[], cwd: string) => { pid: number };
};

/** The CLI remains the shell job's supervisor until its native child exits. */
export function terminalLaunch() {
  let child: ReturnType<typeof Bun.spawn> | undefined;
  const interrupt = () => {}; // The foreground process group delivers SIGINT to OMP too.
  const terminate = () => { child?.kill("SIGTERM"); };
  const hangup = () => { child?.kill("SIGHUP"); };
  const removeHandlers = () => { process.off("SIGINT", interrupt); process.off("SIGTERM", terminate); process.off("SIGHUP", hangup); };
  return {
    pid: process.pid, isTTY: isatty(0) && isatty(1),
    get active() { return !!child; },
    start(argv: string[], cwd: string) {
      if (child) throw new Error("Native terminal child already started");
      process.on("SIGINT", interrupt);
      process.on("SIGTERM", terminate); process.on("SIGHUP", hangup);
      try { child = Bun.spawn(argv, { cwd, stdin: "inherit", stdout: "inherit", stderr: "inherit" }); }
      catch (error) { removeHandlers(); throw error; }
      return { pid: child.pid };
    },
    async wait() {
      try { return child ? await child.exited : undefined; }
      finally { removeHandlers(); }
    },
  };
}

/** Prove this exact caller, not another job or a suspended native TUI, owns the shell. */
export async function callerOwnsTerminal(pane: string, runner: Runner, caller: Pick<TerminalLaunch, "pid" | "isTTY">): Promise<boolean> {
  // The read-only probe itself can briefly share the caller's foreground group.
  const probe = (p: any) => p.name?.split("/").at(-1) === "herdr" && Array.isArray(p.argv) &&
    p.argv[0]?.split("/").at(-1) === "herdr" && JSON.stringify(p.argv.slice(1)) === JSON.stringify(["pane", "process-info", "--pane", pane]);
  const inspect = async () => {
    const result = await runner(["herdr", "pane", "process-info", "--pane", pane]);
    if (result.code) throw new Error("Launcher foreground ownership unavailable");
    const info = JSON.parse(result.out)?.result?.process_info;
    if (info?.pane_id !== pane || !Number.isSafeInteger(info.shell_pid) || info.shell_pid <= 0 || !Array.isArray(info.foreground_processes)) throw new Error("Launcher foreground ownership incomplete");
    return info;
  };
  const before = await inspect();
  if (!before.foreground_processes.some((p: any) => p.pid === caller.pid)) return false;
  if (!caller.isTTY) throw new Error("Same-pane OMP launch requires an interactive terminal");
  const result = await runner(["ps", "-axo", "pid=,ppid=,pgid=,comm="]);
  if (result.code || !result.out.trim()) throw new Error("Launcher shell process tree unavailable");
  const rows = result.out.trim().split("\n").map(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!match) throw new Error("Launcher shell process tree incomplete");
    return { pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), name: match[4]!.split("/").at(-1) };
  });
  const helpers = new Set(ownedFencePids()), services = new Set(ownedServicePids());
  const byPid = new Map(rows.map(p => [p.pid, p]));
  if (byPid.size !== rows.length) throw new Error("Launcher shell process tree ambiguous");
  const chain = new Set<number>();
  let pid = caller.pid;
  while (pid !== before.shell_pid) {
    if (chain.has(pid) || !byPid.has(pid)) throw new Error("Launcher is not a child of the target shell");
    chain.add(pid); pid = byPid.get(pid)!.ppid;
  }
  chain.add(pid);
  if ([...helpers].some(pid => byPid.get(pid)?.ppid !== caller.pid || rows.some(row => row.ppid === pid))) throw new Error("Launcher fence helper ownership changed");
  if ([...services].some(pid => byPid.get(pid)?.ppid !== caller.pid || byPid.get(pid)?.pgid !== pid || before.foreground_process_group_id === pid)) throw new Error("Owned service process isolation changed");
  const allowed = new Set([...chain, ...helpers, ...services]);
  if (!byPid.has(pid) || rows.some(p => chain.has(p.ppid) && !allowed.has(p.pid) && !(p.ppid === caller.pid && p.name === "ps")) ||
    !chain.has(before.foreground_process_group_id) || before.foreground_processes.some((p: any) => !allowed.has(p.pid) && !probe(p))) throw new Error("Target shell has another process; refusing duplicate native startup");
  const after = await inspect();
  if (after.shell_pid !== before.shell_pid || after.foreground_process_group_id !== before.foreground_process_group_id ||
    !after.foreground_processes.some((p: any) => p.pid === caller.pid) || after.foreground_processes.some((p: any) => !allowed.has(p.pid) && !probe(p))) throw new Error("Launcher foreground ownership changed");
  return true;
}
