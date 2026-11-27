import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ConfigError,
  ENV_KEYS,
  MOCK_ENV_KEYS,
  loadConfig,
  loadMockConfig,
} from "../src/config.js";
import { TEST_ENV } from "./helpers.js";

/** TEST_ENV with some variables replaced (undefined removes one). */
const env = (overrides = {}) => {
  const merged = { ...TEST_ENV, ...overrides };
  return Object.fromEntries(
    Object.entries(merged).filter(([, value]) => value !== undefined),
  );
};

/** The problems `load` (default loadConfig) reports for `values`. */
function problemsFor(values, load = loadConfig) {
  try {
    load(values);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return error.problems;
  }
  throw new Error("expected the config loader to throw");
}
/** Same, for loadMockConfig. */
problemsFor.mock = (values) => problemsFor(values, loadMockConfig);

describe("loadConfig", () => {
  it("builds the app config from the env", () => {
    expect(loadConfig(TEST_ENV)).toEqual({
      apiBaseUrl: "",
      atproto: {
        plcBase: "https://plc.directory",
        resolverBases: ["https://public.api.bsky.app", "https://bsky.social"],
      },
      map: {
        leafletJs: "https://leaflet.test/leaflet.js",
        leafletCss: "https://leaflet.test/leaflet.css",
        tileUrl: "https://tiles.test/{z}/{x}/{y}.png",
        attribution: "&copy; Test tiles",
        maxZoom: 19,
        center: [32.8801, -117.234],
        zoom: 15,
      },
    });
  });

  it("returns a frozen config", () => {
    const config = loadConfig(TEST_ENV);
    expect(Object.isFrozen(config.map.center)).toBe(true);
    expect(Object.isFrozen(config.atproto.resolverBases)).toBe(true);
  });

  it("reports every missing variable at once", () => {
    const problems = problemsFor({});
    for (const name of Object.values(ENV_KEYS))
      expect(problems.join("\n")).toContain(name);
  });

  it.each([
    ["", ""],
    ["/backend/", "/backend"],
    ["http://127.0.0.1:8000/", "http://127.0.0.1:8000"],
  ])("accepts API base %j", (value, expected) => {
    expect(loadConfig(env({ VITE_API_BASE_URL: value })).apiBaseUrl).toBe(
      expected,
    );
  });

  it.each(["ftp://x.test", "api.example.com"])(
    "rejects API base %j",
    (value) => {
      expect(problemsFor(env({ VITE_API_BASE_URL: value }))[0]).toMatch(
        /^VITE_API_BASE_URL must be/,
      );
    },
  );

  it("requires the API base to be defined, even if empty", () => {
    expect(problemsFor(env({ VITE_API_BASE_URL: undefined }))).toEqual([
      "VITE_API_BASE_URL must be set, got undefined",
    ]);
  });

  it("trims URLs and drops trailing slashes", () => {
    const config = loadConfig(
      env({
        VITE_ATPROTO_PLC_DIRECTORY_URL: "  https://plc.test/  ",
        VITE_ATPROTO_HANDLE_RESOLVER_URLS: " https://a.test/ , https://b.test ",
      }),
    );
    expect(config.atproto).toEqual({
      plcBase: "https://plc.test",
      resolverBases: ["https://a.test", "https://b.test"],
    });
  });

  it.each(["not a url", "javascript:alert(1)", "ftp://plc.test"])(
    "rejects a non-http(s) URL (%s)",
    (value) => {
      expect(
        problemsFor(env({ VITE_ATPROTO_PLC_DIRECTORY_URL: value }))[0],
      ).toMatch(/must be an http\(s\) URL/);
    },
  );

  it.each([",", "https://a.test,nope"])(
    "rejects a bad resolver list (%j)",
    (value) => {
      expect(
        problemsFor(env({ VITE_ATPROTO_HANDLE_RESOLVER_URLS: value }))[0],
      ).toMatch(/comma-separated http\(s\) URLs/);
    },
  );

  it.each([
    "https://tiles.test/{z}/{x}.png",
    "tiles.test/{z}/{x}/{y}.png",
    "javascript:{z}{x}{y}",
  ])("rejects a tile URL without {z}/{x}/{y} or http(s) (%s)", (value) => {
    expect(problemsFor(env({ VITE_MAP_TILE_URL: value }))[0]).toMatch(
      /^VITE_MAP_TILE_URL must be/,
    );
  });

  it.each([
    ["VITE_MAP_CENTER_LAT", "91"],
    ["VITE_MAP_CENTER_LAT", "north"],
    ["VITE_MAP_CENTER_LNG", "-181"],
    ["VITE_MAP_DEFAULT_ZOOM", "15.5"],
    ["VITE_MAP_MAX_ZOOM", "23"],
    ["VITE_MAP_MAX_ZOOM", "-1"],
  ])("rejects %s=%s", (name, value) => {
    expect(problemsFor(env({ [name]: value }))[0]).toMatch(
      new RegExp(`^${name} must be`),
    );
  });

  it("treats blank values as missing", () => {
    expect(problemsFor(env({ VITE_MAP_TILE_ATTRIBUTION: "   " }))).toEqual([
      "VITE_MAP_TILE_ATTRIBUTION is required",
    ]);
  });

  it("points at .env.example in the error message", () => {
    expect(() => loadConfig({})).toThrow(/frontend\/\.env\.example/);
  });
});

describe("loadMockConfig (?mock demo mode only)", () => {
  it("reads the mock PDS token prefixes", () => {
    expect(loadMockConfig(TEST_ENV)).toEqual({
      tokenPrefixes: {
        accessTokenPrefix: "test-access-",
        refreshTokenPrefix: "test-refresh-",
      },
    });
  });

  it("is not needed by the main config (production never sets it)", () => {
    const {
      VITE_MOCK_PDS_ACCESS_TOKEN_PREFIX: _accessPrefix,
      VITE_MOCK_PDS_REFRESH_TOKEN_PREFIX: _refreshPrefix,
      ...productionEnv
    } = TEST_ENV;
    expect(() => loadConfig(productionEnv)).not.toThrow();
    expect(() => loadMockConfig(productionEnv)).toThrow(ConfigError);
  });

  it("reports both missing prefixes", () => {
    expect(problemsFor.mock({})).toEqual([
      "VITE_MOCK_PDS_ACCESS_TOKEN_PREFIX is required",
      "VITE_MOCK_PDS_REFRESH_TOKEN_PREFIX is required",
    ]);
  });

  it.each(["has space", "semi;colon", "new\nline"])(
    "rejects header-unsafe prefixes (%j)",
    (value) => {
      expect(
        problemsFor.mock(env({ VITE_MOCK_PDS_ACCESS_TOKEN_PREFIX: value }))[0],
      ).toMatch(/may only contain/);
    },
  );

  it("requires the two prefixes to differ", () => {
    expect(
      problemsFor.mock(
        env({
          VITE_MOCK_PDS_ACCESS_TOKEN_PREFIX: "same-",
          VITE_MOCK_PDS_REFRESH_TOKEN_PREFIX: "same-",
        }),
      ),
    ).toEqual([
      "VITE_MOCK_PDS_REFRESH_TOKEN_PREFIX must differ from VITE_MOCK_PDS_ACCESS_TOKEN_PREFIX",
    ]);
  });
});

describe("frontend/.env.example", () => {
  /** Parse KEY=value lines the way Vite's dotenv does for this simple file. */
  function parseExample() {
    const text = readFileSync(resolve(__dirname, "../.env.example"), "utf8");
    const values = {};
    for (const line of text.split("\n")) {
      const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (!match) continue;
      values[match[1]] = match[2].replace(/^'(.*)'$/, "$1");
    }
    return values;
  }

  it("is a complete, valid configuration (copying it is enough to run)", () => {
    const example = parseExample();
    expect(Object.keys(example).sort()).toEqual(
      [...Object.values(ENV_KEYS), ...Object.values(MOCK_ENV_KEYS)].sort(),
    );
    expect(() => loadConfig(example)).not.toThrow();
    expect(() => loadMockConfig(example)).not.toThrow();
  });

  it("contains only VITE_ variables (Vite exposes nothing else)", () => {
    for (const name of Object.keys(parseExample()))
      expect(name.startsWith("VITE_")).toBe(true);
  });
});

describe("app startup with a bad config", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    document.body.replaceChildren();
  });

  it("shows what is wrong instead of starting", async () => {
    globalThis.__CM_NO_AUTOSTART__ = true;
    const { start } = await import("../src/app.js");
    document.body.innerHTML = '<div id="list" aria-busy="true"></div>';
    vi.stubEnv("VITE_MAP_TILE_URL", "not-a-tile-url");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await start();
    const notice = document.querySelector("#list [role=alert]");
    expect(notice.textContent).toContain("VITE_MAP_TILE_URL");
    expect(notice.textContent).toContain("frontend/.env.example");
    expect(document.querySelector("#list").getAttribute("aria-busy")).toBe(
      "false",
    );
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });
});
