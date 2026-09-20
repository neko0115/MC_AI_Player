import type {
  WorkspaceAuditInput,
  WorkspaceAuditRecord,
  WorkspaceRegion,
  WorkspaceRegionInput,
  WorkspaceSearchQuery,
  WorkspaceStatus
} from './contracts.js'

export interface WorkspaceRepository {
  create(
    input: WorkspaceRegionInput,
    audit?: WorkspaceAuditInput
  ): WorkspaceRegion

  update(
    id: string,
    input: WorkspaceRegionInput,
    audit?: WorkspaceAuditInput
  ): WorkspaceRegion | null

  setStatus(
    id: string,
    status: WorkspaceStatus,
    audit: WorkspaceAuditInput
  ): WorkspaceRegion | null

  get(id: string): WorkspaceRegion | null
  search(query: WorkspaceSearchQuery): WorkspaceRegion[]

  listAudit(
    workspaceId: string,
    limit?: number
  ): WorkspaceAuditRecord[]

  /**
   * Low-level physical purge for future dependency-safe maintenance only.
   * User-facing "delete" must use lifecycle archive instead.
   */
  delete(id: string): boolean

  close(): void
}
