import assert from 'node:assert/strict'
import test from 'node:test'
import { validateExternalToolContract } from '../src/plugin-contract.js'

test('插件契约阻止重复工具名、缺少输出字段和版本不匹配', () => {
  const issues = validateExternalToolContract('files', [
    { name: 'read_document', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
    { name: 'read_document', inputSchema: { type: 'object' } },
  ], { contractVersion: 2, capability: 'files' }, 'invalid')
  assert.ok(issues.some((issue) => issue.includes('version')))
  assert.ok(issues.some((issue) => issue.includes('contractVersion')))
  assert.ok(issues.some((issue) => issue.includes('名称重复')))
  assert.ok(issues.some((issue) => issue.includes('read_document.outputSchema')))
  assert.ok(issues.some((issue) => issue.includes('search_documents')))
})
