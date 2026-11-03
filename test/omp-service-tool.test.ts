import { expect, test } from "bun:test";
import { connectServiceTool, scopedServiceEnvironment } from "../src/runtime/omp/service-tool.ts";
test("OMP scoped MCP helper forwards structured arguments and excludes ambient credentials", async () => {
  const service = { bunBinary: process.execPath, cliPath: new URL("./fixtures/omp-mcp.ts", import.meta.url).pathname, contextFile: "/private/context", configFile: "/private/config", stateDir: "/private/state" };
  const tool = await connectServiceTool(service, { timeoutMs: 1000, env: { PATH: process.env.PATH, HOME: process.env.HOME, UNRELATED_SECRET: "private", DORI_LANE_TOKEN: "private", DORI_CONTEXT: "/wrong" } });
  try {
    const result: any = await tool.call("report", { text: "`literal` $(literal)", key: "worker" });
    const data = JSON.parse(result.content[0].text);
    expect(data.args).toEqual({ action: "report", args: { text: "`literal` $(literal)", key: "worker" } });
    expect(data.context).toBe(service.contextFile); expect(data.config).toBe(service.configFile); expect(data.state).toBe(service.stateDir);
    expect(data.secret).toBeUndefined(); expect(data.laneToken).toBeUndefined();
  } finally { tool.close(); }
});
test("lost MCP mutation result is unknown and never retried", async () => {
  const tool = await connectServiceTool({ bunBinary: process.execPath, cliPath: new URL("./fixtures/omp-mcp.ts", import.meta.url).pathname, contextFile: "/context", configFile: "/config", stateDir: "/state" }, { timeoutMs: 50 });
  try { await expect(tool.call("lose-result", { operationId: "op" })).rejects.toThrow("unknown"); const result: any = await tool.call("count", {}); expect(result.content[0].text).toBe("2"); }
  finally { tool.close(); }
});
test("MCP environment retains only ordinary process lookup, never alternate Dori capabilities", () => {
  expect(scopedServiceEnvironment({ PATH: "/bin", HOME: "/home", DORI_LANE_TOKEN: "secret", DORI_CONFIG: "/wrong", DORI_CONTEXT: "/wrong", IYEN_OMP_BOOTSTRAP: "/bootstrap" })).toEqual({ PATH: "/bin", HOME: "/home" });
});
