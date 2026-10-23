import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DoriConfig } from "./config.ts";
export const socketDir = (stateDir: string): string => {
  const path = `/tmp/dori-${process.getuid?.() ?? "user"}-${createHash("sha256").update(stateDir).digest("hex").slice(0, 16)}`;
  mkdirSync(path, { recursive: true, mode: 0o700 }); chmodSync(path, 0o700); return path;
};
export const serviceSocket = (stateDir: string): string => join(socketDir(stateDir), "service.sock");
export const hostSocket = (stateDir: string, key: string): string => join(socketDir(stateDir), `${createHash("sha256").update(key).digest("hex").slice(0, 16)}.sock`);
export const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8"));
export const ipc = async <T = any>(socket: string, token: string, action: string, args: unknown = {}, timeoutMs = 30000): Promise<T> => {
  const response = await fetch("http://localhost/rpc", { unix: socket, method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ action, args }), signal: AbortSignal.timeout(timeoutMs) });
  const body = await response.json() as { result?: T; error?: string };
  if (!response.ok) throw new Error(body.error ?? `IPC error ${response.status}`);
  return body.result as T;
};
export const serviceClient = (config: DoriConfig) => {
  const scoped = process.env.DORI_CONTEXT ? readJson<{ token: string; key: string; stateDir: string }>(process.env.DORI_CONTEXT) : undefined;
  if (process.env.DORI_CONTEXT && (!scoped || typeof scoped.token !== "string" || !scoped.token || typeof scoped.key !== "string" || !scoped.key)) throw new Error("Invalid scoped context; admin fallback prohibited");
  if (scoped && scoped.stateDir !== config.stateDir) throw new Error("Scoped context state mismatch");
  if (process.env.DORI_LANE_KEY && !scoped && !process.env.DORI_LANE_TOKEN) throw new Error("Lane capability missing; use the managed dori executable");
  const token = scoped?.token ?? process.env.DORI_LANE_TOKEN ?? readJson<{ token: string }>(join(config.stateDir, "control.json")).token;
  return <T = any>(action: string, args: unknown = {}, timeoutMs = 180000) => ipc<T>(serviceSocket(config.stateDir), token, action, args, timeoutMs);
};
