import {readFileSync} from 'node:fs';
import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';

const {version} = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {version: string};
// Release builds talk only to the production service; a test build (emulator) may name a loopback origin.
const origin = process.env.MULTAI_SERVICE_ORIGIN ?? 'https://api.multai.si';
if (!/^https:\/\/[a-z0-9.-]+$/u.test(origin) && !/^http:\/\/(localhost|127\.0\.0\.1):\d+$/u.test(origin)) throw new Error('MULTAI_SERVICE_ORIGIN must be an HTTPS origin or a loopback test origin.');

export default defineConfig({
  base: './',
  // The page may connect only to the one service this build was made for.
  plugins: [react(), {name: 'multai-csp', transformIndexHtml: html => html.replace('__SERVICE_ORIGIN__', origin)}],
  define: {__COMPANION_VERSION__: JSON.stringify(version), __SERVICE_ORIGIN__: JSON.stringify(origin)},
  build: {outDir: 'dist', emptyOutDir: true, sourcemap: false, target: ['es2022', 'chrome111'], assetsInlineLimit: 0, modulePreload: {polyfill: false}},
});
