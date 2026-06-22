import { defineConfig } from 'vite';

export default defineConfig({
  // Base public path. Default '/' keeps dev and `npm run serve` (static at
  // root :8080) working. A subpath deploy (e.g. GitHub Pages project site at
  // /choccus/) sets VITE_BASE=/choccus/ at build time.
  base: process.env.VITE_BASE ?? '/',
  server: {
    fs: {
      // Allow importing ../shared (outside the client root).
      allow: ['..'],
    },
  },
});
