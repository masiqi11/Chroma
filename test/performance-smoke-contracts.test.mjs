import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sourcePromise = readFile(
  new URL("../scripts/performance-smoke.mjs", import.meta.url),
  "utf8"
);

function sourceBetween(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `missing source marker: ${start}`);
  assert.notEqual(endIndex, -1, `missing source marker: ${end}`);
  return source.slice(startIndex, endIndex);
}

test("performance smoke invalidates stale passing artifacts before setup", async () => {
  const source = await sourcePromise;
  const startingReport = source.indexOf('status: "starting"');
  const gitDiscovery = source.indexOf("git: await resolveGitMetadata()");
  const temporaryProfile = source.indexOf("userData = await mkdtemp");
  const electronLaunch = source.indexOf("child = spawn(");

  assert.ok(startingReport >= 0);
  assert.ok(startingReport < gitDiscovery);
  assert.ok(startingReport < temporaryProfile);
  assert.ok(startingReport < electronLaunch);
  assert.match(
    source.slice(0, gitDiscovery),
    /passed:\s*false,[\s\S]*status:\s*"starting"/
  );
  assert.match(source, /passed:\s*false,[\s\S]*status:\s*"running"/);
});

test("performance reports are versioned and diagnostic on every outcome", async () => {
  const source = await sourcePromise;
  const metadata = sourceBetween(
    source,
    "const initialMetadata = {",
    "// Overwrite any previous passing artifact"
  );
  const finalReport = sourceBetween(
    source,
    "const finalReport = {",
    "try {\n  await writeReport(finalReport);"
  );

  for (const field of [
    "schemaVersion",
    "timestamp",
    "git",
    "platform",
    "arch",
    "osRelease",
    "node",
    "electron",
    "mode",
  ]) {
    assert.match(metadata, new RegExp(`\\b${field}:`));
  }
  assert.match(source, /return "unavailable"/);
  assert.match(finalReport, /passed:\s*!runError/);
  assert.match(finalReport, /status:\s*runError \? "failed" : "passed"/);
  assert.match(finalReport, /fatalLogMatches/);
  assert.match(finalReport, /cleanupErrors/);
  assert.match(finalReport, /error:\s*serializeError\(runError\)/);
  assert.match(finalReport, /outputTail:\s*logs\.slice\(-16_000\)/);
});

test("CDP connection and commands have explicit timeouts", async () => {
  const source = await sourcePromise;
  const cdpClient = sourceBetween(
    source,
    "class CdpClient {",
    "function round(value)"
  );

  assert.match(cdpClient, /async open\(timeoutMilliseconds = cdpOpenTimeoutMilliseconds\)/);
  assert.match(cdpClient, /connection open timed out after/);
  assert.match(cdpClient, /timeoutMilliseconds = cdpCommandTimeoutMilliseconds/);
  assert.match(cdpClient, /DevTools \$\{method\} timed out after/);
  assert.match(cdpClient, /readyState !== WebSocket\.OPEN/);
});

test("fatal log and cleanup contracts cover known Electron failure modes", async () => {
  const source = await sourcePromise;

  for (const marker of [
    "render-process-gone",
    "unhandled-rejection",
    "epipe",
    "object-destroyed",
    "shell-preload-failed",
    "sandboxed-renderer-script-failed",
  ]) {
    assert.ok(source.includes(`"${marker}"`), `missing fatal marker ${marker}`);
  }
  assert.match(source, /await cleanup\(\)/);
  assert.match(source, /cleanupTimeoutMilliseconds/);
  assert.match(source, /SIGKILL/);
  assert.match(source, /fixtureServer\.closeAllConnections\?\.\(\)/);
  assert.match(source, /temporary user-data removal/);
});
