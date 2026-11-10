import { mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// The service requires herdr-core; tests that do not supply their own PATH get the fixture.
const bin = mkdtempSync(join(tmpdir(), "dori-hc-fixture-"));
symlinkSync(join(import.meta.dir, "fixtures/herdr-core.ts"), join(bin, "herdr-core"));
process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
