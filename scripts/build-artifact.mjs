// Builds the claude.ai artifact version of the app into .build-artifact/ (gitignored). Run with
// `npm run build:artifact`.
//
// Same source as `npm run build`, except three.js is left out of the bundle and loaded from
// jsDelivr at the pinned version through an import map in the artifact page
// (scripts/artifact-page.html), because the artifact host only runs scripts from a short list
// of CDNs. The output is index.html (the page, without its own document skeleton: the publisher
// wraps it), assets/app.js and assets/app.css; publish those three files.

import { build } from 'vite';
import { copyFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);
const outDir = join(root, '.build-artifact');

await build({
  root,
  configFile: false,
  base: './',
  logLevel: 'warn',
  build: {
    outDir,
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
    rolldownOptions: {
      external: (id) => id === 'three' || id.startsWith('three/addons/'),
      output: {
        entryFileNames: 'assets/app.js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/app[extname]',
      },
    },
  },
});

// The artifact page replaces Vite's index.html.
copyFileSync(join(here, 'artifact-page.html'), join(outDir, 'index.html'));
console.log(['index.html', ...readdirSync(join(outDir, 'assets')).map((f) => `assets/${f}`)].join('\n'));
