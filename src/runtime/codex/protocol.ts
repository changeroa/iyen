export type RpcMessage = { id?: string | number; method?: string; params?: any; result?: any; error?: { code: number; message: string } };
export class RpcError extends Error { constructor(message: string, readonly code?: number) { super(message); } }
export type RpcTransport = { send(line: string): void; close(): void };

/** Newline-delimited JSON-RPC. Timeouts are ambiguous; never retry mutations here. */
export class RpcClient {
  private buffer = "";
  private sequence = 0;
  private ended = false;
  private pending = new Map<string | number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  onNotification: (message: RpcMessage) => void = () => {};
  onRequest: (message: RpcMessage) => void = () => {};
  onDisconnect: (error: Error) => void = () => {};
  constructor(private transport: RpcTransport, private timeoutMs = 15000) {}
  request<T>(method: string, params: unknown): Promise<T> {
    if (this.ended) return Promise.reject(new RpcError("Codex transport is closed"));
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new RpcError(`${method}: response unknown (timeout)`)); }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.transport.send(JSON.stringify({ id, method, params }) + "\n"); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }
  notify(method: string, params?: unknown): void { this.transport.send(JSON.stringify({ method, ...(params === undefined ? {} : { params }) }) + "\n"); }
  respond(id: string | number, result: unknown): void { this.transport.send(JSON.stringify({ id, result }) + "\n"); }
  reject(id: string | number, message: string): void { this.transport.send(JSON.stringify({ id, error: { code: -32601, message } }) + "\n"); }
  feed(chunk: string): void {
    if (this.ended) return;
    this.buffer += chunk;
    if (this.buffer.length > 16 * 1024 * 1024) { this.disconnect(new RpcError("Codex frame exceeds 16 MiB")); return; }
    for (;;) {
      const end = this.buffer.indexOf("\n");
      if (end < 0) break;
      const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
      if (!line.trim()) continue;
      let msg: RpcMessage;
      try { msg = JSON.parse(line); if (!msg || typeof msg !== "object") throw new Error(); }
      catch { this.disconnect(new RpcError("Invalid JSON-RPC frame")); return; }
      if (msg.method) {
        if (msg.id !== undefined) this.onRequest(msg); else this.onNotification(msg);
      } else if (msg.id !== undefined) {
        const pending = this.pending.get(msg.id);
        if (!pending) continue;
        clearTimeout(pending.timer); this.pending.delete(msg.id);
        if (msg.error) pending.reject(new RpcError(msg.error.message, msg.error.code)); else pending.resolve(msg.result);
      }
    }
  }
  disconnect(error = new RpcError("Codex disconnected; pending results unknown")): void {
    if (this.ended) return;
    this.ended = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear(); this.transport.close(); this.onDisconnect(error);
  }
}
