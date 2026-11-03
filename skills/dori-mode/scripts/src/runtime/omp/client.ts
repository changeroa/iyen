import { randomUUID } from "node:crypto";
import { constants, closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { isAbsolute } from "node:path";
import { OMP_MAX_FRAME_BYTES, OmpError, assertIdentity, exactKeys, identityOf, nonempty, object, payloadHash, validReceipt, validSnapshot, validFailureRequest, validateFailurePage,
  validInteraction, validInteractionResponse, validInteractionStatus,
  validRestartIntent, validRestartStatus, validRestartContinuation,
  type NativeInteractionReceipt, type OmpController, type OmpMethod, type OmpOperation, type OmpReceipt, type OmpSnapshot, type OmpTarget } from "./contract.ts";

export async function connectOmp(target: OmpTarget, options: { timeoutMs?: number } = {}): Promise<OmpController> {
  const identity = identityOf(target); assertIdentity(identity);
  if (!isAbsolute(target.socketPath) || !isAbsolute(target.tokenFile)) throw new OmpError("invalid-target", "OMP endpoints require absolute paths", false);
  const timeoutMs = options.timeoutMs ?? 15000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new OmpError("invalid-timeout", "Invalid OMP timeout", false);
  const fd = openSync(target.tokenFile, constants.O_RDONLY | constants.O_NOFOLLOW);
  let token: string;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid()) || stat.size > 4096) throw new OmpError("invalid-token-file", "OMP token file must be private and owned by this user", false);
    token = readFileSync(fd, "utf8").trim();
    if (!nonempty(token)) throw new OmpError("invalid-token-file", "Empty OMP bearer token", false);
  } finally { closeSync(fd); }
  let closed = false;
  let failureStream: string | undefined;
  const sockets = new Set<Socket>();
  // Each request has its own connection: a receipt wait cannot block hold or observation.
  const request = (method: OmpMethod, params: Record<string, unknown>): Promise<unknown> => new Promise((resolve, reject) => {
    if (closed) { reject(new OmpError("closed", "OMP control closed; outcome unknown")); return; }
    const id = randomUUID();
    const frame = Buffer.from(JSON.stringify({ protocol: 1, id, token, target: identity, method, params }) + "\n");
    if (frame.length > OMP_MAX_FRAME_BYTES) { reject(new OmpError("frame-limit", "OMP request exceeds frame limit", false)); return; }
    const socket = createConnection({ path: target.socketPath }); sockets.add(socket);
    let buffer = Buffer.alloc(0), settled = false;
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return; settled = true; clearTimeout(timer); sockets.delete(socket); socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new OmpError("timeout", "OMP request timed out; outcome unknown")), timeoutMs);
    socket.on("connect", () => socket.write(frame));
    socket.on("error", () => finish(new OmpError("transport", "OMP transport failed; outcome unknown")));
    socket.on("close", () => finish(new OmpError("disconnected", "OMP disconnected; outcome unknown")));
    socket.on("data", chunk => {
      buffer = Buffer.concat([buffer, typeof chunk === "string" ? Buffer.from(chunk) : chunk]);
      if (buffer.length > OMP_MAX_FRAME_BYTES) { finish(new OmpError("frame-limit", "OMP response exceeds frame limit; outcome unknown")); return; }
      const end = buffer.indexOf(10); if (end < 0) return;
      try {
        if (end !== buffer.length - 1) throw new Error();
        const response: unknown = JSON.parse(buffer.subarray(0, end).toString("utf8"));
        if (!object(response) || response.protocol !== 1 || response.id !== id ||
          !exactKeys(response, ["protocol", "id", "identity"], ["result", "error"]) ||
          Object.hasOwn(response, "result") === Object.hasOwn(response, "error")) throw new Error();
        assertIdentity(response.identity, identity);
        if (Object.hasOwn(response, "error")) {
          const e = response.error;
          if (!object(e) || !exactKeys(e, ["code", "message", "attempted"]) || !nonempty(e.code) || typeof e.message !== "string" || typeof e.attempted !== "boolean") throw new Error();
          // Do not echo arbitrary server text, which might contain credentials or prompt data.
          finish(new OmpError(e.code, `OMP ${method} refused (${e.code})${e.attempted ? "; outcome unknown" : " before submission"}`, e.attempted));
        } else finish(undefined, response.result);
      } catch (error) { finish(error instanceof OmpError ? error : new OmpError("invalid-response", "Invalid OMP response; outcome unknown")); }
    });
  });
  const invalid = (): never => { throw new OmpError("invalid-result", "Invalid OMP result; outcome unknown"); };
  const snapshot = (result: unknown): OmpSnapshot => validSnapshot(result, identity) ? result : invalid();
  const receipt = (result: unknown, operationId: string, digest: string): { receipt: OmpReceipt } =>
    object(result) && exactKeys(result, ["receipt"]) && validReceipt(result.receipt, identity, operationId, digest) ? { receipt: result.receipt } : invalid();
  const controller: OmpController = {
    inspect: async () => snapshot(await request("inspect", {})),
    interactions: async () => {
      const result = await request("interactions", {});
      if (!Array.isArray(result) || !result.every(r => validInteraction(r, identity.sessionId)) || new Set(result.map(r => r.id)).size !== result.length) return invalid();
      return result;
    },
    interactionRespond: async (requestId, response, operationId) => {
      if (!nonempty(requestId) || !nonempty(operationId) || !validInteractionResponse(response)) throw new OmpError("invalid-params", "Invalid native answer", false);
      const result = await request("interaction-respond", { requestId, response, operationId });
      if (!validInteractionStatus(result, operationId) || !["applied", "stale"].includes(result.status) || result.requestId !== requestId || result.responseHash !== payloadHash(JSON.stringify(response))) return invalid();
      return result as NativeInteractionReceipt;
    },
    interactionResponseStatus: async operationId => {
      if (!nonempty(operationId)) throw new OmpError("invalid-params", "Invalid native response operation", false);
      const result = await request("interaction-response-status", { operationId });
      return validInteractionStatus(result, operationId) ? result : invalid();
    },
    failures: async (after, limit = 100) => {
      if (!validFailureRequest(after, limit)) throw new OmpError("invalid-params", "Invalid OMP failure cursor", false);
      const result = await request("failures", { after, limit });
      if (!validateFailurePage(result, identity, after, limit) || (failureStream && result.streamId !== failureStream)) return invalid();
      failureStream = result.streamId;
      return result;
    },
    input: async (text, operationId) => receipt(await request("input", { text, operationId, payloadHash: payloadHash(text) }), operationId, payloadHash(text)),
    operation: async (operationId, text): Promise<OmpOperation> => {
      const digest = payloadHash(text), result = await request("operation", { operationId, payloadHash: digest });
      if (!object(result)) return invalid();
      if (result.status === "absent" && exactKeys(result, ["status"])) return { status: "absent" };
      if (result.status === "received" && exactKeys(result, ["status", "receipt"]) && validReceipt(result.receipt, identity, operationId, digest)) return { status: "received", receipt: result.receipt };
      if (["reserved", "attempted", "unknown"].includes(result.status as string) && exactKeys(result, ["status", "operationId", "payloadHash"]) && result.operationId === operationId && result.payloadHash === digest) return result as OmpOperation;
      return invalid();
    },
    hold: async (origin, operationId) => snapshot(await request("hold", { origin, operationId })),
    release: async (origin, operationId) => snapshot(await request("release", { origin, operationId })),
    stop: async operationId => { const result = await request("stop", { operationId }); return object(result) && exactKeys(result, ["stopping"]) && result.stopping === true ? { stopping: true } : invalid(); },
    leadRestart: async (method, intent) => {
      if (!validRestartIntent(intent) || (method === "restart-release" && !intent.previousTarget))
        throw new OmpError("invalid-params", "Invalid restart intent", false);
      const result = await request(method, intent);
      return validRestartStatus(result, target, intent) ? result : invalid();
    },
    leadRestartStage: async (intent, text) => {
      if (!validRestartIntent(intent) || !intent.previousTarget || !nonempty(text)) throw new OmpError("invalid-params", "Invalid restart continuation", false);
      const result = await request("restart-stage", { ...intent, text, payloadHash: payloadHash(text) });
      return validRestartContinuation(result, target, intent) && result.textHash === payloadHash(text) ? result : invalid();
    },
    close: () => { closed = true; for (const socket of sockets) socket.destroy(); },
  };
  try { await controller.inspect(); return controller; } catch (error) { controller.close(); throw error; }
}
