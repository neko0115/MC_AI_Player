import { createRequire } from 'node:module'

const expectedArch = process.env.EXPECTED_ARCH
const expectedVersion = '12.11.1'
const report = process.report?.getReport?.()
const glibc = report?.header?.glibcVersionRuntime ?? null

if (process.platform !== 'linux') {
  throw new Error(`sqlite probe requires linux, got ${process.platform}`)
}
if (expectedArch && process.arch !== expectedArch) {
  throw new Error(`expected architecture ${expectedArch}, got ${process.arch}`)
}
if (!glibc) {
  throw new Error('glibc runtime version was not detected')
}

const require = createRequire(import.meta.url)
const packageJson = require('better-sqlite3/package.json')
if (packageJson.version !== expectedVersion) {
  throw new Error(`expected better-sqlite3 ${expectedVersion}, got ${packageJson.version}`)
}

const { default: Database } = await import('better-sqlite3')
const db = new Database(':memory:')
try {
  db.exec(`
    CREATE TABLE probe (
      id INTEGER PRIMARY KEY,
      value TEXT NOT NULL
    );
  `)
  db.prepare('INSERT INTO probe (value) VALUES (?)').run('arm64-ready')
  const row = db.prepare('SELECT value FROM probe WHERE id = 1').get()
  if (!row || row.value !== 'arm64-ready') {
    throw new Error(`sqlite round-trip failed: ${JSON.stringify(row)}`)
  }
  const sqlite = db.prepare('SELECT sqlite_version() AS version').get()
  console.log(JSON.stringify({
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    glibc,
    betterSqlite3: packageJson.version,
    sqlite: sqlite?.version ?? null,
    roundTrip: 'PASS'
  }, null, 2))
} finally {
  db.close()
}
