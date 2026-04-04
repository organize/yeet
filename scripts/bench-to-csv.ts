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

const HEADER = 'suite,name,hz,mean_ms,p75_ms,p99_ms,rme_pct,samples'
const INPUT = 'bench-results.json'
const OUTPUT = 'bench-results.csv'

const report: BenchmarkReport = JSON.parse(await Bun.file(INPUT).text())
const rows: string[] = []

for (const file of report.files) {
  for (const group of file.groups) {
    for (const bench of group.benchmarks) {
      rows.push(
        [
          `"${group.fullName}"`,
          `"${bench.name}"`,
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

await Bun.write(OUTPUT, `${[HEADER, ...rows].join('\n')}\n`)
console.log(`bench results written to ${OUTPUT}`)

export {}
