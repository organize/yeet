import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '#/': new URL('./src/', import.meta.url).pathname,
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    benchmark: {
      include: ['src/**/*.bench.ts'],
      reporters: ['verbose'],
      outputJson: 'bench-results.json',
    },
  },
})
