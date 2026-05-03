/* oxlint-disable max-lines -- Why: these tests cover the full reaper
decision matrix (keep set, mtime gate, two-launch quarantine, edge
cases) in one place so a regression anywhere trips a single suite. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { getHistorySessionDirName } from './history-paths'
import { mintPtySessionId } from './pty-session-id'
import {
  REAP_MTIME_GRACE_MS,
  REAP_QUARANTINE_LAUNCHES,
  runOrphanHistoryReaper
} from './orphan-history-reaper'
import type { WorkspaceSessionState } from '../../shared/types'

function freshTmp(): { sidecarDir: string; historyBasePath: string; cleanup: () => void } {
  const sidecarDir = mkdtempSync(join(tmpdir(), 'orca-reaper-'))
  const historyBasePath = join(sidecarDir, 'terminal-history')
  mkdirSync(historyBasePath, { recursive: true })
  return {
    sidecarDir,
    historyBasePath,
    cleanup: () => rmSync(sidecarDir, { recursive: true, force: true })
  }
}

// Helper: create a session dir with a synthetic mtime by writing a file and
// then reaching back in time. Returns the directory path.
function makeSessionDir(
  historyBasePath: string,
  sessionId: string,
  opts?: { ageMs?: number }
): string {
  const dir = join(historyBasePath, getHistorySessionDirName(sessionId))
  mkdirSync(dir, { recursive: true })
  // Write something so the dir has distinct mtime semantics on all FSes.
  writeFileSync(join(dir, 'checkpoint.json'), '{}')
  if (opts?.ageMs !== undefined) {
    const ts = Date.now() - opts.ageMs
    utimesSync(dir, ts / 1000, ts / 1000)
    utimesSync(join(dir, 'checkpoint.json'), ts / 1000, ts / 1000)
  }
  return dir
}

function emptySession(overrides: Partial<WorkspaceSessionState> = {}): WorkspaceSessionState {
  return {
    activeRepoId: null,
    activeWorktreeId: null,
    activeTabId: null,
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    ...overrides
  }
}

describe('runOrphanHistoryReaper — keep set', () => {
  let tmp: ReturnType<typeof freshTmp>

  beforeEach(() => {
    tmp = freshTmp()
  })
  afterEach(() => {
    tmp.cleanup()
  })

  it('never reaps a dir whose sessionId appears in the live daemon set, even if old', async () => {
    // Why: the daemon is the ground truth for live sessions. A running PTY
    // whose workspace-session slot failed to persist must still be kept.
    const sessionId = 'wt-a@@deadbeef'
    makeSessionDir(tmp.historyBasePath, sessionId, { ageMs: REAP_MTIME_GRACE_MS + 10_000 })

    const stats = await runOrphanHistoryReaper({
      historyBasePath: tmp.historyBasePath,
      sidecarDir: tmp.sidecarDir,
      workspaceSession: emptySession(),
      liveDaemonSessionIds: [sessionId]
    })

    expect(stats.reaped).toBe(0)
    expect(stats.keptByKeepSet).toBe(1)
    expect(existsSync(join(tmp.historyBasePath, getHistorySessionDirName(sessionId)))).toBe(true)
  })

  it('keeps a dir whose sessionId is only reachable via deterministic derivation', async () => {
    // Why: this is the core correctness case — the ptyId field wasn't
    // persisted (SIGKILL-before-persist), but the layout snapshot has a
    // pane entry whose (worktreeId, tabId, leafId) still derives to the
    // right id. Without deterministic keep-set derivation, this dir would
    // be treated as orphan and eventually reaped.
    const wt = 'wt-alpha'
    const tabId = 'tab-xyz'
    const leafId = 'pane:2'
    const derivedId = mintPtySessionId(wt, tabId, leafId)
    makeSessionDir(tmp.historyBasePath, derivedId, { ageMs: REAP_MTIME_GRACE_MS + 10_000 })

    const session = emptySession({
      tabsByWorktree: {
        [wt]: [
          {
            id: tabId,
            ptyId: null,
            worktreeId: wt,
            title: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 0
          }
        ]
      },
      terminalLayoutsByTabId: {
        [tabId]: {
          root: { type: 'leaf', leafId },
          activeLeafId: null,
          expandedLeafId: null
        }
      }
    })

    const stats = await runOrphanHistoryReaper({
      historyBasePath: tmp.historyBasePath,
      sidecarDir: tmp.sidecarDir,
      workspaceSession: session,
      liveDaemonSessionIds: []
    })

    expect(stats.reaped).toBe(0)
    expect(stats.keptByKeepSet).toBe(1)
  })

  it('keeps verbatim ptyIds stored in the workspace session', async () => {
    // Why: legacy panes whose pre-restart ptyId persisted must still
    // round-trip through the reaper's keep set even after the
    // deterministic path lands — failure to keep them would surface as
    // one-time scrollback loss on the upgrade boot.
    const id = 'wt-legacy@@cafebabe'
    makeSessionDir(tmp.historyBasePath, id, { ageMs: REAP_MTIME_GRACE_MS + 10_000 })

    const session = emptySession({
      tabsByWorktree: {
        'wt-legacy': [
          {
            id: 'tab-1',
            ptyId: id,
            worktreeId: 'wt-legacy',
            title: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 0
          }
        ]
      }
    })

    const stats = await runOrphanHistoryReaper({
      historyBasePath: tmp.historyBasePath,
      sidecarDir: tmp.sidecarDir,
      workspaceSession: session,
      liveDaemonSessionIds: []
    })

    expect(stats.reaped).toBe(0)
  })

  it('keeps ptyIdsByLeafId entries verbatim', async () => {
    const id = 'wt-alpha@@abcdef12'
    makeSessionDir(tmp.historyBasePath, id, { ageMs: REAP_MTIME_GRACE_MS + 10_000 })

    const session = emptySession({
      terminalLayoutsByTabId: {
        'tab-1': {
          root: { type: 'leaf', leafId: 'pane:1' },
          activeLeafId: null,
          expandedLeafId: null,
          ptyIdsByLeafId: { 'pane:1': id }
        }
      }
    })

    const stats = await runOrphanHistoryReaper({
      historyBasePath: tmp.historyBasePath,
      sidecarDir: tmp.sidecarDir,
      workspaceSession: session,
      liveDaemonSessionIds: []
    })

    expect(stats.reaped).toBe(0)
  })

  it('keeps remote SSH session ids (arbitrary format)', async () => {
    // Why: remote session ids do not follow the `worktreeId@@suffix`
    // pattern. The reaper must not reap them just because they miss
    // every other keep-set source.
    const id = 'ssh::user@host::session-xyz'
    makeSessionDir(tmp.historyBasePath, id, { ageMs: REAP_MTIME_GRACE_MS + 10_000 })

    const session = emptySession({
      remoteSessionIdsByTabId: { 'tab-ssh': id }
    })

    const stats = await runOrphanHistoryReaper({
      historyBasePath: tmp.historyBasePath,
      sidecarDir: tmp.sidecarDir,
      workspaceSession: session,
      liveDaemonSessionIds: []
    })

    expect(stats.reaped).toBe(0)
  })
})

describe('runOrphanHistoryReaper — mtime gate', () => {
  let tmp: ReturnType<typeof freshTmp>
  beforeEach(() => {
    tmp = freshTmp()
  })
  afterEach(() => {
    tmp.cleanup()
  })

  it('never reaps a dir whose mtime is within the grace window, even if orphan', async () => {
    const id = 'wt-a@@aaaaaaaa'
    makeSessionDir(tmp.historyBasePath, id, { ageMs: REAP_MTIME_GRACE_MS - 60_000 })

    const stats = await runOrphanHistoryReaper({
      historyBasePath: tmp.historyBasePath,
      sidecarDir: tmp.sidecarDir,
      workspaceSession: emptySession(),
      liveDaemonSessionIds: []
    })

    expect(stats.reaped).toBe(0)
    expect(stats.keptByMtimeGrace).toBe(1)
  })
})

describe('runOrphanHistoryReaper — two-launch quarantine', () => {
  let tmp: ReturnType<typeof freshTmp>
  beforeEach(() => {
    tmp = freshTmp()
  })
  afterEach(() => {
    tmp.cleanup()
  })

  it('requires at least REAP_QUARANTINE_LAUNCHES elapsed launches before reaping', async () => {
    // Why: quarantine is measured in *elapsed* launches after the first
    // sighting, not sightings. So with REAP_QUARANTINE_LAUNCHES = 2, an
    // orphan first seen on launch N is reaped no earlier than launch N+2.
    // That asymmetry is deliberate: a single "dropped" launch (crash after
    // workspace-session write but before reaper pass) cannot eat a
    // surviving dir — the user has an extra boot to recover.
    expect(REAP_QUARANTINE_LAUNCHES).toBe(2)
    const id = 'wt-a@@bbbbbbbb'
    const dir = makeSessionDir(tmp.historyBasePath, id, { ageMs: REAP_MTIME_GRACE_MS + 10_000 })

    // Launch 1: firstSeenLaunchN = 1. Quarantined.
    const s1 = await runOrphanHistoryReaper({
      historyBasePath: tmp.historyBasePath,
      sidecarDir: tmp.sidecarDir,
      workspaceSession: emptySession(),
      liveDaemonSessionIds: []
    })
    expect(s1.reaped).toBe(0)
    expect(s1.keptByQuarantine).toBe(1)
    expect(existsSync(dir)).toBe(true)

    // Launch 2: launchesSinceSeen = 1. Still quarantined — the whole
    // point of the two-launch bound is "one in-flight bad run cannot
    // reap data the user still wants".
    const s2 = await runOrphanHistoryReaper({
      historyBasePath: tmp.historyBasePath,
      sidecarDir: tmp.sidecarDir,
      workspaceSession: emptySession(),
      liveDaemonSessionIds: []
    })
    expect(s2.reaped).toBe(0)
    expect(s2.keptByQuarantine).toBe(1)
    expect(existsSync(dir)).toBe(true)

    // Launch 3: launchesSinceSeen = 2. Eligible for reap.
    const s3 = await runOrphanHistoryReaper({
      historyBasePath: tmp.historyBasePath,
      sidecarDir: tmp.sidecarDir,
      workspaceSession: emptySession(),
      liveDaemonSessionIds: []
    })
    expect(s3.reaped).toBe(1)
    expect(existsSync(dir)).toBe(false)
  })

  it('resets the quarantine clock when a previously-orphaned id reappears in the keep set', async () => {
    const id = 'wt-a@@cccccccc'
    makeSessionDir(tmp.historyBasePath, id, { ageMs: REAP_MTIME_GRACE_MS + 10_000 })

    // Launch 1: orphan — records.
    await runOrphanHistoryReaper({
      historyBasePath: tmp.historyBasePath,
      sidecarDir: tmp.sidecarDir,
      workspaceSession: emptySession(),
      liveDaemonSessionIds: []
    })

    // Launch 2: id reappears in keep set (e.g. the workspace session
    // persistence that was failing is now healthy). Must NOT reap.
    const s2 = await runOrphanHistoryReaper({
      historyBasePath: tmp.historyBasePath,
      sidecarDir: tmp.sidecarDir,
      workspaceSession: emptySession(),
      liveDaemonSessionIds: [id]
    })
    expect(s2.reaped).toBe(0)
    expect(s2.keptByKeepSet).toBe(1)

    // Launch 3: id is orphaned again — the counter must have been reset,
    // so this launch re-records rather than immediately reaping.
    const s3 = await runOrphanHistoryReaper({
      historyBasePath: tmp.historyBasePath,
      sidecarDir: tmp.sidecarDir,
      workspaceSession: emptySession(),
      liveDaemonSessionIds: []
    })
    expect(s3.reaped).toBe(0)
    expect(s3.keptByQuarantine).toBe(1)
  })

  it('treats a corrupt sidecar as "nothing seen yet" (extra quarantine, never premature reap)', async () => {
    const id = 'wt-a@@dddddddd'
    const dir = makeSessionDir(tmp.historyBasePath, id, {
      ageMs: REAP_MTIME_GRACE_MS + 10_000
    })

    // Seed a corrupt sidecar that would otherwise appear to have seen
    // the id on launch 1 with counter at 10 — if we trusted it, the reaper
    // would fire immediately. We must NOT.
    writeFileSync(join(tmp.sidecarDir, 'reaper-seen.json'), '{not: "json')

    const stats = await runOrphanHistoryReaper({
      historyBasePath: tmp.historyBasePath,
      sidecarDir: tmp.sidecarDir,
      workspaceSession: emptySession(),
      liveDaemonSessionIds: []
    })
    expect(stats.reaped).toBe(0)
    expect(stats.keptByQuarantine).toBe(1)
    expect(existsSync(dir)).toBe(true)

    // Sidecar should have been rewritten with a valid JSON shape.
    const written = JSON.parse(readFileSync(join(tmp.sidecarDir, 'reaper-seen.json'), 'utf-8'))
    expect(written.version).toBe(1)
    expect(written.launchCounter).toBe(1)
  })
})

describe('runOrphanHistoryReaper — edge cases', () => {
  let tmp: ReturnType<typeof freshTmp>
  beforeEach(() => {
    tmp = freshTmp()
  })
  afterEach(() => {
    tmp.cleanup()
  })

  it('no-ops when the history directory does not exist (fresh install)', async () => {
    rmSync(tmp.historyBasePath, { recursive: true, force: true })
    const stats = await runOrphanHistoryReaper({
      historyBasePath: tmp.historyBasePath,
      sidecarDir: tmp.sidecarDir,
      workspaceSession: emptySession(),
      liveDaemonSessionIds: []
    })
    expect(stats).toEqual({
      scanned: 0,
      keptByKeepSet: 0,
      keptByMtimeGrace: 0,
      keptByQuarantine: 0,
      reaped: 0,
      errors: 0
    })
  })

  it('ignores directory entries whose names do not round-trip through encodeURIComponent', async () => {
    // A directory named literally `%` cannot be a valid minted session id
    // because decodeURIComponent('%') throws. The reaper must skip it.
    mkdirSync(join(tmp.historyBasePath, '%'), { recursive: true })
    // And a legitimate orphan alongside.
    const id = 'wt-a@@eeeeeeee'
    makeSessionDir(tmp.historyBasePath, id, { ageMs: REAP_MTIME_GRACE_MS + 10_000 })

    const stats = await runOrphanHistoryReaper({
      historyBasePath: tmp.historyBasePath,
      sidecarDir: tmp.sidecarDir,
      workspaceSession: emptySession(),
      liveDaemonSessionIds: []
    })
    // Malformed entry: not counted in keep/mtime/quarantine/reaped. Scanned
    // increments for every readdir entry.
    expect(stats.scanned).toBe(2)
    expect(existsSync(join(tmp.historyBasePath, '%'))).toBe(true)
  })
})
