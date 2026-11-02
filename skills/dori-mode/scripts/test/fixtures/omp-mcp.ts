// An offline MCP peer for testing transport behavior, not service authorization.
export {};
let calls = 0;
for await (const line of console) {
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  let result: unknown;
  if (request.method === "initialize") result = { protocolVersion: "2024-11-05", capabilities: { tools: {} } };
  else if (request.method === "tools/list") result = { tools: [{ name: "control" }] };
  else {
    calls++;
    const args = request.params.arguments;
    if (args.action === "lose-result") continue;
    if (args.action === "count") result = { content: [{ type: "text", text: String(calls) }], isError: false };
    else result = { content: [{ type: "text", text: JSON.stringify({ args, context: process.env.DORI_CONTEXT, config: process.env.DORI_CONFIG, state: process.env.DORI_STATE_DIR,
      secret: process.env.UNRELATED_SECRET, laneToken: process.env.DORI_LANE_TOKEN }) }], isError: false };
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
}
