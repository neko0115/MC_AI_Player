import assert from 'node:assert/strict'
import test from 'node:test'
import {
  WorkspaceBoundsSchema,
  WorkspaceRegionSchema,
  WorkspaceSelectionSchema
} from '../../src/workspace/contracts.js'
import {
  blockToChunk,
  normalizeWorkspaceBounds,
  workspaceContainsBounds,
  workspaceContainsPoint,
  workspaceGeometry,
  workspacesIntersect
} from '../../src/workspace/geometry.js'

test('two wand points normalize into an inclusive 5 x 10 x 10 cuboid', () => {
  const bounds = normalizeWorkspaceBounds(
    { x: 14, y: 73, z: 29 },
    { x: 10, y: 64, z: 20 }
  )

  assert.deepEqual(bounds, {
    min: { x: 10, y: 64, z: 20 },
    max: { x: 14, y: 73, z: 29 }
  })

  assert.deepEqual(
    workspaceGeometry(bounds),
    {
      bounds,
      sizeX: 5,
      sizeY: 10,
      sizeZ: 10,
      volume: 500,
      chunkRange: {
        minX: 0,
        maxX: 0,
        minZ: 1,
        maxZ: 1
      },
      chunkCount: 1
    }
  )
})

test('a 9 x 1 x 9 surface selection is represented without inventing height', () => {
  const geometry = workspaceGeometry(
    normalizeWorkspaceBounds(
      { x: 0, y: 64, z: 0 },
      { x: 8, y: 64, z: 8 }
    )
  )

  assert.equal(geometry.sizeX, 9)
  assert.equal(geometry.sizeY, 1)
  assert.equal(geometry.sizeZ, 9)
  assert.equal(geometry.volume, 81)
})

test('large selections derive chunk coverage without enumerating every block', () => {
  const geometry = workspaceGeometry(
    normalizeWorkspaceBounds(
      { x: 0, y: 64, z: 0 },
      { x: 63, y: 70, z: 47 }
    )
  )

  assert.deepEqual(geometry.chunkRange, {
    minX: 0,
    maxX: 3,
    minZ: 0,
    maxZ: 2
  })
  assert.equal(geometry.chunkCount, 12)
})

test('negative block coordinates map to Minecraft chunk coordinates correctly', () => {
  assert.equal(blockToChunk(-1), -1)
  assert.equal(blockToChunk(-16), -1)
  assert.equal(blockToChunk(-17), -2)
  assert.equal(blockToChunk(0), 0)
  assert.equal(blockToChunk(16), 1)
})

test('containment and intersection are inclusive at region edges', () => {
  const outer = normalizeWorkspaceBounds(
    { x: 0, y: 60, z: 0 },
    { x: 10, y: 70, z: 10 }
  )
  const inner = normalizeWorkspaceBounds(
    { x: 2, y: 64, z: 2 },
    { x: 8, y: 64, z: 8 }
  )
  const touching = normalizeWorkspaceBounds(
    { x: 10, y: 70, z: 10 },
    { x: 15, y: 75, z: 15 }
  )

  assert.equal(
    workspaceContainsPoint(outer, { x: 10, y: 70, z: 10 }),
    true
  )
  assert.equal(workspaceContainsBounds(outer, inner), true)
  assert.equal(workspacesIntersect(outer, touching), true)
})

test('workspace contracts preserve custom labels without inventing behavior authority', () => {
  const selection = WorkspaceSelectionSchema.parse({
    id: 'selection-1',
    generation: 1,
    worldKey: 'localhost:25565',
    dimension: 'overworld',
    playerId: 'player-1',
    playerName: 'Boss',
    pointA: { x: 0, y: 64, z: 0 },
    pointB: { x: 8, y: 64, z: 8 },
    selectedAt: 10
  })

  const region = WorkspaceRegionSchema.parse({
    id: 'workspace-fast-furnace',
    worldKey: selection.worldKey,
    dimension: selection.dimension,
    bounds: normalizeWorkspaceBounds(
      selection.pointA,
      selection.pointB
    ),
    label: '快速熔爐',
    purpose: 'production',
    moxueUsePolicy: 'shared',
    status: 'active',
    tags: ['smelting', 'high-throughput'],
    constraints: {
      preserveExistingStructures: true
    },
    ownerPrincipal: selection.playerId,
    sourceSelectionId: selection.id,
    createdAt: 20,
    updatedAt: 20
  })

  assert.equal(region.label, '快速熔爐')
  assert.equal(region.purpose, 'production')
  assert.equal(region.moxueUsePolicy, 'shared')
  assert.deepEqual(region.tags, ['smelting', 'high-throughput'])
})

test('workspace bounds reject reversed or unbounded spans', () => {
  assert.equal(
    WorkspaceBoundsSchema.safeParse({
      min: { x: 10, y: 64, z: 10 },
      max: { x: 0, y: 64, z: 0 }
    }).success,
    false
  )

  assert.equal(
    WorkspaceBoundsSchema.safeParse({
      min: { x: 0, y: 64, z: 0 },
      max: { x: 9000, y: 64, z: 0 }
    }).success,
    false
  )
})
