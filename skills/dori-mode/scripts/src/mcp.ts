import type { DoriConfig } from "./config.ts";
import { serviceClient } from "./ipc.ts";
const actions = ["status", "can-launch", "launch", "input", "report", "reply", "claim-done", "object-done", "pause", "resume", "close", "recover", "reopen", "sync", "approval-list", "mail-list"];
/** stdio MCP keeps lifecycle RPC outside the command sandbox without granting network access. */
export const mcpServer = async (config: DoriConfig): Promise<void> => {
  if (!process.env.DORI_CONTEXT) throw new Error("MCP requires a managed lane context");
  const call = serviceClient(config);
  const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n");
  const handle = async (message: any) => {
    if (message.id === undefined) return;
    try {
      let result: any;
      if (message.method === "initialize") result = { protocolVersion: ["2024-11-05", "2025-03-26", "2025-06-18"].includes(message.params?.protocolVersion) ? message.params.protocolVersion : "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "dori-runtime", version: "0.2.0" } };
      else if (message.method === "ping") result = {};
      else if (message.method === "tools/list") result = { tools: [{ name: "control", description: "Control your Dori work using scoped lifecycle operations. args is the Dori service payload. launch requires key,title,brief,done,operationId and optional cwd/thread/worktree. input/reply require text and operationId. report requires key,kind,text,eventId. claim-done requires key,evidence. Use stable unique IDs; unknown deliveries are not retried. Lanes may only status/report/claim their own work. The lead may dispatch and report; approvals require the owner.", inputSchema: { type: "object", properties: { action: { type: "string", enum: actions }, args: { type: "object", additionalProperties: true } }, required: ["action", "args"], additionalProperties: false } }] };
      else if (message.method === "tools/call" && message.params?.name === "control") {
        const { action, args } = message.params.arguments ?? {};
        if (!actions.includes(action)) throw new Error("Unsupported Dori action");
        const value = await call(action, args);
        result = { content: [{ type: "text", text: JSON.stringify(value) }], isError: false };
      } else { send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Unknown MCP method" } }); return; }
      send({ jsonrpc: "2.0", id: message.id, result });
    } catch (error) {
      send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: error instanceof Error ? error.message : "Dori request failed" }], isError: true } });
    }
  };
  const decoder = new TextDecoder(); let buffer = "";
  const requests = new Set<Promise<void>>();
  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk, { stream: true });
    if (buffer.length > 1024 * 1024) throw new Error("MCP frame too large");
    while (buffer.includes("\n")) {
      const at = buffer.indexOf("\n"), line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
      if (!line.trim()) continue;
      let message: unknown;
      try { message = JSON.parse(line); } catch { send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON" } }); continue; }
      const request = handle(message).finally(() => requests.delete(request)); requests.add(request);
    }
  }
  await Promise.all(requests);
};
