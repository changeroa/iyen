#!/usr/bin/env node
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { atomicPrivate, command, digest, validateConfig } from './lead-pane.mjs';

const requireThat = (condition, message) => { if (!condition) throw new Error(message); };
const packagedShim = fileURLToPath(new URL('./lead-pane.mjs', import.meta.url));

// A lock file, a missing PID or caller-supplied "stopped" boolean is never proof.
export async function verifyDispatchersStopped(config, run = command) {
  const dispatchers = config.dispatchers;
  requireThat(Array.isArray(dispatchers) && dispatchers.length === 2 && ['slack', 'discord'].every(source => dispatchers.filter(d => d.source === source).length === 1), 'both dispatchers required');
  const processes = await run('/bin/ps', ['-axo', 'pid=,command=']);
  requireThat(processes.code === 0 && /^\s*\d+\s+\S/m.test(processes.out), 'process inventory unverifiable');
  for (const d of dispatchers) {
    requireThat(/^gui\/\d+$/.test(d.domain) && /^[\w.-]+$/.test(d.label) && typeof d.script === 'string' && realpathSync(d.script) === d.script && d.script.endsWith(`/${d.source}-service.mjs`), 'dispatcher identity invalid');
    requireThat(!processes.out.includes(d.script) && !processes.out.includes(`${d.source}-service.mjs`), `${d.source} dispatcher alive`);
    const disabled = await run('/bin/launchctl', ['print-disabled', d.domain]);
    const escaped = d.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    requireThat(disabled.code === 0 && new RegExp(`"${escaped}"\\s*=>\\s*true`).test(disabled.out), `${d.source} respawn not disabled`);
    const service = await run('/bin/launchctl', ['print', `${d.domain}/${d.label}`]);
    const absent = service.code === 113 && /Could not find service/.test(service.err ?? '') && (service.err ?? '').includes(d.label);
    const stopped = service.code === 0 && /\bstate = (?:not running|exited)\b/.test(service.out) && !/\bpid = \d+/.test(service.out);
    requireThat(absent || stopped, `${d.source} launchd state unverifiable or running`);
  }
}

export async function install({ configPath, target, apply = false, run = command }) {
  const config = validateConfig(JSON.parse(readFileSync(configPath, 'utf8')));
  requireThat(target === resolve(target) && realpathSync(target) === target && lstatSync(target).isFile() && target.endsWith('/lead-pane.mjs'), 'target must be canonical lead-pane.mjs');
  const original = readFileSync(target), replacement = readFileSync(packagedShim);
  requireThat(digest(original) === config.originalHash, 'original shim hash mismatch');
  requireThat((await run(process.execPath, ['--check', packagedShim])).code === 0, 'replacement syntax invalid');
  await verifyDispatchersStopped(config, run);
  const backup = `${target}.backup-${config.originalHash}`;
  if (existsSync(backup)) requireThat(digest(readFileSync(backup)) === config.originalHash, 'backup hash mismatch');
  const destinationConfig = join(dirname(target), 'lead-pane.compat.json');
  requireThat(!existsSync(destinationConfig), 'compat config already exists; explicit reconciliation required');
  const result = { dryRun: !apply, target, originalHash: config.originalHash, replacementHash: digest(replacement), backup, config: destinationConfig,
    rollback: 'Stop and disable BOTH dispatchers; reconcile every queued/unknown/delivered operation with native and source receipts before restoring the verified backup. Never replay old pane input merely because the file was restored.' };
  if (!apply) return result;
  // Recheck immediately before mutation. Keep the original independently recoverable.
  await verifyDispatchersStopped(config, run);
  requireThat(digest(readFileSync(target)) === config.originalHash, 'original changed during preflight');
  if (!existsSync(backup)) atomicPrivate(backup, original);
  requireThat(digest(readFileSync(backup)) === config.originalHash, 'backup not recoverable');
  atomicPrivate(destinationConfig, JSON.stringify(config, null, 2) + '\n');
  atomicPrivate(target, replacement);
  requireThat(digest(readFileSync(target)) === result.replacementHash, 'replacement verification failed; keep dispatchers disabled');
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2), value = flag => args[args.indexOf(flag) + 1];
    requireThat(args.includes('--config') && args.includes('--target') && args.every((arg, i) => ['--config', '--target', '--apply'].includes(arg) || ['--config', '--target'].includes(args[i - 1])), 'usage: node install.mjs --config FILE --target FILE [--apply]');
    console.log(JSON.stringify(await install({ configPath: resolve(value('--config')), target: resolve(value('--target')), apply: args.includes('--apply') }), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
