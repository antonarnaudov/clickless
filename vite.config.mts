import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Three UI surfaces:
//   shell.html     the window chrome: sidebar, top bar, agent panel (behind the page views)
//   overlay.html   a transparent layer above the pages: command palette, settings, organizer
//   internal.html  clickless:// pages loaded inside tabs: new tab, AI search answers
export default defineConfig({
  root: path.resolve(__dirname, 'src/renderer'),
  base: './',
  plugins: [react()],
  build: {
    outDir: path.resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true,
    target: 'chrome140',
    sourcemap: true,
    rollupOptions: {
      input: {
        shell: path.resolve(__dirname, 'src/renderer/shell.html'),
        overlay: path.resolve(__dirname, 'src/renderer/overlay.html'),
        internal: path.resolve(__dirname, 'src/renderer/internal.html'),
      },
    },
  },
  server: { port: 5199, strictPort: true },
});
