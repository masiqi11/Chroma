import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { sanitizeState, stateForDisk } from "../shared/model.mjs";

export class StateStore {
  #filePath;
  #idFactory;
  #timer = null;
  #pendingState = null;
  #writePromise = Promise.resolve();

  constructor(filePath, { idFactory = randomUUID } = {}) {
    this.#filePath = filePath;
    this.#idFactory = idFactory;
  }

  async load() {
    try {
      const raw = await readFile(this.#filePath, "utf8");
      return sanitizeState(JSON.parse(raw), this.#idFactory);
    } catch (error) {
      if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) {
        console.warn("Unable to read Chromium shell state:", error);
      }
      return sanitizeState(null, this.#idFactory);
    }
  }

  scheduleSave(state, delay = 120) {
    this.#pendingState = structuredClone(stateForDisk(state));
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#enqueueWrite();
    }, delay);
  }

  async flush(state) {
    if (state) {
      this.#pendingState = structuredClone(stateForDisk(state));
    }
    clearTimeout(this.#timer);
    this.#timer = null;
    this.#enqueueWrite();
    await this.#writePromise;
  }

  #enqueueWrite() {
    if (!this.#pendingState) return;
    const snapshot = this.#pendingState;
    this.#pendingState = null;
    this.#writePromise = this.#writePromise
      .catch(() => {})
      .then(() => this.#write(snapshot));
    // Observe debounced write failures immediately so Node does not treat them
    // as unhandled rejections. Keep #writePromise rejected so flush() can still
    // report the failure to shutdown coordination.
    void this.#writePromise.catch(error => {
      console.warn("Unable to save Chromium shell state:", error);
    });
  }

  async #write(state) {
    const directory = path.dirname(this.#filePath);
    const tempPath = `${this.#filePath}.tmp`;
    await mkdir(directory, { recursive: true });
    await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    try {
      await rename(tempPath, this.#filePath);
    } catch (error) {
      await rm(tempPath, { force: true });
      throw error;
    }
  }
}
