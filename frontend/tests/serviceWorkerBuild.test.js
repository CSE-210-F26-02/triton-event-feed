import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  SERVICE_WORKER_FILE_NAME,
  buildVersion,
  injectIntoServiceWorker,
  listFiles,
  precacheUrls,
  serviceWorkerPlugin,
} from "../build/serviceWorkerBuild.js";

const SOURCE_SW_PATH = path.resolve(__dirname, "..", SERVICE_WORKER_FILE_NAME);

/** A minimal sw.js with the two declarations the build replaces. */
const SAMPLE_SW = [
  'const VERSION = "dev";',
  'const SHELL = [\n  "./",\n  "./src/app.js",\n];',
  "self.addEventListener('install', () => {});",
].join("\n");

/** A fresh, empty temporary folder. */
const makeTempDir = () => mkdtempSync(path.join(tmpdir(), "sw-build-"));

describe("precacheUrls", () => {
  it("puts the page first and sorts the built files", () => {
    expect(
      precacheUrls(["assets/b.js", "icon.svg", "assets/a.css", "index.html"]),
    ).toEqual([
      "./",
      "./index.html",
      "./assets/a.css",
      "./assets/b.js",
      "./icon.svg",
    ]);
  });

  it("never precaches the worker itself or source maps", () => {
    expect(
      precacheUrls(["sw.js", "assets/app.js", "assets/app.js.map"]),
    ).toEqual(["./", "./index.html", "./assets/app.js"]);
  });

  it("normalises separators and leading ./ and drops duplicates", () => {
    expect(
      precacheUrls(["./assets/x.js", "assets\\x.js", "/assets/x.js", ""]),
    ).toEqual(["./", "./index.html", "./assets/x.js"]);
  });

  it("still lists the page for an empty build", () => {
    expect(precacheUrls([])).toEqual(["./", "./index.html"]);
  });

  it.each([null, "assets/a.js", [1, "a.js"]])("rejects %j", (bad) => {
    expect(() => precacheUrls(bad)).toThrow(TypeError);
  });
});

describe("buildVersion", () => {
  it("is stable for the same files in any order", () => {
    const first = buildVersion({ "a.js": "one", "b.css": "two" });
    const second = buildVersion({ "b.css": "two", "a.js": "one" });
    expect(first).toBe(second);
    expect(first).toMatch(/^build-[0-9a-f]{12}$/);
  });

  it("changes when any file's content or name changes", () => {
    const base = buildVersion({ "a.js": "one" });
    expect(buildVersion({ "a.js": "ONE" })).not.toBe(base);
    expect(buildVersion({ "b.js": "one" })).not.toBe(base);
  });

  it("accepts binary content", () => {
    expect(buildVersion({ "a.jpg": new Uint8Array([1, 2, 3]) })).toMatch(
      /^build-/,
    );
  });
});

describe("injectIntoServiceWorker", () => {
  it("replaces VERSION and SHELL and keeps the rest", () => {
    const output = injectIntoServiceWorker(SAMPLE_SW, {
      version: "build-abc",
      shell: ["./", "./assets/app-1.js"],
    });
    expect(output).toContain('const VERSION = "build-abc";');
    expect(output).toContain('"./assets/app-1.js"');
    expect(output).not.toContain("./src/app.js");
    expect(output).toContain("self.addEventListener('install'");
  });

  it("does not treat $ in values as a replacement pattern", () => {
    const output = injectIntoServiceWorker(SAMPLE_SW, {
      version: "build-$&",
      shell: ["./$1.js"],
    });
    expect(output).toContain('const VERSION = "build-$&";');
    expect(output).toContain('"./$1.js"');
  });

  it("fails loudly when sw.js no longer declares VERSION", () => {
    expect(() =>
      injectIntoServiceWorker("const SHELL = [];", { version: "x", shell: [] }),
    ).toThrow(/VERSION/);
  });

  it("fails loudly when sw.js no longer declares SHELL", () => {
    expect(() =>
      injectIntoServiceWorker('const VERSION = "v";', {
        version: "x",
        shell: [],
      }),
    ).toThrow(/SHELL/);
  });

  it("works on the real frontend/sw.js", () => {
    const source = readFileSync(SOURCE_SW_PATH, "utf8");
    const output = injectIntoServiceWorker(source, {
      version: "build-test",
      shell: ["./"],
    });
    expect(output).toContain('const VERSION = "build-test";');
    expect(output).toContain('const SHELL = [\n  "./"\n];');
  });
});

describe("listFiles", () => {
  it("lists nested files relative to the folder", () => {
    const folder = makeTempDir();
    mkdirSync(path.join(folder, "nested"));
    writeFileSync(path.join(folder, "icon.svg"), "<svg/>");
    writeFileSync(path.join(folder, "nested", "data.json"), "{}");
    expect(listFiles(folder).sort()).toEqual(["icon.svg", "nested/data.json"]);
  });

  it("returns [] for a missing folder", () => {
    expect(listFiles(path.join(makeTempDir(), "missing"))).toEqual([]);
  });
});

describe("serviceWorkerPlugin", () => {
  it("emits sw.js listing the bundle and public files", () => {
    const folder = makeTempDir();
    const publicDir = path.join(folder, "public");
    mkdirSync(publicDir);
    writeFileSync(path.join(publicDir, "manifest.webmanifest"), "{}");
    const sourcePath = path.join(folder, "sw.js");
    writeFileSync(sourcePath, SAMPLE_SW);

    const plugin = serviceWorkerPlugin({ sourcePath });
    plugin.configResolved({ publicDir });
    const emitted = [];
    plugin.generateBundle.call(
      { emitFile: (file) => emitted.push(file) },
      {},
      {
        "assets/app-1.js": { type: "chunk", code: "console.log(1)" },
        "index.html": { type: "asset", source: "<html></html>" },
      },
    );

    expect(plugin.apply).toBe("build");
    expect(emitted).toHaveLength(1);
    expect(emitted[0].fileName).toBe(SERVICE_WORKER_FILE_NAME);
    expect(emitted[0].source).toMatch(/const VERSION = "build-[0-9a-f]{12}";/);
    expect(emitted[0].source).toContain('"./assets/app-1.js"');
    expect(emitted[0].source).toContain('"./manifest.webmanifest"');
  });
});
