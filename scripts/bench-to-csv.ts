import { readFile, writeFile } from 'node:fs/promises'

interface BenchmarkEntry {
  name: string
  hz: number
  mean: number
  p75: number
  p99: number
  rme: number
  sampleCount: number
}

interface BenchmarkGroup {
  fullName: string
  benchmarks: BenchmarkEntry[]
}

interface BenchmarkReport {
  files: Array<{ groups: BenchmarkGroup[] }>
}

const RESULT_HEADER = 'suite,name,hz,mean_ms,p75_ms,p99_ms,rme_pct,samples'
const DEFAULT_INPUT = 'bench-results.json'
const DEFAULT_OUTPUT = 'bench-results.csv'
const input =
  process.env['BENCH_OUTPUT_JSON'] ?? process.argv[2] ?? DEFAULT_INPUT
const output =
  process.env['BENCH_OUTPUT_CSV'] ??
  process.argv[3] ??
  defaultCsvPath(input, DEFAULT_OUTPUT)
const target = process.env['BENCH_TARGET']
const runtimeVersion = process.env['BENCH_RUNTIME_VERSION']
const includeTargetColumns =
  target !== undefined || runtimeVersion !== undefined

const report: BenchmarkReport = JSON.parse(await readFile(input, 'utf8'))
const rows: string[] = []

for (const file of report.files) {
  for (const group of file.groups) {
    for (const bench of group.benchmarks) {
      const targetColumns = includeTargetColumns
        ? [csv(target ?? ''), csv(runtimeVersion ?? '')]
        : []
      rows.push(
        [
          ...targetColumns,
          csv(group.fullName),
          csv(bench.name),
          bench.hz.toFixed(0),
          bench.mean.toFixed(7),
          bench.p75.toFixed(7),
          bench.p99.toFixed(7),
          bench.rme.toFixed(2),
          String(bench.sampleCount),
        ].join(','),
      )
    }
  }
}

const header = includeTargetColumns
  ? `target,runtime,${RESULT_HEADER}`
  : RESULT_HEADER

await writeFile(output, `${[header, ...rows].join('\n')}\n`)
console.log(`bench results written to ${output}`)

function defaultCsvPath(inputPath: string, fallback: string): string {
  return inputPath.endsWith('.json')
    ? `${inputPath.slice(0, -'.json'.length)}.csv`
    : fallback
}

function csv(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

export {}
