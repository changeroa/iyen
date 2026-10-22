/** Persist categories and fixed guidance, never upstream messages, tool output or credentials. */
export const turnFailure = (error: any): { category: string; guidance: string } => {
  const info = error?.codexErrorInfo;
  const code = typeof info === "string" ? info : info && typeof info === "object" ? Object.keys(info)[0] ?? "" : "";
  const message = typeof error?.message === "string" ? error.message : "";
  if (/unauthorized|auth|credential|login|401|403/i.test(code + " " + message)) return { category: "authentication", guidance: "Check Codex authentication, then explicitly continue after checking completed actions." };
  if (/usageLimit|rateLimit|budget|quota|429/i.test(code + " " + message)) return { category: "usage-limit", guidance: "Check usage limits or quota, then explicitly continue after checking completed actions." };
  if (/model|badRequest|configuration/i.test(code + " " + message)) return { category: "configuration", guidance: "Check model and runtime configuration, then explicitly continue after checking completed actions." };
  if (/sandbox|tool|mcp/i.test(code + " " + message)) return { category: "tools", guidance: "Check tool and sandbox setup, then explicitly continue after checking completed actions." };
  return { category: "runtime", guidance: "Inspect runtime status and completed actions before explicitly continuing." };
};
