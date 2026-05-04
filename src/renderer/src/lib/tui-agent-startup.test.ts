import { describe, expect, it } from 'vitest'
import { buildAgentStartupPlan, isShellProcess } from './tui-agent-startup'

describe('buildAgentStartupPlan', () => {
  it('passes Claude prompts as a positional interactive argument', () => {
    expect(
      buildAgentStartupPlan({
        agent: 'claude',
        prompt: 'Fix the bug',
        cmdOverrides: {},
        platform: 'darwin'
      })
    ).toEqual({
      launchCommand: "claude 'Fix the bug'",
      expectedProcess: 'claude',
      followupPrompt: null
    })
  })

  it('uses Gemini interactive prompt mode instead of dropping the prompt', () => {
    expect(
      buildAgentStartupPlan({
        agent: 'gemini',
        prompt: 'Investigate this regression',
        cmdOverrides: {},
        platform: 'linux'
      })
    ).toEqual({
      launchCommand: "gemini --prompt-interactive 'Investigate this regression'",
      expectedProcess: 'gemini',
      followupPrompt: null
    })
  })

  it('launches aider first and injects the draft prompt after startup', () => {
    expect(
      buildAgentStartupPlan({
        agent: 'aider',
        prompt: 'Refactor the parser',
        cmdOverrides: {},
        platform: 'linux'
      })
    ).toEqual({
      launchCommand: 'aider',
      expectedProcess: 'aider',
      followupPrompt: 'Refactor the parser'
    })
  })

  it('launches Autohand Code first and injects the draft prompt after startup', () => {
    expect(
      buildAgentStartupPlan({
        agent: 'autohand',
        prompt: 'Add tests for the parser',
        cmdOverrides: {},
        platform: 'linux'
      })
    ).toEqual({
      launchCommand: 'autohand',
      expectedProcess: 'autohand',
      followupPrompt: 'Add tests for the parser'
    })
  })

  it('uses cursor-agent as the actual launch binary', () => {
    expect(
      buildAgentStartupPlan({
        agent: 'cursor',
        prompt: 'Review this file',
        cmdOverrides: {},
        platform: 'darwin'
      })
    ).toEqual({
      launchCommand: "cursor-agent 'Review this file'",
      expectedProcess: 'cursor-agent',
      followupPrompt: null
    })
  })

  it('applies command overrides without changing the prompt syntax contract', () => {
    expect(
      buildAgentStartupPlan({
        agent: 'droid',
        prompt: 'Ship the fix',
        cmdOverrides: { droid: '/opt/factory/bin/droid' },
        platform: 'linux'
      })
    ).toEqual({
      launchCommand: "/opt/factory/bin/droid 'Ship the fix'",
      expectedProcess: 'droid',
      followupPrompt: null
    })
  })

  it('passes Copilot prompts with the -i flag for an interactive session', () => {
    expect(
      buildAgentStartupPlan({
        agent: 'copilot',
        prompt: 'Fix the bug',
        cmdOverrides: {},
        platform: 'darwin'
      })
    ).toEqual({
      launchCommand: "copilot -i 'Fix the bug'",
      expectedProcess: 'copilot',
      followupPrompt: null
    })
  })

  it('returns null when there is no prompt to inject', () => {
    expect(
      buildAgentStartupPlan({
        agent: 'codex',
        prompt: '   ',
        cmdOverrides: {},
        platform: 'darwin'
      })
    ).toBeNull()
  })

  it('uses -i flag for copilot to start an interactive session with initial prompt', () => {
    expect(
      buildAgentStartupPlan({
        agent: 'copilot',
        prompt: 'Fix the bug',
        cmdOverrides: {},
        platform: 'darwin'
      })
    ).toEqual({
      launchCommand: "copilot -i 'Fix the bug'",
      expectedProcess: 'copilot',
      followupPrompt: null
    })
  })
})

describe('isShellProcess', () => {
  it('treats common shells as non-agent foreground processes', () => {
    expect(isShellProcess('bash')).toBe(true)
    expect(isShellProcess('pwsh.exe')).toBe(true)
    expect(isShellProcess('')).toBe(true)
  })

  it('does not confuse agent processes with the host shell', () => {
    expect(isShellProcess('gemini')).toBe(false)
    expect(isShellProcess('cursor-agent')).toBe(false)
  })
})
