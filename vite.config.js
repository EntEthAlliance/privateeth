import { defineConfig } from "vite";

// Static build for GitHub Pages: relative base so it works under /privateeth/.
export default defineConfig({
  root: "web",
  base: "./",
  publicDir: "public",
  build: { outDir: "../dist", emptyOutDir: true, target: "esnext", chunkSizeWarningLimit: 20000 },
  esbuild: { target: "esnext" },
  optimizeDeps: {
    esbuildOptions: { target: "esnext" },
    exclude: ["@aztec/bb.js", "@noir-lang/noirc_abi", "@noir-lang/acvm_js", "@noir-lang/noir_js"],
  },
  worker: { format: "es" },
  server: { headers: { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" } },
  preview: { headers: { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" } },
});
