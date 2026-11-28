/**
 * Build-time support for the service worker (sw.js).
 *
 * `vite build` renames every bundled file with a content hash
 * (e.g. assets/index-BGWvOKFA.js), so the hand-written precache list in sw.js
 * cannot name them. This Vite plugin emits dist/sw.js with:
 *   - SHELL: every file of the build, so the app still opens offline, and
 *   - VERSION: a hash of the build, so each deploy gets fresh caches and the
 *     old ones (an old frontend) are deleted when the new worker activates.
 * @module serviceWorkerBuild
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/** Name of the service worker, in the source folder and in dist/. */
export const SERVICE_WORKER_FILE_NAME = "sw.js";

/** Matches the `const VERSION = ...;` line of sw.js. */
const VERSION_DECLARATION = /^const VERSION = .*;$/m;

/** Matches the whole `const SHELL = [ ... ];` array of sw.js. */
const SHELL_DECLARATION = /^const SHELL = \[[\s\S]*?\];$/m;

/** Characters of the SHA-256 digest kept in VERSION. */
const VERSION_HASH_LENGTH = 12;

/** Prefix of an injected VERSION, so build caches are easy to recognise. */
const VERSION_PREFIX = "build-";

/** Entries that are always cached first: the page itself. */
const PAGE_ENTRIES = ["./", "./index.html"];

/** Built files that must not be precached (the worker, source maps). */
const NOT_PRECACHED = /(^|\/)sw\.js$|\.map$/;

/**
 * Turn built file names into the SHELL precache list.
 * @param {string[]} fileNames paths relative to dist/, e.g. "assets/app-1a2b.js"
 * @returns {string[]} "./"-relative URLs: the page first, then the files, sorted
 * @throws {TypeError} when fileNames is not an array of strings
 */
export function precacheUrls(fileNames) {
  if (
    !Array.isArray(fileNames) ||
    fileNames.some((name) => typeof name !== "string")
  )
    throw new TypeError("precacheUrls expects an array of file names");
  const files = fileNames
    .map((name) => name.replaceAll("\\", "/").replace(/^\.?\//, ""))
    .filter((name) => name && !NOT_PRECACHED.test(name))
    .map((name) => `./${name}`)
    .filter((url) => !PAGE_ENTRIES.includes(url));
  return [...PAGE_ENTRIES, ...[...new Set(files)].sort()];
}

/**
 * A short, stable hash of a build: the same files always give the same version.
 * @param {Record<string, string | Uint8Array>} contentsByFileName file name -> content
 * @returns {string} e.g. "build-3f9a1c0b2d4e"
 */
export function buildVersion(contentsByFileName) {
  const hash = createHash("sha256");
  for (const fileName of Object.keys(contentsByFileName).sort()) {
    hash.update(fileName);
    hash.update("\0");
    hash.update(contentsByFileName[fileName]);
    hash.update("\0");
  }
  return VERSION_PREFIX + hash.digest("hex").slice(0, VERSION_HASH_LENGTH);
}

/**
 * Replace VERSION and SHELL in the sw.js source.
 * @param {string} source the contents of frontend/sw.js
 * @param {{version: string, shell: string[]}} build what to inject
 * @returns {string} the service worker for dist/
 * @throws {Error} when sw.js no longer declares VERSION or SHELL as expected
 */
export function injectIntoServiceWorker(source, { version, shell }) {
  if (!VERSION_DECLARATION.test(source))
    throw new Error(
      `${SERVICE_WORKER_FILE_NAME}: no "const VERSION = ...;" line`,
    );
  if (!SHELL_DECLARATION.test(source))
    throw new Error(
      `${SERVICE_WORKER_FILE_NAME}: no "const SHELL = [...];" array`,
    );
  return source
    .replace(
      VERSION_DECLARATION,
      () => `const VERSION = ${JSON.stringify(version)};`,
    )
    .replace(
      SHELL_DECLARATION,
      () => `const SHELL = ${JSON.stringify(shell, null, 2)};`,
    );
}

/**
 * Every file under a folder, as paths relative to it ("/"-separated).
 * @param {string} folder e.g. frontend/public
 * @returns {string[]} relative paths; [] when the folder does not exist
 */
export function listFiles(folder) {
  let entries;
  try {
    entries = readdirSync(folder, { recursive: true, withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) =>
      path
        .relative(folder, path.join(entry.parentPath ?? entry.path, entry.name))
        .replaceAll("\\", "/"),
    );
}

/**
 * Content of every file in a Rollup bundle, keyed by file name.
 * @param {Record<string, {type: string, code?: string, source?: string | Uint8Array}>} bundle
 * @returns {Record<string, string | Uint8Array>}
 */
function bundleContents(bundle) {
  const contents = {};
  for (const [fileName, output] of Object.entries(bundle))
    contents[fileName] = output.type === "chunk" ? output.code : output.source;
  return contents;
}

/**
 * Vite plugin that emits dist/sw.js with the build's VERSION and SHELL.
 * Only runs for `vite build`; the dev server serves frontend/sw.js unchanged.
 * @param {{sourcePath: string}} options sourcePath: the hand-written sw.js
 * @returns {import("vite").Plugin}
 */
export function serviceWorkerPlugin({ sourcePath }) {
  let publicDir = "";
  return {
    name: "triton-service-worker",
    apply: "build",
    // Run after Vite has emitted index.html, so it is part of the version hash.
    enforce: "post",
    configResolved(config) {
      publicDir = config.publicDir;
    },
    generateBundle(_options, bundle) {
      const contents = bundleContents(bundle);
      for (const fileName of listFiles(publicDir))
        contents[fileName] = readFileSync(path.join(publicDir, fileName));
      const source = readFileSync(sourcePath, "utf8");
      this.emitFile({
        type: "asset",
        fileName: SERVICE_WORKER_FILE_NAME,
        source: injectIntoServiceWorker(source, {
          version: buildVersion(contents),
          shell: precacheUrls(Object.keys(contents)),
        }),
      });
    },
  };
}
