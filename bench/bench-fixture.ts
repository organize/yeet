import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

let fixtureDir: string | undefined
let fixtureCounter = 0

export async function importBenchFixture<T>(
  code: string,
  name: string,
): Promise<T> {
  const file = await writeBenchFixture(code, name)
  return (await import(pathToFileURL(file).href)) as T
}

export async function cleanupBenchFixtures(): Promise<void> {
  const dir = fixtureDir
  if (dir === undefined) return
  fixtureDir = undefined
  await rm(dir, { recursive: true, force: true })
}

async function writeBenchFixture(code: string, name: string): Promise<string> {
  fixtureDir ??= await mkdtemp(join(tmpdir(), 'yeet-bench-'))
  const safeName = name.replaceAll(/[^a-zA-Z0-9._-]/g, '-')
  const file = join(fixtureDir, `${safeName}-${fixtureCounter++}.mjs`)
  await writeFile(file, code)
  return file
}
