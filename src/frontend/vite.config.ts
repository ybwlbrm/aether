import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    // P2-10: 代码分割防单 chunk 过大
    rollupOptions: {
      output: {
        manualChunks: {
          'react-vendor': ['react', 'react-dom', 'react-router-dom'],
          'ai-vendor': ['ai', '@ai-sdk/react', '@ai-sdk/ui-utils', 'streamdown'],
          'radix-vendor': ['@radix-ui/react-accordion', '@radix-ui/react-select', '@radix-ui/react-separator', '@radix-ui/react-slot', '@radix-ui/react-collapsible'],
          'motion-vendor': ['framer-motion', 'motion'],
        },
      },
    },
  },
});