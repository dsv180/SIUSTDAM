import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// team-memory-control 后端地址（链路 A `/api/v1/meta/*` 等接口所在的后端）。
const TMC_BACKEND_TARGET = process.env.VITE_TMC_BACKEND_URL || 'http://127.0.0.1:8123';

// Skill Gateway 地址（`/v3/skill/*` 等接口所在的记忆网关）。
const SKILL_GATEWAY_TARGET = process.env.VITE_SKILL_GATEWAY_URL || 'http://127.0.0.1:8420';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api/v1': {
        target: TMC_BACKEND_TARGET,
        changeOrigin: true,
      },
      '/health': {
        target: TMC_BACKEND_TARGET,
        changeOrigin: true,
      },
      '/v3': {
        target: SKILL_GATEWAY_TARGET,
        changeOrigin: true,
        // [pilot-patch] Gateway с ключом (TDAI_GATEWAY_API_KEY из gateway.env):
        // прокси подставляет Bearer — фронтенду панель пользователя ключ не нужен.
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            if (process.env.TDAI_GATEWAY_API_KEY) {
              proxyReq.setHeader('authorization', `Bearer ${process.env.TDAI_GATEWAY_API_KEY}`);
            }
          });
        },
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
      },
    },
  },
});
