/* oxlint-disable max-lines */
/**
 * E2E tests for terminal scrollback persistence across clean app restarts.
 *
 * Why this suite exists:
 *   PR #461 added a 3-minute periodic interval that re-serialized every
 *   mounted TerminalPane's scrollback so an unclean exit (crash, SIGKILL)
 *   wouldn't lose in-session output. With many panes of accumulated output,
 *   each tick blocked the renderer main thread for seconds, causing visible
 *   input lag across the whole app. The periodic save was removed in favor
 *   of the out-of-process terminal daemon (PR #729). For users who don't
 *   opt into the daemon, the `beforeunload` save in App.tsx is now the
 *   *only* thing that preserves scrollback across a restart — this suite
 *   locks that behavior down so a future regression can't silently return
 *   us to "quit → empty terminal on relaunch."
 *
 * What it covers:
 *   - Scrollback survives clean quit → relaunch (primary regression test).
 *   - Tab layout (active worktree, terminal tab count) survives restart.
 *   - Idle session writes stay infrequent (catches a reintroduced frequent
 *     interval before it ships; weaker than asserting the 3-minute cadence
 *     is gone, but doesn't require a minutes-long test run).
 *
 * What it does NOT try to cover:
 *   - Main-thread input-lag improvement — machine-dependent and flaky.
 *   - Crash/SIGKILL recovery — non-daemon users now intentionally lose
 *     in-session scrollback on unclean exit; that's the tradeoff the
 *     removed periodic save represented.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { TEST_REPO_PATH_FILE } from './global-setup'
import {
  discoverActivePtyId,
  execInTerminal,
  splitActiveTerminalPane,
  waitForActiveTerminalManager,
  waitForTerminalOutput,
  waitForPaneCount,
  getTerminalContent
} from './helpers/terminal'
import {
  waitForSessionReady,
  waitForActiveWorktree,
  getActiveWorktreeId,
  getWorktreeTabs,
  ensureTerminalVisible
} from './helpers/store'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'

// Why: each test in this file does a full quit→relaunch cycle, which spawns
// two Electron instances back-to-back. Running in serial keeps the isolated
// userDataDirs from competing for the same Electron cache lock on cold start
// and keeps the failure mode interpretable when something goes wrong.
test.describe.configure({ mode: 'serial' })

/**
 * Shared bootstrap for a *first* launch: attach the seeded test repo,
 * activate its worktree, ensure a terminal is mounted, and return the
 * PTY id we can drive with `execInTerminal`.
 *
 * Why: every test in this file needs the exact same starting state on the
 * first launch. Inlining it would obscure the thing each test is actually
 * asserting about the *second* launch.
 */
async function bootstrapFirstLaunch(
  page: Page,
  repoPath: string
): Promise<{ worktreeId: string; ptyId: string }> {
  const worktreeId = await attachRepoAndOpenTerminal(page, repoPath)
  await waitForSessionReady(page)
  await waitForActiveWorktree(page)
  await ensureTerminalVisible(page)

  const hasPaneManager = await waitForActiveTerminalManager(page, 30_000)
    .then(() => true)
    .catch(() => false)
  test.skip(
    !hasPaneManager,
    'Electron automation in this environment never mounts the TerminalPane manager, so restart-persistence assertions would only fail on harness setup.'
  )
  await waitForPaneCount(page, 1, 30_000)

  const ptyId = await discoverActivePtyId(page)
  return { worktreeId, ptyId }
}

/**
 * Shared bootstrap for a *second* launch: just wait for the session to
 * restore, and confirm the previously-active worktree is the active one
 * again so downstream assertions operate against the right worktree.
 */
async function bootstrapRestoredLaunch(
  page: Page,
  expectedWorktreeId: string,
  expectedPaneCount = 1
): Promise<void> {
  await waitForSessionReady(page)
  await expect
    .poll(async () => getActiveWorktreeId(page), { timeout: 10_000 })
    .toBe(expectedWorktreeId)
  await ensureTerminalVisible(page)
  // Why: the PaneManager remounts asynchronously after session hydration. The
  // restored terminal surface is what we're about to assert against, so make
  // sure it exists before any content/layout assertion races.
  await waitForActiveTerminalManager(page, 30_000)
  await waitForPaneCount(page, expectedPaneCount, 30_000)
}

test.describe('Terminal restart persistence', () => {
  test('scrollback survives clean quit and relaunch', async (// oxlint-disable-next-line no-empty-pattern -- Playwright's second fixture arg is testInfo; the first must be an object destructure to opt out of the default fixture set.
  {}, testInfo) => {
    const repoPath = readFileSync(TEST_REPO_PATH_FILE, 'utf-8').trim()
    if (!repoPath || !existsSync(repoPath)) {
      test.skip(true, 'Global setup did not produce a seeded test repo')
      return
    }

    const session = createRestartSession(testInfo)
    let firstApp: ElectronApplication | null = null
    let secondApp: ElectronApplication | null = null

    try {
      // ── First launch ────────────────────────────────────────────────
      const firstLaunch = await session.launch()
      firstApp = firstLaunch.app
      const { worktreeId, ptyId } = await bootstrapFirstLaunch(firstLaunch.page, repoPath)

      // Why: the marker must be distinctive enough that it can't appear in the
      // restored prompt banner or a stray OSC sequence. The timestamp suffix
      // keeps it unique across retries, and the trailing newline ensures the
      // buffer snapshot contains it on a line of its own.
      const marker = `SCROLLBACK_PERSIST_${Date.now()}`
      await execInTerminal(firstLaunch.page, ptyId, `echo ${marker}`)
      await waitForTerminalOutput(firstLaunch.page, marker)

      // Why: closing the app triggers beforeunload → session.setSync, which is
      // the one remaining codepath that flushes serialized scrollback to disk
      // for non-daemon users. This is the behavior the suite is guarding.
      await session.close(firstApp)
      firstApp = null

      // ── Second launch ───────────────────────────────────────────────
      const secondLaunch = await session.launch()
      secondApp = secondLaunch.app
      await bootstrapRestoredLaunch(secondLaunch.page, worktreeId)

      // Why: buffer restore replays the serialized output through xterm.write
      // during pane mount. Poll the live terminal content rather than hitting
      // the store because the store only sees the raw saved buffer, whereas
      // restoreScrollbackBuffers can strip alt-screen sequences before write.
      await expect
        .poll(async () => (await getTerminalContent(secondLaunch.page)).includes(marker), {
          timeout: 15_000,
          message: 'Restored terminal did not contain the pre-quit scrollback marker'
        })
        .toBe(true)
    } finally {
      if (secondApp) {
        await session.close(secondApp)
      }
      if (firstApp) {
        await session.close(firstApp)
      }
      session.dispose()
    }
  })

  test('active worktree and terminal tab count survive restart', async (// oxlint-disable-next-line no-empty-pattern -- Playwright's second fixture arg is testInfo; the first must be an object destructure to opt out of the default fixture set.
  {}, testInfo) => {
    const repoPath = readFileSync(TEST_REPO_PATH_FILE, 'utf-8').trim()
    if (!repoPath || !existsSync(repoPath)) {
      test.skip(true, 'Global setup did not produce a seeded test repo')
      return
    }

    const session = createRestartSession(testInfo)
    let firstApp: ElectronApplication | null = null
    let secondApp: ElectronApplication | null = null

    try {
      // ── First launch ────────────────────────────────────────────────
      const firstLaunch = await session.launch()
      firstApp = firstLaunch.app
      const { worktreeId } = await bootstrapFirstLaunch(firstLaunch.page, repoPath)

      // Add a second terminal tab so the restart has layout state to restore
      // beyond "one default tab." createTab goes through the same store path
      // as the Cmd+T shortcut but doesn't depend on window focus timing.
      await firstLaunch.page.evaluate((worktreeId: string) => {
        const store = window.__store
        if (!store) {
          return
        }
        store.getState().createTab(worktreeId)
      }, worktreeId)

      await expect
        .poll(async () => (await getWorktreeTabs(firstLaunch.page, worktreeId)).length, {
          timeout: 5_000
        })
        .toBeGreaterThanOrEqual(2)

      const tabsBefore = await getWorktreeTabs(firstLaunch.page, worktreeId)

      await session.close(firstApp)
      firstApp = null

      // ── Second launch ───────────────────────────────────────────────
      const secondLaunch = await session.launch()
      secondApp = secondLaunch.app
      await bootstrapRestoredLaunch(secondLaunch.page, worktreeId)

      // Why: checking tab *count* (not ids) is the stable assertion — tab ids
      // are regenerated on each launch because the renderer mints them fresh,
      // while the persisted layout only carries the tab positions. Count
      // survives; id identity does not.
      await expect
        .poll(async () => (await getWorktreeTabs(secondLaunch.page, worktreeId)).length, {
          timeout: 10_000
        })
        .toBe(tabsBefore.length)
    } finally {
      if (secondApp) {
        await session.close(secondApp)
      }
      if (firstApp) {
        await session.close(firstApp)
      }
      session.dispose()
    }
  })

  test('scrollback survives quit with missing ptyId (Issue #217 regression)', async (// oxlint-disable-next-line no-empty-pattern -- Playwright's second fixture arg is testInfo; the first must be an object destructure to opt out of the default fixture set.
  {}, testInfo) => {
    // Why (design doc §7.2): this is the load-bearing test for the
    // deterministic-sessionId fix. Issue #217 failed specifically when
    // orca-data.json's `ptyId` field was empty at restore time (the
    // SIGKILL-between-spawn-and-persist window). Before the fix, the
    // renderer had no way to reach the on-disk history dir without that
    // field. After the fix, mintPtySessionId(worktreeId, tabId, leafId)
    // reproduces the same id, so the cold-restore reader finds the dir
    // anyway. We simulate the race here by mutating the persisted
    // orca-data.json between launches — deleting the ptyId field gives
    // us the exact state the old code couldn't recover from, without
    // the flakiness of racing a real SIGKILL.
    const repoPath = readFileSync(TEST_REPO_PATH_FILE, 'utf-8').trim()
    if (!repoPath || !existsSync(repoPath)) {
      test.skip(true, 'Global setup did not produce a seeded test repo')
      return
    }

    const session = createRestartSession(testInfo)
    let firstApp: ElectronApplication | null = null
    let secondApp: ElectronApplication | null = null

    try {
      // ── First launch: produce scrollback, let clean quit flush state ──
      const firstLaunch = await session.launch()
      firstApp = firstLaunch.app
      const { worktreeId, ptyId } = await bootstrapFirstLaunch(firstLaunch.page, repoPath)

      const marker = `DETERMINISTIC_RESTORE_${Date.now()}`
      await execInTerminal(firstLaunch.page, ptyId, `echo ${marker}`)
      await waitForTerminalOutput(firstLaunch.page, marker)

      await session.close(firstApp)
      firstApp = null

      // Simulate the SIGKILL-before-persist race: strip ptyId from every
      // tab in the persisted session. The terminal-history/ dir stays on
      // disk (it was written by the daemon's checkpoint tick, not by
      // orca-data.json). Pre-fix code would fail to find it; post-fix
      // code re-derives the id from (worktreeId, tabId, leafId) and
      // hits the same directory.
      const dataFile = join(session.userDataDir, 'orca-data.json')
      const data = JSON.parse(readFileSync(dataFile, 'utf-8')) as {
        workspaceSession?: {
          tabsByWorktree?: Record<string, { ptyId: string | null }[]>
        }
      }
      const tabs = data.workspaceSession?.tabsByWorktree?.[worktreeId] ?? []
      for (const tab of tabs) {
        tab.ptyId = null
      }
      writeFileSync(dataFile, JSON.stringify(data))

      // ── Second launch: deterministic path must recover scrollback ────
      const secondLaunch = await session.launch()
      secondApp = secondLaunch.app
      await bootstrapRestoredLaunch(secondLaunch.page, worktreeId)

      await expect
        .poll(async () => (await getTerminalContent(secondLaunch.page)).includes(marker), {
          timeout: 15_000,
          message:
            'Deterministic-sessionId restore did not recover scrollback when ptyId was missing'
        })
        .toBe(true)
    } finally {
      if (secondApp) {
        await session.close(secondApp)
      }
      if (firstApp) {
        await session.close(firstApp)
      }
      session.dispose()
    }
  })

  test('2-pane split: both panes restore their scrollback after quit', async (// oxlint-disable-next-line no-empty-pattern -- Playwright's second fixture arg is testInfo; the first must be an object destructure to opt out of the default fixture set.
  {}, testInfo) => {
    // Why (design doc §7.2): the multi-pane path is distinct from single-pane
    // because each pane derives its sessionId from its own leafId via
    // mintPtySessionId(worktreeId, tabId, leafId). A bug in the leafId arm of
    // the derivation (e.g. the renderer forgets to thread leafId so every
    // pane collapses to the tab-level random fallback) would pass the
    // single-pane test and silently regress the split case. This test
    // produces a distinct marker in each pane, quits, and requires both
    // markers to be restored after relaunch.
    const repoPath = readFileSync(TEST_REPO_PATH_FILE, 'utf-8').trim()
    if (!repoPath || !existsSync(repoPath)) {
      test.skip(true, 'Global setup did not produce a seeded test repo')
      return
    }

    const session = createRestartSession(testInfo)
    let firstApp: ElectronApplication | null = null
    let secondApp: ElectronApplication | null = null

    try {
      // ── First launch ────────────────────────────────────────────────
      const firstLaunch = await session.launch()
      firstApp = firstLaunch.app
      const { worktreeId, ptyId: firstPtyId } = await bootstrapFirstLaunch(
        firstLaunch.page,
        repoPath
      )

      const markerA = `SPLIT_PANE_A_${Date.now()}`
      await execInTerminal(firstLaunch.page, firstPtyId, `echo ${markerA}`)
      await waitForTerminalOutput(firstLaunch.page, markerA)

      // Split vertically — a new pane is created with its own ptyId
      await splitActiveTerminalPane(firstLaunch.page, 'vertical')
      await waitForPaneCount(firstLaunch.page, 2, 15_000)
      // Why: splitActiveTerminalPane makes the new pane active, so the next
      // discoverActivePtyId returns the *new* pane's pty.
      const secondPtyId = await discoverActivePtyId(firstLaunch.page)
      expect(secondPtyId).not.toBe(firstPtyId)

      const markerB = `SPLIT_PANE_B_${Date.now()}`
      await execInTerminal(firstLaunch.page, secondPtyId, `echo ${markerB}`)
      await waitForTerminalOutput(firstLaunch.page, markerB)

      await session.close(firstApp)
      firstApp = null

      // ── Second launch ───────────────────────────────────────────────
      const secondLaunch = await session.launch()
      secondApp = secondLaunch.app
      await bootstrapRestoredLaunch(secondLaunch.page, worktreeId, 2)

      // Both markers must be present in the restored terminal content.
      // getTerminalContent returns content of the active pane only, so we
      // check whether the combined content across panes contains both.
      await expect
        .poll(
          async () => {
            const content = await secondLaunch.page.evaluate(() => {
              const managers = window.__paneManagers
              if (!managers) {
                return ''
              }
              const allText: string[] = []
              for (const manager of managers.values()) {
                const panes = manager.getPanes?.() ?? []
                for (const pane of panes) {
                  // Why: Terminal.buffer.active.getLine(n).translateToString()
                  // joined across the visible viewport gives us the rendered
                  // text regardless of which pane is currently focused.
                  const term = (
                    pane as {
                      terminal?: {
                        buffer?: {
                          active?: {
                            length: number
                            getLine: (
                              n: number
                            ) => { translateToString: (trim?: boolean) => string } | undefined
                          }
                        }
                      }
                    }
                  ).terminal
                  const buf = term?.buffer?.active
                  if (!buf) {
                    continue
                  }
                  for (let i = 0; i < buf.length; i++) {
                    const line = buf.getLine(i)?.translateToString(true)
                    if (line) {
                      allText.push(line)
                    }
                  }
                }
              }
              return allText.join('\n')
            })
            return content.includes(markerA) && content.includes(markerB)
          },
          {
            timeout: 20_000,
            message: 'Split-pane restore did not recover both per-pane markers'
          }
        )
        .toBe(true)
    } finally {
      if (secondApp) {
        await session.close(secondApp)
      }
      if (firstApp) {
        await session.close(firstApp)
      }
      session.dispose()
    }
  })

  // Why: the cold-restore-miss warn signal (design doc §9) is covered by the
  // unit test in src/main/daemon/daemon-pty-adapter.test.ts (
  // "warns when an explicit sessionId produces a new daemon session with no
  // disk history"). That's the right granularity for asserting a log-line
  // contract — an e2e-scale repro was attempted but Playwright's
  // _electron.launch reliably captures only a small subset of main-process
  // console output, which made the assertion flaky despite the production
  // code path firing correctly.

  test('idle session does not spam session.set writes', async (// oxlint-disable-next-line no-empty-pattern -- Playwright's second fixture arg is testInfo; the first must be an object destructure to opt out of the default fixture set.
  {}, testInfo) => {
    const repoPath = readFileSync(TEST_REPO_PATH_FILE, 'utf-8').trim()
    if (!repoPath || !existsSync(repoPath)) {
      test.skip(true, 'Global setup did not produce a seeded test repo')
      return
    }

    const session = createRestartSession(testInfo)
    let app: ElectronApplication | null = null

    try {
      const { app: launchedApp, page } = await session.launch()
      app = launchedApp
      await bootstrapFirstLaunch(page, repoPath)

      // Why: the periodic scrollback save that this branch removes was a
      // `session.set` call on every tick. Counting `session.set` calls over a
      // short idle window is a cheap proxy for "no high-frequency background
      // writer was reintroduced." The 10s window intentionally stays below the
      // per-test budget; the threshold is deliberately loose so normal user-
      // driven store activity (tab auto-create, worktree activation) doesn't
      // flake the test, while still catching an interval that fires every
      // couple of seconds.
      const callCount = await page.evaluate(async () => {
        const api = (
          window as unknown as { api: { session: { set: (...args: unknown[]) => unknown } } }
        ).api
        let count = 0
        const originalSet = api.session.set.bind(api.session)
        api.session.set = (...args: unknown[]) => {
          count += 1
          return originalSet(...args)
        }
        await new Promise((resolve) => setTimeout(resolve, 10_000))
        api.session.set = originalSet
        return count
      })

      expect(callCount).toBeLessThan(20)
    } finally {
      if (app) {
        await session.close(app)
      }
      session.dispose()
    }
  })
})
