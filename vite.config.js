import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue()],
  build: {
    rollupOptions: {
      // 多入口：/ 对应 main.js，/config 对应 config-main.js
      input: {
        main: 'index.html',
        config: 'config.html',
      },
    },
  },
});
