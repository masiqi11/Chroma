import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { channels, commandNames, commands } from "../src/shared/channels.mjs";

test("preload bridge allows every shared browser command", async () => {
  const preloadSource = await readFile(
    new URL("../src/preload/shell-preload.cjs", import.meta.url),
    "utf8"
  );

  for (const command of commandNames) {
    assert.match(
      preloadSource,
      new RegExp(`(["'])${command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\1`),
      `missing preload allow-list entry for ${command}`
    );
  }
});

test("appearance updates cross only the shared allow-listed command boundary", async () => {
  const preloadSource = await readFile(
    new URL("../src/preload/shell-preload.cjs", import.meta.url),
    "utf8"
  );

  assert.equal(commands.setAppearance, "settings:set-appearance");
  assert.equal(commandNames.has(commands.setAppearance), true);
  assert.match(preloadSource, /["']settings:set-appearance["']/);
});

test("preload bridge exposes shell-owned modal notification channels", async () => {
  const preloadSource = await readFile(
    new URL("../src/preload/shell-preload.cjs", import.meta.url),
    "utf8"
  );

  for (const channel of [channels.openHistory, channels.openCommandPalette]) {
    assert.match(preloadSource, new RegExp(channel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(preloadSource, /onOpenCommandPalette/);
  assert.match(preloadSource, /requestOpenCommandPalette/);
});

test("preload bridge exposes only a sanitized split-ratio preview surface", async () => {
  const preloadSource = await readFile(
    new URL("../src/preload/shell-preload.cjs", import.meta.url),
    "utf8"
  );

  assert.match(preloadSource, new RegExp(channels.splitRatioPreview));
  assert.match(preloadSource, /previewSplitRatio/);
  assert.match(preloadSource, /part === "first" \|\| part === "second"/);
  assert.match(preloadSource, /pathCandidate\.length <= 8/);
  assert.doesNotMatch(preloadSource, /\.filter\(part => part === "first"/);
  assert.match(preloadSource, /typeof ratio === "number"/);
  assert.match(preloadSource, /Number\.isFinite\(ratio\)/);
});
