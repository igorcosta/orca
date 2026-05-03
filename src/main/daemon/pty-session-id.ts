import { createHash, randomUUID } from 'crypto'
import { isAbsolute, join, relative, resolve, sep } from 'path'

export type MintedSessionIdOrigin = 'deterministic' | 'explicit' | 'random-fallback'

export type MintSessionIdResult = {
  sessionId: string
  /**
   * How the id was produced:
   *  - `deterministic`: derived from (worktreeId, tabId, leafId) — the happy
   *    path that lets cold-restore survive a crash before persistence.
   *  - `explicit`: caller supplied a pre-computed sessionId (reattach path).
   *  - `random-fallback`: a daemon-host spawn did not receive tabId/leafId
   *    and had to fall back to a random UUID. Persistence still matters for
   *    this branch — it is the old behavior and re-exposes the race this
   *    design is trying to close. Logged at warn level so regressions in
   *    the renderer plumbing surface loudly.
   */
  derivedFrom: MintedSessionIdOrigin
}

/**
 * Session IDs use the format `${worktreeId}@@${suffix}` so that
 * DaemonPtyAdapter.reconcileOnStartup (see daemon-pty-adapter.ts) can
 * derive the owning worktree by splitting on the @@ separator.
 *
 * Deterministic suffix (preferred): when both `tabId` and `leafId` are
 * provided, the suffix is the first 32 bits of SHA-256(tabId || "\0" ||
 * leafId), hex-encoded. This lets a restart reach the same history
 * directory for the same (worktreeId, tabId, leafId) triple *without*
 * needing `orca-data.json` to have persisted the sessionId — closing
 * the SIGKILL-between-spawn-and-persist race that Issue #217 describes.
 *
 * Random suffix (fallback): when tabId/leafId are absent (e.g. an older
 * non-pane caller) the suffix is `randomUUID().slice(0, 8)`. This is the
 * legacy behavior; the renderer is expected to thread tabId+leafId for
 * every daemon-host spawn, so falling in here from a daemon-host code
 * path indicates a plumbing bug and is logged at warn level by callers.
 *
 * Both `pty.ts` (host-daemon spawn path) and DaemonPtyAdapter.doSpawn
 * (fallback when opts.sessionId is absent) delegate to this helper —
 * a drifted format would break cold-restore mapping and Pi overlay
 * keying.
 *
 * Collision bound: with 32 bits of suffix entropy, the birthday bound
 * for two distinct (tabId, leafId) pairs colliding within one worktree
 * is ~1 in 2^16 at ~256 pairs. Real worktrees hold O(10) panes. The
 * bound matches the pre-existing random-UUID path (also 32 bits) — no
 * regression.
 */
export function mintPtySessionId(worktreeId?: string, tabId?: string, leafId?: string): string {
  if (!worktreeId) {
    return randomUUID()
  }
  if (tabId && leafId) {
    // Why: length-prefix each field before hashing so (tabId, leafId)
    // pairs that concatenate to the same byte string but differ in where
    // the boundary falls still produce distinct digests. A plain NUL
    // separator is NOT sufficient — `hash("a\0b" + "\0" + "c")` equals
    // `hash("a" + "\0" + "b\0c")` because `createHash.update` is a
    // streaming append. Today's inputs (tabIds are `crypto.randomUUID()`,
    // leafIds are `pane:<number>`) never contain NUL, so the practical
    // risk is zero — but the design doc §7.1 calls out this property
    // explicitly, and length-prefixing is the cheapest unambiguous
    // encoding that doesn't rely on an input-alphabet invariant we'd
    // have to re-verify every time a caller changes.
    const tabBuf = Buffer.from(tabId, 'utf8')
    const leafBuf = Buffer.from(leafId, 'utf8')
    const tabLen = Buffer.alloc(4)
    tabLen.writeUInt32BE(tabBuf.length, 0)
    const leafLen = Buffer.alloc(4)
    leafLen.writeUInt32BE(leafBuf.length, 0)
    const h = createHash('sha256')
    h.update(tabLen)
    h.update(tabBuf)
    h.update(leafLen)
    h.update(leafBuf)
    const suffix = h.digest('hex').slice(0, 8)
    return `${worktreeId}@@${suffix}`
  }
  return `${worktreeId}@@${randomUUID().slice(0, 8)}`
}

/**
 * Variant that also reports how the id was produced. Use this at the
 * single mint call site in `ipc/pty.ts` so the observability log can
 * split info vs. warn appropriately.
 */
export function mintPtySessionIdWithOrigin(args: {
  worktreeId?: string
  tabId?: string
  leafId?: string
  explicitSessionId?: string
}): MintSessionIdResult {
  if (args.explicitSessionId) {
    return { sessionId: args.explicitSessionId, derivedFrom: 'explicit' }
  }
  if (args.worktreeId && args.tabId && args.leafId) {
    return {
      sessionId: mintPtySessionId(args.worktreeId, args.tabId, args.leafId),
      derivedFrom: 'deterministic'
    }
  }
  // Either worktreeId is absent (non-daemon spawn — we return a raw uuid
  // and the caller is responsible for deciding whether that's expected)
  // or tabId/leafId weren't threaded through from the renderer. The
  // second case is the one we want to hear about; callers differentiate
  // on `!!args.worktreeId` before choosing the log level.
  return {
    sessionId: mintPtySessionId(args.worktreeId, args.tabId, args.leafId),
    derivedFrom: 'random-fallback'
  }
}

/**
 * Why: `effectiveSessionId` is used as a filesystem key (Pi overlay
 * directory under app.getPath('userData')). The security property we
 * want is containment: the derived overlay path must be strictly
 * inside the userData root so a crafted IPC payload (args.sessionId
 * or args.worktreeId forwarded from the renderer) cannot make us
 * write overlay files outside userData.
 *
 * Callers pass `app.getPath('userData')` as `userDataPath`. Any
 * subpath inside userData is acceptable as a filesystem key since
 * the Pi overlay path lives deeper inside userData — enforcing
 * "id cannot escape userData" is a superset of "id cannot escape Pi
 * overlay root".
 *
 * Note: real worktreeIds are `${repo.id}::${absolutePath}` so minted
 * session ids contain `/` on POSIX and `\` on Windows. Rejecting
 * those chars outright would break every real daemon spawn with a
 * worktree. We instead compute `join(userDataPath, id)` and assert
 * the normalized result is a strict subpath — this rejects `..`
 * sequences, absolute-path injection, and NUL truncation attacks
 * without false positives on legitimate path-shaped ids.
 */
export function isSafePtySessionId(id: string, userDataPath: string): boolean {
  if (id.length === 0 || id.length > 512) {
    return false
  }
  if (id.includes('\0')) {
    return false
  }
  const resolvedRoot = resolve(userDataPath)
  const resolvedTarget = resolve(join(userDataPath, id))
  const rel = relative(resolvedRoot, resolvedTarget)
  // Why: `path.relative` can return an absolute path when the target lives
  // on a different drive or under a UNC share on Windows (e.g. relative
  // from C:\userdata to D:\evil yields "D:\evil", which does NOT start with
  // ".."). Reject any absolute result — a legitimate subpath under
  // userData always produces a relative result on every platform.
  if (rel === '' || isAbsolute(rel) || rel.startsWith('..') || rel.includes(`..${sep}`)) {
    return false
  }
  return true
}
