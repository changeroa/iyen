import type { Command, LegacyConfig } from './lead-pane.mjs';
export function verifyDispatchersStopped(config: LegacyConfig, run?: Command): Promise<void>;
export function install(options: { configPath: string; target: string; apply?: boolean; run?: Command }): Promise<{
  dryRun: boolean; target: string; originalHash: string; replacementHash: string; backup: string; config: string; rollback: string;
}>;
