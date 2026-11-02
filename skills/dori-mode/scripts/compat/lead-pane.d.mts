export type LegacyConfig = {
  version: 1; bridge: string; stateDir: string; pane: string; threadId: string;
  attachmentInstance: string; attachmentGeneration: number; sessionId: string; sessionFile: string;
  originalHash: string; inboxRoots: { slack: string; discord: string };
  dispatchers?: { source: 'slack' | 'discord'; domain: string; label: string; script: string }[];
};
export type Command = (executable: string, args: string[], timeout?: number) => Promise<{ code: number | string; out: string; err?: string }>;
export function digest(text: string | Buffer): string;
export function validateConfig(config: LegacyConfig): LegacyConfig;
export function atomicPrivate(path: string, value: string | Buffer): void;
export const command: Command;
export function createLeadPane(options?: { config?: LegacyConfig; configPath?: string; run?: Command }): {
  leadState(pane: string): Promise<'idle' | 'busy' | 'missing'>;
  deliver(pane: string, text: string): Promise<'delivered' | 'busy' | 'failed'>;
};
export const leadState: ReturnType<typeof createLeadPane>['leadState'];
export const deliver: ReturnType<typeof createLeadPane>['deliver'];
