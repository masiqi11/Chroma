import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import path from "node:path";

export const DOWNLOAD_TERMINAL_STATES = Object.freeze([
  "completed",
  "cancelled",
  "interrupted",
]);

const TERMINAL_STATES = new Set(DOWNLOAD_TERMINAL_STATES);
const UPDATED_STATES = new Set(["progressing", "interrupted"]);
const MAX_TEXT_LENGTH = 4_096;
const MAX_FILENAME_LENGTH = 500;
const MAX_MIME_LENGTH = 200;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finiteNonNegative(value, fallback = 0) {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function boundedText(value, maximum = MAX_TEXT_LENGTH) {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function normalizeFilePath(value) {
  const normalized = boundedText(value);
  return normalized && path.isAbsolute(normalized) ? normalized : "";
}

function normalizeDownloadUrl(value) {
  const raw = boundedText(value, 8_192);
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol)) return "";
    url.username = "";
    url.password = "";
    url.hash = "";
    return url.href.length <= 8_192 ? url.href : "";
  } catch {
    return "";
  }
}

function normalizeTimestamp(value, fallback) {
  if (!Number.isFinite(value) || value < 0) return fallback;
  // Electron reports DownloadItem#getStartTime in seconds.
  return value > 0 && value < 100_000_000_000 ? value * 1_000 : value;
}

function safeRead(item, method, fallback) {
  try {
    return typeof item?.[method] === "function" ? item[method]() : fallback;
  } catch {
    return fallback;
  }
}

function itemIsDestroyed(item) {
  try {
    if (typeof item?.isDestroyed === "function") return item.isDestroyed() === true;
    // DownloadItem has no public isDestroyed() in Electron. getState() is a
    // side-effect-free probe that throws after the native wrapper is gone.
    if (typeof item?.getState === "function") item.getState();
    return false;
  } catch {
    return true;
  }
}

function terminalState(value, fallback = "interrupted") {
  return TERMINAL_STATES.has(value) ? value : fallback;
}

function eventState(first, second) {
  if (typeof second === "string") return second;
  return typeof first === "string" ? first : "";
}

function cloneSnapshot(record) {
  return {
    id: record.id,
    url: record.url,
    filename: record.filename,
    mimeType: record.mimeType,
    savePath: record.savePath,
    state: record.state,
    receivedBytes: record.receivedBytes,
    totalBytes: record.totalBytes,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    completedAt: record.completedAt,
    paused: record.paused,
    canResume: record.canResume,
    terminal: record.terminal,
  };
}

function terminalMetadata(record) {
  const snapshot = cloneSnapshot(record);
  delete snapshot.paused;
  delete snapshot.canResume;
  delete snapshot.terminal;
  return snapshot;
}

function normalizePersistedDownload(value, id, now) {
  if (!isObject(value) || !TERMINAL_STATES.has(value.state)) return null;
  const savePath = normalizeFilePath(value.savePath);
  const filename = boundedText(value.filename, MAX_FILENAME_LENGTH)
    || (savePath ? path.basename(savePath) : "Download");
  const startedAt = normalizeTimestamp(value.startedAt, now);
  const updatedAt = normalizeTimestamp(value.updatedAt, startedAt);

  return {
    id,
    url: normalizeDownloadUrl(value.url),
    filename,
    mimeType: boundedText(value.mimeType, MAX_MIME_LENGTH),
    savePath,
    state: value.state,
    receivedBytes: finiteNonNegative(value.receivedBytes),
    totalBytes: finiteNonNegative(value.totalBytes),
    startedAt,
    updatedAt,
    completedAt: normalizeTimestamp(value.completedAt, updatedAt),
    paused: false,
    canResume: false,
    terminal: true,
    item: null,
    listeners: null,
    progressTimer: null,
    lastProgressPublishedAt: null,
  };
}

async function defaultPathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function callbackSucceeded(result) {
  return result === undefined || result === true || result === "";
}

/**
 * Electron-independent download lifecycle service. DownloadItem-like objects and
 * all platform side effects are injected, so the lifecycle is testable in Node.
 */
export class DownloadService {
  #backingDownloads;
  #clock;
  #idFactory;
  #onChange;
  #persist;
  #openPath;
  #revealPath;
  #pathExists;
  #setTimer;
  #clearTimer;
  #progressThrottleMs;
  #maxRecords;
  #records = new Map();
  #order = [];
  #itemIds = new WeakMap();
  #disposed = false;
  #persistencePromise = Promise.resolve();

  constructor(persistedDownloads = [], options = {}) {
    if (!Array.isArray(persistedDownloads)) {
      throw new TypeError("persistedDownloads must be an array");
    }
    if (!isObject(options)) throw new TypeError("download service options must be an object");

    const {
      clock = Date.now,
      idFactory = randomUUID,
      onChange = () => {},
      persist = () => {},
      openPath = async () => false,
      revealPath = options.showItemInFolder ?? (async () => false),
      pathExists = defaultPathExists,
      setTimer = setTimeout,
      clearTimer = clearTimeout,
      progressThrottleMs = 120,
      maxRecords = 100,
    } = options;

    for (const [name, callback] of Object.entries({
      clock,
      idFactory,
      onChange,
      persist,
      openPath,
      revealPath,
      pathExists,
      setTimer,
      clearTimer,
    })) {
      if (typeof callback !== "function") throw new TypeError(`${name} must be a function`);
    }
    if (!Number.isFinite(progressThrottleMs) || progressThrottleMs < 0) {
      throw new TypeError("progressThrottleMs must be a non-negative number");
    }
    if (!Number.isInteger(maxRecords) || maxRecords < 1) {
      throw new TypeError("maxRecords must be a positive integer");
    }

    this.#backingDownloads = persistedDownloads;
    this.#clock = clock;
    this.#idFactory = idFactory;
    this.#onChange = onChange;
    this.#persist = persist;
    this.#openPath = openPath;
    this.#revealPath = revealPath;
    this.#pathExists = pathExists;
    this.#setTimer = setTimer;
    this.#clearTimer = clearTimer;
    this.#progressThrottleMs = progressThrottleMs;
    this.#maxRecords = maxRecords;

    const usedIds = new Set();
    const now = this.#now();
    for (const persisted of persistedDownloads) {
      if (this.#order.length === maxRecords) break;
      const id = this.#uniqueId(persisted?.id, usedIds);
      const record = normalizePersistedDownload(persisted, id, now);
      if (!record) continue;
      usedIds.add(id);
      this.#records.set(id, record);
      this.#order.push(id);
    }
    this.#syncBackingDownloads();
  }

  get disposed() {
    return this.#disposed;
  }

  snapshot() {
    return this.#order
      .map(id => this.#records.get(id))
      .filter(Boolean)
      .map(cloneSnapshot);
  }

  list() {
    return this.snapshot();
  }

  persistedSnapshot() {
    return this.#order
      .map(id => this.#records.get(id))
      .filter(record => record?.terminal)
      .slice(0, this.#maxRecords)
      .map(terminalMetadata);
  }

  get(id) {
    const record = this.#find(id);
    return record ? cloneSnapshot(record) : null;
  }

  register(item, metadata = {}) {
    if (this.#disposed) throw new Error("DownloadService has been disposed");
    if (!isObject(item) || typeof item.on !== "function") {
      throw new TypeError("item must be a DownloadItem-like event emitter");
    }
    if (!isObject(metadata)) throw new TypeError("download metadata must be an object");
    if (itemIsDestroyed(item)) throw new Error("Cannot register a destroyed download item");

    const existingId = this.#itemIds.get(item);
    if (existingId) return this.get(existingId);

    const requestedId = boundedText(metadata.id);
    if (requestedId && this.#records.has(requestedId)) {
      throw new Error(`A download with id ${requestedId} is already registered`);
    }

    const now = this.#now();
    const id = this.#uniqueId(requestedId, new Set(this.#records.keys()));
    const savePath = normalizeFilePath(
      metadata.savePath ?? safeRead(item, "getSavePath", "")
    );
    const filename = boundedText(
      metadata.filename ?? safeRead(item, "getFilename", ""),
      MAX_FILENAME_LENGTH
    ) || (savePath ? path.basename(savePath) : "Download");
    const paused = Boolean(safeRead(item, "isPaused", false));
    const nativeState = safeRead(item, "getState", "progressing");
    const record = {
      id,
      url: normalizeDownloadUrl(metadata.url ?? safeRead(item, "getURL", "")),
      filename,
      mimeType: boundedText(
        metadata.mimeType ?? safeRead(item, "getMimeType", ""),
        MAX_MIME_LENGTH
      ),
      savePath,
      state: paused ? "paused" : nativeState === "interrupted" ? "interrupted" : "progressing",
      receivedBytes: finiteNonNegative(
        metadata.receivedBytes ?? safeRead(item, "getReceivedBytes", 0)
      ),
      totalBytes: finiteNonNegative(
        metadata.totalBytes ?? safeRead(item, "getTotalBytes", 0)
      ),
      startedAt: normalizeTimestamp(
        metadata.startedAt ?? safeRead(item, "getStartTime", now),
        now
      ),
      updatedAt: now,
      completedAt: null,
      paused,
      canResume: Boolean(safeRead(item, "canResume", false)),
      terminal: false,
      item,
      listeners: null,
      progressTimer: null,
      lastProgressPublishedAt: now,
    };

    const updated = (first, second) => this.#handleUpdated(id, eventState(first, second));
    const done = (first, second) => this.#handleDone(id, eventState(first, second));
    record.listeners = { updated, done };
    try {
      item.on("updated", updated);
      item.on("done", done);
    } catch (error) {
      item.removeListener?.("updated", updated);
      item.removeListener?.("done", done);
      throw error;
    }
    this.#itemIds.set(item, id);
    this.#records.set(id, record);
    this.#order.unshift(id);
    this.#trimRecords();
    this.#publish(record, "registered");
    return cloneSnapshot(record);
  }

  pause(id) {
    const record = this.#activeRecord(id);
    if (!record || record.paused || record.state === "cancelling") return false;
    if (!this.#invokeItem(record, "pause")) return false;
    if (record.terminal) return true;
    record.paused = true;
    record.canResume = Boolean(safeRead(record.item, "canResume", true));
    record.state = "paused";
    record.updatedAt = this.#now();
    this.#publish(record, "paused", true);
    return true;
  }

  resume(id) {
    const record = this.#activeRecord(id);
    if (!record || record.state === "cancelling" || (!record.paused && record.state !== "interrupted")) {
      return false;
    }
    if (typeof record.item?.canResume === "function" && !safeRead(record.item, "canResume", false)) {
      return false;
    }
    if (!this.#invokeItem(record, "resume")) return false;
    if (record.terminal) return true;
    record.paused = false;
    record.canResume = Boolean(safeRead(record.item, "canResume", false));
    record.state = "progressing";
    record.updatedAt = this.#now();
    this.#publish(record, "resumed", true);
    return true;
  }

  cancel(id) {
    const record = this.#activeRecord(id);
    if (!record || record.state === "cancelling") return false;
    if (!this.#invokeItem(record, "cancel")) return false;
    if (record.terminal) return true;
    record.paused = false;
    record.canResume = false;
    record.state = "cancelling";
    record.updatedAt = this.#now();
    this.#publish(record, "cancelling", true);
    return true;
  }

  async open(id) {
    if (this.#disposed) return false;
    const record = this.#find(id);
    if (!record?.terminal || record.state !== "completed") return false;
    return this.#withExistingPath(record, this.#openPath);
  }

  async reveal(id) {
    if (this.#disposed) return false;
    const record = this.#find(id);
    if (!record) return false;
    return this.#withExistingPath(record, this.#revealPath);
  }

  remove(id) {
    if (this.#disposed) return false;
    const record = this.#find(id);
    if (!record?.terminal) return false;
    this.#detachItem(record);
    this.#records.delete(record.id);
    this.#order = this.#order.filter(candidate => candidate !== record.id);
    this.#syncBackingDownloads();
    this.#queuePersistence("removed", record.id);
    this.#notify("removed", record.id);
    return true;
  }

  clearFinished() {
    if (this.#disposed) return 0;
    const removedIds = this.#order.filter(id => this.#records.get(id)?.terminal);
    if (!removedIds.length) return 0;
    for (const id of removedIds) {
      const record = this.#records.get(id);
      if (record) this.#detachItem(record);
      this.#records.delete(id);
    }
    const removed = new Set(removedIds);
    this.#order = this.#order.filter(id => !removed.has(id));
    this.#syncBackingDownloads();
    this.#queuePersistence("cleared", null);
    this.#notify("cleared", null);
    return removedIds.length;
  }

  async flush() {
    await this.#persistencePromise;
  }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const record of this.#records.values()) this.#detachItem(record);
  }

  #handleUpdated(id, state) {
    if (this.#disposed) return;
    const record = this.#activeRecord(id);
    if (!record) return;

    const before = JSON.stringify([
      record.filename,
      record.savePath,
      record.state,
      record.receivedBytes,
      record.totalBytes,
      record.paused,
      record.canResume,
    ]);
    this.#refreshFromItem(record);
    record.state = record.state === "cancelling"
      ? "cancelling"
      : record.paused
        ? "paused"
        : UPDATED_STATES.has(state)
          ? state
          : record.state === "paused"
            ? "progressing"
            : record.state;
    const after = JSON.stringify([
      record.filename,
      record.savePath,
      record.state,
      record.receivedBytes,
      record.totalBytes,
      record.paused,
      record.canResume,
    ]);
    if (before === after) return;

    record.updatedAt = this.#now();
    const elapsed = record.lastProgressPublishedAt === null
      ? Number.POSITIVE_INFINITY
      : record.updatedAt - record.lastProgressPublishedAt;
    if (this.#progressThrottleMs === 0 || elapsed >= this.#progressThrottleMs) {
      this.#publish(record, "progress", true);
      return;
    }
    if (record.progressTimer !== null) return;
    const delay = Math.max(0, this.#progressThrottleMs - Math.max(0, elapsed));
    record.progressTimer = this.#setTimer(() => {
      record.progressTimer = null;
      if (!this.#disposed && !record.terminal && this.#records.get(id) === record) {
        this.#publish(record, "progress");
      }
    }, delay);
    record.progressTimer?.unref?.();
  }

  #handleDone(id, state) {
    if (this.#disposed) return;
    const record = this.#find(id);
    if (!record || record.terminal) return;
    this.#refreshFromItem(record);
    const now = this.#now();
    record.state = terminalState(state);
    record.paused = false;
    record.canResume = false;
    record.terminal = true;
    record.updatedAt = now;
    record.completedAt = now;
    this.#detachItem(record);
    this.#order = [id, ...this.#order.filter(candidate => candidate !== id)];
    this.#trimRecords();
    this.#queuePersistence("finished", id);
    this.#publish(record, "finished", true);
  }

  #refreshFromItem(record) {
    const item = record.item;
    const filename = boundedText(safeRead(item, "getFilename", record.filename), MAX_FILENAME_LENGTH);
    const savePath = normalizeFilePath(safeRead(item, "getSavePath", record.savePath));
    if (savePath) {
      record.savePath = savePath;
      record.filename = path.basename(savePath);
    } else if (filename) {
      record.filename = filename;
    }
    record.receivedBytes = finiteNonNegative(
      safeRead(item, "getReceivedBytes", record.receivedBytes),
      record.receivedBytes
    );
    record.totalBytes = finiteNonNegative(
      safeRead(item, "getTotalBytes", record.totalBytes),
      record.totalBytes
    );
    record.paused = Boolean(safeRead(item, "isPaused", record.paused));
    record.canResume = Boolean(safeRead(item, "canResume", record.canResume));
  }

  #activeRecord(id) {
    if (this.#disposed) return null;
    const record = this.#find(id);
    if (!record || record.terminal || !record.item || itemIsDestroyed(record.item)) return null;
    return record;
  }

  #find(id) {
    if (typeof id !== "string" || !id.trim()) return null;
    return this.#records.get(id.trim()) ?? null;
  }

  #invokeItem(record, method) {
    if (itemIsDestroyed(record.item) || typeof record.item?.[method] !== "function") return false;
    try {
      record.item[method]();
      return true;
    } catch {
      return false;
    }
  }

  async #withExistingPath(record, callback) {
    const filePath = normalizeFilePath(record.savePath);
    if (!filePath) return false;
    try {
      if (await this.#pathExists(filePath, cloneSnapshot(record)) !== true) return false;
      const result = await callback(filePath, cloneSnapshot(record));
      return callbackSucceeded(result);
    } catch {
      return false;
    }
  }

  #publish(record, reason, cancelPending = false) {
    if (cancelPending && record.progressTimer !== null) {
      this.#clearTimer(record.progressTimer);
      record.progressTimer = null;
    }
    record.lastProgressPublishedAt = this.#now();
    this.#notify(reason, record.id);
  }

  #notify(reason, id) {
    this.#onChange(this.snapshot(), { reason, id });
  }

  #detachItem(record) {
    if (record.progressTimer !== null) {
      this.#clearTimer(record.progressTimer);
      record.progressTimer = null;
    }
    if (!record.item || !record.listeners) return;
    const remove = typeof record.item.off === "function"
      ? record.item.off.bind(record.item)
      : typeof record.item.removeListener === "function"
        ? record.item.removeListener.bind(record.item)
        : null;
    if (remove) {
      try {
        remove("updated", record.listeners.updated);
        remove("done", record.listeners.done);
      } catch {
        // A native item can become invalid while the app is shutting down.
      }
    }
    this.#itemIds.delete(record.item);
    record.item = null;
    record.listeners = null;
  }

  #trimRecords() {
    let terminalCount = this.#order.reduce(
      (count, id) => count + Number(this.#records.get(id)?.terminal === true),
      0
    );
    while (terminalCount > this.#maxRecords) {
      const removableIndex = this.#order.findLastIndex(id => this.#records.get(id)?.terminal);
      if (removableIndex < 0) return;
      const [id] = this.#order.splice(removableIndex, 1);
      const record = this.#records.get(id);
      if (record) this.#detachItem(record);
      this.#records.delete(id);
      terminalCount -= 1;
    }
    this.#syncBackingDownloads();
  }

  #syncBackingDownloads() {
    const persisted = this.persistedSnapshot();
    this.#backingDownloads.splice(0, this.#backingDownloads.length, ...persisted);
  }

  #queuePersistence(reason, id) {
    const snapshot = this.persistedSnapshot();
    this.#persistencePromise = this.#persistencePromise
      .catch(() => {})
      .then(() => this.#persist(snapshot, { reason, id }));
    void this.#persistencePromise.catch(() => {});
  }

  #uniqueId(requested, used) {
    const normalized = boundedText(requested);
    if (normalized && !used.has(normalized)) return normalized;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const generated = boundedText(this.#idFactory());
      if (generated && !used.has(generated)) return generated;
    }
    let suffix = used.size + 1;
    while (used.has(`download-${suffix}`)) suffix += 1;
    return `download-${suffix}`;
  }

  #now() {
    const value = this.#clock();
    return Number.isFinite(value) && value >= 0 ? value : Date.now();
  }
}

export function createDownloadService(persistedDownloads, options) {
  return new DownloadService(persistedDownloads, options);
}
