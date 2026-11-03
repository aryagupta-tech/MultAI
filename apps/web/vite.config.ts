import {readFileSync} from 'node:fs';
import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';

const {version} = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {version: string};

// Served at /app/ on the browser's origin, alongside its /v1/ proxy, under a strict CSP: no inline scripts or styles.
export default defineConfig({
  base: '/app/',
  plugins: [react()],
  define: {__COMPANION_VERSION__: JSON.stringify(version)},
  build: {outDir: 'dist', emptyOutDir: true, sourcemap: false, target: ['es2022', 'safari16', 'chrome111'], assetsInlineLimit: 0, modulePreload: {polyfill: false}},
});
