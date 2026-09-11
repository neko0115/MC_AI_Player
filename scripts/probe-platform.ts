import { pathToFileURL } from 'node:url'

export interface PlatformProbeReport {
  nodeMajor: number
  nodeVersion: string
  arch: NodeJS.Architecture
  platform: NodeJS.Platform
  mineflayerLoaded: boolean
  pathfinderLoaded: boolean
}

export async function runPlatformProbe(): Promise<PlatformProbeReport> {
  const nodeMajor = Number(process.versions.node.split('.')[0])

  await import('mineflayer')
  await import('mineflayer-pathfinder')

  return {
    nodeMajor,
    nodeVersion: process.versions.node,
    arch: process.arch,
    platform: process.platform,
    mineflayerLoaded: true,
    pathfinderLoaded: true
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await runPlatformProbe(), null, 2))
}
