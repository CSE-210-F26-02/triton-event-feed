import { defineConfig } from "vite";

export default defineConfig({
  server: {
    fs: {
      // Let the dev server serve files from the repo root, so the frontend can
      // import the shared lexicon in ../lexicons (see src/lexicon/validateEvent.js).
      allow: [".."],
    },
  },
});
