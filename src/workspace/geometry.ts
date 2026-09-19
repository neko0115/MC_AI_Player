import {
  WORKSPACE_MAX_HORIZONTAL_SPAN,
  WORKSPACE_MAX_VERTICAL_SPAN,
  WorkspaceBoundsSchema,
  WorkspacePointSchema,
  type WorkspaceBounds,
  type WorkspacePoint
} from './contracts.js'

export interface WorkspaceGeometry {
  readonly bounds: WorkspaceBounds
  readonly sizeX: number
  readonly sizeY: number
  readonly sizeZ: number
  readonly volume: number
  readonly chunkRange: {
    readonly minX: number
    readonly maxX: number
    readonly minZ: number
    readonly maxZ: number
  }
  readonly chunkCount: number
}

export function normalizeWorkspaceBounds(
  pointA: WorkspacePoint,
  pointB: WorkspacePoint
): WorkspaceBounds {
  const a = WorkspacePointSchema.parse(pointA)
  const b = WorkspacePointSchema.parse(pointB)

  const bounds = {
    min: {
      x: Math.min(a.x, b.x),
      y: Math.min(a.y, b.y),
      z: Math.min(a.z, b.z)
    },
    max: {
      x: Math.max(a.x, b.x),
      y: Math.max(a.y, b.y),
      z: Math.max(a.z, b.z)
    }
  }

  return WorkspaceBoundsSchema.parse(bounds)
}

export function workspaceGeometry(
  bounds: WorkspaceBounds
): WorkspaceGeometry {
  const normalized = WorkspaceBoundsSchema.parse(bounds)

  const sizeX = normalized.max.x - normalized.min.x + 1
  const sizeY = normalized.max.y - normalized.min.y + 1
  const sizeZ = normalized.max.z - normalized.min.z + 1

  if (
    sizeX > WORKSPACE_MAX_HORIZONTAL_SPAN ||
    sizeZ > WORKSPACE_MAX_HORIZONTAL_SPAN ||
    sizeY > WORKSPACE_MAX_VERTICAL_SPAN
  ) {
    throw new RangeError('workspace bounds exceed configured span limits')
  }

  const volume = sizeX * sizeY * sizeZ
  if (!Number.isSafeInteger(volume)) {
    throw new RangeError('workspace volume exceeds safe integer range')
  }

  const minChunkX = blockToChunk(normalized.min.x)
  const maxChunkX = blockToChunk(normalized.max.x)
  const minChunkZ = blockToChunk(normalized.min.z)
  const maxChunkZ = blockToChunk(normalized.max.z)

  const chunkCount =
    (maxChunkX - minChunkX + 1) *
    (maxChunkZ - minChunkZ + 1)

  if (!Number.isSafeInteger(chunkCount)) {
    throw new RangeError('workspace chunk count exceeds safe integer range')
  }

  return {
    bounds: cloneBounds(normalized),
    sizeX,
    sizeY,
    sizeZ,
    volume,
    chunkRange: {
      minX: minChunkX,
      maxX: maxChunkX,
      minZ: minChunkZ,
      maxZ: maxChunkZ
    },
    chunkCount
  }
}

export function workspaceContainsPoint(
  bounds: WorkspaceBounds,
  point: WorkspacePoint
): boolean {
  const normalized = WorkspaceBoundsSchema.parse(bounds)
  const candidate = WorkspacePointSchema.parse(point)

  return (
    candidate.x >= normalized.min.x &&
    candidate.x <= normalized.max.x &&
    candidate.y >= normalized.min.y &&
    candidate.y <= normalized.max.y &&
    candidate.z >= normalized.min.z &&
    candidate.z <= normalized.max.z
  )
}

export function workspaceContainsBounds(
  outer: WorkspaceBounds,
  inner: WorkspaceBounds
): boolean {
  const parent = WorkspaceBoundsSchema.parse(outer)
  const child = WorkspaceBoundsSchema.parse(inner)

  return (
    child.min.x >= parent.min.x &&
    child.max.x <= parent.max.x &&
    child.min.y >= parent.min.y &&
    child.max.y <= parent.max.y &&
    child.min.z >= parent.min.z &&
    child.max.z <= parent.max.z
  )
}

export function workspacesIntersect(
  left: WorkspaceBounds,
  right: WorkspaceBounds
): boolean {
  const a = WorkspaceBoundsSchema.parse(left)
  const b = WorkspaceBoundsSchema.parse(right)

  return !(
    a.max.x < b.min.x ||
    b.max.x < a.min.x ||
    a.max.y < b.min.y ||
    b.max.y < a.min.y ||
    a.max.z < b.min.z ||
    b.max.z < a.min.z
  )
}

export function blockToChunk(blockCoordinate: number): number {
  if (!Number.isInteger(blockCoordinate)) {
    throw new TypeError('block coordinate must be an integer')
  }
  return Math.floor(blockCoordinate / 16)
}

function cloneBounds(
  bounds: WorkspaceBounds
): WorkspaceBounds {
  return {
    min: { ...bounds.min },
    max: { ...bounds.max }
  }
}
