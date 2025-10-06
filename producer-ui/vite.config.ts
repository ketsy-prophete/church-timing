// vite.config.ts
import { defineConfig } from 'vite';
import angular from '@analogjs/vite-plugin-angular';

export default defineConfig({
  plugins: [angular()],
  server: {
    host: true,
    port: 4200,
    allowedHosts: ['.trycloudflare.com'],   // ← move it here
    // HMR tweaks (optional; helpful when viewing via the tunnel)
    hmr: {
      protocol: 'wss',
      clientPort: 443,
    },
    proxy: {
      '/api': { target: 'http://localhost:5272', changeOrigin: true, secure: false },
      '/hubs/serviceSync': { target: 'http://localhost:5272', ws: true, changeOrigin: true, secure: false },
    },
  },
});
