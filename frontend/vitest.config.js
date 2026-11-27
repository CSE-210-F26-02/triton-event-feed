// Test-only config. The app runs through Vite (it imports the shared lexicon JSON and
// @atproto/lexicon), and Vitest reuses that same module pipeline.
export default {
  test: {
    environment: "jsdom",
    // tests/ holds the view/app suites; src/**/*.test.js holds tests that live next to
    // their module (e.g. src/lexicon/validateEvent.test.js, which runs the shared fixtures).
    include: ["tests/**/*.test.js", "src/**/*.test.js"],
  },
};
