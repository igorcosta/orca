/**
 * Orphan history reaper.
 *
 * Why: with the deterministic-sessionId path in place
 * (`mintPtySessionId(worktreeId, tabId, leafId)`), cold-restore now maps a
 * fresh post-restart PTY to the same `terminal-history/<encodedId>/` dir as
 * before the crash. The tradeoff is that session-id persistence is no longer
 * the gate for reachability — a deterministic id may point at a history dir
 * whose owning pane was permanently closed before persistence landed, and
 * nothing in the lifecycle will ever clean that dir up. Without a reaper,
 * the `terminal-history/` tree grows unboundedly over time.
 *
 * This pass is intentionally conservative — the single most important
 * invariant is **never delete a history dir whose pane still exists, even if
 * the workspace-session persistence failed to list it this launch.** Two
 * guards stack on top of the keep set:
 *
 *   1. mtime gate: skip any dir whose on-disk mtime is newer than
 *      `REAP_MTIME_GRACE_MS` (30 days). A live PTY writes checkpoint.json
 *      frequently, so anything fresh is in use (or very recently was).
 *
 *   2. two-launch quarantine: we record every orphan candidate in a sidecar
 *      (`reaper-seen.json`) along with the first launch counter that saw it,
 *      and only delete on the Nth launch where N >= REAP_QUARANTINE_LAUNCHES
 *      after that. So a transient keep-set miss on one launch (e.g. a
 *      corrupted workspace-session file, a worker that failed to persist)
 *      simply defers deletion by a launch; it cannot reap data the user
 *      still wants on the next boot.
 *
 * The sidecar lives *sibling* to `terminal-history/` in userData so that
 * clearing terminal-history to recover from a bug does not also clear the
 * reaper's memory (which would put every surviving dir immediately at
 * launchN and re-start the quarantine clock).
 *
 * Corrupt sidecar → we treat it as "nothing seen yet" — extra quarantine,
 * never premature reap. Filesystem errors anywhere in the walk are logged
 * and swallowed; the reaper is a best-effort disk-hygiene pass and must
 * never crash startup.
 */
import { join } from 'path'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'fs'
import { getHistorySessionDirName } from './history-paths'
import { mintPtySessionId } from './pty-session-id'
import type { TerminalPaneLayoutNode, WorkspaceSessionState } from '../../shared/types'

/** 30 days. Any history dir with an mtime newer than this is assumed to
 *  belong to a pane that was live recently enough that the reaper should
 *  not touch it, regardless of keep-set membership. */
export const REAP_MTIME_GRACE_MS = 30 * 24 * 60 * 60 * 1000

/** Two distinct launches must see the same orphan before it becomes
 *  eligible for deletion. A launch that persists the workspace session
 *  before crashing would set the counter back to "never seen" for every
 *  still-referenced dir, so REAP_QUARANTINE_LAUNCHES >= 2 means a single
 *  bad launch cannot cost us anything the user still wants. */
export const REAP_QUARANTINE_LAUNCHES = 2

const SIDECAR_FILENAME = 'reaper-seen.json'

type SidecarV1 = {
  version: 1
  launchCounter: number
  /** sessionId → { firstSeenLaunchN: number } */
  seen: Record<string, { firstSeenLaunchN: number }>
}

type ReaperInputs = {
  /** Absolute path to `<userData>/terminal-history`. Passed from
   *  `getHistoryDir()` rather than recomputed so tests can override. */
  historyBasePath: string
  /** Parent of `terminal-history/` — the sidecar lives *here*, not
   *  inside `terminal-history/`, so wiping history for recovery does
   *  not also erase the quarantine state. */
  sidecarDir: string
  /** Current workspace session (from `store.getWorkspaceSession()`).
   *  The reaper derives the deterministic keep set from this. */
  workspaceSession: WorkspaceSessionState
  /** Session IDs that the daemon currently reports as live. Always kept. */
  liveDaemonSessionIds: Iterable<string>
  /** Clock injection for tests. Defaults to `Date.now`. */
  now?: () => number
}

export type ReapStats = {
  scanned: number
  keptByKeepSet: number
  keptByMtimeGrace: number
  keptByQuarantine: number
  reaped: number
  errors: number
}

/**
 * Run the orphan reaper once. Safe to call unconditionally at startup even
 * if `historyBasePath` does not exist yet (first launch) — the function
 * treats a missing directory as "nothing to scan".
 */
export async function runOrphanHistoryReaper(inputs: ReaperInputs): Promise<ReapStats> {
  const now = inputs.now ?? Date.now
  const stats: ReapStats = {
    scanned: 0,
    keptByKeepSet: 0,
    keptByMtimeGrace: 0,
    keptByQuarantine: 0,
    reaped: 0,
    errors: 0
  }

  if (!existsSync(inputs.historyBasePath)) {
    return stats
  }

  const keep = buildKeepSet(inputs.workspaceSession, inputs.liveDaemonSessionIds)

  const sidecarPath = join(inputs.sidecarDir, SIDECAR_FILENAME)
  const sidecar = loadSidecar(sidecarPath)
  sidecar.launchCounter += 1

  let entries: string[]
  try {
    entries = readdirSync(inputs.historyBasePath)
  } catch (err) {
    console.warn('[history-reaper] failed to read history dir:', err)
    stats.errors += 1
    persistSidecar(sidecarPath, sidecar, inputs.sidecarDir)
    return stats
  }

  // Why: track which sessionIds we saw this launch so we can prune sidecar
  // entries that have since been deleted or restored to the keep set —
  // otherwise `seen` grows without bound across the lifetime of the app.
  const seenThisLaunch = new Set<string>()

  for (const entry of entries) {
    stats.scanned += 1
    const dirPath = join(inputs.historyBasePath, entry)
    let sessionId: string
    try {
      sessionId = decodeURIComponent(entry)
    } catch {
      // Malformed dir name (not produced by getHistorySessionDirName). Leave
      // alone — we only touch dirs whose name round-trips through
      // encode/decodeURIComponent cleanly.
      continue
    }
    // Defensive: require the round-trip encoding matches exactly. Anything
    // else could be an unrelated directory that shares the parent path.
    if (getHistorySessionDirName(sessionId) !== entry) {
      continue
    }

    if (keep.has(sessionId)) {
      stats.keptByKeepSet += 1
      // Drop any quarantine state — a previously-orphaned id that reappeared
      // in the keep set should start from zero if it ever orphans again.
      delete sidecar.seen[sessionId]
      continue
    }

    let mtimeMs: number
    try {
      mtimeMs = statSync(dirPath).mtimeMs
    } catch (err) {
      console.warn('[history-reaper] stat failed for', entry, err)
      stats.errors += 1
      continue
    }
    if (now() - mtimeMs < REAP_MTIME_GRACE_MS) {
      stats.keptByMtimeGrace += 1
      // Still update the quarantine counter so that when the mtime grace
      // eventually lapses the two-launch timer is already running.
      recordSeen(sidecar, sessionId, seenThisLaunch)
      continue
    }

    const seenEntry = sidecar.seen[sessionId]
    if (!seenEntry) {
      recordSeen(sidecar, sessionId, seenThisLaunch)
      stats.keptByQuarantine += 1
      continue
    }
    seenThisLaunch.add(sessionId)
    const launchesSinceSeen = sidecar.launchCounter - seenEntry.firstSeenLaunchN
    if (launchesSinceSeen < REAP_QUARANTINE_LAUNCHES) {
      stats.keptByQuarantine += 1
      continue
    }

    // All three gates (keep set, mtime grace, two-launch quarantine) cleared.
    try {
      rmSync(dirPath, { recursive: true, force: true })
      stats.reaped += 1
      delete sidecar.seen[sessionId]
    } catch (err) {
      console.warn('[history-reaper] rm failed for', entry, err)
      stats.errors += 1
    }
  }

  // Prune sidecar entries for sessions that no longer have an on-disk dir
  // (deleted outside the reaper) or that turned out to be in the keep set.
  for (const id of Object.keys(sidecar.seen)) {
    if (!seenThisLaunch.has(id)) {
      delete sidecar.seen[id]
    }
  }

  persistSidecar(sidecarPath, sidecar, inputs.sidecarDir)
  return stats
}

function recordSeen(sidecar: SidecarV1, sessionId: string, seenThisLaunch: Set<string>): void {
  if (!sidecar.seen[sessionId]) {
    sidecar.seen[sessionId] = { firstSeenLaunchN: sidecar.launchCounter }
  }
  seenThisLaunch.add(sessionId)
}

/**
 * Build the union of all sessionIds that should be preserved this launch:
 *
 *  - Every ptyId stored on a terminal tab (legacy ptyId field) or inside
 *    a persisted pane-layout snapshot (ptyIdsByLeafId). These are verbatim
 *    session ids that survived the previous app run.
 *
 *  - remoteSessionIdsByTabId — defensive keep for SSH-hosted sessions
 *    whose ids don't match the `worktreeId@@suffix` pattern.
 *
 *  - Deterministic ids derived from every (worktreeId, tabId, leafId) triple
 *    reachable through the workspace session. This is the critical entry:
 *    it protects history dirs whose verbatim ptyId never got persisted
 *    (the SIGKILL-between-spawn-and-persist window the fix is closing).
 *
 *  - Live daemon session ids from the reconciled adapter.
 */
function buildKeepSet(
  session: WorkspaceSessionState,
  liveDaemonSessionIds: Iterable<string>
): Set<string> {
  const keep = new Set<string>()

  for (const id of liveDaemonSessionIds) {
    keep.add(id)
  }

  for (const tabs of Object.values(session.tabsByWorktree ?? {})) {
    for (const tab of tabs) {
      if (tab.ptyId) {
        keep.add(tab.ptyId)
      }
    }
  }

  for (const [tabId, layout] of Object.entries(session.terminalLayoutsByTabId ?? {})) {
    if (!layout) {
      continue
    }
    for (const ptyId of Object.values(layout.ptyIdsByLeafId ?? {})) {
      keep.add(ptyId)
    }
    // Deterministic derivation: for every pane leaf we know how to reach
    // through the persisted layout tree, compute the id mintPtySessionId
    // would produce for (worktreeId, tabId, leafId) and keep it. We need
    // the worktreeId for this — look it up via the tab record so the keep
    // set survives even if the tab's ptyId slot is empty.
    const worktreeId = findWorktreeIdForTab(session, tabId)
    if (!worktreeId) {
      continue
    }
    for (const leafId of collectLeafIdsFromLayoutRoot(layout.root)) {
      keep.add(mintPtySessionId(worktreeId, tabId, leafId))
    }
  }

  for (const remoteId of Object.values(session.remoteSessionIdsByTabId ?? {})) {
    if (remoteId) {
      keep.add(remoteId)
    }
  }

  return keep
}

function findWorktreeIdForTab(session: WorkspaceSessionState, tabId: string): string | undefined {
  for (const [worktreeId, tabs] of Object.entries(session.tabsByWorktree ?? {})) {
    if (tabs.some((t) => t.id === tabId)) {
      return worktreeId
    }
  }
  return undefined
}

function collectLeafIdsFromLayoutRoot(node: TerminalPaneLayoutNode | null): string[] {
  if (!node) {
    return []
  }
  if (node.type === 'leaf') {
    return [node.leafId]
  }
  return [...collectLeafIdsFromLayoutRoot(node.first), ...collectLeafIdsFromLayoutRoot(node.second)]
}

function loadSidecar(sidecarPath: string): SidecarV1 {
  const empty: SidecarV1 = { version: 1, launchCounter: 0, seen: {} }
  if (!existsSync(sidecarPath)) {
    return empty
  }
  try {
    const raw = JSON.parse(readFileSync(sidecarPath, 'utf-8')) as Partial<SidecarV1>
    if (
      raw &&
      raw.version === 1 &&
      typeof raw.launchCounter === 'number' &&
      raw.seen &&
      typeof raw.seen === 'object'
    ) {
      return {
        version: 1,
        launchCounter: raw.launchCounter,
        seen: { ...raw.seen }
      }
    }
  } catch (err) {
    console.warn('[history-reaper] sidecar unreadable, resetting:', err)
  }
  // Corrupt sidecar → start over. That resets the quarantine clock for
  // every current orphan, which is the safe direction (one extra launch
  // of quarantine beats one premature reap).
  return empty
}

function persistSidecar(sidecarPath: string, sidecar: SidecarV1, sidecarDir: string): void {
  try {
    mkdirSync(sidecarDir, { recursive: true })
    writeFileSync(sidecarPath, JSON.stringify(sidecar), { mode: 0o600 })
  } catch (err) {
    console.warn('[history-reaper] sidecar write failed:', err)
  }
}
