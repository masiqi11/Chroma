const unavailableOutputCodes = new Set(["EPIPE", "ERR_STREAM_DESTROYED"]);

export function isUnavailableOutputError(error) {
  return unavailableOutputCodes.has(error?.code);
}

function rethrowUnexpectedOutputError(error) {
  setImmediate(() => {
    throw error;
  });
}

export function guardOutputStream(
  stream,
  { onUnexpected = rethrowUnexpectedOutputError } = {}
) {
  if (!stream || typeof stream.on !== "function") return () => {};
  const onError = error => {
    if (isUnavailableOutputError(error)) return;
    onUnexpected(error);
  };
  stream.on("error", onError);
  return () => stream.off?.("error", onError);
}

export function installProcessOutputGuards({
  stdout = process.stdout,
  stderr = process.stderr,
  onUnexpected,
} = {}) {
  const options = onUnexpected ? { onUnexpected } : undefined;
  const removeStdoutGuard = guardOutputStream(stdout, options);
  const removeStderrGuard = guardOutputStream(stderr, options);
  return () => {
    removeStdoutGuard();
    removeStderrGuard();
  };
}
