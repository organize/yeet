import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    benchmark: {
      include: ['src/**/*.bench.ts'],
      reporters: ['verbose'],
      outputJson: 'bench-results.json',
    },
  },
})
