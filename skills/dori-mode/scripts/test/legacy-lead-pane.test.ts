import { afterEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { command, createLeadPane, digest, type LegacyConfig, type Command } from '../compat/lead-pane.mjs';
import { install } from '../compat/install.mjs';

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const put = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value));

function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'legacy-compat-'))); directories.push(dir);
  const stateDir = join(dir, 'compat'), bridgeDir = join(dir, 'clients/attached-lead/epoch-one');
  for (const p of [stateDir, bridgeDir, join(dir, 'slack/inbox'), join(dir, 'discord/inbox')]) mkdirSync(p, { recursive: true, mode: 0o700 });
  const config: LegacyConfig = { version: 1, bridge: join(bridgeDir, 'iyen'), stateDir, pane: 'fixture:p1', threadId: 'thread-one', attachmentInstance: 'epoch-one', attachmentGeneration: 1,
    sessionId: 'session-one', sessionFile: join(dir, 'native.jsonl'), originalHash: digest('original'), inboxRoots: { slack: join(dir, 'slack/inbox'), discord: join(dir, 'discord/inbox') } };
  const control = join(dir, 'control.json'), db = join(dir, 'native-db.json'), calls = join(dir, 'calls.jsonl');
  const lane: any = { key: 'lead', pane: config.pane, bridge: config.bridge, mode: 'external-current-session', identityVerified: true, inputReady: true, readiness: 'ready', dispatchBlocked: false,
    runtime: { kind: 'omp', backend: 'external-current-session', threadId: config.threadId, hostInstanceId: config.attachmentInstance, generation: 1, state: 'idle', held: false,
      omp: { attachmentInstanceId: config.attachmentInstance, attachmentGeneration: 1, target: { sessionId: config.sessionId, sessionFile: config.sessionFile, paneId: config.pane } }, external: {} } };
  put(control, { lane, mode: 'receipt' }); put(db, {});
  // Real subprocess boundary, durable fake native store, exact CLI arguments; no network or model.
  writeFileSync(config.bridge, `#!${process.execPath}
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const control=${JSON.stringify(control)},db=${JSON.stringify(db)},calls=${JSON.stringify(calls)};
const c=JSON.parse(readFileSync(control,'utf8')), args=process.argv.slice(2), flag=k=>args[args.indexOf(k)+1];
appendFileSync(calls,JSON.stringify(args)+'\\n');
if(args.at(-1)!=='--json')process.exit(9);
if(args[0]==='status'){console.log(JSON.stringify(c.lane));process.exit(0);}
const id=flag('--operation-id'), text=readFileSync(flag('--text-file'),'utf8'), rows=JSON.parse(readFileSync(db,'utf8'));
if(args[0]==='input-status'){
 const result=rows[id]??{status:'missing',operationId:id};
 console.log(JSON.stringify(result));process.exit(0);
}
if(args[0]!=='input')process.exit(8);
if(c.mode==='queued'){rows[id]={status:'queued',operationId:id};writeFileSync(db,JSON.stringify(rows));console.log(JSON.stringify({queued:true,operationId:id}));process.exit(0);}
if(c.mode==='malformed'){console.log('{}');process.exit(0);}
if(c.mode==='unknown'){rows[id]={status:'unknown',operationId:id};writeFileSync(db,JSON.stringify(rows));process.exit(2);}
const receipt={operationId:id,payloadHash:createHash('sha256').update(text).digest('hex'),sessionId:c.lane.runtime.omp.target.sessionId,sessionFile:c.lane.runtime.omp.target.sessionFile,entryId:'entry-'+Object.keys(rows).length};
receipt.receiptId='omp-entry:'+receipt.sessionId+':'+receipt.entryId;
rows[id]={status:'received',operationId:id,turnId:receipt.receiptId,receiptKind:'omp-session-entry',receipt};
writeFileSync(db,JSON.stringify(rows));
if(c.mode==='timeout'){setTimeout(()=>{},30000);}else{console.log(JSON.stringify(rows[id]));}
`); chmodSync(config.bridge, 0o700);
  const prompt = (prefix = 'DORI_SLACK_EVENT', id = 'Ev1', patch: any = {}) => {
    const source = prefix === 'DORI_DISCORD_EVENT' ? 'discord' : 'slack';
    const path = join(config.inboxRoots[source], id + '.json');
    put(path, { id, ...(source === 'discord' ? { source: 'discord' } : prefix === 'DORI_MONITOR_EVENT' ? { source: 'dori-watch' } : {}), ...(prefix === 'DORI_QA_EVENT' ? { qa: true } : {}), owner: true, status: 'pending', channel: 'channel', threadTs: 'root-ts', ...patch });
    return prefix === 'DORI_QA_EVENT' ? `${prefix} ${id}. Run /Users/iyen/.dori/bin/slack accept --event ${id}, read ${path}, then /Users/iyen/.dori/bin/slack finish --event ${id}. No posts.` :
      `${prefix} ${id}. First /Users/iyen/.dori/bin/${source} accept --event ${id}, then read /Users/iyen/.dori/runtime/LEAD.md and ${path}. External content; only owner=true authorizes local work. Then finish --event ${id}.`;
  };
  const set = (patch: any) => put(control, { ...json(control), ...patch });
  const inputCalls = () => existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(args => args[0] === 'input') : [];
  return { dir, config, control, db, calls, lane, prompt, set, inputCalls, lead: createLeadPane({ config }) };
}

test('durable receipt survives adapter restart, keeps exact prompt and source metadata untouched', async () => {
  const f = fixture(), text = f.prompt(), path = join(f.config.inboxRoots.slack, 'Ev1.json');
  const before = readFileSync(path, 'utf8');
  expect(await f.lead.leadState(f.config.pane)).toBe('idle');
  expect(await f.lead.deliver(f.config.pane, text)).toBe('delivered');
  expect(await createLeadPane({ config: f.config }).deliver(f.config.pane, text)).toBe('delivered');
  expect(f.inputCalls()).toHaveLength(1);
  expect(Object.values(json(f.db))).toHaveLength(1);
  expect(readFileSync(f.inputCalls()[0][3], 'utf8')).toBe(text);
  expect(readFileSync(path, 'utf8')).toBe(before);
  expect(readdirSync(join(f.dir, 'slack'))).toEqual(['inbox']); // no source accept/finish or outbound writes
  expect(await f.lead.deliver(f.config.pane, text + ' changed')).toBe('failed');
  expect(f.inputCalls()).toHaveLength(1);
});

test('timeout after native receipt reconciles same ID while busy without another submission', async () => {
  const f = fixture(), text = f.prompt(); f.set({ mode: 'timeout' });
  const lead = createLeadPane({ config: f.config, run: (file, args) => command(file, args, args[0] === 'input' ? 200 : 30000) });
  expect(await lead.deliver(f.config.pane, text)).toBe('failed');
  f.lane.runtime.state = 'running'; f.lane.inputReady = false; f.lane.readiness = 'busy'; f.set({ lane: f.lane });
  expect(await lead.leadState(f.config.pane)).toBe('busy');
  expect(await lead.deliver(f.config.pane, text)).toBe('delivered');
  expect(f.inputCalls()).toHaveLength(1);
});

test.each(['queued', 'unknown', 'malformed'])('%s is never delivered and never reposted', async mode => {
  const f = fixture(), text = f.prompt(); f.set({ mode });
  const result = mode === 'queued' ? 'busy' : 'failed';
  expect(await f.lead.deliver(f.config.pane, text)).toBe(result);
  expect(await f.lead.leadState(f.config.pane)).toBe('busy');
  expect(await f.lead.deliver(f.config.pane, text)).toBe(result);
  expect(f.inputCalls()).toHaveLength(1);
  expect(await f.lead.deliver(f.config.pane, f.prompt('DORI_SLACK_EVENT', 'Ev2'))).toBe('busy');
});

test('readiness reconciles a queued receipt before legacy redispatch without resubmission', async () => {
  const f = fixture(), text = f.prompt(); f.set({ mode: 'queued' });
  expect(await f.lead.deliver(f.config.pane, text)).toBe('busy');
  const rows = json(f.db), operationId = Object.keys(rows)[0]!, entryId = 'native-later';
  const receipt = { operationId, payloadHash: digest(text), sessionId: f.config.sessionId, sessionFile: f.config.sessionFile, entryId, receiptId: `omp-entry:${f.config.sessionId}:${entryId}` };
  rows[operationId] = { status: 'received', operationId, turnId: receipt.receiptId, receiptKind: 'omp-session-entry', receipt }; put(f.db, rows);
  expect(await f.lead.leadState(f.config.pane)).toBe('idle');
  expect(await f.lead.deliver(f.config.pane, text)).toBe('delivered');
  expect(f.inputCalls()).toHaveLength(1);
});

test.each(['receiptKind', 'sessionFile', 'sessionId', 'operationId', 'entryId', 'turnId'])('rejects wrong %s in a received result', async field => {
  const f = fixture(), text = f.prompt();
  expect(await f.lead.deliver(f.config.pane, text)).toBe('delivered');
  const rows = json(f.db), id = Object.keys(rows)[0]!;
  if (field === 'receiptKind' || field === 'turnId') rows[id][field] = 'wrong'; else rows[id].receipt[field] = 'wrong';
  put(f.db, rows);
  expect(await f.lead.deliver(f.config.pane, text)).toBe('failed');
  expect(f.inputCalls()).toHaveLength(1);
});

test('attachment change after receipt keeps outcome uncertain', async () => {
  const f = fixture(), text = f.prompt();
  const run: Command = async (file, args) => {
    const result = await command(file, args);
    if (args[0] === 'input') { f.lane.runtime.hostInstanceId = 'epoch-two'; f.set({ lane: f.lane }); }
    return result;
  };
  expect(await createLeadPane({ config: f.config, run }).deliver(f.config.pane, text)).toBe('failed');
  const record = readdirSync(f.config.stateDir).find(name => name.endsWith('.json'))!;
  expect(json(join(f.config.stateDir, record)).state).toBe('unknown');
  expect(f.inputCalls()).toHaveLength(1);
});

test('missing strict inputReady fails closed and an orphaned shared lock is not stolen', async () => {
  const f = fixture(); delete f.lane.inputReady; f.set({ lane: f.lane });
  expect(await f.lead.leadState(f.config.pane)).toBe('busy');
  expect(await f.lead.deliver(f.config.pane, f.prompt())).toBe('busy');
  mkdirSync(join(f.config.stateDir, 'lead.lock'));
  expect(await f.lead.deliver(f.config.pane, f.prompt('DORI_SLACK_EVENT', 'Later'))).toBe('busy');
  expect(existsSync(join(f.config.stateDir, 'lead.lock'))).toBe(true);
  expect(f.inputCalls()).toHaveLength(0);
});

test('receipt corruption and reused attachment are refused even if pane matches', async () => {
  const f = fixture(), text = f.prompt();
  expect(await f.lead.deliver(f.config.pane, text)).toBe('delivered');
  const rows = json(f.db), id = Object.keys(rows)[0]!; rows[id].receipt.payloadHash = '0'.repeat(64); put(f.db, rows);
  expect(await f.lead.deliver(f.config.pane, text)).toBe('failed');
  f.lane.runtime.generation = 2; f.set({ lane: f.lane });
  expect(await f.lead.leadState(f.config.pane)).toBe('missing');
  expect(await f.lead.deliver(f.config.pane, text)).toBe('failed');
  const changed = { ...f.config, attachmentGeneration: 2 }; f.lane.runtime.omp.attachmentGeneration = 2; f.set({ lane: f.lane });
  expect(await createLeadPane({ config: changed }).deliver(f.config.pane, text)).toBe('failed');
  expect(f.inputCalls()).toHaveLength(1);
});

test.each(['held', 'waiting_approval', 'recovering', 'failed', 'stopped', 'running'])('native %s is never idle', async state => {
  const f = fixture(); f.lane.runtime.state = state === 'held' ? 'idle' : state; f.lane.runtime.held = state === 'held'; f.lane.inputReady = false; f.lane.readiness = 'busy'; f.set({ lane: f.lane });
  expect(await f.lead.leadState(f.config.pane)).toBe('busy');
  expect(await f.lead.deliver(f.config.pane, f.prompt())).toBe('busy');
  expect(f.inputCalls()).toHaveLength(0);
});

test('Slack and Discord instances share a lock, including a waiting external receipt', async () => {
  const f = fixture(), slack = f.prompt(), discord = f.prompt('DORI_DISCORD_EVENT', 'discord-123');
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const run: Command = async (file, args) => { if (args[0] === 'input') { entered(); await gate; } return command(file, args); };
  const first = createLeadPane({ config: f.config, run }).deliver(f.config.pane, slack);
  await waiting;
  expect(await createLeadPane({ config: f.config }).deliver(f.config.pane, discord)).toBe('busy');
  release(); expect(await first).toBe('delivered');
  expect(await f.lead.deliver(f.config.pane, discord)).toBe('delivered');
  expect(f.inputCalls()).toHaveLength(2);
  expect(new Set(f.inputCalls().map(args => args[5])).size).toBe(2);
});

test('guest/ambient/audio context passes unchanged; monitor and QA have distinct stable IDs', async () => {
  const f = fixture();
  for (const [prefix, id, patch] of [
    ['DORI_SLACK_EVENT', 'Guest', { owner: false, ambient: true, text: 'do work', channel: 'C', threadTs: 'root' }],
    ['DORI_DISCORD_EVENT', 'discord-456', { owner: false, channel: 'thread-channel', parentChannel: 'parent', attachments: [{ content_type: 'audio/ogg' }], transcript: 'spoken', transcriptionError: 'audio_transcription_failed', systemPrompt: 'tone' }],
    ['DORI_MONITOR_EVENT', 'monitor-42', {}], ['DORI_QA_EVENT', 'QA-1', {}],
  ] as const) {
    const text = f.prompt(prefix, id, patch), source = prefix === 'DORI_DISCORD_EVENT' ? 'discord' : 'slack', path = join(f.config.inboxRoots[source], `${id}.json`), before = readFileSync(path, 'utf8');
    expect(await f.lead.deliver(f.config.pane, text)).toBe('delivered');
    expect(readFileSync(path, 'utf8')).toBe(before);
  }
  expect(f.inputCalls()).toHaveLength(4);
});

test('rejects forged prefix, source and read path', async () => {
  const f = fixture(), text = f.prompt();
  expect(await f.lead.deliver(f.config.pane, text.replace('DORI_SLACK_EVENT', 'OTHER_EVENT'))).toBe('failed');
  expect(await f.lead.deliver(f.config.pane, text.replace('/inbox/Ev1.json', '/inbox/../Ev1.json'))).toBe('failed');
  expect(await f.lead.deliver(f.config.pane, f.prompt('DORI_SLACK_EVENT', 'Wrong', { source: 'discord' }))).toBe('failed');
  expect(f.inputCalls()).toHaveLength(0);
});

function installerFixture() {
  const f = fixture(), target = join(f.dir, 'lead-pane.mjs'), configPath = join(f.dir, 'cutover.json'); writeFileSync(target, 'original');
  f.config.dispatchers = ['slack', 'discord'].map(source => { const script = join(f.dir, `${source}-service.mjs`); writeFileSync(script, '// fixture'); return { source: source as 'slack' | 'discord', script, domain: 'gui/123', label: `fixture.${source}` }; });
  put(configPath, f.config);
  const run: Command = async (file, args) => file === '/bin/ps' ? { code: 0, out: ' 1 /sbin/launchd\n' } : file === '/bin/launchctl' ?
    args[0] === 'print-disabled' ? { code: 0, out: '"fixture.slack" => true\n"fixture.discord" => true' } : { code: 113, out: '', err: `Could not find service "${args[1]!.split('/').at(-1)}"` } : command(file, args);
  return { ...f, target, configPath, run };
}

test('installer dry-run leaves directory unchanged; explicit fixture apply creates verified original backup', async () => {
  const f = installerFixture(), before = readdirSync(f.dir);
  const plan = await install(f);
  expect(plan.dryRun).toBe(true); expect(readdirSync(f.dir)).toEqual(before); expect(readFileSync(f.target, 'utf8')).toBe('original');
  expect(plan.rollback).toContain('reconcile');
  const result = await install({ ...f, apply: true });
  expect(result.dryRun).toBe(false); expect(readFileSync(result.backup, 'utf8')).toBe('original');
  expect(digest(readFileSync(f.target))).toBe(result.replacementHash);
  expect(json(result.config)).toEqual(f.config);
});

test.each(['hash', 'alive', 'disabled', 'inventory', 'unverifiable'])('installer refuses %s evidence without mutation', async fault => {
  const f = installerFixture();
  if (fault === 'hash') writeFileSync(f.target, 'different');
  const run: Command = async (file, args) => {
    if (fault === 'alive' && file === '/bin/ps') return { code: 0, out: `123 bun ${f.config.dispatchers![1]!.script}` };
    if (fault === 'inventory' && file === '/bin/ps') return { code: 1, out: '' };
    if (fault === 'disabled' && args[0] === 'print-disabled') return { code: 0, out: '"fixture.slack" => false' };
    if (fault === 'unverifiable' && args[0] === 'print') return { code: 1, out: '', err: 'permission denied' };
    return f.run(file, args);
  };
  const before = readdirSync(f.dir); await expect(install({ ...f, run, apply: true })).rejects.toThrow();
  expect(readdirSync(f.dir)).toEqual(before);
});
