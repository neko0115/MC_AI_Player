import type {
  WorkspaceChatRouteResult
} from './chat-router.js'
import type {
  WorkspaceRegion
} from './contracts.js'

const MAX_LABEL_LENGTH = 36
const MAX_CANDIDATE_LABELS = 3

export function formatWorkspaceChatReply(
  result: WorkspaceChatRouteResult
): string | null {
  switch (result.kind) {
    case 'fallback':
      return null

    case 'rejected':
      return '這個區域操作目前無法安全完成。'

    case 'clarify':
      return formatClarification(result)

    case 'handled':
      return formatHandled(result)
  }
}

function formatClarification(
  result: Extract<
    WorkspaceChatRouteResult,
    { kind: 'clarify' }
  >
): string {
  switch (result.reason) {
    case 'missing_selection':
      return '請先用墨雪設定棍框選區域，再告訴我這裡要設定成什麼。'

    case 'missing_reference':
      return '我還不確定你指的是哪個區域，請說區域名稱或用設定棍重新選取。'

    case 'ambiguous_reference': {
      const candidates =
        result.candidates ?? []
      const labels =
        uniqueCandidateLabels(
          candidates
        )
      if (labels.length === 0) {
        return '我找到不只一個可能的區域，請說更明確的名稱或重新框選。'
      }
      if (
        candidates.length > 1 &&
        labels.length === 1
      ) {
        return boundedReply(
          `我找到 ${candidates.length} 個都叫「${labels[0]}」的區域。請用墨雪設定棍選其中一塊，再告訴我你指的是選到的那個。`
        )
      }
      return boundedReply(
        `我找到不只一個可能的區域：${labels.join('、')}。請告訴我是其中哪一個。`
      )
    }

    case 'missing_semantics':
      return '我知道你在說一個區域，但還不確定它的用途或使用規則，可以再說清楚一點嗎？'

    case 'ambiguous_intent':
      return '我不確定你想新增、修改還是封存這個區域，可以再說清楚一點嗎？'
  }
}

function formatHandled(
  result: Extract<
    WorkspaceChatRouteResult,
    { kind: 'handled' }
  >
): string {
  switch (result.operation) {
    case 'create':
      return result.workspace
        ? boundedReply(
            `好，我記住「${safeLabel(result.workspace.label)}」了。${usePolicySuffix(result.workspace)}`
          )
        : '好，我已記住這個區域。'

    case 'rename':
      return result.workspace
        ? boundedReply(
            `好，這個區域現在叫「${safeLabel(result.workspace.label)}」。`
          )
        : '好，區域名稱已更新。'

    case 'resize':
      return result.workspace
        ? boundedReply(
            `好，「${safeLabel(result.workspace.label)}」的範圍已改成你剛選的區域。`
          )
        : '好，區域範圍已更新。'

    case 'change_purpose':
      return result.workspace
        ? boundedReply(
            `好，「${safeLabel(result.workspace.label)}」的用途已更新。`
          )
        : '好，區域用途已更新。'

    case 'change_use_policy':
      return result.workspace
        ? boundedReply(
            `好，「${safeLabel(result.workspace.label)}」的使用規則已更新。${usePolicySuffix(result.workspace)}`
          )
        : '好，區域使用規則已更新。'

    case 'replace_tags':
      return '好，區域標籤已更新。'

    case 'change_constraints':
      return '好，區域限制條件已更新。'

    case 'archive':
      return result.workspace
        ? boundedReply(
            `好，我先把「${safeLabel(result.workspace.label)}」封存起來，不會再當成一般可用區域。`
          )
        : '好，這個區域已封存。'

    case 'restore':
      return result.workspace
        ? boundedReply(
            `好，「${safeLabel(result.workspace.label)}」已恢復使用。`
          )
        : '好，這個區域已恢復。'

    case 'show':
      return result.workspace
        ? boundedReply(
            `「${safeLabel(result.workspace.label)}」：${purposeText(result.workspace)}，${usePolicyText(result.workspace)}。`
          )
        : '我找到了這個區域。'

    case 'list': {
      const workspaces =
        result.workspaces ?? []
      if (workspaces.length === 0) {
        return '目前沒有符合條件的區域。'
      }
      const labels =
        workspaces
          .slice(0, MAX_CANDIDATE_LABELS)
          .map(workspace =>
            safeLabel(workspace.label)
          )
      const more =
        workspaces.length >
          MAX_CANDIDATE_LABELS
          ? `，另外還有 ${workspaces.length - MAX_CANDIDATE_LABELS} 個`
          : ''
      return boundedReply(
        `目前有：${labels.join('、')}${more}。`
      )
    }
  }
}

function uniqueCandidateLabels(
  candidates:
    readonly WorkspaceRegion[]
): string[] {
  const seen = new Set<string>()
  const labels: string[] = []

  for (const candidate of candidates) {
    const label =
      safeLabel(candidate.label)
    if (
      seen.has(label) ||
      label.length === 0
    ) {
      continue
    }
    seen.add(label)
    labels.push(label)
    if (
      labels.length >=
      MAX_CANDIDATE_LABELS
    ) {
      break
    }
  }

  return labels
}

function usePolicySuffix(
  workspace: WorkspaceRegion
): string {
  switch (workspace.moxueUsePolicy) {
    case 'owner_only':
      return '這是你的私人區域，我不會使用裡面的資源。'
    case 'moxue_preferred':
      return '這是你優先給我使用的區域。'
    case 'shared':
      return '這是一般共享區域。'
  }
}

function usePolicyText(
  workspace: WorkspaceRegion
): string {
  switch (workspace.moxueUsePolicy) {
    case 'owner_only':
      return '你的私人區域，墨雪不使用資源'
    case 'moxue_preferred':
      return '墨雪優先使用'
    case 'shared':
      return '一般共享'
  }
}

function purposeText(
  workspace: WorkspaceRegion
): string {
  switch (workspace.purpose) {
    case 'farm':
      return '農田'
    case 'storage':
      return '倉庫／儲存區'
    case 'production':
      return '生產區'
    case 'construction':
      return '建築區'
    case 'lighting':
      return '照明區'
    case 'protected':
      return '保護區'
    case 'transit':
      return '通行區'
    case 'custom':
      return '自訂用途'
  }
}

function safeLabel(
  value: string
): string {
  const cleaned =
    value
      .replace(
        /[\r\n\u0000-\u001f\u007f]/gu,
        ' '
      )
      .replace(/\s+/gu, ' ')
      .trim()

  if (
    cleaned.length <=
    MAX_LABEL_LENGTH
  ) {
    return cleaned
  }

  return (
    cleaned.slice(
      0,
      MAX_LABEL_LENGTH - 1
    ) + '…'
  )
}

function boundedReply(
  value: string
): string {
  const normalized =
    value
      .replace(
        /[\r\n\u0000-\u001f\u007f]/gu,
        ' '
      )
      .replace(/\s+/gu, ' ')
      .trim()

  if (normalized.length <= 256) {
    return normalized
  }

  return normalized.slice(0, 255) + '…'
}
