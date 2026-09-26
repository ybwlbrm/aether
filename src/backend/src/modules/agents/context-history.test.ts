import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildAgentHistory } from './orchestration.js'
import { buildForceSummaryMessages } from './tool-loop.js'

type StoredHistoryRow = Parameters<typeof buildAgentHistory>[0][number]

const toolCall = {
  id: 'call-read-file',
  type: 'function',
  function: {
    name: 'read_file',
    arguments: '{"path":"notes.txt"}',
  },
} as const

const persistedRows: readonly StoredHistoryRow[] = [
  { role: 'user', content: '读取 notes.txt' },
  {
    role: 'assistant',
    content: '',
    toolCalls: JSON.stringify([toolCall]),
  },
  {
    role: 'tool',
    content: '文件内容',
    toolCalls: JSON.stringify(toolCall),
  },
  { role: 'assistant', content: '已读取文件' },
]

const expectedToolChain: Array<Record<string, unknown>> = [
  { role: 'user', content: '读取 notes.txt' },
  {
    role: 'assistant',
    content: '',
    tool_calls: [toolCall],
  },
  {
    role: 'tool',
    tool_call_id: 'call-read-file',
    content: '文件内容',
  },
  { role: 'assistant', content: '已读取文件' },
]

describe('agents context history', () => {
  it('rebuilds persisted assistant tool_calls and tool results for the next agent turn', () => {
    // Given
    const requestHistory = [{ role: 'user' as const, content: '客户端只发送了文本历史' }]

    // When
    const history = buildAgentHistory(persistedRows, requestHistory)

    // Then
    assert.deepEqual(history, expectedToolChain)
  })

  it('keeps the execution-loop tool chain in the force-summary request', () => {
    // Given
    const executionChain: Array<Record<string, unknown>> = [
      { role: 'user', content: '读取 notes.txt' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [toolCall],
      },
      {
        role: 'tool',
        tool_call_id: 'call-read-file',
        content: '文件内容',
      },
    ]

    // When
    const summaryMessages = buildForceSummaryMessages(executionChain)

    // Then
    assert.deepEqual(summaryMessages.slice(0, executionChain.length), executionChain)
    assert.equal(summaryMessages[executionChain.length]?.role, 'user')
    assert.equal(
      summaryMessages[executionChain.length]?.content,
      '请基于上面所有工具执行的结果，给出完整的总结与最终答复。如果任务还没完成，请继续说明还需要做什么。',
    )
  })
})
