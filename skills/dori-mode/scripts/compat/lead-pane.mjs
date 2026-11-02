// Drop-in for the legacy dispatchers. No pane text, administrative token or source receipts.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const digest = text => createHash('sha256').update(text, 'utf8').digest('hex');
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const required = (value, name) => { if (!value) throw new Error(name); };
const canonical = path => typeof path === 'string' && isAbsolute(path) && resolve(path) === path && realpathSync(path) === path;

export function validateConfig(config) {
  required(config?.version === 1, 'compat config version');
  for (const key of ['bridge', 'stateDir']) required(typeof config[key] === 'string' && isAbsolute(config[key]) && resolve(config[key]) === config[key], key);
  for (const key of ['pane', 'threadId', 'attachmentInstance', 'sessionId', 'sessionFile']) required(typeof config[key] === 'string' && config[key].length > 0 && !config[key].includes('\0'), key);
  required(isAbsolute(config.sessionFile), 'sessionFile');
  required(Number.isSafeInteger(config.attachmentGeneration) && config.attachmentGeneration > 0, 'attachmentGeneration');
  required(/^[a-f0-9]{64}$/.test(config.originalHash), 'originalHash');
  required(config.bridge.endsWith(`/clients/attached-lead/${config.attachmentInstance}/iyen`), 'activated scoped bridge required');
  for (const source of ['slack', 'discord']) required(canonical(config.inboxRoots?.[source]) && lstatSync(config.inboxRoots[source]).isDirectory(), `${source} inbox root`);
  required(canonical(config.bridge) && lstatSync(config.bridge).isFile() && (lstatSync(config.bridge).mode & 0o111), 'bridge executable');
  return config;
}

export function atomicPrivate(path, value) {
  const temporary = `${path}.tmp-${process.pid}`;
  const fd = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(fd, value); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path);
  const dir = openSync(dirname(path), 'r');
  try { fsyncSync(dir); } finally { closeSync(dir); }
}

function privateState(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  required(canonical(path) && stat.isDirectory() && stat.uid === process.getuid() && (stat.mode & 0o077) === 0, 'private state directory required');
}

export function command(executable, args, timeout = 30000) {
  // The pinned wrapper supplies its own context. Ambient DORI_* must not select another service.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('DORI_')));
  return new Promise(resolve => execFile(executable, args, { timeout, maxBuffer: 1024 * 1024, env }, (error, out, err) => resolve({ code: error ? (error.code ?? 1) : 0, out, err })));
}

function parseEvent(config, text) {
  required(typeof text === 'string', 'text');
  const match = /^(DORI_SLACK_EVENT|DORI_DISCORD_EVENT|DORI_MONITOR_EVENT|DORI_QA_EVENT) ([A-Za-z0-9_][A-Za-z0-9_.-]{0,199})\. (?:First|Run) /.exec(text);
  required(match, 'unsupported event prefix');
  const [, prefix, id] = match;
  const source = prefix === 'DORI_DISCORD_EVENT' ? 'discord' : prefix === 'DORI_MONITOR_EVENT' ? 'dori-watch' : 'slack';
  const root = config.inboxRoots[source === 'discord' ? 'discord' : 'slack'];
  const path = join(root, `${id}.json`);
  required(canonical(path) && lstatSync(path).isFile(), 'event path');
  // Match the adapter-owned read clause, not a path quoted inside external content.
  const clause = prefix === 'DORI_QA_EVENT' ? `, read ${path}, then ` : `, then read /Users/iyen/.dori/runtime/LEAD.md and ${path}. `;
  required(text.startsWith(`${prefix} ${id}. ${prefix === 'DORI_QA_EVENT' ? 'Run' : 'First'} `) && text.includes(` accept --event ${id}${clause}`), 'event read clause');
  const event = read(path);
  required(event.id === id, 'event id');
  required(source === 'discord' ? event.source === 'discord' && /^discord-\d+$/.test(id) : source === 'dori-watch' ? event.source === 'dori-watch' && /^monitor-\d+$/.test(id) : event.source === undefined || event.source === 'slack', 'event source');
  required(prefix === 'DORI_QA_EVENT' ? event.qa === true : event.qa !== true, 'QA prefix');
  return { prefix, source, eventId: id, operationId: `legacy:${digest(JSON.stringify([prefix, source, id]))}` };
}

function epoch(config) {
  return { bridge: config.bridge, pane: config.pane, threadId: config.threadId, attachmentInstance: config.attachmentInstance,
    attachmentGeneration: config.attachmentGeneration, sessionId: config.sessionId, sessionFile: config.sessionFile };
}
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function createLeadPane({ config, configPath = process.env.IYEN_LEGACY_COMPAT_CONFIG ?? join(dirname(fileURLToPath(import.meta.url)), 'lead-pane.compat.json'), run = command } = {}) {
  const load = () => validateConfig(config ?? read(configPath));
  const invoke = async (cfg, args) => {
    const result = await run(cfg.bridge, [...args, '--json']);
    required(result.code === 0, 'bridge command failed');
    return JSON.parse(result.out);
  };
  const probe = async cfg => {
    const lane = await invoke(cfg, ['status', 'lead']);
    const rt = lane?.runtime, native = rt?.omp?.target;
    required(lane.key === 'lead' && lane.identityVerified === true && lane.mode === 'external-current-session' && lane.pane === cfg.pane && lane.bridge === cfg.bridge &&
      rt?.kind === 'omp' && rt.backend === 'external-current-session' && rt.threadId === cfg.threadId && rt.hostInstanceId === cfg.attachmentInstance && rt.generation === cfg.attachmentGeneration &&
      rt.omp.attachmentInstanceId === cfg.attachmentInstance && rt.omp.attachmentGeneration === cfg.attachmentGeneration && native.sessionId === cfg.sessionId && native.sessionFile === cfg.sessionFile && native.paneId === cfg.pane &&
      !rt.external?.detachedAt && !rt.omp.detachedAt, 'attachment mismatch');
    return lane;
  };
  const ready = lane => lane.inputReady === true && lane.readiness === 'ready' && lane.runtime.state === 'idle' && lane.runtime.held !== true && !lane.dispatchBlocked && !lane.holdReason;
  const records = cfg => readdirSync(cfg.stateDir).filter(name => /^legacy:[a-f0-9]{64}\.json$/.test(name));
  const unresolved = cfg => records(cfg).some(name => !['prepared', 'received'].includes(read(join(cfg.stateDir, name)).state));
  const receipt = (cfg, row, value) => value?.receiptKind === 'omp-session-entry' && typeof value.turnId === 'string' && value.turnId.length > 0 &&
    value.receipt?.operationId === row.operationId && value.receipt.payloadHash === row.payloadHash && value.receipt.sessionId === cfg.sessionId && value.receipt.sessionFile === cfg.sessionFile &&
    typeof value.receipt.entryId === 'string' && value.receipt.entryId.length > 0 && value.turnId === value.receipt.receiptId && value.receipt.receiptId === `omp-entry:${cfg.sessionId}:${value.receipt.entryId}`;
  const locked = async (cfg, busy, action) => {
    privateState(cfg.stateDir);
    const lock = join(cfg.stateDir, 'lead.lock');
    try { mkdirSync(lock, { mode: 0o700 }); } catch (error) { if (error.code === 'EEXIST') return busy; throw error; }
    try { return await action(); } finally { rmdirSync(lock); }
  };
  const leadState = async pane => {
    try {
      const cfg = load(); if (pane !== cfg.pane) return 'missing';
      return await locked(cfg, 'busy', async () => {
        await probe(cfg);
        // Legacy adapters ask readiness before retrying. Clear only exact receipt barriers,
        // without submitting input or changing their source event state.
        for (const name of records(cfg)) {
          const path = join(cfg.stateDir, name), row = read(path);
          if (row.state === 'received' || row.state === 'prepared') continue;
          required(equal(row.epoch, epoch(cfg)) && name === `${row.operationId}.json`, 'unreconciled previous epoch');
          const textPath = join(cfg.stateDir, `${row.operationId}.txt`);
          required(digest(readFileSync(textPath, 'utf8')) === row.payloadHash, 'saved payload changed');
          const status = await invoke(cfg, ['input-status', 'lead', '--text-file', textPath, '--operation-id', row.operationId]);
          required(status.operationId === row.operationId, 'operation status identity');
          if (status.status === 'received') {
            required(receipt(cfg, row, status), 'native receipt missing'); await probe(cfg);
            atomicPrivate(path, JSON.stringify({ ...row, state: 'received', receipt: status.receipt }));
          }
        }
        return ready(await probe(cfg)) && !unresolved(cfg) ? 'idle' : 'busy';
      });
    } catch { return 'missing'; }
  };
  const deliver = async (pane, text) => {
    try {
      const cfg = load(); required(pane === cfg.pane, 'pane mismatch');
      return await locked(cfg, 'busy', async () => {
        const event = parseEvent(cfg, text), path = join(cfg.stateDir, `${event.operationId}.json`), textPath = join(cfg.stateDir, `${event.operationId}.txt`);
        let row = existsSync(path) ? read(path) : undefined;
        required(!row || row.operationId === event.operationId && row.payloadHash === digest(text) && equal(row.epoch, epoch(cfg)), 'operation payload or epoch changed');
        let lane = await probe(cfg);
        if (!row) {
          if (!ready(lane) || unresolved(cfg)) return 'busy';
          row = { ...event, epoch: epoch(cfg), payloadHash: digest(text), state: 'prepared' };
          atomicPrivate(path, JSON.stringify(row));
          atomicPrivate(textPath, text);
        }
        required(readFileSync(textPath, 'utf8') === text, 'saved payload changed');
        const save = state => { row = { ...row, ...state }; atomicPrivate(path, JSON.stringify(row)); };
        // Always query first, including while busy/held, and after an uncertain CLI exit.
        const status = await invoke(cfg, ['input-status', 'lead', '--text-file', textPath, '--operation-id', row.operationId]);
        required(status.operationId === row.operationId, 'operation status identity');
        if (status.status === 'received') {
          required(receipt(cfg, row, status), 'native receipt missing'); await probe(cfg);
          save({ state: 'received', receipt: status.receipt }); return 'delivered';
        }
        // Service admission may dispatch later. Legacy busy releases the source
        // active-event lease, so admitted work must stay blocked for reconciliation.
        if (status.status === 'queued') { save({ state: 'unknown' }); return 'failed'; }
        if (status.status !== 'missing' || !['prepared'].includes(row.state)) { save({ state: 'unknown' }); return 'failed'; }
        lane = await probe(cfg);
        if (!ready(lane)) return 'busy';
        // Persist the uncertainty barrier BEFORE invoking the external process.
        save({ state: 'unknown' });
        const result = await invoke(cfg, ['input', 'lead', '--text-file', textPath, '--operation-id', row.operationId]);
        if (result?.queued === true && result.operationId === row.operationId) { save({ state: 'unknown' }); return 'failed'; }
        required(receipt(cfg, row, result), 'native receipt missing'); await probe(cfg);
        save({ state: 'received', receipt: result.receipt }); return 'delivered';
      });
    } catch { return 'failed'; }
  };
  return { leadState, deliver };
}

const lead = createLeadPane();
export const leadState = lead.leadState;
export const deliver = lead.deliver;
