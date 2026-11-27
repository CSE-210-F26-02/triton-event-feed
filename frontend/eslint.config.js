import { defineConfig } from "eslint/config";

export default defineConfig([
  {
    rules: {
      semi: "error",
      "prefer-const": "error",
      // Names must say what a value is: no one-letter variables, parameters or
      // functions (e.g. `event`, not `e`). Property names are exempt because some
      // are fixed by others: the AppView's `q` query parameter, Leaflet's `window.L`.
      "id-length": ["error", { min: 2, properties: "never" }],
    },
  },
]);
