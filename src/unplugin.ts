import { createUnplugin } from 'unplugin'

import {
  transformYeet,
  type YeetTransformOptions,
  type YeetTransformResult,
} from './unplugin/transform.ts'

export type { YeetTransformOptions, YeetTransformResult }
export type YeetPluginAdapter = (options?: YeetTransformOptions) => any
export type YeetUnplugin = {
  readonly vite: YeetPluginAdapter
  readonly rollup: YeetPluginAdapter
  readonly webpack: YeetPluginAdapter
  readonly rspack: YeetPluginAdapter
  readonly esbuild: YeetPluginAdapter
  readonly bun: YeetPluginAdapter
  readonly raw: any
}

const INCLUDE = /\.[cm]?[jt]sx?$/

export const yeet: YeetUnplugin = createUnplugin<
  YeetTransformOptions | undefined
>((options = {}) => ({
  name: '@big-time/yeet',
  enforce: 'pre',
  transform: {
    filter: { id: INCLUDE },
    handler(code, id) {
      const result = transformYeet(code, id, options)
      if (result === null) return null
      return { code: result.code, map: result.map as any }
    },
  },
}))

/** @alias yeet */
export default yeet
