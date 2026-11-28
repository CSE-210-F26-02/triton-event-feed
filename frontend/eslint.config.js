import eslintJavascript from "@eslint/js";
import globals from "globals";
import { defineConfig } from "eslint/config";

/** Abbreviations a newcomer cannot guess (also refused in backend/tests/test_naming.py). */
const ABBREVIATIONS = [
  "addr",
  "arr",
  "btn",
  "cb",
  "cfg",
  "cm",
  "cnt",
  "coll",
  "conn",
  "ctx",
  "cur",
  "desc",
  "dt",
  "dur",
  "el",
  "err",
  "ev",
  "evt",
  "fmt",
  "fn",
  "gen",
  "idx",
  "kw",
  "li",
  "loc",
  "msg",
  "norm",
  "num",
  "obj",
  "op",
  "pos",
  "prev",
  "proc",
  "rec",
  "req",
  "res",
  "resp",
  "sep",
  "sub",
  "subs",
  "tmp",
  "tx",
  "upd",
  "val",
];

export default defineConfig([
  {
    ignores: ["node_modules/**", "coverage/**", "dist/**"],
  },
  {
    // The app runs in the browser (sw.js runs in a service worker, whose globals such
    // as `self` and `caches` are part of the browser set).
    files: ["**/*.{js,mjs,cjs}"],
    // The plugin key "js" is fixed: "js/recommended" below refers to it.
    plugins: { js: eslintJavascript },
    extends: ["js/recommended"],
    languageOptions: { globals: globals.browser },
    rules: {
      semi: "error",
      "prefer-const": "error",
      // Names must say what a value is, so someone new to the project can tell its
      // purpose from the name and the code around it: `event`, not `e` or `ev`.
      // Same rule as backend/tests/test_naming.py. Property names are exempt
      // because some are fixed by others: the AppView's `q` query parameter,
      // Leaflet's `window.L`.
      "id-length": [
        "error",
        { min: 3, properties: "never", exceptions: ["id"] },
      ],
      // Cryptic abbreviations: spell them out (`message`, not `msg`).
      "id-denylist": ["error", ...ABBREVIATIONS],
      // `const { uri: _uri, ...rest } = event` drops a field on purpose; a leading
      // underscore marks any other intentionally unused name.
      "no-unused-vars": [
        "error",
        {
          ignoreRestSiblings: true,
          varsIgnorePattern: "^_",
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    // Tests, build helpers and tool configs also run under Node (vitest, `node:fs`).
    files: [
      "tests/**/*.js",
      "src/**/*.test.js",
      "build/**/*.js",
      "*.config.{js,mjs}",
    ],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },
]);
