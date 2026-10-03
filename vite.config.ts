/// <reference types="vitest/config" />
import { fileURLToPath, URL } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: 5173,
    strictPort: true,
    host: true,
    open: false,
  },
  build: {
    outDir: './dist',
    sourcemap: true,
    emptyOutDir: true,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.{js,ts}'],
    exclude: [...configDefaults.exclude, '.claude/**', 'legacy/**', 'dist/**'],
  },
});
