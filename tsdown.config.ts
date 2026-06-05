import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  clean: true,
  sourcemap: true,
  minify: true,
  deps: {
    neverBundle: [
      'better-result',
      'vitest',
      'oxfmt',
      'oxlint',
      'oxlint-tsgolint',
      'tsdown',
      'typescript',
    ],
  },
  platform: 'neutral',
  target: 'es2025',
  fixedExtension: true,
})
