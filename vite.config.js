import { defineConfig } from 'vite';

// Relative base so the static dist/ opens from any path (file://, a subfolder, a share).
// The dev harnesses under dev/ are served by the dev server only; the production
// build bundles index.html alone.
export default defineConfig({
  base: './',
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    // three.js alone is over 500 kB minified; one bundle is fine for a static page.
    chunkSizeWarningLimit: 1200,
  },
});
