import type {
  WorkspaceRegion,
  WorkspaceRegionInput,
  WorkspaceSearchQuery
} from './contracts.js'

export interface WorkspaceRepository {
  create(input: WorkspaceRegionInput): WorkspaceRegion
  update(
    id: string,
    input: WorkspaceRegionInput
  ): WorkspaceRegion | null
  get(id: string): WorkspaceRegion | null
  search(query: WorkspaceSearchQuery): WorkspaceRegion[]
  delete(id: string): boolean
  close(): void
}
