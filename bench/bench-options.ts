const DEFAULT_TIME_MS = 3_000 as const
const DEFAULT_WARMUP_TIME_MS = 1_000 as const
const DEFAULT_WARMUP_ITERATIONS = 1_000 as const

export const readPositiveInt = (name: string, fallback: number): number => {
  const raw = process.env[name]
  if (raw === undefined) return fallback

  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback
}

export const BENCH_OPTS: {
  time: number
  warmupTime: number
  warmupIterations: number
} = {
  time: readPositiveInt('BENCH_TIME_MS', DEFAULT_TIME_MS),
  warmupTime: readPositiveInt('BENCH_WARMUP_TIME_MS', DEFAULT_WARMUP_TIME_MS),
  warmupIterations: readPositiveInt(
    'BENCH_WARMUP_ITERATIONS',
    DEFAULT_WARMUP_ITERATIONS,
  ),
} as const satisfies {
  time: number
  warmupTime: number
  warmupIterations: number
}
