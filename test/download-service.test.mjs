import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import test from "node:test";

import {
  DownloadService,
  createDownloadService,
} from "../src/main/download-service.mjs";

const NOW = Date.UTC(2026, 6, 16, 12);

class FakeDownloadItem extends EventEmitter {
  constructor(overrides = {}) {
    super();
    this.url = overrides.url ?? "https://example.com/archive.zip";
    this.filename = overrides.filename ?? "archive.zip";
    this.mimeType = overrides.mimeType ?? "application/zip";
    this.savePath = overrides.savePath ?? "/tmp/archive.zip";
    this.receivedBytes = overrides.receivedBytes ?? 0;
    this.totalBytes = overrides.totalBytes ?? 1_000;
    this.startTime = overrides.startTime ?? NOW / 1_000;
    this.state = overrides.state ?? "progressing";
    this.paused = overrides.paused ?? false;
    this.resumable = overrides.resumable ?? true;
    this.destroyed = overrides.destroyed ?? false;
    this.cancelSynchronously = overrides.cancelSynchronously ?? false;
    this.calls = { pause: 0, resume: 0, cancel: 0 };
  }

  getURL() { return this.#read(this.url); }
  getFilename() { return this.#read(this.filename); }
  getMimeType() { return this.#read(this.mimeType); }
  getSavePath() { return this.#read(this.savePath); }
  getReceivedBytes() { return this.#read(this.receivedBytes); }
  getTotalBytes() { return this.#read(this.totalBytes); }
  getStartTime() { return this.#read(this.startTime); }
  getState() { return this.#read(this.state); }
  isPaused() { return this.#read(this.paused); }
  canResume() { return this.#read(this.resumable); }
  isDestroyed() { return this.destroyed; }

  pause() {
    this.#assertAlive();
    this.calls.pause += 1;
    this.paused = true;
  }

  resume() {
    this.#assertAlive();
    this.calls.resume += 1;
    this.paused = false;
  }

  cancel() {
    this.#assertAlive();
    this.calls.cancel += 1;
    if (this.cancelSynchronously) this.finish("cancelled");
  }

  update(state = "progressing") {
    this.emit("updated", {}, state);
  }

  finish(state = "completed") {
    this.emit("done", {}, state);
  }

  #read(value) {
    this.#assertAlive();
    return value;
  }

  #assertAlive() {
    if (this.destroyed) throw new Error("Object has been destroyed");
  }
}

function sequentialIds() {
  let id = 0;
  return () => `download-${++id}`;
}

function fakeTimers() {
  let nextId = 0;
  const callbacks = new Map();
  return {
    setTimer(callback, delay) {
      const handle = { id: ++nextId, delay, unref() {} };
      callbacks.set(handle.id, callback);
      return handle;
    },
    clearTimer(handle) {
      callbacks.delete(handle.id);
    },
    runAll() {
      const pending = [...callbacks.values()];
      callbacks.clear();
      for (const callback of pending) callback();
    },
    get size() { return callbacks.size; },
  };
}

test("register exposes isolated snapshots and deduplicates the same native item", () => {
  const changes = [];
  const item = new FakeDownloadItem({ receivedBytes: 25 });
  const service = createDownloadService([], {
    clock: () => NOW,
    idFactory: sequentialIds(),
    onChange: (downloads, change) => changes.push({ downloads, change }),
  });

  const registered = service.register(item);
  assert.deepEqual(registered, {
    id: "download-1",
    url: "https://example.com/archive.zip",
    filename: "archive.zip",
    mimeType: "application/zip",
    savePath: "/tmp/archive.zip",
    state: "progressing",
    receivedBytes: 25,
    totalBytes: 1_000,
    startedAt: NOW,
    updatedAt: NOW,
    completedAt: null,
    paused: false,
    canResume: true,
    terminal: false,
  });
  assert.deepEqual(service.register(item), registered);
  assert.equal(item.listenerCount("updated"), 1);
  assert.equal(item.listenerCount("done"), 1);
  assert.equal(changes.length, 1);

  const exposed = service.snapshot();
  exposed[0].filename = "mutated.zip";
  exposed.push({ id: "fake" });
  assert.equal(service.get("download-1").filename, "archive.zip");
  assert.equal(service.list().length, 1);
  assert.equal(service.get("missing"), null);
  assert.equal(service.get(null), null);
});

test("download snapshots strip URL credentials and fragments", () => {
  const item = new FakeDownloadItem({
    url: "https://user:secret@example.com/archive.zip#private",
  });
  const service = new DownloadService([], {
    clock: () => NOW,
    idFactory: sequentialIds(),
  });

  assert.equal(service.register(item).url, "https://example.com/archive.zip");
});

test("progress notifications are trailing-throttled and duplicate updates are ignored", () => {
  let now = NOW;
  const timers = fakeTimers();
  const reasons = [];
  const item = new FakeDownloadItem();
  const service = new DownloadService([], {
    clock: () => now,
    idFactory: sequentialIds(),
    progressThrottleMs: 100,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    onChange: (_downloads, change) => reasons.push(change.reason),
  });
  service.register(item);

  item.receivedBytes = 10;
  now += 20;
  item.update();
  item.receivedBytes = 20;
  now += 20;
  item.update();
  item.update();
  assert.deepEqual(reasons, ["registered"]);
  assert.equal(timers.size, 1);
  assert.equal(service.get("download-1").receivedBytes, 20);

  now += 60;
  timers.runAll();
  assert.deepEqual(reasons, ["registered", "progress"]);
  assert.equal(timers.size, 0);

  item.update();
  assert.deepEqual(reasons, ["registered", "progress"]);
});

test("pause, resume, cancel, terminal events, and invalid IDs are safe and idempotent", async () => {
  const persisted = [];
  const persistenceCalls = [];
  const item = new FakeDownloadItem({ receivedBytes: 100 });
  const service = new DownloadService(persisted, {
    clock: () => NOW,
    idFactory: sequentialIds(),
    persist: (downloads, change) => persistenceCalls.push({ downloads, change }),
  });
  const id = service.register(item).id;

  assert.equal(service.pause("missing"), false);
  assert.equal(service.resume("missing"), false);
  assert.equal(service.cancel("missing"), false);
  assert.equal(service.pause(id), true);
  assert.equal(service.pause(id), false);
  assert.equal(item.calls.pause, 1);
  assert.equal(service.get(id).state, "paused");
  assert.equal(service.resume(id), true);
  assert.equal(service.resume(id), false);
  assert.equal(item.calls.resume, 1);
  assert.equal(service.cancel(id), true);
  assert.equal(service.cancel(id), false);
  assert.equal(item.calls.cancel, 1);
  item.receivedBytes = 200;
  item.update("progressing");
  assert.equal(service.get(id).state, "cancelling");
  assert.equal(persisted.length, 0, "active and cancelling rows are not durable");

  item.receivedBytes = 1_000;
  item.finish("completed");
  item.finish("completed");
  await service.flush();
  assert.equal(item.listenerCount("updated"), 0);
  assert.equal(item.listenerCount("done"), 0);
  assert.equal(service.get(id).terminal, true);
  assert.equal(service.get(id).state, "completed");
  assert.equal(service.pause(id), false);
  assert.equal(service.resume(id), false);
  assert.equal(service.cancel(id), false);
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].receivedBytes, 1_000);
  assert.equal(Object.hasOwn(persisted[0], "terminal"), false);
  assert.equal(persistenceCalls.length, 1, "repeated done events persist once");
});

test("an initially interrupted native item can resume", () => {
  const item = new FakeDownloadItem({ state: "interrupted", resumable: true });
  const service = new DownloadService([], {
    clock: () => NOW,
    idFactory: sequentialIds(),
  });
  const id = service.register(item).id;

  assert.equal(service.get(id).state, "interrupted");
  assert.equal(service.resume(id), true);
  assert.equal(item.calls.resume, 1);
  assert.equal(service.get(id).state, "progressing");
});

test("a synchronous cancel done event cannot be overwritten by cancelling state", async () => {
  const backing = [];
  const item = new FakeDownloadItem({ cancelSynchronously: true });
  const service = new DownloadService(backing, {
    clock: () => NOW,
    idFactory: sequentialIds(),
  });
  const id = service.register(item).id;

  assert.equal(service.cancel(id), true);
  await service.flush();
  assert.equal(service.get(id).terminal, true);
  assert.equal(service.get(id).state, "cancelled");
  assert.equal(backing[0].state, "cancelled");
});

test("a destroyed item uses cached terminal data and control methods fail closed", async () => {
  const persisted = [];
  const item = new FakeDownloadItem({ receivedBytes: 400 });
  const service = new DownloadService(persisted, {
    clock: () => NOW,
    idFactory: sequentialIds(),
  });
  const id = service.register(item).id;

  item.destroyed = true;
  assert.equal(service.pause(id), false);
  assert.equal(service.resume(id), false);
  assert.equal(service.cancel(id), false);
  item.finish("interrupted");
  await service.flush();
  assert.equal(service.get(id).state, "interrupted");
  assert.equal(service.get(id).receivedBytes, 400);
  assert.equal(persisted[0].receivedBytes, 400);

  assert.throws(
    () => service.register(new FakeDownloadItem({ destroyed: true })),
    /destroyed/
  );
});

test("done uses the actual save path filename after a save-dialog rename", () => {
  const item = new FakeDownloadItem({
    filename: "server-name.zip",
    savePath: "/tmp/server-name.zip",
  });
  const service = new DownloadService([], {
    clock: () => NOW,
    idFactory: sequentialIds(),
  });
  const id = service.register(item).id;
  item.savePath = "/tmp/user-name.zip";
  item.finish("completed");

  assert.equal(service.get(id).filename, "user-name.zip");
  assert.equal(service.get(id).savePath, "/tmp/user-name.zip");
});

test("open and reveal validate terminal state, absolute paths, existence, and callbacks", async () => {
  const opened = [];
  const revealed = [];
  const existing = new Set(["/tmp/finished.zip"]);
  const service = new DownloadService([
    {
      id: "finished",
      filename: "finished.zip",
      savePath: "/tmp/finished.zip",
      state: "completed",
      receivedBytes: 10,
      totalBytes: 10,
      completedAt: NOW,
    },
    {
      id: "missing",
      filename: "missing.zip",
      savePath: "/tmp/missing.zip",
      state: "completed",
      completedAt: NOW,
    },
    {
      id: "relative",
      filename: "relative.zip",
      savePath: "relative.zip",
      state: "completed",
      completedAt: NOW,
    },
  ], {
    clock: () => NOW,
    pathExists: async filePath => existing.has(filePath),
    openPath: async filePath => { opened.push(filePath); return ""; },
    revealPath: filePath => { revealed.push(filePath); },
  });
  const active = service.register(new FakeDownloadItem(), { id: "active" }).id;

  assert.equal(await service.open("finished"), true);
  assert.equal(await service.reveal("finished"), true);
  assert.equal(await service.open("missing"), false);
  assert.equal(await service.reveal("relative"), false);
  assert.equal(await service.open(active), false);
  assert.equal(await service.open("unknown"), false);
  assert.deepEqual(opened, ["/tmp/finished.zip"]);
  assert.deepEqual(revealed, ["/tmp/finished.zip"]);
});

test("remove and clearFinished preserve active downloads and update durable state", async () => {
  const backing = [
    { id: "one", filename: "one", state: "completed", completedAt: NOW },
    { id: "two", filename: "two", state: "cancelled", completedAt: NOW },
  ];
  const service = new DownloadService(backing, {
    clock: () => NOW,
    idFactory: sequentialIds(),
  });
  const activeItem = new FakeDownloadItem();
  const activeId = service.register(activeItem).id;

  assert.equal(service.remove("unknown"), false);
  assert.equal(service.remove(activeId), false);
  assert.equal(service.remove("one"), true);
  assert.deepEqual(backing.map(item => item.id), ["two"]);
  assert.equal(service.clearFinished(), 1);
  assert.equal(service.clearFinished(), 0);
  assert.deepEqual(service.snapshot().map(item => item.id), [activeId]);
  assert.deepEqual(backing, []);
  await service.flush();
});

test("the terminal record cap is enforced after concurrent active downloads finish", async () => {
  let now = NOW;
  const backing = [];
  const service = new DownloadService(backing, {
    clock: () => now,
    idFactory: sequentialIds(),
    maxRecords: 1,
  });
  const first = new FakeDownloadItem({ filename: "first.zip" });
  const second = new FakeDownloadItem({ filename: "second.zip" });
  const firstId = service.register(first).id;
  const secondId = service.register(second).id;
  assert.equal(service.list().length, 2, "all active downloads remain visible");

  second.finish("completed");
  now += 1;
  first.finish("completed");
  await service.flush();
  assert.deepEqual(service.list().map(download => download.id), [firstId]);
  assert.deepEqual(backing.map(download => download.id), [firstId]);
  assert.equal(service.get(secondId), null);
});

test("dispose clears timers and native listeners and prevents later mutations", () => {
  const timers = fakeTimers();
  const reasons = [];
  const item = new FakeDownloadItem();
  const service = new DownloadService([], {
    clock: () => NOW,
    idFactory: sequentialIds(),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    onChange: (_downloads, change) => reasons.push(change.reason),
  });
  const id = service.register(item).id;
  item.receivedBytes = 1;
  item.update();
  assert.equal(timers.size, 1);

  service.dispose();
  service.dispose();
  assert.equal(service.disposed, true);
  assert.equal(timers.size, 0);
  assert.equal(item.listenerCount("updated"), 0);
  assert.equal(item.listenerCount("done"), 0);
  item.receivedBytes = 2;
  item.update();
  item.finish();
  assert.deepEqual(reasons, ["registered"]);
  assert.equal(service.get(id).terminal, false);
  assert.equal(service.pause(id), false);
  assert.equal(service.remove(id), false);
  assert.throws(() => service.register(new FakeDownloadItem()), /disposed/);
});
