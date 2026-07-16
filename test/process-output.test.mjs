import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  guardOutputStream,
  isUnavailableOutputError,
} from "../src/main/process-output.mjs";

test("treats closed output pipes as non-fatal", () => {
  assert.equal(isUnavailableOutputError({ code: "EPIPE" }), true);
  assert.equal(isUnavailableOutputError({ code: "ERR_STREAM_DESTROYED" }), true);
  assert.equal(isUnavailableOutputError({ code: "ENOSPC" }), false);
});

test("guards only unavailable-output errors", () => {
  const stream = new EventEmitter();
  const unexpected = [];
  const removeGuard = guardOutputStream(stream, {
    onUnexpected: error => unexpected.push(error),
  });

  stream.emit("error", Object.assign(new Error("closed pipe"), { code: "EPIPE" }));
  stream.emit(
    "error",
    Object.assign(new Error("destroyed stream"), { code: "ERR_STREAM_DESTROYED" })
  );
  const diskError = Object.assign(new Error("unexpected output failure"), {
    code: "ENOSPC",
  });
  stream.emit("error", diskError);

  assert.deepEqual(unexpected, [diskError]);
  removeGuard();
  assert.equal(stream.listenerCount("error"), 0);
});
