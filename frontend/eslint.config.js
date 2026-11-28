import js from "@eslint/js";
import globals from "globals";
import { defineConfig } from "eslint/config";

export default defineConfig([
  {
    files: ["**/*.{js,mjs,cjs}"],
    plugins: { js },
    extends: ["js/recommended"],
    languageOptions: { globals: globals.browser },
  },
  {
    // Tests run under Node (vitest), so Node globals such as __dirname exist there.
    files: ["tests/**/*.js"],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },
]);
