import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createExtensionService } from "../src/main/extension-service.mjs";

function createFakeSession() {
  const loaded = new Map();
  let nextId = 1;
  let failNextLoad = null;
  return {
    extensions: {
      loadExtension: async directory => {
        if (failNextLoad) {
          const message = failNextLoad;
          failNextLoad = null;
          throw new Error(message);
        }
        const extension = {
          id: `ext-${nextId++}`,
          name: `Extension ${nextId - 1}`,
          version: "1.2.3",
          path: directory,
        };
        loaded.set(extension.id, extension);
        return extension;
      },
      removeExtension: id => {
        loaded.delete(id);
      },
    },
    setFailNextLoad(message) {
      failNextLoad = message;
    },
    loaded,
  };
}

async function createHarness() {
  const root = await mkdtemp(path.join(os.tmpdir(), "chroma-ext-test-"));
  const registryFile = path.join(root, "extensions.json");
  const fakeSession = createFakeSession();
  let changeCount = 0;
  const service = createExtensionService({
    browserSession: fakeSession,
    registryFile,
    onChange: () => { changeCount += 1; },
  });
  return {
    root,
    registryFile,
    fakeSession,
    service,
    changes: () => changeCount,
  };
}

async function createUnpackedExtension(root, name) {
  const directory = path.join(root, name);
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "manifest.json"),
    JSON.stringify({ manifest_version: 3, name, version: "1.0.0" })
  );
  return directory;
}

test("installs an unpacked extension, persists it, and reloads it on boot", async () => {
  const harness = await createHarness();
  const directory = await createUnpackedExtension(harness.root, "alpha");

  const entry = await harness.service.install(directory);
  assert.ok(entry.id);
  assert.equal(entry.path, directory);
  assert.deepEqual(harness.service.snapshot(), [entry]);
  assert.equal(harness.changes(), 1);

  const registry = JSON.parse(await readFile(harness.registryFile, "utf8"));
  assert.deepEqual(registry, [{ path: directory }]);

  const secondBoot = await createHarness();
  const rebootService = createExtensionService({
    browserSession: secondBoot.fakeSession,
    registryFile: harness.registryFile,
  });
  const { loadedCount, failures } = await rebootService.loadInstalled();
  assert.equal(loadedCount, 1);
  assert.deepEqual(failures, []);
  assert.equal(rebootService.snapshot()[0].path, directory);
});

test("rejects packed archives and directories without a manifest", async () => {
  const harness = await createHarness();
  await assert.rejects(
    () => harness.service.install(path.join(harness.root, "missing")),
    /ENOENT/
  );
  await assert.rejects(
    () => harness.service.install(path.join(harness.root, "bundle.crx")),
    /not supported/
  );
  await assert.rejects(() => harness.service.install(""), /required/);
  assert.deepEqual(harness.service.snapshot(), []);
  assert.equal(harness.changes(), 0);
});

test("installing the same directory twice is idempotent", async () => {
  const harness = await createHarness();
  const directory = await createUnpackedExtension(harness.root, "beta");

  const first = await harness.service.install(directory);
  const second = await harness.service.install(directory);
  assert.equal(second.id, first.id);
  assert.equal(harness.service.snapshot().length, 1);
  const registry = JSON.parse(await readFile(harness.registryFile, "utf8"));
  assert.equal(registry.length, 1);
});

test("remove unloads the extension and prunes the registry", async () => {
  const harness = await createHarness();
  const directory = await createUnpackedExtension(harness.root, "gamma");
  const entry = await harness.service.install(directory);

  assert.equal(await harness.service.remove(entry.id), true);
  assert.deepEqual(harness.service.snapshot(), []);
  assert.equal(harness.fakeSession.loaded.size, 0);
  assert.deepEqual(JSON.parse(await readFile(harness.registryFile, "utf8")), []);

  assert.equal(await harness.service.remove("missing-id"), false);
});

test("reload replaces the loaded instance for the same directory", async () => {
  const harness = await createHarness();
  const directory = await createUnpackedExtension(harness.root, "delta");
  const entry = await harness.service.install(directory);

  assert.equal(await harness.service.reload(entry.id), true);
  const snapshot = harness.service.snapshot();
  assert.equal(snapshot.length, 1);
  assert.equal(snapshot[0].path, directory);
  assert.notEqual(snapshot[0].id, entry.id);

  assert.equal(await harness.service.reload("missing-id"), false);
});

test("boot replay drops registry entries that fail to load", async () => {
  const harness = await createHarness();
  const good = await createUnpackedExtension(harness.root, "good");
  const bad = await createUnpackedExtension(harness.root, "bad");
  await harness.service.install(good);
  await harness.service.install(bad);

  const rebootSession = createFakeSession();
  const rebootService = createExtensionService({
    browserSession: rebootSession,
    registryFile: harness.registryFile,
  });
  rebootSession.setFailNextLoad("simulated corrupt extension");
  const { loadedCount, failures } = await rebootService.loadInstalled();

  assert.equal(loadedCount, 1);
  assert.equal(failures.length, 1);
  assert.match(failures[0].message, /simulated corrupt extension/);
  const registry = JSON.parse(await readFile(harness.registryFile, "utf8"));
  assert.equal(registry.length, 1, "the failing entry must be pruned from the registry");
});

test("reads action metadata and embeds the largest in-root icon as a data URI", async () => {
  const { root, service } = await createHarness();
  const directory = path.join(root, "with-action");
  await mkdir(directory, { recursive: true });
  // A 1x1 transparent PNG.
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64"
  );
  await writeFile(path.join(directory, "icon-16.png"), png);
  await writeFile(path.join(directory, "icon-64.png"), png);
  await writeFile(path.join(directory, "popup.html"), "<!doctype html>");
  await writeFile(
    path.join(directory, "manifest.json"),
    JSON.stringify({
      manifest_version: 3,
      name: "Action Extension",
      version: "1.0.0",
      icons: { 16: "icon-16.png" },
      action: {
        default_popup: "popup.html",
        default_title: "Do action",
        default_icon: { 16: "icon-16.png", 64: "icon-64.png" },
      },
    })
  );

  const entry = await service.install(directory);
  assert.equal(entry.popupPath, "popup.html");
  assert.equal(entry.actionTitle, "Do action");
  assert.ok(entry.iconDataUrl.startsWith("data:image/png;base64,"));
  assert.deepEqual(service.snapshot().find(item => item.id === entry.id), entry);
});

test("discards escaping popup paths, foreign icon types, and oversized icons", async () => {
  const { root, service } = await createHarness();
  const directory = path.join(root, "hostile-action");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "icon.svg"), "<svg/>");
  await writeFile(
    path.join(directory, "manifest.json"),
    JSON.stringify({
      manifest_version: 3,
      name: "Hostile Extension",
      version: "1.0.0",
      icons: { 128: "icon.svg" },
      action: { default_popup: "../outside.html", default_icon: "../evil.png" },
    })
  );
  const hostile = await service.install(directory);
  assert.equal(hostile.popupPath, "");
  assert.equal(hostile.iconDataUrl, "", "SVG and escaping icons must be discarded");

  const oversizedDirectory = path.join(root, "oversized-icon");
  await mkdir(oversizedDirectory, { recursive: true });
  await writeFile(path.join(oversizedDirectory, "big.png"), Buffer.alloc(256 * 1024));
  await writeFile(
    path.join(oversizedDirectory, "manifest.json"),
    JSON.stringify({
      manifest_version: 3,
      name: "Oversized Icon",
      version: "1.0.0",
      icons: { 128: "big.png" },
    })
  );
  const oversized = await service.install(oversizedDirectory);
  assert.equal(oversized.iconDataUrl, "");
});
