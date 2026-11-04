import { expect, test } from "bun:test";
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
