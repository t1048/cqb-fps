import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    chunkSizeWarningLimit: 750,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: 'three',
              test: /[\\/]node_modules[\\/]three[\\/]/,
            },
            {
              name: 'world-gen',
              test: /[\\/]src[\\/]world[\\/]generator[\\/]/,
            },
          ],
        },
      },
    },
  },
});
