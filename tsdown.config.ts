import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/unplugin.ts',
    'src/unplugin/vite.ts',
    'src/unplugin/rollup.ts',
    'src/unplugin/webpack.ts',
    'src/unplugin/rspack.ts',
    'src/unplugin/esbuild.ts',
    'src/unplugin/bun.ts',
  ],
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
    dts: {
      neverBundle: ['unplugin'],
    },
  },
  platform: 'node',
  target: 'es2025',
  fixedExtension: true,
})
