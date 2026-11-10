#!/usr/bin/env bun
// Fake hc for integration tests: an empty event stream, and lane terminals backed by the herdr fixture's panes.
const args = process.argv.slice(2);
if (args[0] === "connect") {
  for await (const line of console) {
    const message = JSON.parse(line);
    if (message.method === "events.subscribe") console.log(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { channel: null, seq: 0, terminals: [] } }));
  }
} else if (args[0] === "run") {
  const option = (name: string) => args[args.indexOf(name) + 1]!;
  const lane = args.find(a => a.startsWith("dori.lane="))!.slice("dori.lane=".length);
  const created = Bun.spawn(["herdr", "tab", "create", "--cwd", option("--cwd"), "--label", lane, "--no-focus"], { stdout: "pipe", env: process.env });
  const out = JSON.parse(await new Response(created.stdout).text());
  if (await created.exited) process.exit(1);
  console.log(JSON.stringify({ address: out.result.root_pane.pane_id }));
} else process.exit(2);
export {};
