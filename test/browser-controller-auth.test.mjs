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
  { commands },
  { createDefaultState },
  { MockBrowserWindow, electronMock },
] = await Promise.all([
  import("../src/main/browser-controller.mjs"),
  import("../src/shared/channels.mjs"),
  import("../src/shared/model.mjs"),
  import("electron"),
]);

function createHarness(t, { autoDestroy = true } = {}) {
  electronMock.reset();
  let nextId = 1;
  const state = createDefaultState(() => `auth-${nextId++}`);
  const store = {
    scheduleSave() {},
    async flush() {},
  };
  const controller = new BrowserController(new MockBrowserWindow(), state, store);
  if (autoDestroy) {
    t.after(async () => {
      await controller.destroy();
    });
  }
  return { controller };
}

test("queues auth challenges and passes submitted credentials through", async t => {
  const { controller } = createHarness(t);
  const received = [];
  assert.equal(
    controller.handleAuthRequest(
      { host: "intranet.example", realm: "Staff Area", isProxy: false },
      (...credentials) => received.push(credentials)
    ),
    true
  );

  const pending = controller.getPublicState().pendingAuth;
  assert.ok(pending.id);
  assert.equal(pending.host, "intranet.example");
  assert.equal(pending.realm, "Staff Area");
  assert.equal(pending.isProxy, false);
  assert.equal(
    Object.hasOwn(pending, "callback"),
    false,
    "the callback must never cross into public state"
  );

  assert.equal(
    await controller.dispatch(commands.submitAuthCredentials, {
      id: pending.id,
      username: "user",
      password: "secret",
    }),
    true
  );
  assert.deepEqual(received, [["user", "secret"]]);
  assert.equal(controller.getPublicState().pendingAuth, null);
  assert.equal(
    controller.submitAuthCredentials({
      id: pending.id,
      username: "user",
      password: "again",
    }),
    false,
    "a settled challenge cannot be answered twice"
  );
});

test("cancelling a challenge invokes the callback without credentials", async t => {
  const { controller } = createHarness(t);
  const received = [];
  controller.handleAuthRequest(
    { host: "example.com", realm: "", isProxy: true },
    (...credentials) => received.push(credentials)
  );
  const pending = controller.getPublicState().pendingAuth;
  assert.equal(pending.isProxy, true);

  assert.equal(
    await controller.dispatch(commands.cancelAuthRequest, { id: pending.id }),
    true
  );
  assert.deepEqual(received, [[]]);
  assert.equal(controller.getPublicState().pendingAuth, null);
  assert.equal(controller.cancelAuthRequest({ id: pending.id }), false);
});

test("rejects malformed submissions and surfaces challenges in FIFO order", async t => {
  const { controller } = createHarness(t);
  const first = [];
  const second = [];
  controller.handleAuthRequest({ host: "first.example" }, (...c) => first.push(c));
  controller.handleAuthRequest({ host: "second.example" }, (...c) => second.push(c));

  const pending = controller.getPublicState().pendingAuth;
  assert.equal(pending.host, "first.example");

  assert.equal(controller.submitAuthCredentials({}), false);
  assert.equal(
    controller.submitAuthCredentials({ id: pending.id, username: 1, password: "x" }),
    false
  );
  assert.equal(
    controller.submitAuthCredentials({
      id: pending.id,
      username: "u",
      password: "p".repeat(501),
    }),
    false
  );
  assert.deepEqual(first, []);

  assert.equal(
    controller.submitAuthCredentials({ id: pending.id, username: "u", password: "p" }),
    true
  );
  assert.equal(controller.getPublicState().pendingAuth.host, "second.example");
});

test("teardown cancels outstanding challenges and refuses new ones", async t => {
  const { controller } = createHarness(t, { autoDestroy: false });
  const received = [];
  controller.handleAuthRequest({ host: "open.example" }, (...c) => received.push(c));

  await controller.destroy();
  assert.deepEqual(received, [[]], "destroy must cancel the pending challenge");
  assert.equal(
    controller.handleAuthRequest({ host: "late.example" }, () => {}),
    false,
    "a destroyed controller must decline new challenges"
  );
});
