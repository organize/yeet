import { defineConfig } from 'vitest/config'

const benchOutputJson = process.env['BENCH_OUTPUT_JSON'] ?? 'bench-results.json'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    benchmark: {
      include: ['bench/**/*.bench.ts'],
      reporters: ['verbose'],
      outputJson: benchOutputJson,
    },
  },
})
