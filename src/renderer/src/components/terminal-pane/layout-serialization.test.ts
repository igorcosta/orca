/* oxlint-disable max-lines -- Why: layout-serialization concentrates the
replay/snapshot/fallback-font logic and its regressions are easiest to
catch together. */
import { describe, expect, it, beforeAll } from 'vitest'
import type { TerminalPaneLayoutNode } from '../../../../shared/types'

// ---------------------------------------------------------------------------
// Provide a minimal HTMLElement so `instanceof HTMLElement` passes in Node env
// ---------------------------------------------------------------------------
class MockHTMLElement {
  classList: { contains: (cls: string) => boolean }
  dataset: Record<string, string>
  children: MockHTMLElement[]
  style: Record<string, string>
  firstElementChild: MockHTMLElement | null

  constructor(opts: {
    classList?: string[]
    dataset?: Record<string, string>
    children?: MockHTMLElement[]
    style?: Record<string, string>
    firstElementChild?: MockHTMLElement | null
  }) {
    const classes = opts.classList ?? []
    this.classList = { contains: (cls: string) => classes.includes(cls) }
    this.dataset = opts.dataset ?? {}
    this.children = opts.children ?? []
    this.style = opts.style ?? {}
    this.firstElementChild = opts.firstElementChild ?? null
  }
}

beforeAll(() => {
  // Expose globally so `child instanceof HTMLElement` works inside the module
  ;(globalThis as unknown as Record<string, unknown>).HTMLElement = MockHTMLElement
})

import {
  paneLeafId,
  buildFontFamily,
  serializePaneTree,
  serializeTerminalLayout,
  EMPTY_LAYOUT,
  collectLeafIdsInOrder,
  collectLeafIdsInReplayCreationOrder,
  replayTerminalLayout
} from './layout-serialization'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'

// ---------------------------------------------------------------------------
// Helper to create mock elements
// ---------------------------------------------------------------------------
function mockElement(opts: {
  classList?: string[]
  dataset?: Record<string, string>
  children?: MockHTMLElement[]
  style?: Record<string, string>
  firstElementChild?: MockHTMLElement | null
}): HTMLElement {
  return new MockHTMLElement(opts) as unknown as HTMLElement
}

// ---------------------------------------------------------------------------
// paneLeafId
// ---------------------------------------------------------------------------
describe('paneLeafId', () => {
  it('returns "pane:0" for paneId 0', () => {
    expect(paneLeafId(0)).toBe('pane:0')
  })

  it('returns "pane:1" for paneId 1', () => {
    expect(paneLeafId(1)).toBe('pane:1')
  })

  it('returns "pane:42" for paneId 42', () => {
    expect(paneLeafId(42)).toBe('pane:42')
  })
})

// ---------------------------------------------------------------------------
// buildFontFamily
// ---------------------------------------------------------------------------
const FULL_FALLBACK =
  '"SF Mono", "Menlo", "Monaco", "Cascadia Mono", "Consolas", "DejaVu Sans Mono", "Liberation Mono", "Symbols Nerd Font Mono", "MesloLGS Nerd Font", "JetBrainsMono Nerd Font", "Hack Nerd Font", monospace'

describe('buildFontFamily', () => {
  it('puts custom font first with full cross-platform fallback chain', () => {
    const result = buildFontFamily('JetBrains Mono')
    expect(result).toBe(`"JetBrains Mono", ${FULL_FALLBACK}`)
  })

  it('does not duplicate SF Mono when it is the input', () => {
    const result = buildFontFamily('SF Mono')
    expect(result).toBe(
      '"SF Mono", "Menlo", "Monaco", "Cascadia Mono", "Consolas", "DejaVu Sans Mono", "Liberation Mono", "Symbols Nerd Font Mono", "MesloLGS Nerd Font", "JetBrainsMono Nerd Font", "Hack Nerd Font", monospace'
    )
  })

  it('returns full fallback chain for empty string', () => {
    const result = buildFontFamily('')
    expect(result).toBe(FULL_FALLBACK)
  })

  it('treats whitespace-only string same as empty', () => {
    const result = buildFontFamily('   ')
    expect(result).toBe(FULL_FALLBACK)
  })

  it('does not duplicate when font name contains "sf mono" (case-insensitive)', () => {
    const result = buildFontFamily('My SF Mono Custom')
    expect(result).toBe(
      '"My SF Mono Custom", "Menlo", "Monaco", "Cascadia Mono", "Consolas", "DejaVu Sans Mono", "Liberation Mono", "Symbols Nerd Font Mono", "MesloLGS Nerd Font", "JetBrainsMono Nerd Font", "Hack Nerd Font", monospace'
    )
  })

  it('does not duplicate Consolas when it is the input', () => {
    const result = buildFontFamily('Consolas')
    expect(result).toBe(
      '"Consolas", "SF Mono", "Menlo", "Monaco", "Cascadia Mono", "DejaVu Sans Mono", "Liberation Mono", "Symbols Nerd Font Mono", "MesloLGS Nerd Font", "JetBrainsMono Nerd Font", "Hack Nerd Font", monospace'
    )
  })

  it('does not duplicate MesloLGS Nerd Font when it is the input', () => {
    const result = buildFontFamily('MesloLGS Nerd Font')
    expect(result).toBe(
      '"MesloLGS Nerd Font", "SF Mono", "Menlo", "Monaco", "Cascadia Mono", "Consolas", "DejaVu Sans Mono", "Liberation Mono", "Symbols Nerd Font Mono", "JetBrainsMono Nerd Font", "Hack Nerd Font", monospace'
    )
  })
})

// ---------------------------------------------------------------------------
// serializePaneTree
// ---------------------------------------------------------------------------
describe('serializePaneTree', () => {
  it('returns null for null input', () => {
    expect(serializePaneTree(null)).toBeNull()
  })

  it('returns a leaf node for a single pane', () => {
    const pane = mockElement({ classList: ['pane'], dataset: { paneId: '1' } })
    expect(serializePaneTree(pane)).toEqual({ type: 'leaf', leafId: 'pane:1' })
  })

  it('returns null for a pane with non-numeric paneId', () => {
    const pane = mockElement({ classList: ['pane'], dataset: { paneId: 'abc' } })
    expect(serializePaneTree(pane)).toBeNull()
  })

  it('returns null for element that is neither pane nor pane-split', () => {
    const el = mockElement({ classList: ['random-class'] })
    expect(serializePaneTree(el)).toBeNull()
  })

  it('returns a vertical split node with two pane children', () => {
    const first = new MockHTMLElement({ classList: ['pane'], dataset: { paneId: '1' } })
    const second = new MockHTMLElement({ classList: ['pane'], dataset: { paneId: '2' } })
    const split = mockElement({ classList: ['pane-split'], children: [first, second] })

    expect(serializePaneTree(split)).toEqual({
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', leafId: 'pane:1' },
      second: { type: 'leaf', leafId: 'pane:2' }
    })
  })

  it('returns horizontal direction when split has is-horizontal class', () => {
    const first = new MockHTMLElement({ classList: ['pane'], dataset: { paneId: '3' } })
    const second = new MockHTMLElement({ classList: ['pane'], dataset: { paneId: '4' } })
    const split = mockElement({
      classList: ['pane-split', 'is-horizontal'],
      children: [first, second]
    })

    expect(serializePaneTree(split)).toEqual({
      type: 'split',
      direction: 'horizontal',
      first: { type: 'leaf', leafId: 'pane:3' },
      second: { type: 'leaf', leafId: 'pane:4' }
    })
  })

  it('captures flex ratio when children have unequal flex', () => {
    const first = new MockHTMLElement({
      classList: ['pane'],
      dataset: { paneId: '1' },
      style: { flex: '3' }
    })
    const second = new MockHTMLElement({
      classList: ['pane'],
      dataset: { paneId: '2' },
      style: { flex: '1' }
    })
    const split = mockElement({ classList: ['pane-split'], children: [first, second] })

    const result = serializePaneTree(split)
    expect(result).toEqual({
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', leafId: 'pane:1' },
      second: { type: 'leaf', leafId: 'pane:2' },
      ratio: 0.75
    })
  })

  it('omits ratio when flex values are equal (both 1)', () => {
    const first = new MockHTMLElement({
      classList: ['pane'],
      dataset: { paneId: '1' },
      style: { flex: '1' }
    })
    const second = new MockHTMLElement({
      classList: ['pane'],
      dataset: { paneId: '2' },
      style: { flex: '1' }
    })
    const split = mockElement({ classList: ['pane-split'], children: [first, second] })

    const result = serializePaneTree(split)
    expect(result).not.toHaveProperty('ratio')
  })

  it('handles nested splits recursively', () => {
    const leaf1 = new MockHTMLElement({ classList: ['pane'], dataset: { paneId: '1' } })
    const leaf2 = new MockHTMLElement({ classList: ['pane'], dataset: { paneId: '2' } })
    const leaf3 = new MockHTMLElement({ classList: ['pane'], dataset: { paneId: '3' } })

    const innerSplit = new MockHTMLElement({
      classList: ['pane-split', 'is-horizontal'],
      children: [leaf2, leaf3]
    })
    const outerSplit = mockElement({
      classList: ['pane-split'],
      children: [leaf1, innerSplit]
    })

    expect(serializePaneTree(outerSplit)).toEqual({
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', leafId: 'pane:1' },
      second: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', leafId: 'pane:2' },
        second: { type: 'leaf', leafId: 'pane:3' }
      }
    })
  })
})

// ---------------------------------------------------------------------------
// serializeTerminalLayout
// ---------------------------------------------------------------------------
describe('serializeTerminalLayout', () => {
  it('returns EMPTY_LAYOUT equivalent when root is null', () => {
    const result = serializeTerminalLayout(null, null, null)
    expect(result).toEqual(EMPTY_LAYOUT)
  })

  it('returns null root when root has no firstElementChild', () => {
    const root = mockElement({}) as unknown as HTMLDivElement
    const result = serializeTerminalLayout(root, 5, null)
    expect(result).toEqual({
      root: null,
      activeLeafId: 'pane:5',
      expandedLeafId: null
    })
  })
})

// ---------------------------------------------------------------------------
// collectLeafIdsInReplayCreationOrder
// ---------------------------------------------------------------------------
describe('collectLeafIdsInReplayCreationOrder', () => {
  it('matches replayTerminalLayout pane creation order for nested left splits', () => {
    const layout: TerminalPaneLayoutNode = {
      type: 'split',
      direction: 'vertical',
      first: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', leafId: 'A' },
        second: { type: 'leaf', leafId: 'B' }
      },
      second: { type: 'leaf', leafId: 'C' }
    }

    expect(collectLeafIdsInOrder(layout)).toEqual(['A', 'B', 'C'])
    expect(collectLeafIdsInReplayCreationOrder(layout)).toEqual(['A', 'C', 'B'])
  })

  it('matches replayTerminalLayout pane creation order for nested right splits', () => {
    const layout: TerminalPaneLayoutNode = {
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', leafId: 'A' },
      second: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', leafId: 'B' },
        second: { type: 'leaf', leafId: 'C' }
      }
    }

    expect(collectLeafIdsInReplayCreationOrder(layout)).toEqual(['A', 'B', 'C'])
  })
})

// ---------------------------------------------------------------------------
// replayTerminalLayout — pane-counter advance
// ---------------------------------------------------------------------------
/**
 * Why: a persisted layout stores leafIds as `pane:<N>` verbatim. After replay
 * the PaneManager's monotonic counter (a per-instance `nextPaneId` that
 * resets to 1 on each app start) must be advanced past max(N) so the next
 * user-triggered split does not mint a pane whose `paneLeafId` collides with
 * an existing persisted leaf. Collision would collapse the determinism of
 * session ids derived from `(worktreeId, tabId, leafId)` — two distinct panes
 * sharing one history directory. Covered by tests below.
 */

function createMockPaneManager(): {
  manager: PaneManager
  createdIds: number[]
  advanceCalls: number[]
  // How the mock simulates the real counter. On createInitialPane / splitPane
  // we hand out `nextId++`; advanceNextPaneIdTo bumps the counter forward.
  nextId: () => number
} {
  let counter = 1
  const created: number[] = []
  const advances: number[] = []

  const mintPane = (): { id: number } => {
    const id = counter++
    created.push(id)
    return { id }
  }

  const manager = {
    createInitialPane: ({ focus }: { focus?: boolean } = {}) => {
      void focus
      return mintPane()
    },
    splitPane: () => mintPane(),
    advanceNextPaneIdTo: (minNextId: number) => {
      advances.push(minNextId)
      if (minNextId > counter) {
        counter = minNextId
      }
    }
    // Why: we cast through unknown because the mock only implements the
    // narrow surface replayTerminalLayout actually calls. Keeps the test
    // from having to stand up WebGL/DOM dependencies.
  } as unknown as PaneManager

  return {
    manager,
    createdIds: created,
    advanceCalls: advances,
    nextId: () => counter
  }
}

describe('replayTerminalLayout — pane counter advance', () => {
  it('bumps the counter past the highest persisted pane:N', () => {
    // Why: persisted leafIds can encode panes with N higher than what the
    // replay itself mints (e.g. the user closed pane 2 and then split
    // pane 5 before shutdown — the snapshot still contains pane:5 but
    // only 3 panes end up replayed). The counter must reach max(N)+1.
    const { manager, advanceCalls, nextId } = createMockPaneManager()
    const snapshot = {
      root: {
        type: 'split' as const,
        direction: 'vertical' as const,
        first: { type: 'leaf' as const, leafId: 'pane:7' },
        second: { type: 'leaf' as const, leafId: 'pane:3' }
      },
      activeLeafId: null,
      expandedLeafId: null
    }

    replayTerminalLayout(manager, snapshot, false)

    // highest persisted N is 7; counter must be advanced to >= 8.
    expect(advanceCalls).toEqual([8])
    expect(nextId()).toBeGreaterThanOrEqual(8)
  })

  it('does not regress the counter when the highest persisted N is small', () => {
    const { manager, advanceCalls } = createMockPaneManager()
    const snapshot = {
      root: { type: 'leaf' as const, leafId: 'pane:1' },
      activeLeafId: null,
      expandedLeafId: null
    }

    replayTerminalLayout(manager, snapshot, false)

    // advanceNextPaneIdTo(2) is called but has no effect if the counter
    // is already >= 2 — in the mock `createInitialPane` minted id 1 and
    // left the counter at 2 so this is a no-op move, which the mock
    // ignores (the real implementation's guard matches).
    expect(advanceCalls).toEqual([2])
  })

  it('skips non-matching leaf ids without throwing', () => {
    // Why: a corrupted or legacy snapshot might contain leafIds that
    // don't match `pane:<N>`. These must be skipped rather than crash
    // the restore — the counter fix is a best-effort safety valve.
    const { manager, advanceCalls } = createMockPaneManager()
    const snapshot = {
      root: {
        type: 'split' as const,
        direction: 'vertical' as const,
        first: { type: 'leaf' as const, leafId: 'legacy-shape-123' },
        second: { type: 'leaf' as const, leafId: 'pane:4' }
      },
      activeLeafId: null,
      expandedLeafId: null
    }

    replayTerminalLayout(manager, snapshot, false)

    expect(advanceCalls).toEqual([5])
  })

  it('advances to 1 (a no-op) when the snapshot has no persisted panes', () => {
    const { manager, advanceCalls } = createMockPaneManager()
    replayTerminalLayout(manager, { root: null, activeLeafId: null, expandedLeafId: null }, false)
    // Snapshot has no root → replayTerminalLayout returns early, before
    // the advance call path. Assert no advance was issued.
    expect(advanceCalls).toEqual([])
  })
})
