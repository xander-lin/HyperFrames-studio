import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * Build config for the MyStudio Studio fork.
 *
 * Differences from upstream (see AGENTS.md, "Studio fork discipline"):
 * - dependencies come from published npm packages; no workspace: references remain.
 * - the project API that upstream's dev server provided is supplied by the
 *   @mystudio/desktop main process and is not reimplemented here.
 *
 * MYSTUDIO: upstream also aliased `canvas` to a browser stub. The current published
 * package never reaches linkedom's canvas branch in a browser build, so it is omitted;
 * if `createCanvas is not a function` ever appears, restore upstream's
 * src/shims/canvasBrowserStub.js and add the alias here.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    // Upstream reads this global for its version display. The fork gets its own marker
    // so problems are easy to attribute.
    __STUDIO_VERSION__: JSON.stringify("0.9.21+mystudio.1"),
  },
  resolve: {
    alias: {
      // Studio imports this subpath deeply; the published package already exposes the
      // same export, so it is kept as-is.
      "@hyperframes/studio-server/source-mutation":
        "@hyperframes/studio-server/source-mutation",
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    chunkSizeWarningLimit: 6000,
  },
  server: {
    port: 5190,
    watch: {
      // Compositions are user content; editing one must not trigger a full HMR reload.
      ignored: ["**/data/projects/**"],
    },
  },
  test: {
    // Upstream ships ~700 test files (kept intact at fork time, neither deleted nor
    // weakened). They depend on the upstream monorepo's workspace layout and fixtures
    // and cannot run in a standalone repo. Only this project's own tests run here, plus
    // the dock tests, which the fork modifies (layout floors are derived from the window
    // size so the window can be small) and which therefore need real coverage.
    include: [
      "src/annotate/**/*.test.ts",
      "src/annotate/**/*.test.tsx",
      "src/components/dock/**/*.test.ts",
      "src/components/dock/**/*.test.tsx",
    ],
    exclude: ["node_modules/**", "dist/**"],
    /*
     * Two environments, chosen per file.
     *
     * Most annotation logic is pure and must stay testable in a bare node process —
     * that is what keeps those tests fast and free of DOM quirks. But the bugs that
     * actually reached the user lived in the DOM layer: a contenteditable that dropped
     * keystrokes, a text-selection policy that let chrome text be selected. Those need
     * a real document, so `.test.tsx` files opt into jsdom with a file-level
     * `@vitest-environment jsdom` comment.
     */
    environment: "node",
    environmentMatchGlobs: [["src/annotate/**/*.test.tsx", "jsdom"]],
    /*
     * Runs for every file that declares an environment. It exists because happy-dom under
     * Vitest 4 here exposes no `localStorage`, which the dock tests need; see the file for
     * why a shim is enough. The annotation tests never relied on it — they inject their
     * own fake into `window`.
     */
    setupFiles: ["src/test-setup.ts"],
  },
});
