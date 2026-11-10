import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { defaultConfig } from "../src/config.ts";
import { ipc, readJson, serviceSocket, socketDir } from "../src/ipc.ts";
import { withState } from "./fakes.ts";
import { drainIngress } from "../src/service.ts";

const producer = (script: string) => Bun.spawn([process.execPath, "-e", script], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
const ready = async (child: ReturnType<typeof producer>) => {
  const reader = child.stderr.getReader(); await reader.read(); reader.releaseLock();
};

test("ingress drain waits for producer final frame, receive completion and exit before returning", async () => {
  const child = producer('process.on("SIGTERM", () => { process.stdout.write("final\\n"); setTimeout(() => process.exit(0), 20); }); console.error("ready"); setInterval(() => {}, 1000);');
  await ready(child);
  let accepted = "";
  const reading = (async () => { for await (const chunk of child.stdout) { await Bun.sleep(35); accepted += new TextDecoder().decode(chunk); } })();
  await drainIngress([child], [reading], 500);
  expect(accepted).toBe("final\n"); expect(child.exitCode).toBe(0);
});

test("ingress drain escalates an uncooperative producer and still awaits reader exit", async () => {
  const child = producer('process.on("SIGTERM", () => {}); console.error("ready"); setInterval(() => {}, 1000);');
  await ready(child); let drained = false;
  const reading = (async () => { for await (const _chunk of child.stdout) {} drained = true; })();
  await drainIngress([child], [reading], 30);
  expect(child.signalCode).toBe("SIGKILL"); expect(drained).toBe(true);
});

test("ingress drain fails closed when an accepted reader cannot settle within the bounded shutdown", async () => {
  let settle!: () => void;
  const reading = new Promise<void>(resolve => { settle = resolve; });
  try { await expect(drainIngress([], [reading], 10)).rejects.toThrow("ownership retained"); }
  finally { settle(); }
});

test("failed service drain rejects authenticated mutation RPC, retains ownership, and lets accepted receive settle", async () => {
  const state = withState(), started = join(state.dir, "receive-started"), release = join(state.dir, "release-receive"), settled = join(state.dir, "receive-settled");
  const config = { ...defaultConfig(state.dir), stateDir: state.dir, ingress: [{ id: "fixture", owners: ["owner"],
    command: [process.execPath, "-e", `console.log(JSON.stringify({id:"accepted",user:"owner",thread:"fixture:owner",text:"last accepted frame"}));`] }] };
  const script = `
    import { existsSync, writeFileSync } from "node:fs";
    import { DoriService, serve } from ${JSON.stringify(join(import.meta.dir, "../src/service.ts"))};
    const receive = DoriService.prototype.receive;
    DoriService.prototype.receive = async function(source, event) {
      writeFileSync(${JSON.stringify(started)}, "started");
      while (!existsSync(${JSON.stringify(release)})) await Bun.sleep(10);
      await receive.call(this, source, event);
      writeFileSync(${JSON.stringify(settled)}, "settled");
    };
    serve(${JSON.stringify(config)}).catch(error => console.log("DRAIN_FAILED " + error.message));
  `;
  const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe", env: process.env });
  let output = "";
  const reading = (async () => { for await (const chunk of child.stdout) output += new TextDecoder().decode(chunk); })();
  const waitFor = async (predicate: () => boolean, timeoutMs = 1500) => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) { if (Date.now() >= deadline) throw new Error(`Timed out: ${output}`); await Bun.sleep(10); }
  };
  try {
    await waitFor(() => output.includes("DORI_SERVICE_READY") && existsSync(started));
    const control = readJson<{ token: string }>(join(state.dir, "control.json"));
    const lock = readJson<any>(join(state.dir, "service.lock")), socket = serviceSocket(state.dir);
    // A real successful mutation establishes that the live RPC path is usable.
    const work = await ipc<any>(socket, control.token, "work-start", { title: "before shutdown", operationId: crypto.randomUUID() });
    expect(work.work.title).toBe("before shutdown");
    child.kill("SIGTERM");
    await waitFor(() => output.includes("DRAIN_FAILED"), 5000);
    expect(child.exitCode).toBeNull();
    await expect(ipc(socket, control.token, "work-start", { title: "must not start", operationId: crypto.randomUUID() })).rejects.toThrow("Service stopping");
    expect(readJson(join(state.dir, "service.lock"))).toEqual(lock);
    expect(existsSync(socket)).toBe(true);
    expect(readJson<any>(join(state.dir, "service-health.json")).phase).toBe("failed");
    writeFileSync(release, "release"); await waitFor(() => existsSync(settled));
    expect(readFileSync(join(state.dir, "inbox.json"), "utf8")).toContain("last accepted frame");
    expect(readJson(join(state.dir, "service.lock"))).toEqual(lock);
    await expect(ipc(socket, control.token, "work-start", { title: "must not start", operationId: crypto.randomUUID() })).rejects.toThrow("Service stopping");
  } finally {
    child.kill("SIGKILL"); await child.exited; await reading;
    rmSync(socketDir(state.dir), { recursive: true, force: true }); state.done();
  }
}, 10000);
