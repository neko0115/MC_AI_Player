import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const VERSION_MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'

interface VersionManifest {
  versions: Array<{ id: string; url: string }>
}

interface VersionMetadata {
  downloads: {
    server?: {
      sha1: string
      size: number
      url: string
    }
  }
}

export async function fetchTestServer(version = process.env.MC_TEST_VERSION || '1.21.1'): Promise<string> {
  const targetDirectory = resolve('artifacts', 'test-server')
  const targetPath = resolve(targetDirectory, `minecraft-server-${version}.jar`)
  await mkdir(targetDirectory, { recursive: true })

  const manifest = await fetchJson<VersionManifest>(VERSION_MANIFEST_URL)
  const entry = manifest.versions.find(item => item.id === version)
  if (!entry) {
    throw new Error(`Minecraft version not found in Mojang manifest: ${version}`)
  }

  const metadata = await fetchJson<VersionMetadata>(entry.url)
  const server = metadata.downloads.server
  if (!server) {
    throw new Error(`No server download published for Minecraft ${version}`)
  }

  try {
    const existing = await readFile(targetPath)
    if (sha1(existing) === server.sha1) {
      return targetPath
    }
  } catch (error) {
    if (!isMissingFile(error)) throw error
  }

  const response = await fetch(server.url)
  if (!response.ok) {
    throw new Error(`Server download failed with HTTP ${response.status}`)
  }
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.byteLength !== server.size) {
    throw new Error(`Server size mismatch: expected ${server.size}, got ${bytes.byteLength}`)
  }
  const digest = sha1(bytes)
  if (digest !== server.sha1) {
    throw new Error(`Server SHA-1 mismatch: expected ${server.sha1}, got ${digest}`)
  }

  await writeFile(targetPath, bytes)
  return targetPath
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} while fetching ${url}`)
  }
  return (await response.json()) as T
}

function sha1(bytes: Uint8Array): string {
  return createHash('sha1').update(bytes).digest('hex')
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

if (import.meta.url === new URL(process.argv[1] ?? '', 'file:').href) {
  console.log(await fetchTestServer())
}
