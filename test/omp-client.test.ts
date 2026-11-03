import { expect, test } from "bun:test";
import { connectOmp } from "../src/runtime/omp/client.ts";
import { FailureJournal } from "../src/runtime/omp/failures.ts";
import { join } from "node:path";
import { OmpError, payloadHash } from "../src/runtime/omp/contract.ts";
import { ompFixture } from "./fixtures/omp.ts";

test("OMP receipt wait permits concurrent hold and read-only reconciliation", async () => {
  const f = ompFixture(); let inputs = 0; let resolveInput!: (value: unknown) => void;
  await f.serve(async request => {
    const response = (result: unknown) => ({ protocol: 1, id: request.id, identity: f.identity, result });
    if (request.method === "input") { inputs++; return await new Promise(resolve => { resolveInput = resolve; }); }
    if (request.method === "operation") return response({ status: "unknown", ...request.params });
    return response({ ...f.snapshot, held: request.method === "hold" });
  });
  const client = await connectOmp(f.target, { timeoutMs: 1000 });
  try {
    const pending = client.input("literal `x` $(x)", "op");
    await Bun.sleep(10);
    expect((await client.hold("user", "hold")).held).toBe(true);
    expect(await client.operation("op", "literal `x` $(x)")).toEqual({ status: "unknown", operationId: "op", payloadHash: payloadHash("literal `x` $(x)") });
    resolveInput({ protocol: 1, id: "wrong", identity: f.identity, result: {} });
    await expect(pending).rejects.toThrow("Invalid OMP response"); expect(inputs).toBe(1);
  } finally { client.close(); f.cleanup(); }
});

test("OMP timeout never retries input and is never a pre-submit refusal", async () => {
  const f = ompFixture(); let inputs = 0;
  await f.serve(request => { if (request.method === "input") { inputs++; return undefined; } return { protocol: 1, id: request.id, identity: f.identity, result: f.snapshot }; });
  const client = await connectOmp(f.target, { timeoutMs: 30 });
  try { let error: unknown; try { await client.input("work", "op"); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(OmpError); expect((error as OmpError).attempted).toBeUndefined(); expect(inputs).toBe(1);
  } finally { client.close(); f.cleanup(); }
});

test("OMP validates response generation and exact operation receipt", async () => {
  const f = ompFixture(); let changed = false;
  await f.serve(request => ({ protocol: 1, id: request.id, identity: changed ? { ...f.identity, generation: 2 } : f.identity,
    result: request.method === "inspect" ? f.snapshot : { receipt: { operationId: "op", payloadHash: payloadHash("work"), sessionId: f.identity.sessionId, sessionFile: f.identity.sessionFile, entryId: "entry", receiptId: "pretend-turn" } } }));
  const client = await connectOmp(f.target);
  try { await expect(client.input("work", "op")).rejects.toThrow("Invalid OMP result"); changed = true; await expect(client.inspect()).rejects.toThrow("identity mismatch"); }
  finally { client.close(); f.cleanup(); }
});

test("OMP preserves verified pre-submit refusal without exposing server text", async () => {
  const f = ompFixture();
  await f.serve(request => request.method === "inspect" ? { protocol: 1, id: request.id, identity: f.identity, result: f.snapshot } :
    { protocol: 1, id: request.id, identity: f.identity, error: { code: "held", message: "fixture-bearer PRIVATE", attempted: false } });
  const client = await connectOmp(f.target);
  try { let error: unknown; try { await client.input("work", "op"); } catch (e) { error = e; }
    expect((error as OmpError).attempted).toBe(false); expect((error as Error).message).not.toContain("PRIVATE");
  } finally { client.close(); f.cleanup(); }
});


test("OMP failure client pins stream and target, rejects malformed pages and validates cursor before sending", async () => {
  const f = ompFixture(), journal = new FailureJournal(join(f.directory, "failures.json"), f.identity);
  journal.append("run", "model", "authentication");
  let changed: Record<string, unknown> = {}, requests = 0;
  await f.serve(request => {
    if (request.method === "failures") requests++;
    return { protocol: 1, id: request.id, identity: f.identity, result: request.method === "inspect" ? f.snapshot : { ...journal.page(request.params.after, request.params.limit), ...changed } };
  });
  const client = await connectOmp(f.target);
  try {
    expect((await client.failures(0)).records).toHaveLength(1);
    for (const malformed of [{ laneKey: "foreign" }, { records: [] }, { extra: true }, { through: 0 }, { streamId: "019a4190-0000-7000-8000-000000000099", records: [{ ...journal.page(0).records[0], failureId: "omp-failure:019a4190-0000-7000-8000-000000000099:1" }] }]) {
      changed = malformed; await expect(client.failures(0)).rejects.toThrow("Invalid OMP result");
    }
    const before = requests;
    await expect(client.failures(-1)).rejects.toThrow("Invalid OMP failure cursor"); await expect(client.failures(0, 101)).rejects.toThrow("Invalid OMP failure cursor");
    expect(requests).toBe(before);
  } finally { client.close(); f.cleanup(); }
});

test("OMP missing durableFailures capability fails strict handshake; borrowed lead permits explicit false", async () => {
  const f = ompFixture(); let missing = true;
  await f.serve(request => {
    const capabilities: Record<string, unknown> = { ...f.snapshot.capabilities, durableFailures: false };
    if (missing) delete capabilities.durableFailures;
    return { protocol: 1, id: request.id, identity: f.identity, result: { ...f.snapshot, capabilities } };
  });
  try {
    await expect(connectOmp(f.target)).rejects.toThrow("Invalid OMP result");
    missing = false; f.identity.role = "attached-lead"; f.target.role = "attached-lead";
    const client = await connectOmp(f.target); try { expect((await client.inspect()).capabilities.durableFailures).toBe(false); } finally { client.close(); }
  } finally { f.cleanup(); }
});
