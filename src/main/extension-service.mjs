import { randomUUID } from "node:crypto";
import { access, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Owns unpacked Chrome-extension loading for one persistent session.
 *
 * Electron does not remember loaded extensions across launches, so this
 * service keeps a small JSON registry of installed extension directories and
 * replays `loadExtension` on every boot. Packed `.crx` archives are not
 * supported by Electron's loader and are therefore rejected up front.
 */
const ICON_MAX_BYTES = 128 * 1_024;

export function createExtensionService({
  browserSession,
  registryFile,
  onChange = () => {},
} = {}) {
  if (!browserSession || !registryFile) {
    throw new Error("Extension service requires a session and registry file");
  }
  const extensionsApi = browserSession.extensions || browserSession;
  const loaded = new Map();

  async function readRegistry() {
    try {
      const parsed = JSON.parse(await readFile(registryFile, "utf8"));
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(entry =>
        entry && typeof entry === "object" && typeof entry.path === "string"
      );
    } catch (error) {
      if (error?.code === "ENOENT" || error instanceof SyntaxError) return [];
      throw error;
    }
  }

  async function writeRegistry(entries) {
    const temporary = `${registryFile}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
    try {
      await rename(temporary, registryFile);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  async function validateUnpackedDirectory(sourcePath) {
    if (typeof sourcePath !== "string" || !sourcePath.trim()) {
      throw new Error("An unpacked extension directory is required");
    }
    const resolved = path.resolve(sourcePath);
    if (resolved.toLowerCase().endsWith(".crx")) {
      throw new Error("Packed .crx extensions are not supported; unpack it first");
    }
    await access(path.join(resolved, "manifest.json"));
    return resolved;
  }

  function insideRoot(directory, relativePath) {
    if (!relativePath) return false;
    return path
      .resolve(directory, relativePath)
      .startsWith(`${path.resolve(directory)}${path.sep}`);
  }

  function largestIconPath(candidate) {
    if (typeof candidate === "string") return candidate;
    if (!candidate || typeof candidate !== "object") return "";
    const sizes = Object.keys(candidate)
      .filter(key => /^\d+$/.test(key) && typeof candidate[key] === "string")
      .map(Number)
      .sort((left, right) => right - left);
    return sizes.length ? candidate[String(sizes[0])] : "";
  }

  async function readIconDataUrl(directory, manifest) {
    const relativePath = (
      largestIconPath(manifest?.action?.default_icon) ||
      largestIconPath(manifest?.icons)
    ).replace(/^\/+/, "").slice(0, 500);
    if (!insideRoot(directory, relativePath)) return "";
    const mime = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".webp": "image/webp",
    }[path.extname(relativePath).toLowerCase()];
    if (!mime) return "";
    try {
      const data = await readFile(path.resolve(directory, relativePath));
      if (data.byteLength > ICON_MAX_BYTES) return "";
      return `data:${mime};base64,${data.toString("base64")}`;
    } catch {
      return "";
    }
  }

  async function readActionMetadata(directory) {
    try {
      const manifest = JSON.parse(
        await readFile(path.join(directory, "manifest.json"), "utf8")
      );
      const action = manifest?.action && typeof manifest.action === "object"
        ? manifest.action
        : {};
      const popupPath = typeof action.default_popup === "string"
        ? action.default_popup.replace(/^\/+/, "").slice(0, 500)
        : "";
      const actionTitle = typeof action.default_title === "string"
        ? action.default_title.slice(0, 200)
        : "";
      return {
        // Popup and icon paths resolve against the extension root; anything
        // that escapes it is discarded so the shell never loads a foreign
        // resource.
        popupPath: insideRoot(directory, popupPath) ? popupPath : "",
        actionTitle,
        iconDataUrl: await readIconDataUrl(directory, manifest),
      };
    } catch {
      return { popupPath: "", actionTitle: "", iconDataUrl: "" };
    }
  }

  async function loadDirectory(directory) {
    const extension = await extensionsApi.loadExtension(directory, {
      allowFileAccess: false,
    });
    const actionMetadata = await readActionMetadata(directory);
    loaded.set(extension.id, {
      id: extension.id,
      name: String(extension.name || "Extension").slice(0, 200),
      version: String(extension.version || "0.0.0").slice(0, 50),
      path: directory,
      popupPath: actionMetadata.popupPath,
      actionTitle: actionMetadata.actionTitle,
      iconDataUrl: actionMetadata.iconDataUrl,
    });
    return loaded.get(extension.id);
  }

  return {
    /** Replays every registered extension; drops entries that fail to load. */
    async loadInstalled() {
      const entries = await readRegistry();
      const surviving = [];
      const failures = [];
      for (const entry of entries) {
        try {
          await loadDirectory(await validateUnpackedDirectory(entry.path));
          surviving.push({ path: path.resolve(entry.path) });
        } catch (error) {
          failures.push({ path: entry.path, message: error?.message || String(error) });
        }
      }
      if (failures.length) await writeRegistry(surviving);
      if (surviving.length || failures.length) onChange();
      return { loadedCount: surviving.length, failures };
    },

    async install(sourcePath) {
      const directory = await validateUnpackedDirectory(sourcePath);
      const existing = [...loaded.values()].find(entry => entry.path === directory);
      if (existing) return existing;
      const snapshotEntry = await loadDirectory(directory);
      const entries = await readRegistry();
      if (!entries.some(entry => path.resolve(entry.path) === directory)) {
        entries.push({ path: directory });
        await writeRegistry(entries);
      }
      onChange();
      return snapshotEntry;
    },

    async remove(id) {
      const entry = loaded.get(id);
      if (!entry) return false;
      extensionsApi.removeExtension(id);
      loaded.delete(id);
      const entries = await readRegistry();
      await writeRegistry(
        entries.filter(candidate => path.resolve(candidate.path) !== entry.path)
      );
      onChange();
      return true;
    },

    async reload(id) {
      const entry = loaded.get(id);
      if (!entry) return false;
      extensionsApi.removeExtension(id);
      loaded.delete(id);
      await loadDirectory(entry.path);
      onChange();
      return true;
    },

    snapshot() {
      return [...loaded.values()].map(entry => ({ ...entry }));
    },
  };
}
