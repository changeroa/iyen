import { join } from "node:path";
import { acquireFileFence, ownedFencePids } from "../../src/binding-fence.ts";
import { callerOwnsTerminal, terminalLaunch } from "../../src/launcher/terminal.ts";
import { ensureService, ownedServicePids, alive } from "../../src/launcher/service.ts";
import { defaultConfig } from "../../src/config.ts";
import { atomicJson } from "../../src/journal.ts";
import { run, type Runner } from "../../src/run.ts";
const [mode, dir] = process.argv.slice(2);
if (mode === "native") {
  console.log(`NATIVE_READY ${process.pid}`);
  process.stdin.on("data", data => console.log(`NATIVE_INPUT ${String(data).trim()}`));
  process.on("SIGINT", () => { console.log("NATIVE_SIGINT"); process.exit(0); });
  process.on("SIGTERM", () => { console.log("NATIVE_SIGTERM"); process.exit(0); });
  setInterval(() => {}, 1000);
} else {
  const terminal = terminalLaunch();
  const releaseA = await acquireFileFence(join(dir!, "registry.lock"));
  const releaseB = await acquireFileFence(join(dir!, "state.lock"));
  const runner: Runner = async args => {
    if (args[0] !== "herdr") return run(args);
    const result = await run(["ps", "-axo", "pid=,ppid=,pgid=,comm="]);
    const rows = result.out.trim().split("\n").map(line => { const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line)!; return { pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), name: m[4]!.split("/").at(-1) }; });
    const own = rows.find(p => p.pid === process.pid)!;
    return { code: 0, err: "", out: JSON.stringify({ result: { process_info: { pane_id: "fixture", shell_pid: Number(process.env.FIXTURE_SHELL_PID), foreground_process_group_id: own.pgid,
      foreground_processes: rows.filter(p => p.pgid === own.pgid && p.name !== "ps") } } }) };
  };
  let sibling: ReturnType<typeof Bun.spawn> | undefined;
  try {
    if (mode === "service") {
      const config = defaultConfig(dir!); config.stateDir = join(dir!, "state"); config.defaultCwd = dir!; config.runtime.startupTimeoutMs = 5000;
      const profile = { configPath: join(dir!, "config.json") }; atomicJson(profile.configPath, config);
      await ensureService({ config, profile, kind: "codex", registryPath: join(dir!, "registry.json"), registered: [] }, false, run);
      console.log(`OWNED_SERVICE ${ownedServicePids().length}`);
    }
    if (mode === "sibling") sibling = Bun.spawn([process.execPath, "-e", "setInterval(()=>{},1000)"], { stdout: "ignore", stderr: "ignore" });
    const proven = await callerOwnsTerminal("fixture", runner, terminal);
    if (!proven) throw new Error("proof missing");
    console.log(`PROVEN ${process.pid} ${ownedFencePids().length}`);
    terminal.start([process.execPath, import.meta.path, "native", dir!], process.cwd());
    if (mode === "failure") throw new Error("fixture startup verification failed");
  } catch (error) { console.log(`FAILURE ${String(error)}`); }
  finally {
    const code = await terminal.wait();
    if (sibling) { sibling.kill(); await sibling.exited; }
    for (const pid of ownedFencePids()) process.kill(pid, 0);
    console.log(`REAPED ${code} FENCES ${ownedFencePids().length}`);
    for (const pid of ownedServicePids()) {
      process.kill(pid, "SIGTERM"); const deadline = Date.now() + 3000;
      while (alive(pid) && Date.now() < deadline) await Bun.sleep(10);
      if (alive(pid)) throw new Error("Owned fixture service failed to stop");
    }
    await releaseB(); await releaseA();
    console.log(`DONE FENCES ${ownedFencePids().length}`);
  }
}
