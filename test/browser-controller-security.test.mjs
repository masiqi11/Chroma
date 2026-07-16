import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

const electronMockUrl = new URL(
  "./fixtures/electron-controller-mock.mjs",
  import.meta.url
).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "electron") {
      return { url: electronMockUrl, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const [
  { BrowserController },
  {
    TAB_COUNT_LIMIT,
    TAB_DATA_FAVICON_MAX_LENGTH,
    createDefaultState,
  },
  electron,
] = await Promise.all([
  import("../src/main/browser-controller.mjs"),
  import("../src/shared/model.mjs"),
  import("electron"),
]);

function createHarness() {
  electron.electronMock.reset();
  let nextId = 1;
  const state = createDefaultState(() => `security-${nextId++}`);
  state.tabs = [];
  state.activeTabId = "";
  const store = {
    scheduleSave() {},
    async flush() {},
  };
  const window = new electron.MockBrowserWindow();
  const controller = new BrowserController(window, state, store);
  return { controller, state, window };
}

async function createPage(controller, url = "https://media.example/") {
  const id = await controller.createTab({ url });
  const view = electron.electronMock.views.at(-1);
  await new Promise(resolve => setImmediate(resolve));
  return { id, view, contents: view.webContents, session: view.webContents.session };
}

function requestPermission(session, contents, permission, details) {
  return new Promise(resolve => {
    session.permissionRequestHandler(
      contents,
      permission,
      resolve,
      details
    );
  });
}

test("media permission decisions isolate microphone, camera, and origin scope", async () => {
  const { controller } = createHarness();
  const { contents, session } = await createPage(controller);
  const originalShowMessageBox = electron.dialog.showMessageBox;
  const prompts = [];
  electron.dialog.showMessageBox = async (_window, options) => {
    prompts.push(options.message);
    return { response: 0 };
  };

  const mainAudioRequest = {
    requestingUrl: "https://media.example/audio",
    securityOrigin: "https://media.example",
    isMainFrame: true,
    mediaTypes: ["audio"],
  };
  try {
    assert.equal(
      await requestPermission(session, contents, "media", mainAudioRequest),
      true
    );
    assert.match(prompts[0], /microphone/);
    assert.doesNotMatch(prompts[0], /camera/);

    assert.equal(
      session.permissionCheckHandler(
        contents,
        "media",
        "https://media.example",
        {
          requestingUrl: mainAudioRequest.requestingUrl,
          securityOrigin: mainAudioRequest.securityOrigin,
          isMainFrame: true,
          mediaType: "audio",
        }
      ),
      true
    );
    assert.equal(
      session.permissionCheckHandler(
        contents,
        "media",
        "https://media.example",
        {
          requestingUrl: "https://media.example/video",
          securityOrigin: "https://media.example",
          isMainFrame: true,
          mediaType: "video",
        }
      ),
      false,
      "microphone consent must not grant camera access"
    );

    assert.equal(
      await requestPermission(session, contents, "media", {
        ...mainAudioRequest,
        requestingUrl: "https://media.example/combined",
        mediaTypes: ["video", "audio"],
      }),
      true
    );
    assert.match(prompts[1], /microphone and camera/);
    assert.equal(
      session.permissionCheckHandler(
        contents,
        "media",
        "https://media.example",
        {
          requestingUrl: "https://media.example/video",
          securityOrigin: "https://media.example",
          isMainFrame: true,
          mediaType: "video",
        }
      ),
      true
    );

    const promptCount = prompts.length;
    assert.equal(
      await requestPermission(session, contents, "media", {
        ...mainAudioRequest,
        mediaTypes: ["unknown"],
      }),
      false
    );
    assert.equal(prompts.length, promptCount, "unknown media types must fail closed");
    assert.equal(
      session.permissionCheckHandler(
        contents,
        "media",
        "https://media.example",
        {
          requestingUrl: mainAudioRequest.requestingUrl,
          securityOrigin: "https://different-security.example",
          isMainFrame: true,
          mediaType: "audio",
        }
      ),
      false,
      "security origins must not share media decisions"
    );
    assert.equal(
      session.permissionCheckHandler(
        contents,
        "media",
        "https://media.example",
        {
          requestingUrl: mainAudioRequest.requestingUrl,
          securityOrigin: mainAudioRequest.securityOrigin,
          embeddingOrigin: "https://embedder.example",
          isMainFrame: false,
          mediaType: "audio",
        }
      ),
      false,
      "embedded frames must not inherit main-frame media decisions"
    );
  } finally {
    electron.dialog.showMessageBox = originalShowMessageBox;
    await controller.destroy();
  }
});

test("teardown keeps permission handling fail-closed until remote views are gone", async () => {
  const { controller } = createHarness();
  const { contents, session } = await createPage(controller);
  const originalShowMessageBox = electron.dialog.showMessageBox;
  let resolveDialog;
  const dialogResult = new Promise(resolve => {
    resolveDialog = resolve;
  });
  electron.dialog.showMessageBox = () => dialogResult;
  let pendingDecision = null;
  let duringCloseDecision = null;
  let duringCloseCheck = null;

  session.permissionRequestHandler(
    contents,
    "media",
    decision => {
      pendingDecision = decision;
    },
    {
      requestingUrl: "https://media.example/audio",
      securityOrigin: "https://media.example",
      isMainFrame: true,
      mediaTypes: ["audio"],
    }
  );
  contents.beforeClose = () => {
    session.permissionRequestHandler(
      contents,
      "geolocation",
      decision => {
        duringCloseDecision = decision;
      },
      {
        requestingUrl: "https://media.example/location",
        isMainFrame: true,
      }
    );
    duringCloseCheck = session.permissionCheckHandler(
      contents,
      "geolocation",
      "https://media.example",
      {
        requestingUrl: "https://media.example/location",
        isMainFrame: true,
      }
    );
  };

  try {
    const activePermissionHandler = session.permissionRequestHandler;
    const destroyPromise = controller.destroy();
    assert.notEqual(
      session.permissionRequestHandler,
      activePermissionHandler,
      "destroy must install the static deny-all handler synchronously"
    );
    await destroyPromise;
    assert.equal(duringCloseDecision, false);
    assert.equal(duringCloseCheck, false);
    assert.equal(session.permissionRequestHandler, null);
    assert.equal(session.permissionCheckHandler, null);
    assert.equal(session.devicePermissionHandler, null);

    resolveDialog({ response: 0 });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(
      pendingDecision,
      false,
      "a permission dialog resolved during teardown must never grant access"
    );
  } finally {
    electron.dialog.showMessageBox = originalShowMessageBox;
  }
});

test("failed navigation logs only fixed context and a bounded error code", async () => {
  const { controller } = createHarness();
  const { id, contents } = await createPage(controller);
  const sensitiveUrl =
    "https://user:password@unreachable.invalid/path?token=top-secret#private";
  contents.loadURL = async url => {
    const error = new Error(`ERR_NAME_NOT_RESOLVED loading ${url}`);
    error.code = "ERR_NAME_NOT_RESOLVED";
    error.url = url;
    throw error;
  };
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...parts) => warnings.push(parts);

  try {
    assert.equal(controller.navigate(id, sensitiveUrl), true);
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
  } finally {
    console.warn = originalWarn;
  }

  assert.deepEqual(warnings, [["Navigation failed: [ERR_NAME_NOT_RESOLVED]"]]);
  const serialized = JSON.stringify(warnings);
  assert.doesNotMatch(serialized, /top-secret|password|unreachable\.invalid/);
  await controller.destroy();
});

test("runtime tab URLs and favicons are bounded and privacy-normalized", async () => {
  const { controller, state, window } = createHarness();
  const { id, contents } = await createPage(
    controller,
    "https://user:secret@example.com/page?q=kept#private"
  );
  assert.equal(
    state.tabs[0].url,
    "https://example.com/page?q=kept#private",
    "runtime navigation keeps bounded document fragments"
  );

  const sendsBeforeOversizedFavicon = window.webContents.sent.length;
  contents.emit("page-favicon-updated", {}, [
    `data:image/png;base64,${"A".repeat(TAB_DATA_FAVICON_MAX_LENGTH)}`,
  ]);
  assert.equal(state.tabs[0].favicon, "");
  assert.equal(
    window.webContents.sent.length,
    sendsBeforeOversizedFavicon,
    "rejected favicon data must not trigger a state broadcast"
  );

  contents.emit("page-favicon-updated", {}, [
    "https://user:secret@example.com/favicon.ico#tracking",
  ]);
  assert.equal(state.tabs[0].favicon, "https://example.com/favicon.ico");

  assert.equal(controller.navigate(id, "x".repeat(20_000)), true);
  assert.equal(state.tabs[0].url, "chroma://newtab/");
  assert.doesNotMatch(
    JSON.stringify(window.webContents.sent.at(-1)?.payload),
    /x{100}/,
    "oversized navigation input must not be broadcast"
  );
  await controller.destroy();
});

test("runtime tab creation refuses to exceed the model tab limit", async () => {
  const { controller, state } = createHarness();
  state.tabs = Array.from({ length: TAB_COUNT_LIMIT }, (_, index) => ({
    id: `tab-${index}`,
    workspaceId: state.activeWorkspaceId,
    url: "chroma://newtab/",
    title: "New Tab",
    favicon: "",
    essential: false,
    pinned: false,
    muted: false,
    audible: false,
    loading: false,
    crashed: false,
    canGoBack: false,
    canGoForward: false,
    lastActiveAt: index,
  }));
  state.activeTabId = state.tabs[0].id;

  assert.equal(await controller.createTab(), null);
  assert.equal(state.tabs.length, TAB_COUNT_LIMIT);
  assert.equal(await controller.createWorkspace({ name: "Overflow" }), null);
  assert.equal(state.workspaces.length, 1);
  await controller.destroy();
});
