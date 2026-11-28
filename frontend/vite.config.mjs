import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import {
  SERVICE_WORKER_FILE_NAME,
  serviceWorkerPlugin,
} from "./build/serviceWorkerBuild.js";

/** Folder `vite build` writes the site to; the FastAPI backend serves it. */
const BUILD_OUTPUT_DIR = "dist";

export default defineConfig({
  server: {
    fs: {
      // Let the dev server serve files from the repo root, so the frontend can
      // import the shared lexicon in ../lexicons (see src/lexicon/validateEvent.js).
      allow: [".."],
    },
  },
  build: {
    outDir: BUILD_OUTPUT_DIR,
    emptyOutDir: true,
  },
  plugins: [
    // Emits dist/sw.js with a precache list of the hashed build files.
    serviceWorkerPlugin({
      sourcePath: fileURLToPath(
        new URL(`./${SERVICE_WORKER_FILE_NAME}`, import.meta.url),
      ),
    }),
  ],
});
