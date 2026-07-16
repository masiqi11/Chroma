import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import electronPath from "electron";
import pixelmatch from "pixelmatch";
import pngjs from "pngjs";

import {
  STATE_SCHEMA_VERSION,
  sanitizeState,
  stateForDisk,
} from "../src/shared/model.mjs";

const { PNG } = pngjs;
const require = createRequire(import.meta.url);
const electronVersion = require("electron/package.json").version;
const electronMajor = Number.parseInt(electronVersion, 10);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const artifactsDirectory = path.join(root, "artifacts/visual");
const baselineDirectory = path.join(
  root,
  "test/visual/baselines",
  `${process.platform}-electron${electronMajor}`
);
const manifestPath = path.join(baselineDirectory, "manifest.json");
const FIXTURE_PORT = 41_727;
const FIXTURE_ORIGIN = `http://127.0.0.1:${FIXTURE_PORT}`;
const FIXED_NOW = Date.parse("2026-01-15T12:00:00.000Z");
const VIEWPORT = Object.freeze({ width: 1_280, height: 720 });
const PIXEL_THRESHOLD = 0.1;
const MAX_DIFF_RATIO = 0.0025;
const GEOMETRY_TOLERANCE = 1;
const UPDATE_FLAG = process.argv.includes("--update");
const UPDATE_AUTHORIZED = process.env.CHROMA_UPDATE_VISUAL_BASELINES === "1";

if (UPDATE_FLAG !== UPDATE_AUTHORIZED) {
  throw new Error(
    UPDATE_FLAG
      ? "Baseline updates require CHROMA_UPDATE_VISUAL_BASELINES=1"
      : "CHROMA_UPDATE_VISUAL_BASELINES=1 is only accepted together with --update"
  );
}

const scenarios = Object.freeze([
  {
    name: "expanded-dark",
    theme: "dark",
    paneIds: ["tab-alpha"],
  },
  {
    name: "split-2-dark-60-40",
    theme: "dark",
    paneIds: ["tab-alpha", "tab-beta"],
    layout: {
      type: "split",
      direction: "row",
      ratio: 0.6,
      first: { type: "pane", paneId: "tab-alpha" },
      second: { type: "pane", paneId: "tab-beta" },
    },
  },
  {
    name: "expanded-light",
    theme: "light",
    paneIds: ["tab-alpha"],
  },
  {
    name: "collapsed-dark-hidden",
    theme: "dark",
    sidebarCollapsed: true,
    paneIds: ["tab-alpha"],
  },
  {
    name: "overlay-dark",
    theme: "dark",
    sidebarCollapsed: true,
    overlay: true,
    paneIds: ["tab-alpha"],
  },
  {
    name: "split-3-dark",
    theme: "dark",
    paneIds: ["tab-alpha", "tab-beta", "tab-gamma"],
    layout: {
      type: "split",
      direction: "row",
      ratio: 0.5,
      first: { type: "pane", paneId: "tab-alpha" },
      second: {
        type: "split",
        direction: "column",
        ratio: 0.5,
        first: { type: "pane", paneId: "tab-beta" },
        second: { type: "pane", paneId: "tab-gamma" },
      },
    },
  },
  {
    name: "split-4-dark",
    theme: "dark",
    paneIds: ["tab-alpha", "tab-beta", "tab-gamma", "tab-delta"],
    layout: {
      type: "split",
      direction: "row",
      ratio: 0.5,
      first: {
        type: "split",
        direction: "column",
        ratio: 0.5,
        first: { type: "pane", paneId: "tab-alpha" },
        second: { type: "pane", paneId: "tab-beta" },
      },
      second: {
        type: "split",
        direction: "column",
        ratio: 0.5,
        first: { type: "pane", paneId: "tab-gamma" },
        second: { type: "pane", paneId: "tab-delta" },
      },
    },
  },
]);

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function waitFor(callback, timeout = 20_000) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeout) {
    try {
      const value = await callback();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw lastError || new Error(`Timed out after ${timeout}ms`);
}

class CdpClient {
  #socket;
  #nextId = 0;
  #pending = new Map();

  constructor(url) {
    this.#socket = new WebSocket(url);
    this.#socket.addEventListener("message", event => {
      const message = JSON.parse(event.data);
      if (!message.id) return;
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.#pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
    this.#socket.addEventListener("close", () => {
      const error = new Error("DevTools connection closed");
      for (const pending of this.#pending.values()) {
        clearTimeout(pending.timeout);
        pending.reject(error);
      }
      this.#pending.clear();
    });
  }

  async open() {
    if (this.#socket.readyState === WebSocket.OPEN) return;
    await new Promise((resolve, reject) => {
      this.#socket.addEventListener("open", resolve, { once: true });
      this.#socket.addEventListener("error", reject, { once: true });
    });
  }

  send(method, params = {}, timeout = 12_000) {
    const id = ++this.#nextId;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method} timed out after ${timeout}ms`));
      }, timeout);
      this.#pending.set(id, { resolve, reject, timeout: timer });
    });
    this.#socket.send(JSON.stringify({ id, method, params }));
    return promise;
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ||
          "Renderer evaluation failed"
      );
    }
    return result.result.value;
  }

  async close() {
    if (this.#socket.readyState === WebSocket.CLOSED) return;
    const closed = new Promise(resolve =>
      this.#socket.addEventListener("close", resolve, { once: true })
    );
    this.#socket.close();
    await Promise.race([closed, delay(500)]);
  }
}

function fixtureDocument(kind) {
  const variants = {
    alpha: {
      eyebrow: "CHROMA NOTES",
      title: "A calmer place for focused browsing",
      copy: "Keep research, references, and the next useful action together.",
      accent: "#6f57d9",
      pale: "#eeeaff",
      cards: ["Reading queue", "Design review", "Weekly plan"],
    },
    beta: {
      eyebrow: "CHROMA RESEARCH",
      title: "Research without losing the thread",
      copy: "A stable fixture for split-view geometry and responsive content.",
      accent: "#247c76",
      pale: "#e3f4f1",
      cards: ["Sources", "Highlights", "Open questions"],
    },
    gamma: {
      eyebrow: "CHROMA CANVAS",
      title: "Ideas arranged into a clear next step",
      copy: "A stable fixture for the lower-right pane in a three-way split.",
      accent: "#a34f72",
      pale: "#f8e6ee",
      cards: ["Sketches", "Decisions", "Next steps"],
    },
    delta: {
      eyebrow: "CHROMA LIBRARY",
      title: "References ready when the work needs them",
      copy: "A stable fixture for the fourth pane in a balanced grid.",
      accent: "#916b22",
      pale: "#f7efd9",
      cards: ["Briefs", "Examples", "Patterns"],
    },
    folder: {
      eyebrow: "CHROMA ARCHIVE",
      title: "Saved reference",
      copy: "A deterministic hidden tab used to exercise folder chrome.",
      accent: "#a65f31",
      pale: "#f8eadd",
      cards: ["Archive", "Library", "Later"],
    },
    essential: {
      eyebrow: "CHROMA HOME",
      title: "Essential workspace",
      copy: "A deterministic hidden tab used to exercise Essentials.",
      accent: "#b34c68",
      pale: "#f9e5eb",
      cards: ["Inbox", "Pinned", "Today"],
    },
  };
  const page = variants[kind] || variants.alpha;
  return `<!doctype html>
    <html lang="en" data-visual-fixture="${kind}">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${page.title}</title>
        <style>
          :root { color-scheme: light; font-family: Arial, Helvetica, sans-serif; }
          * { box-sizing: border-box; }
          body { margin: 0; color: #292733; background: #fbfafc; }
          main { min-height: 100vh; padding: clamp(30px, 6vw, 76px); }
          .eyebrow { color: ${page.accent}; font-size: 12px; font-weight: 800; letter-spacing: .16em; }
          h1 { max-width: 720px; margin: 20px 0 16px; font-size: clamp(36px, 5.6vw, 72px); line-height: .98; letter-spacing: -.055em; }
          .copy { max-width: 610px; margin: 0; color: #66616f; font-size: clamp(16px, 2vw, 22px); line-height: 1.55; }
          .rule { width: 72px; height: 5px; margin: 38px 0; border-radius: 99px; background: ${page.accent}; }
          .cards { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; max-width: 860px; }
          article { min-height: 150px; padding: 20px; border: 1px solid #dedbe4; border-radius: 18px; background: ${page.pale}; }
          article span { display: grid; width: 34px; height: 34px; place-items: center; margin-bottom: 35px; border-radius: 11px; color: white; background: ${page.accent}; font-weight: 800; }
          article strong { font-size: 16px; }
          @media (max-width: 640px) { .cards { grid-template-columns: 1fr; } article { min-height: 96px; } }
        </style>
      </head>
      <body>
        <main>
          <div class="eyebrow">${page.eyebrow}</div>
          <h1>${page.title}</h1>
          <p class="copy">${page.copy}</p>
          <div class="rule"></div>
          <section class="cards">
            ${page.cards.map((card, index) => `<article><span>${index + 1}</span><strong>${card}</strong></article>`).join("")}
          </section>
        </main>
      </body>
    </html>`;
}

function createFixtureServer() {
  return createServer((request, response) => {
    const url = new URL(request.url || "/", FIXTURE_ORIGIN);
    const kind = url.pathname.slice(1);
    if (!["alpha", "beta", "gamma", "delta", "folder", "essential"].includes(kind)) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
      "content-type": "text/html; charset=utf-8",
    });
    response.end(fixtureDocument(kind));
  });
}

async function listen(server, port = 0) {
  await new Promise((resolve, reject) => {
    const onError = error => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
  return server.address().port;
}

async function availablePort() {
  const server = createServer();
  const port = await listen(server);
  await new Promise(resolve => server.close(resolve));
  return port;
}

function visualState(scenario) {
  let generatedId = 0;
  const extraTabs = [];
  if (scenario.paneIds.includes("tab-gamma")) {
    extraTabs.push({
      id: "tab-gamma",
      workspaceId: "workspace-personal",
      url: `${FIXTURE_ORIGIN}/gamma`,
      title: "Ideas arranged into a clear next step",
      lastActiveAt: FIXED_NOW - 4_000,
    });
  }
  if (scenario.paneIds.includes("tab-delta")) {
    extraTabs.push({
      id: "tab-delta",
      workspaceId: "workspace-personal",
      url: `${FIXTURE_ORIGIN}/delta`,
      title: "References ready when the work needs them",
      lastActiveAt: FIXED_NOW - 5_000,
    });
  }
  const candidate = {
    schemaVersion: STATE_SCHEMA_VERSION,
    activeWorkspaceId: "workspace-personal",
    activeTabId: "tab-alpha",
    workspaces: [
      {
        id: "workspace-personal",
        name: "Personal",
        icon: "sparkles",
        color: "#e4a8ff",
      },
    ],
    tabs: [
      {
        id: "tab-essential",
        workspaceId: "workspace-personal",
        url: `${FIXTURE_ORIGIN}/essential`,
        title: "Essential workspace",
        essential: true,
        lastActiveAt: FIXED_NOW - 3_000,
      },
      {
        id: "tab-alpha",
        workspaceId: "workspace-personal",
        url: `${FIXTURE_ORIGIN}/alpha`,
        title: "A calmer place for focused browsing",
        lastActiveAt: FIXED_NOW,
      },
      {
        id: "tab-beta",
        workspaceId: "workspace-personal",
        url: `${FIXTURE_ORIGIN}/beta`,
        title: "Research without losing the thread",
        lastActiveAt: FIXED_NOW - 1_000,
      },
      {
        id: "tab-folder",
        workspaceId: "workspace-personal",
        url: `${FIXTURE_ORIGIN}/folder`,
        title: "Saved reference",
        lastActiveAt: FIXED_NOW - 2_000,
      },
      ...extraTabs,
    ],
    folders: [
      {
        id: "folder-research",
        workspaceId: "workspace-personal",
        name: "Research",
        tabIds: ["tab-folder"],
        expanded: true,
      },
    ],
    splitGroups: scenario.layout
      ? [
          {
            id: "split-primary",
            workspaceId: "workspace-personal",
            direction: scenario.layout.direction,
            tabIds: [...scenario.paneIds],
            layout: structuredClone(scenario.layout),
          },
        ]
      : [],
    history: {
      revision: 0,
      entries: [],
      preferences: {
        recordingEnabled: false,
        retentionDays: 90,
        clearOnExit: false,
      },
    },
    bookmarks: [
      {
        id: "bookmark-alpha",
        title: "Chroma Notes",
        url: `${FIXTURE_ORIGIN}/alpha`,
        createdAt: FIXED_NOW,
      },
    ],
    downloads: [],
    settings: {
      sidebarWidth: 228,
      sidebarCollapsed: scenario.sidebarCollapsed === true,
      compactMode: false,
      appearance: {
        theme: scenario.theme,
        reduceTransparency: false,
      },
    },
  };
  return stateForDisk(
    sanitizeState(candidate, () => `visual-generated-${++generatedId}`, {
      now: FIXED_NOW,
    })
  );
}

async function targetList(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!response.ok) throw new Error(`DevTools endpoint returned ${response.status}`);
  return response.json();
}

async function prepareTarget(client, theme) {
  await client.send("Emulation.setEmulatedMedia", {
    media: "screen",
    features: [
      { name: "prefers-color-scheme", value: theme },
      { name: "prefers-reduced-motion", value: "reduce" },
      { name: "prefers-contrast", value: "no-preference" },
    ],
  });
  await client.evaluate(`(() => {
    const fixedNow = ${FIXED_NOW};
    const NativeDate = Date;
    class FixedDate extends NativeDate {
      constructor(...args) { super(...(args.length ? args : [fixedNow])); }
      static now() { return fixedNow; }
    }
    FixedDate.parse = NativeDate.parse;
    FixedDate.UTC = NativeDate.UTC;
    globalThis.Date = FixedDate;
    document.documentElement.style.setProperty(
      "font-family",
      "Arial, Helvetica, sans-serif",
      "important"
    );
    let stabilityStyle = document.querySelector("#chroma-visual-stability");
    if (!stabilityStyle) {
      stabilityStyle = document.createElement("style");
      stabilityStyle.id = "chroma-visual-stability";
      stabilityStyle.textContent = "*, *::before, *::after { animation: none !important; caret-color: transparent !important; transition: none !important; }";
      document.head.append(stabilityStyle);
    }
    return document.fonts.ready.then(() => new Promise(resolve => {
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        for (const animation of document.getAnimations()) {
          try {
            const endTime = animation.effect?.getComputedTiming().endTime;
            if (Number.isFinite(endTime)) animation.finish();
            else { animation.pause(); animation.currentTime = 0; }
          } catch {}
        }
        resolve(true);
      };
      // Native WebContentsViews report document.visibilityState="hidden" in
      // the off-screen smoke window even while Electron draws them. Their RAF
      // callbacks may therefore be throttled indefinitely, so keep a timer
      // fallback while still giving visible shell targets two compositor frames.
      requestAnimationFrame(() => requestAnimationFrame(settle));
      setTimeout(settle, 160);
    }));
  })()`);
}

async function capturePng(client, { transparent = false } = {}) {
  if (transparent) {
    await client.send("Emulation.setDefaultBackgroundColorOverride", {
      color: { r: 0, g: 0, b: 0, a: 0 },
    });
  }
  const result = await client.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false,
  });
  return PNG.sync.read(Buffer.from(result.data, "base64"));
}

function roundedCoverage(x, y, width, height, radius) {
  if (radius <= 0 || (x >= radius && x < width - radius) ||
      (y >= radius && y < height - radius)) {
    return 1;
  }
  const centerX = x < radius ? radius : width - radius;
  const centerY = y < radius ? radius : height - radius;
  let inside = 0;
  const samples = 4;
  for (let sampleY = 0; sampleY < samples; sampleY += 1) {
    for (let sampleX = 0; sampleX < samples; sampleX += 1) {
      const pointX = x + (sampleX + 0.5) / samples;
      const pointY = y + (sampleY + 0.5) / samples;
      const deltaX = pointX - centerX;
      const deltaY = pointY - centerY;
      if (deltaX * deltaX + deltaY * deltaY <= radius * radius) inside += 1;
    }
  }
  return inside / (samples * samples);
}

function composite(target, surface, left, top, { radius = 0 } = {}) {
  for (let sourceY = 0; sourceY < surface.height; sourceY += 1) {
    const targetY = top + sourceY;
    if (targetY < 0 || targetY >= target.height) continue;
    for (let sourceX = 0; sourceX < surface.width; sourceX += 1) {
      const targetX = left + sourceX;
      if (targetX < 0 || targetX >= target.width) continue;
      const sourceIndex = (sourceY * surface.width + sourceX) * 4;
      const targetIndex = (targetY * target.width + targetX) * 4;
      const coverage = roundedCoverage(
        sourceX,
        sourceY,
        surface.width,
        surface.height,
        radius
      );
      const sourceAlpha = (surface.data[sourceIndex + 3] / 255) * coverage;
      if (sourceAlpha <= 0) continue;
      const targetAlpha = target.data[targetIndex + 3] / 255;
      const outputAlpha = sourceAlpha + targetAlpha * (1 - sourceAlpha);
      for (let channel = 0; channel < 3; channel += 1) {
        const sourceValue = surface.data[sourceIndex + channel];
        const targetValue = target.data[targetIndex + channel];
        target.data[targetIndex + channel] = Math.round(
          (sourceValue * sourceAlpha +
            targetValue * targetAlpha * (1 - sourceAlpha)) /
            outputAlpha
        );
      }
      target.data[targetIndex + 3] = Math.round(outputAlpha * 255);
    }
  }
}

function rounded(value) {
  return Math.round(Number(value) * 1_000) / 1_000;
}

function normalizedRect(rect) {
  if (!rect) return null;
  return {
    x: rounded(rect.x ?? rect.left),
    y: rounded(rect.y ?? rect.top),
    width: rounded(rect.width),
    height: rounded(rect.height),
  };
}

async function shellSnapshot(client) {
  return client.evaluate(`window.chromaBrowser.getState().then(state => {
    const elementRect = element => {
      if (!element) return null;
      const bounds = element.getBoundingClientRect();
      return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
    };
    const rect = selector => elementRect(document.querySelector(selector));
    const rows = [...document.querySelectorAll('.split-tab-group > .tab-row')]
      .map(element => ({ id: element.dataset.tabId, ...elementRect(element) }))
      .sort((left, right) => left.id.localeCompare(right.id));
    const frames = [...document.querySelectorAll('.pane-frame')]
      .map(element => ({ id: element.dataset.tabId, ...elementRect(element) }))
      .sort((left, right) => left.id.localeCompare(right.id));
    const app = document.querySelector('#app');
    const sidebar = document.querySelector('#sidebar');
    const sidebarStyle = getComputedStyle(sidebar);
    const peekTrigger = document.querySelector('#sidebar-peek-trigger');
    const peekStyle = getComputedStyle(peekTrigger);
    return {
      state,
      dpr: devicePixelRatio,
      theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
      shellReady: !app?.classList.contains('is-loading') &&
        Number.parseFloat(getComputedStyle(app).opacity) >= 0.999,
      shellClassName: app?.className || '',
      shellOpacity: getComputedStyle(app).opacity,
      geometry: {
        viewport: { width: innerWidth, height: innerHeight },
        contentBounds: state.runtime.contentBounds,
        sidebar: rect('#sidebar'),
        sidebarDisplay: sidebarStyle.display,
        sidebarBorderRadius: Number.parseFloat(sidebarStyle.borderRadius) || 0,
        contentViewport: rect('#content-viewport'),
        peekTrigger: elementRect(peekTrigger),
        peekDisplay: peekStyle.display,
        peekBackgroundColor: peekStyle.backgroundColor,
        trafficLights: rect('.traffic-lights'),
        addressForm: rect('#address-form'),
        tabsList: rect('#tabs-list'),
        splitCapsule: rect('.split-tab-group'),
        splitRows: rows,
        paneFrames: frames,
      },
    };
  })`);
}

function normalizeGeometry(snapshot, viewports) {
  const visibleViews = Object.entries(viewports)
    .filter(([, viewport]) => viewport.nativeVisible === true)
    .map(([id, viewport]) => ({ id, ...normalizedRect(viewport.bounds) }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const geometry = structuredClone(snapshot.geometry);
  geometry.contentBounds = normalizedRect(geometry.contentBounds);
  for (const key of [
    "sidebar",
    "contentViewport",
    "peekTrigger",
    "trafficLights",
    "addressForm",
    "tabsList",
    "splitCapsule",
  ]) {
    geometry[key] = normalizedRect(geometry[key]);
  }
  geometry.splitRows = geometry.splitRows.map(row => ({
    id: row.id,
    ...normalizedRect(row),
  }));
  geometry.paneFrames = geometry.paneFrames.map(frame => ({
    id: frame.id,
    ...normalizedRect(frame),
  }));
  geometry.visibleViews = visibleViews;
  return geometry;
}

function normalizeOverlayGeometry(snapshot, bounds) {
  return {
    bounds: normalizedRect(bounds),
    viewport: structuredClone(snapshot.geometry.viewport),
    sidebar: normalizedRect(snapshot.geometry.sidebar),
    sidebarDisplay: snapshot.geometry.sidebarDisplay,
    sidebarBorderRadius: rounded(snapshot.geometry.sidebarBorderRadius),
    trafficLights: normalizedRect(snapshot.geometry.trafficLights),
    addressForm: normalizedRect(snapshot.geometry.addressForm),
    tabsList: normalizedRect(snapshot.geometry.tabsList),
    targetComposited: true,
  };
}

function compareGeometry(expected, actual, location = "geometry", differences = []) {
  if (typeof expected === "number" && typeof actual === "number") {
    if (Math.abs(expected - actual) > GEOMETRY_TOLERANCE) {
      differences.push(`${location}: expected ${expected}, received ${actual}`);
    }
    return differences;
  }
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) {
      differences.push(`${location}: collection shape changed`);
      return differences;
    }
    if (expected.length !== actual.length) {
      differences.push(
        `${location}.length: expected ${expected.length}, received ${actual.length}`
      );
    }
    const length = Math.min(expected.length, actual.length);
    for (let index = 0; index < length; index += 1) {
      compareGeometry(expected[index], actual[index], `${location}[${index}]`, differences);
    }
    return differences;
  }
  if (expected && typeof expected === "object" && actual && typeof actual === "object") {
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    for (const key of [...keys].sort()) {
      if (!(key in expected) || !(key in actual)) {
        differences.push(`${location}.${key}: key set changed`);
        continue;
      }
      compareGeometry(expected[key], actual[key], `${location}.${key}`, differences);
    }
    return differences;
  }
  if (expected !== actual) {
    differences.push(`${location}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
  return differences;
}

function assertApprox(actual, expected, tolerance, message) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${message}: expected ${expected} ± ${tolerance}, received ${actual}`
  );
}

function entriesById(entries) {
  return new Map(entries.map(entry => [entry.id, entry]));
}

function assertScenarioGeometry(scenario, geometry) {
  assert.deepEqual(geometry.viewport, VIEWPORT);
  assert.deepEqual(
    geometry.visibleViews.map(view => view.id),
    [...scenario.paneIds].sort(),
    `${scenario.name} visible pane membership changed`
  );

  if (scenario.sidebarCollapsed) {
    assert.equal(geometry.sidebarDisplay, "none");
    assert.equal(geometry.sidebar.width, 0, "collapsed sidebar must have no visible rail");
    assert.equal(geometry.peekDisplay, "block");
    assert.equal(geometry.peekBackgroundColor, "rgba(0, 0, 0, 0)");
    assert.ok(geometry.contentBounds.x <= 10);
    assert.ok(geometry.contentBounds.width >= VIEWPORT.width - 20);
    assert.deepEqual(geometry.contentViewport, geometry.contentBounds);
  } else {
    assert.equal(geometry.sidebarDisplay, "flex");
    assertApprox(geometry.sidebar.width, 228, 0.01, "expanded sidebar width");
    assertApprox(geometry.contentBounds.x, 228, 0.01, "expanded content inset");
  }

  if (scenario.overlay) {
    const overlay = geometry.sidebarOverlay;
    assert.ok(overlay?.targetComposited, "overlay WebContentsView was not composited");
    assert.equal(overlay.sidebarDisplay, "flex");
    assert.ok(overlay.sidebarBorderRadius >= 14, "overlay must keep a rounded panel");
    assertApprox(overlay.bounds.x, 0, 0.01, "overlay target x");
    assertApprox(overlay.bounds.y, 0, 0.01, "overlay target y");
    assertApprox(overlay.sidebar.x, 5, 0.01, "overlay panel x");
    assertApprox(overlay.sidebar.y, 5, 0.01, "overlay panel y");
    assertApprox(overlay.sidebar.width, 228, 0.01, "overlay panel width");
    assertApprox(
      overlay.sidebar.height,
      VIEWPORT.height - 10,
      0.01,
      "overlay panel height"
    );
    assert.ok(
      overlay.bounds.width > overlay.sidebar.width,
      "overlay target must preserve transparent shadow space"
    );
  } else {
    assert.equal(geometry.sidebarOverlay, null);
  }

  if (!scenario.layout) {
    assert.equal(geometry.splitCapsule, null);
    assert.deepEqual(geometry.splitRows, []);
    assert.deepEqual(geometry.paneFrames, []);
    return;
  }

  assert.ok(geometry.splitCapsule, `${scenario.name} is missing its split capsule`);
  assert.equal(geometry.splitRows.length, scenario.paneIds.length);
  assert.equal(geometry.paneFrames.length, scenario.paneIds.length);
  const frames = entriesById(geometry.paneFrames);
  const rows = entriesById(geometry.splitRows);
  const content = geometry.contentBounds;
  const capsule = geometry.splitCapsule;

  if (scenario.name === "split-2-dark-60-40") {
    const alpha = frames.get("tab-alpha");
    const beta = frames.get("tab-beta");
    assert.ok(alpha.x < beta.x);
    assertApprox(alpha.height / content.height, 1, 0.01, "two-pane alpha height");
    assertApprox(beta.height / content.height, 1, 0.01, "two-pane beta height");
    assertApprox(alpha.width / (alpha.width + beta.width), 0.6, 0.01, "two-pane ratio");
    assertApprox(
      rows.get("tab-alpha").width / capsule.width,
      0.6,
      0.015,
      "two-pane capsule ratio"
    );
    return;
  }

  assert.ok(capsule.height >= 68, "three/four-pane active capsule must use full height");
  if (scenario.name === "split-3-dark") {
    const alpha = frames.get("tab-alpha");
    const beta = frames.get("tab-beta");
    const gamma = frames.get("tab-gamma");
    assert.ok(alpha.x < beta.x && alpha.x < gamma.x);
    assertApprox(beta.x, gamma.x, 1, "three-pane right column x");
    assert.ok(beta.y < gamma.y);
    assertApprox(alpha.width / content.width, 0.5, 0.02, "three-pane primary width");
    assertApprox(alpha.height / content.height, 1, 0.01, "three-pane primary height");
    assertApprox(beta.width / content.width, 0.5, 0.02, "three-pane quarter width");
    assertApprox(gamma.width / content.width, 0.5, 0.02, "three-pane quarter width");
    assertApprox(beta.height / content.height, 0.5, 0.02, "three-pane upper height");
    assertApprox(gamma.height / content.height, 0.5, 0.02, "three-pane lower height");

    const alphaRow = rows.get("tab-alpha");
    const betaRow = rows.get("tab-beta");
    const gammaRow = rows.get("tab-gamma");
    assertApprox(alphaRow.height / capsule.height, 1, 0.01, "three-pane capsule primary height");
    assertApprox(alphaRow.width / capsule.width, 0.5, 0.02, "three-pane capsule primary width");
    assertApprox(betaRow.x, gammaRow.x, 1, "three-pane capsule right column x");
    assert.ok(betaRow.y < gammaRow.y);
    assertApprox(betaRow.height / capsule.height, 0.5, 0.02, "three-pane capsule upper height");
    assertApprox(gammaRow.height / capsule.height, 0.5, 0.02, "three-pane capsule lower height");
    return;
  }

  const alpha = frames.get("tab-alpha");
  const beta = frames.get("tab-beta");
  const gamma = frames.get("tab-gamma");
  const delta = frames.get("tab-delta");
  assertApprox(alpha.x, beta.x, 1, "four-pane left column x");
  assertApprox(gamma.x, delta.x, 1, "four-pane right column x");
  assert.ok(alpha.x < gamma.x && alpha.y < beta.y && gamma.y < delta.y);
  assertApprox(alpha.y, gamma.y, 1, "four-pane top row y");
  assertApprox(beta.y, delta.y, 1, "four-pane bottom row y");
  for (const frame of [alpha, beta, gamma, delta]) {
    assertApprox(frame.width / content.width, 0.5, 0.02, "four-pane cell width");
    assertApprox(frame.height / content.height, 0.5, 0.02, "four-pane cell height");
  }
  const alphaRow = rows.get("tab-alpha");
  const betaRow = rows.get("tab-beta");
  const gammaRow = rows.get("tab-gamma");
  const deltaRow = rows.get("tab-delta");
  assertApprox(alphaRow.x, betaRow.x, 1, "four-pane capsule left column x");
  assertApprox(gammaRow.x, deltaRow.x, 1, "four-pane capsule right column x");
  assert.ok(alphaRow.x < gammaRow.x && alphaRow.y < betaRow.y && gammaRow.y < deltaRow.y);
  assertApprox(alphaRow.y, gammaRow.y, 1, "four-pane capsule top row y");
  assertApprox(betaRow.y, deltaRow.y, 1, "four-pane capsule bottom row y");
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), delay(1_500)]);
  if (child.exitCode === null) {
    child.kill("SIGKILL");
    await Promise.race([once(child, "exit"), delay(1_500)]);
  }
}

async function removeTemporaryProfile(directory) {
  await waitFor(async () => {
    try {
      await rm(directory, { recursive: true, force: true });
      return true;
    } catch (error) {
      if (error?.code === "ENOTEMPTY" || error?.code === "EBUSY") return false;
      throw error;
    }
  }, 3_000);
}

async function captureScenario(scenario) {
  const userData = await mkdtemp(path.join(os.tmpdir(), "chroma-visual-"));
  const stateFile = path.join(userData, "browser-state.json");
  await writeFile(stateFile, `${JSON.stringify(visualState(scenario), null, 2)}\n`, {
    mode: 0o600,
  });
  const debuggingPort = await availablePort();
  const logs = [];
  let child;
  let shellClient;
  let overlayClient;
  const pageClients = [];
  try {
    child = spawn(
      electronPath,
      [
        "--force-device-scale-factor=1",
        "--no-error-dialogs",
        `--remote-debugging-port=${debuggingPort}`,
        ".",
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          CHROMA_CHROMIUM_USER_DATA: userData,
          CHROMA_DISABLE_SINGLE_INSTANCE: "1",
          CHROMA_HEADLESS_SMOKE: "1",
          ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
          LANG: "en_US.UTF-8",
          LC_ALL: "en_US.UTF-8",
          TZ: "UTC",
        },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    child.stdout.on("data", chunk => logs.push(String(chunk)));
    child.stderr.on("data", chunk => logs.push(String(chunk)));

    const shellTarget = await waitFor(async () => {
      const targets = await targetList(debuggingPort);
      return targets.find(
        target => target.url.endsWith("/src/renderer/index.html")
      );
    });
    shellClient = new CdpClient(shellTarget.webSocketDebuggerUrl);
    await shellClient.open();
    await shellClient.evaluate(
      `window.resizeTo(${VIEWPORT.width}, ${VIEWPORT.height})`
    );
    await prepareTarget(shellClient, scenario.theme);

    let lastReadiness = null;
    const ready = await waitFor(async () => {
      const snapshot = await shellSnapshot(shellClient);
      const viewports = await shellClient.evaluate(
        "window.chromaBrowser.getSmokeViewports()"
      );
      lastReadiness = {
        viewport: snapshot.geometry.viewport,
        dpr: snapshot.dpr,
        theme: snapshot.theme,
        shellReady: snapshot.shellReady,
        shellClassName: snapshot.shellClassName,
        shellOpacity: snapshot.shellOpacity,
        tabs: snapshot.state.tabs.map(tab => ({
          id: tab.id,
          url: tab.url,
          loading: tab.loading,
          crashed: tab.crashed,
        })),
        viewports: Object.fromEntries(
          Object.entries(viewports).map(([id, viewport]) => [id, {
            url: viewport.url,
            nativeVisible: viewport.nativeVisible,
            adaptivePendingMode: viewport.adaptivePendingMode,
            width: viewport.width,
            height: viewport.height,
          }])
        ),
      };
      if (
        snapshot.geometry.viewport.width !== VIEWPORT.width ||
        snapshot.geometry.viewport.height !== VIEWPORT.height ||
        snapshot.dpr !== 1 ||
        snapshot.theme !== scenario.theme ||
        !snapshot.shellReady ||
        snapshot.state.settings?.appearance?.theme !== scenario.theme ||
        snapshot.state.tabs.some(tab => tab.loading || tab.crashed)
      ) {
        return false;
      }
      const visible = Object.values(viewports).filter(viewport => viewport.nativeVisible);
      const expectedVisibleCount = scenario.paneIds.length;
      if (
        visible.length !== expectedVisibleCount ||
        visible.some(viewport =>
          !viewport.url.startsWith(FIXTURE_ORIGIN) ||
          viewport.adaptivePendingMode ||
          viewport.width <= 0 ||
          viewport.height <= 0
        )
      ) {
        return false;
      }
      if (scenario.layout) {
        const group = snapshot.state.splitGroups[0];
        if (
          !group ||
          group.tabIds.length !== scenario.paneIds.length ||
          !scenario.paneIds.every(id => group.tabIds.includes(id))
        ) {
          return false;
        }
      }
      return { snapshot, viewports };
    }).catch(error => {
      error.message = `${error.message}; last readiness=${JSON.stringify(lastReadiness)}`;
      throw error;
    });

    if (scenario.overlay) {
      await shellClient.evaluate(`(() => {
        const trigger = document.querySelector("#sidebar-peek-trigger");
        trigger.dispatchEvent(new PointerEvent("pointerenter", {
          bubbles: true,
          pointerType: "mouse"
        }));
        return true;
      })()`);
      const overlayTarget = await waitFor(async () => {
        const state = await shellClient.evaluate("window.chromaBrowser.getState()");
        if (
          !state.runtime.sidebarOverlayOpen ||
          !state.runtime.sidebarOverlayVisible ||
          !state.runtime.sidebarOverlayReady
        ) {
          return false;
        }
        const targets = await targetList(debuggingPort);
        return targets.find(target =>
          target.url.includes("/src/renderer/index.html?mode=sidebar-overlay")
        );
      });
      overlayClient = new CdpClient(overlayTarget.webSocketDebuggerUrl);
      await overlayClient.open();
      await prepareTarget(overlayClient, scenario.theme);
      await waitFor(async () => {
        const snapshot = await shellSnapshot(overlayClient);
        return snapshot.shellReady && snapshot.theme === scenario.theme
          ? snapshot
          : false;
      });
    }

    // Let the final state notification and layout RAF settle after all page loads.
    await delay(100);
    await prepareTarget(shellClient, scenario.theme);
    const finalSnapshot = await shellSnapshot(shellClient);
    const finalViewports = await shellClient.evaluate(
      "window.chromaBrowser.getSmokeViewports()"
    );
    assert.equal(finalSnapshot.dpr, 1);
    assert.equal(finalSnapshot.theme, scenario.theme);
    assert.equal(finalSnapshot.shellReady, true);
    assert.deepEqual(finalSnapshot.geometry.viewport, VIEWPORT);
    assert.equal(
      Object.values(finalViewports).filter(viewport => viewport.nativeVisible).length,
      scenario.paneIds.length
    );
    assert.ok(ready);

    const compositeImage = await capturePng(shellClient);
    assert.equal(compositeImage.width, VIEWPORT.width);
    assert.equal(compositeImage.height, VIEWPORT.height);

    const targets = await targetList(debuggingPort);
    const visibleEntries = Object.entries(finalViewports)
      .filter(([, viewport]) => viewport.nativeVisible === true)
      .sort(([left], [right]) => left.localeCompare(right));
    for (const [tabId, viewport] of visibleEntries) {
      const target = targets.find(candidate => candidate.url === viewport.url);
      assert.ok(target, `No DevTools target found for visible tab ${tabId}`);
      const client = new CdpClient(target.webSocketDebuggerUrl);
      pageClients.push(client);
      await client.open();
      await prepareTarget(client, scenario.theme);
      const fixtureReady = await client.evaluate(
        "document.documentElement.dataset.visualFixture || ''"
      );
      assert.ok(fixtureReady, `Visual fixture was not ready for ${tabId}`);
      const pageImage = await capturePng(client);
      const bounds = normalizedRect(viewport.bounds);
      assert.equal(pageImage.width, bounds.width);
      assert.equal(pageImage.height, bounds.height);
      composite(compositeImage, pageImage, bounds.x, bounds.y, {
        radius: process.platform === "darwin" ? 12 : 8,
      });
    }

    let sidebarOverlay = null;
    if (scenario.overlay) {
      const overlaySnapshot = await shellSnapshot(overlayClient);
      const overlayBounds = finalSnapshot.state.runtime.sidebarOverlayBounds;
      assert.equal(finalSnapshot.state.runtime.sidebarOverlayVisible, true);
      assert.ok(overlayBounds, "Visible overlay is missing native bounds");
      const overlayImage = await capturePng(overlayClient, { transparent: true });
      const normalizedBounds = normalizedRect(overlayBounds);
      assert.equal(overlayImage.width, normalizedBounds.width);
      assert.equal(overlayImage.height, normalizedBounds.height);
      composite(compositeImage, overlayImage, normalizedBounds.x, normalizedBounds.y);
      sidebarOverlay = normalizeOverlayGeometry(overlaySnapshot, overlayBounds);
    }

    const geometry = normalizeGeometry(finalSnapshot, finalViewports);
    geometry.sidebarOverlay = sidebarOverlay;
    assertScenarioGeometry(scenario, geometry);

    return {
      image: compositeImage,
      geometry,
      runtime: {
        chromium: finalSnapshot.state.runtime.chromiumVersion,
        electron: finalSnapshot.state.runtime.electronVersion,
        platform: finalSnapshot.state.runtime.platform,
      },
    };
  } catch (error) {
    error.message = `${error.message}\nElectron output:\n${logs.join("")}`;
    throw error;
  } finally {
    await Promise.allSettled(pageClients.map(client => client.close()));
    await overlayClient?.close().catch(() => {});
    await shellClient?.close().catch(() => {});
    await stopChild(child);
    await removeTemporaryProfile(userData);
  }
}

async function writePng(filePath, png) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, PNG.sync.write(png));
}

async function main() {
  await rm(artifactsDirectory, { recursive: true, force: true });
  await mkdir(artifactsDirectory, { recursive: true });
  const fixtureServer = createFixtureServer();
  try {
    await listen(fixtureServer, FIXTURE_PORT);
  } catch (error) {
    throw new Error(
      `Unable to start deterministic visual fixture on ${FIXTURE_ORIGIN}: ${error.message}`,
      { cause: error }
    );
  }

  let expectedManifest = null;
  if (!UPDATE_FLAG) {
    try {
      expectedManifest = JSON.parse(await readFile(manifestPath, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw new Error(
          `Visual baselines are missing for ${process.platform}/Electron ${electronMajor}. ` +
            "Run CHROMA_UPDATE_VISUAL_BASELINES=1 npm run visual:update on the intended baseline platform."
        );
      }
      throw error;
    }
  }

  const report = {
    schemaVersion: 2,
    mode: UPDATE_FLAG ? "update" : "compare",
    platform: process.platform,
    electronMajor,
    electronVersion,
    viewport: VIEWPORT,
    dpr: 1,
    themes: ["dark", "light"],
    fontFamily: "Arial, Helvetica, sans-serif",
    motion: "disabled",
    thresholds: {
      pixel: PIXEL_THRESHOLD,
      maxDiffRatio: MAX_DIFF_RATIO,
      geometryTolerance: GEOMETRY_TOLERANCE,
    },
    scenarios: [],
    limitations: [
      "GPU acceleration is disabled by CHROMA_HEADLESS_SMOKE.",
      "Native vibrancy, Mica, system window shadows, and OS compositor chrome are outside this gate.",
      "The final image is deterministically composed from the shell and visible WebContentsView targets.",
    ],
  };
  const nextManifest = {
    schemaVersion: 2,
    platform: process.platform,
    electronMajor,
    viewport: VIEWPORT,
    dpr: 1,
    themes: ["dark", "light"],
    fontFamily: report.fontFamily,
    motion: report.motion,
    fixturePort: FIXTURE_PORT,
    thresholds: report.thresholds,
    scenarios: {},
  };
  let failed = false;

  try {
    for (const scenario of scenarios) {
      const captured = await captureScenario(scenario);
      assert.equal(captured.runtime.electron, electronVersion);
      const actualPath = path.join(artifactsDirectory, `${scenario.name}.actual.png`);
      const diffPath = path.join(artifactsDirectory, `${scenario.name}.diff.png`);
      const baselinePath = path.join(baselineDirectory, `${scenario.name}.png`);
      await writePng(actualPath, captured.image);

      if (UPDATE_FLAG) {
        await writePng(baselinePath, captured.image);
        const emptyDiff = new PNG({
          width: captured.image.width,
          height: captured.image.height,
        });
        await writePng(diffPath, emptyDiff);
        nextManifest.scenarios[scenario.name] = {
          geometry: captured.geometry,
        };
        report.scenarios.push({
          name: scenario.name,
          status: "updated",
          diffPixels: 0,
          diffRatio: 0,
          geometryDifferences: [],
        });
        continue;
      }

      let baseline;
      try {
        baseline = PNG.sync.read(await readFile(baselinePath));
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        failed = true;
        const missingDiff = new PNG({
          width: captured.image.width,
          height: captured.image.height,
        });
        missingDiff.data.fill(255);
        await writePng(diffPath, missingDiff);
        report.scenarios.push({
          name: scenario.name,
          status: "failed",
          dimensionsMatch: false,
          expectedSize: null,
          actualSize: {
            width: captured.image.width,
            height: captured.image.height,
          },
          diffPixels: captured.image.width * captured.image.height,
          diffRatio: 1,
          geometryDifferences: [
            `geometry: scenario ${scenario.name} has no reviewed baseline`,
          ],
        });
        continue;
      }
      const dimensionsMatch =
        baseline.width === captured.image.width &&
        baseline.height === captured.image.height;
      const diff = new PNG({
        width: captured.image.width,
        height: captured.image.height,
      });
      let diffPixels = captured.image.width * captured.image.height;
      if (dimensionsMatch) {
        diffPixels = pixelmatch(
          baseline.data,
          captured.image.data,
          diff.data,
          captured.image.width,
          captured.image.height,
          { threshold: PIXEL_THRESHOLD, includeAA: false }
        );
      } else {
        diff.data.fill(255);
      }
      await writePng(diffPath, diff);
      const diffRatio = diffPixels / (captured.image.width * captured.image.height);
      const expectedScenario = expectedManifest.scenarios?.[scenario.name];
      const geometryDifferences = expectedScenario
        ? compareGeometry(expectedScenario.geometry, captured.geometry)
        : [`geometry: scenario ${scenario.name} is absent from manifest`];
      const passed =
        dimensionsMatch &&
        diffRatio <= MAX_DIFF_RATIO &&
        geometryDifferences.length === 0;
      failed ||= !passed;
      report.scenarios.push({
        name: scenario.name,
        status: passed ? "passed" : "failed",
        dimensionsMatch,
        expectedSize: { width: baseline.width, height: baseline.height },
        actualSize: {
          width: captured.image.width,
          height: captured.image.height,
        },
        diffPixels,
        diffRatio,
        geometryDifferences,
      });
    }

    if (UPDATE_FLAG) {
      await mkdir(baselineDirectory, { recursive: true });
      await writeFile(manifestPath, `${JSON.stringify(nextManifest, null, 2)}\n`);
    }
  } finally {
    fixtureServer.closeAllConnections();
    await new Promise(resolve => fixtureServer.close(resolve));
    await writeFile(
      path.join(artifactsDirectory, "report.json"),
      `${JSON.stringify(report, null, 2)}\n`
    );
  }

  if (failed) {
    throw new Error(
      `Visual regression failed; inspect ${path.relative(root, artifactsDirectory)}`
    );
  }
  process.stdout.write(
    `${JSON.stringify({ visual: true, mode: report.mode, scenarios: report.scenarios })}\n`
  );
}

await main();
