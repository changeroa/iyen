import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
type HeldFence = { assertAlive(): void; release(): Promise<void>; command(argv: readonly string[], timeoutMs: number): Promise<{ code: number; out: string; err: string }> };
const helpers = new Map<number, () => void>();
/** Exact live helpers owned by this process, never inferred from executable names. */
export const ownedFencePids = (): number[] => { for (const assertAlive of helpers.values()) assertAlive(); return [...helpers.keys()]; };
const owned = new AsyncLocalStorage<ReadonlyMap<string, HeldFence>>();
// A persistent file is only a lock address. The kernel owns exclusivity and
// owner death closes stdin. A protected child finishes before the helper exits.
const acquireKernelFence = async (path: string, timeoutMs: number, signal?: AbortSignal): Promise<HeldFence> => {
  if (signal?.aborted) throw new Error("Fence acquisition cancelled");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // Terminal Ctrl-C belongs to the native TUI, not the exclusivity helper.
  // A separate session still releases on owner EOF through the private pipe.
  const child = Bun.spawn(["python3", join(import.meta.dir, "binding-lock.py"), path, String(timeoutMs)], { stdin: "pipe", stdout: "pipe", stderr: "ignore", detached: true });
  const cancel = () => { try { child.kill("SIGKILL"); } catch {} };
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  const reader = child.stdout.getReader();
  const line = async () => {
    const result = await reader.read();
    if (result.done) throw new Error("Fence helper unavailable");
    return new TextDecoder().decode(result.value).trim();
  };
  const deadline = setTimeout(cancel, timeoutMs + 1000);
  try { if (await line() !== "locked" || signal?.aborted) throw new Error("Fence unavailable or cancelled"); }
  catch (error) { cancel(); await child.exited; reader.releaseLock(); throw error; }
  finally { clearTimeout(deadline); signal?.removeEventListener("abort", cancel); }
  // After acquisition, cancellation belongs to the action. Never kill the
  // helper while its queue child may still be submitting under this fence.
  let releasing = false;
  const lost = (): never => {
    // Rejecting an action leaves its suspended continuation alive. Stop only
    // this owning Bun process so it cannot commit or poll without exclusivity.
    process.stderr.write("IYEN_FENCE_LOST: stopping owner after lock helper exit\n");
    process.exit(74);
  };
  const assertAlive = () => { if (child.exitCode !== null || child.signalCode) lost(); };
  helpers.set(child.pid, assertAlive);
  void child.exited.then(code => { if (!releasing || code !== 0 || child.signalCode) lost(); });
  return {
    assertAlive,
    release: async () => { assertAlive(); releasing = true; child.stdin.end(); await child.exited; helpers.delete(child.pid); reader.releaseLock(); },
    command: async (argv, timeoutMs) => {
      assertAlive();
      child.stdin.write(JSON.stringify({ argv, timeoutMs }) + "\n"); child.stdin.flush();
      const result = JSON.parse(await line());
      return { code: Number.isInteger(result.code) ? result.code : 124, out: "", err: "" };
    },
  };
};
export const acquireFileFence = async (path: string, timeoutMs = 5000, signal?: AbortSignal): Promise<() => Promise<void>> => (await acquireKernelFence(path, timeoutMs, signal)).release;
const fencePath = (dir: string) => join(dir, "binding-fence.lock");
export const runBindingCommand = async (dir: string, argv: readonly string[], timeoutMs: number) => {
  const fence = owned.getStore()?.get(fencePath(dir));
  if (!fence) throw new Error("Protected submission requires binding fence");
  return fence.command(argv, timeoutMs);
};
export const withBindingFence = async <T>(dir: string, action: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
  const path = fencePath(dir);
  const prior = owned.getStore()?.get(path);
  if (prior) { prior.assertAlive(); return action(); }
  const fence = await acquireKernelFence(path, 5000, signal);
  try { fence.assertAlive(); return await owned.run(new Map([...(owned.getStore() ?? []), [path, fence]]), action); }
  finally { await fence.release(); }
};
