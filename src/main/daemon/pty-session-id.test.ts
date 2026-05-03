import { describe, expect, it } from 'vitest'
import { isSafePtySessionId, mintPtySessionId, mintPtySessionIdWithOrigin } from './pty-session-id'

const USER_DATA = '/tmp/orca-userdata'

describe('mintPtySessionId', () => {
  it('returns a UUID when no worktreeId is provided', () => {
    const id = mintPtySessionId()
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })

  it('prefixes the worktreeId and suffixes an 8-char hex tag', () => {
    const id = mintPtySessionId('wt-alpha')
    expect(id).toMatch(/^wt-alpha@@[0-9a-f]{8}$/)
  })

  it('preserves path-shaped worktreeIds verbatim in the prefix', () => {
    // Why: real worktreeIds are `${repo.id}::${absolutePath}` and contain
    // slashes. The mint must not rewrite or sanitize them — reconcileOnStartup
    // splits on `@@` to recover the worktreeId.
    const id = mintPtySessionId('repo-123::/Users/me/work/wt-1')
    expect(id).toMatch(/^repo-123::\/Users\/me\/work\/wt-1@@[0-9a-f]{8}$/)
  })

  it('derives a deterministic suffix from (worktreeId, tabId, leafId)', () => {
    // Why: cold-restore after a SIGKILL-between-spawn-and-persist only
    // works when re-minting the id for the same pane triple produces the
    // same 8-char suffix — otherwise the post-restart PTY lands on a
    // fresh history directory and scrollback is lost.
    const a = mintPtySessionId('wt-alpha', 'tab-xyz', 'pane:3')
    const b = mintPtySessionId('wt-alpha', 'tab-xyz', 'pane:3')
    expect(a).toBe(b)
    expect(a).toMatch(/^wt-alpha@@[0-9a-f]{8}$/)
  })

  it('does not collide across sibling panes in the same tab', () => {
    // Why: two live panes in the same tab must map to distinct history
    // dirs so their scrollback files do not interleave. Collision is a
    // correctness bug, not a performance concern.
    const p1 = mintPtySessionId('wt-alpha', 'tab-xyz', 'pane:1')
    const p2 = mintPtySessionId('wt-alpha', 'tab-xyz', 'pane:2')
    expect(p1).not.toBe(p2)
  })

  it('does not collide across sibling tabs in the same worktree', () => {
    const a = mintPtySessionId('wt-alpha', 'tab-a', 'pane:1')
    const b = mintPtySessionId('wt-alpha', 'tab-b', 'pane:1')
    expect(a).not.toBe(b)
  })

  it('falls back to a random suffix when tabId is absent', () => {
    // Why: the deterministic path requires BOTH tabId and leafId. A
    // missing piece must degrade to the legacy random-suffix behavior —
    // never silently produce a "deterministic-looking" but empty-input
    // digest that would collide across every tabId-less caller.
    const a = mintPtySessionId('wt-alpha', undefined, 'pane:1')
    const b = mintPtySessionId('wt-alpha', undefined, 'pane:1')
    expect(a).not.toBe(b)
    expect(a).toMatch(/^wt-alpha@@[0-9a-f]{8}$/)
  })

  it('falls back to a random suffix when leafId is absent', () => {
    const a = mintPtySessionId('wt-alpha', 'tab-xyz', undefined)
    const b = mintPtySessionId('wt-alpha', 'tab-xyz', undefined)
    expect(a).not.toBe(b)
  })

  it('distinguishes (tabId="a\\0b", leafId="c") from (tabId="a", leafId="b\\0c")', () => {
    // Why: the design doc §7.1 calls this out explicitly. A plain NUL
    // separator is insufficient because `hash("a\0b" + "\0" + "c")`
    // equals `hash("a" + "\0" + "b\0c")` — the mint uses length-prefixed
    // encoding so the boundary between tabId and leafId is recoverable
    // from the byte stream. Losing this distinction would collapse two
    // distinct panes onto one history dir.
    const a = mintPtySessionId('wt-alpha', 'a\x00b', 'c')
    const b = mintPtySessionId('wt-alpha', 'a', 'b\x00c')
    expect(a).not.toBe(b)
  })

  it('distinguishes siblings that concat to the same string via length prefix', () => {
    // Why: the primary correctness guarantee of length-prefix encoding.
    // ("ab", "cd") and ("a", "bcd") both produce the byte string "abcd"
    // if you just concatenate; with length-prefixed hashing they must
    // still hash differently.
    const a = mintPtySessionId('wt-alpha', 'ab', 'cd')
    const b = mintPtySessionId('wt-alpha', 'a', 'bcd')
    expect(a).not.toBe(b)
  })

  it('has zero collisions across 1000 sibling (tabId, leafId) pairs', () => {
    // Why: 8 hex chars = 32 bits ≈ 1 in 4B per pair; with 1000 pairs the
    // birthday-paradox expected collisions is <<1. A collision here means
    // our hash implementation is broken (e.g. truncating before hashing),
    // not just an unlucky draw.
    const seen = new Set<string>()
    for (let t = 0; t < 100; t++) {
      for (let p = 0; p < 10; p++) {
        const id = mintPtySessionId('wt-alpha', `tab-${t}`, `pane:${p}`)
        expect(seen.has(id)).toBe(false)
        seen.add(id)
      }
    }
    expect(seen.size).toBe(1000)
  })
})

describe('mintPtySessionIdWithOrigin', () => {
  it('reports `explicit` when the caller supplies a session id verbatim', () => {
    const r = mintPtySessionIdWithOrigin({ explicitSessionId: 'sess-preexisting' })
    expect(r.sessionId).toBe('sess-preexisting')
    expect(r.derivedFrom).toBe('explicit')
  })

  it('reports `deterministic` when (worktreeId, tabId, leafId) are all present', () => {
    const r = mintPtySessionIdWithOrigin({
      worktreeId: 'wt-alpha',
      tabId: 'tab-xyz',
      leafId: 'pane:3'
    })
    expect(r.derivedFrom).toBe('deterministic')
    expect(r.sessionId).toMatch(/^wt-alpha@@[0-9a-f]{8}$/)
  })

  it('reports `random-fallback` when worktreeId is present but tabId or leafId is missing', () => {
    // Why: this is the diagnostic signal the renderer-threading work is
    // supposed to eliminate for daemon-host spawns. The caller (ipc/pty.ts)
    // escalates this to a warn log so a plumbing regression surfaces
    // without silently reintroducing the race.
    const r = mintPtySessionIdWithOrigin({ worktreeId: 'wt-alpha', leafId: 'pane:1' })
    expect(r.derivedFrom).toBe('random-fallback')
    expect(r.sessionId).toMatch(/^wt-alpha@@[0-9a-f]{8}$/)
  })

  it('reports `random-fallback` when worktreeId is absent', () => {
    const r = mintPtySessionIdWithOrigin({})
    expect(r.derivedFrom).toBe('random-fallback')
    expect(r.sessionId).toMatch(/^[0-9a-f-]{36}$/)
  })
})

describe('isSafePtySessionId', () => {
  it('accepts minted UUIDs', () => {
    expect(isSafePtySessionId(mintPtySessionId(), USER_DATA)).toBe(true)
  })

  it('accepts minted worktree-scoped ids (happy path, hyphen-only)', () => {
    expect(isSafePtySessionId(mintPtySessionId('wt-alpha'), USER_DATA)).toBe(true)
  })

  it('accepts minted ids with path-shaped worktreeIds containing slashes', () => {
    // Why: real worktreeIds are `${repo.id}::${absolutePath}`, so the minted
    // sessionId contains `/` in its prefix. A char-denylist validator that
    // rejected `/` would break every real daemon spawn.
    const id = mintPtySessionId('repo-abc123::/Users/thebr/work/wt-1')
    expect(isSafePtySessionId(id, USER_DATA)).toBe(true)
  })

  it('accepts caller-supplied path-shaped ids that stay inside userData', () => {
    expect(isSafePtySessionId('some-repo::/Users/me/wt/abc@@deadbeef', USER_DATA)).toBe(true)
  })

  it('rejects empty string', () => {
    expect(isSafePtySessionId('', USER_DATA)).toBe(false)
  })

  it('rejects ids longer than 512 characters', () => {
    expect(isSafePtySessionId('a'.repeat(513), USER_DATA)).toBe(false)
  })

  it('rejects ids containing a NUL byte', () => {
    expect(isSafePtySessionId('safe\0evil', USER_DATA)).toBe(false)
  })

  it('rejects ids that traverse out of userData via ..', () => {
    expect(isSafePtySessionId('../etc/passwd', USER_DATA)).toBe(false)
  })

  it('rejects ids that traverse out of userData via deep ..', () => {
    expect(isSafePtySessionId('sub/../../etc/passwd', USER_DATA)).toBe(false)
  })

  it('rejects ids that resolve to the userData root itself', () => {
    // Why: if id resolves to `.` (the root), callers could overwrite userData
    // meta files. Guard ensures the target is a strict subpath.
    expect(isSafePtySessionId('.', USER_DATA)).toBe(false)
  })

  it('accepts ids with nested valid path segments inside userData', () => {
    // Why: minted ids can contain `/` (from worktreeId::absolute-path) so the
    // validator must allow that as long as the result stays inside userData.
    expect(isSafePtySessionId('sub/path/ok@@12345678', USER_DATA)).toBe(true)
  })
})
