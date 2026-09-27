import assert from 'node:assert/strict'
import test from 'node:test'
import type { RunResult } from '@deepseek-ai/dsh-sdk-client'
import { extractSourceRefs, failedToolNames, toolEventFromNotification } from '../src/runner.js'

test('工具调用与结果事件保留关联及错误状态', () => {
  const names = new Map<string, string>()
  const started = toolEventFromNotification({
    method: 'session.event', params: { event: { type: 'tool/call', data: { callId: 'call-1', name: 'mcp__files__read_document' } } },
  }, 'task-1', names)
  const finished = toolEventFromNotification({
    method: 'session.event', params: { event: { type: 'tool/result', data: { message: { content: [{ toolCallId: 'call-1', isError: true }] } } } },
  }, 'task-1', names)
  assert.deepEqual(started, { type: 'tool_started', taskId: 'task-1', toolName: 'mcp__files__read_document', callId: 'call-1' })
  assert.deepEqual(finished, { type: 'tool_finished', taskId: 'task-1', toolName: 'mcp__files__read_document', callId: 'call-1', success: false })
  const events = [
    { type: 'tool/call', data: { callId: 'call-1', name: 'mcp__files__read_document' } },
    { type: 'tool/result', data: { message: { content: [{ toolCallId: 'call-1', isError: true }] } } },
  ] as unknown as RunResult['events']
  assert.deepEqual(failedToolNames(events), ['mcp__files__read_document'])
})

test('来源只采纳成功的业务工具结果', () => {
  const events = [
    { type: 'tool/call', data: { callId: 'business', name: 'mcp__knowledge__search_knowledge' } },
    { type: 'tool/call', data: { callId: 'report', name: 'mcp__reports__create_weekly_report' } },
    { type: 'tool/result', data: { message: { content: [{ toolCallId: 'business', content: [{ type: 'text', text: '{"sourceRef":"knowledge/真实记录"}' }] }] } } },
    { type: 'tool/result', data: { message: { content: [{ toolCallId: 'report', content: [{ type: 'text', text: '{"sourceRef":"模型提供的引用"}' }] }] } } },
  ] as unknown as RunResult['events']
  assert.deepEqual(extractSourceRefs(events), ['knowledge/真实记录'])
})
