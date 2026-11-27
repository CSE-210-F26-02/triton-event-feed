import js from "@eslint/js";
import globals from "globals";
import { defineConfig } from "eslint/config";

export default defineConfig([
  {
    ignores: ["node_modules/**", "coverage/**", "dist/**"],
  },
  {
    // The app runs in the browser (sw.js runs in a service worker, whose globals such
    // as `self` and `caches` are part of the browser set).
    files: ["**/*.{js,mjs,cjs}"],
    plugins: { js },
    extends: ["js/recommended"],
    languageOptions: { globals: globals.browser },
    rules: {
      semi: "error",
      "prefer-const": "error",
      // Names must say what a value is: no one-letter variables, parameters or
      // functions (e.g. `event`, not `e`). Property names are exempt because some
      // are fixed by others: the AppView's `q` query parameter, Leaflet's `window.L`.
      "id-length": ["error", { min: 2, properties: "never" }],
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
    // Tests and tool configs also run under Node (vitest, `node:fs`, `__dirname`).
    files: ["tests/**/*.js", "src/**/*.test.js", "*.config.js"],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },
]);
