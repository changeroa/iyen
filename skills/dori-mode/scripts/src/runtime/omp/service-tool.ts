import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isAbsolute } from "node:path";
import { OMP_MAX_FRAME_BYTES, OmpError, nonempty, object, type OmpExtensionBootstrap } from "./contract.ts";
export type OmpServiceTool = { call(action: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>; close(): void };
export function scopedServiceEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "XDG_CONFIG_HOME"].filter(key => source[key] !== undefined).map(key => [key, source[key]]));
}
/** The existing scoped MCP server remains the authorization boundary. No shell and no retry. */
export async function connectServiceTool(service: NonNullable<OmpExtensionBootstrap["service"]>, options: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): Promise<OmpServiceTool> {
  if (!Object.values(service).every(path => nonempty(path) && isAbsolute(path))) throw new OmpError("invalid-service-path", "Scoped service paths must be explicit absolute paths", false);
  const child: ChildProcessWithoutNullStreams = spawn(service.bunBinary, [service.cliPath, "mcp-server"], { stdio: ["pipe", "pipe", "pipe"],
    env: { ...scopedServiceEnvironment(options.env ?? process.env), DORI_CONTEXT: service.contextFile, DORI_CONFIG: service.configFile, DORI_STATE_DIR: service.stateDir } });
  let ended = false, sequence = 0, buffer = Buffer.alloc(0);
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  const close = () => {
    if (ended) return; ended = true;
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new OmpError("service-disconnected", "Scoped service result unknown")); }
    pending.clear(); child.stdin.end(); child.kill("SIGTERM");
  };
  child.once("error", close); child.once("exit", close); child.stderr.resume();
  child.stdin.on("error", close); child.stdout.on("error", close);
  child.stdout.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const at = buffer.indexOf(10);
      if (at < 0) { if (buffer.length > OMP_MAX_FRAME_BYTES) close(); return; }
      if (at > OMP_MAX_FRAME_BYTES) { close(); return; }
      const line = buffer.subarray(0, at); buffer = buffer.subarray(at + 1);
      try {
        const message: unknown = JSON.parse(line.toString("utf8"));
        if (!object(message) || message.jsonrpc !== "2.0" || typeof message.id !== "number" || (!Object.hasOwn(message, "result") && !Object.hasOwn(message, "error"))) throw new Error();
        const entry = pending.get(message.id); if (!entry) continue;
        clearTimeout(entry.timer); pending.delete(message.id);
        if (message.error) entry.reject(new OmpError("service-rpc-error", "Scoped service request failed; outcome unknown")); else entry.resolve(message.result);
      } catch { close(); return; }
    }
  });
  const request = (method: string, params: unknown): Promise<unknown> => new Promise((resolve, reject) => {
    if (ended) { reject(new OmpError("service-closed", "Scoped service closed; outcome unknown")); return; }
    const id = ++sequence, frame = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    if (Buffer.byteLength(frame) > OMP_MAX_FRAME_BYTES) { reject(new OmpError("service-frame-limit", "Scoped service request too large", false)); return; }
    const timer = setTimeout(() => { pending.delete(id); reject(new OmpError("service-timeout", "Scoped service result unknown; never retry automatically")); }, options.timeoutMs ?? 15000);
    pending.set(id, { resolve, reject, timer }); child.stdin.write(frame, error => { if (error) close(); });
  });
  try {
    const initialized = await request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "iyen-omp", version: "1" } });
    if (!object(initialized) || initialized.protocolVersion !== "2024-11-05") throw new OmpError("service-incompatible", "Scoped MCP protocol mismatch", false);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const listed = await request("tools/list", {});
    if (!object(listed) || !Array.isArray(listed.tools) || !listed.tools.some(tool => object(tool) && tool.name === "control")) throw new OmpError("service-tool-unavailable", "Scoped MCP control tool unavailable", false);
  } catch (error) { close(); throw error; }
  return { close, async call(action, args, signal) {
    if (!nonempty(action) || !object(args) || signal?.aborted) throw new OmpError("service-call-refused", "Scoped service call refused before submission", false);
    // Cancellation after write is not proof that a mutation was prevented.
    const result = await request("tools/call", { name: "control", arguments: { action, args } });
    if (!object(result) || !Array.isArray(result.content) || (result.isError !== undefined && typeof result.isError !== "boolean")) throw new OmpError("service-invalid-result", "Invalid scoped service result; outcome unknown");
    return result;
  } };
}
