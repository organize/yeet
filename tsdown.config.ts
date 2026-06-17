import { defineConfig, type UserConfig } from 'tsdown'

const runtimeConfig = {
  name: 'runtime',
  entry: ['src/index.ts', 'src/stream.ts'],
  format: ['esm'],
  clean: true,
  sourcemap: true,
  minify: true,
  platform: 'neutral',
  target: 'es2025',
  fixedExtension: true,
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
} satisfies UserConfig

const unpluginConfig = {
  name: 'unplugin',
  entry: [
    'src/unplugin.ts',
    'src/unplugin/vite.ts',
    'src/unplugin/rollup.ts',
    'src/unplugin/webpack.ts',
    'src/unplugin/rspack.ts',
    'src/unplugin/esbuild.ts',
    'src/unplugin/bun.ts',
  ],
  format: ['esm'],
  clean: false,
  sourcemap: true,
  minify: true,
  platform: 'node',
  target: 'es2025',
  fixedExtension: true,
  deps: {
    onlyBundle: false,
    dts: {
      neverBundle: ['unplugin'],
    },
  },
} satisfies UserConfig

export default defineConfig([runtimeConfig, unpluginConfig])
