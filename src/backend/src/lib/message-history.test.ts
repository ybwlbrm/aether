import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { countOrphanToolMessages, rebuildProviderMessages } from './message-history.js'

type StoredMessage = Parameters<typeof rebuildProviderMessages>[0][number]

function assistantWithCalls(content: string, calls: readonly { id: string; name: string; args: string }[]): StoredMessage {
  return {
    role: 'assistant',
    content,
    toolCalls: JSON.stringify(calls.map((call) => ({
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: call.args },
    }))),
  }
}

function toolResult(id: string, content: string): StoredMessage {
  return {
    role: 'tool',
    content,
    toolCalls: JSON.stringify({
      id,
      type: 'function',
      function: { name: 'test_tool', arguments: '{}' },
    }),
  }
}

describe('rebuildProviderMessages', () => {
  it('preserves every assistant tool call in a complete multi-tool group', () => {
    // Given
    const rows: StoredMessage[] = [
      { role: 'user', content: 'run both' },
      assistantWithCalls('', [
        { id: 'call_a', name: 'first', args: '{"value":1}' },
        { id: 'call_b', name: 'second', args: '{"value":2}' },
      ]),
      toolResult('call_a', 'A'),
      toolResult('call_b', 'B'),
      { role: 'assistant', content: 'done' },
    ]

    // When
    const rebuilt = rebuildProviderMessages(rows)

    // Then
    assert.equal(rebuilt.length, 5)
    assert.deepEqual(rebuilt[1], {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'call_a', type: 'function', function: { name: 'first', arguments: '{"value":1}' } },
        { id: 'call_b', type: 'function', function: { name: 'second', arguments: '{"value":2}' } },
      ],
    })
    assert.equal(rebuilt[2].role, 'tool')
    assert.equal(rebuilt[2].tool_call_id, 'call_a')
    assert.equal(rebuilt[3].role, 'tool')
    assert.equal(rebuilt[3].tool_call_id, 'call_b')
    assert.equal(countOrphanToolMessages(rebuilt), 0)
  })

  it('drops an incomplete tool-call group and unrelated orphan tool rows', () => {
    // Given
    const rows: StoredMessage[] = [
      assistantWithCalls('', [{ id: 'call_a', name: 'first', args: '{}' }]),
      toolResult('call_orphan', 'orphan'),
      { role: 'user', content: 'next request' },
    ]

    // When
    const rebuilt = rebuildProviderMessages(rows)

    // Then
    assert.deepEqual(rebuilt, [{ role: 'user', content: 'next request' }])
    assert.equal(countOrphanToolMessages(rebuilt), 0)
  })
})
