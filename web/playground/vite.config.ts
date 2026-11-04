import { defineConfig } from "vite";

// Relative base so the built site works under any path — including GitHub
// project pages at /seedcoherent/playground/ — without a hard-coded prefix.
export default defineConfig({
  root: __dirname,
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
  },
});
