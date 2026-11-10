import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const controller = String.raw`
import os, pty, select, signal, sys, time, json, shlex
pid, fd = pty.fork()
if pid == 0:
    command = 'export FIXTURE_SHELL_PID=$$; ' + ' '.join(shlex.quote(x) for x in sys.argv[1:]) + '; exit $?'
    os.execv('/bin/bash', ['bash', '-c', command])
text = ''; sent = False; signalled = False; deadline = time.time() + 10
try:
    while time.time() < deadline:
        if select.select([fd], [], [], .05)[0]:
            try: chunk = os.read(fd, 65536)
            except OSError: break
            if not chunk: break
            text += chunk.decode(errors='replace')
        if 'NATIVE_READY' in text and not sent:
            os.write(fd, b'hello-native\n'); sent = True
        if 'NATIVE_INPUT hello-native' in text and not signalled:
            if sys.argv[-2] == 'term':
                supervisor = int(text.split('PROVEN ')[1].split()[0]); os.kill(supervisor, signal.SIGTERM)
            else: os.killpg(pid, signal.SIGINT)
            signalled = True
        if 'DONE FENCES 0' in text: break
    print(json.dumps({'text':text, 'signalled':signalled}))
finally:
    try: os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError: pass
    os.waitpid(pid, 0); os.close(fd)
`;
test.each(["normal", "failure", "term", "sibling", "service"])("real PTY %s: two launch fences, native-only input, signal and child lifetime", async mode => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "iyen-terminal-")));
  try {
    const child = Bun.spawn(["python3", "-c", controller, process.execPath, join(import.meta.dir, "fixtures/launcher-terminal.ts"), mode, dir], { stdout: "pipe", stderr: "pipe", env: process.env });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(err).toBe(""); expect(code).toBe(0); const result = JSON.parse(out);
    if (mode === "sibling") { expect(result.text).toContain("another process"); expect(result.text).not.toContain("NATIVE_READY"); }
    else {
      expect(result.text).toContain("PROVEN"); expect(result.text).toContain("NATIVE_INPUT hello-native"); expect(result.signalled).toBe(true);
      expect(result.text).toContain(mode === "term" ? "NATIVE_SIGTERM" : "NATIVE_SIGINT");
      expect(result.text).toContain("REAPED 0 FENCES 2");
      if (mode === "service") expect(result.text).toContain("OWNED_SERVICE 1");
      if (mode === "failure") expect(result.text).toContain("fixture startup verification failed");
    }
    expect(result.text).toContain("DONE FENCES 0");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 15000);
