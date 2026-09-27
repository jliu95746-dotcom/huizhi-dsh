import assert from 'node:assert/strict'
import test from 'node:test'
import { compareCriticalText, findRuleConflicts, validateRuleSuggestion, type GovernanceRule } from '../src/knowledge/governance-policy.js'

const rule = (id: string, amount: string, departments: string[], from = '2026-01-01T00:00:00Z'):
  GovernanceRule => ({ id, sourceRef: `knowledge:doc:v1:build:${id}`, subjectId: 'travel-hotel',
    action: '住宿报销', modality: 'allow', condition: '国内出差', threshold: amount, unit: '元',
    departmentIds: departments, regionIds: [], effectiveFrom: from, effectiveTo: null,
    originalText: `国内出差住宿报销上限为${amount}元。` })

test('规则候选必须保留原文可定位字段，不接受模型补造的金额或来源', () => {
  assert.equal(validateRuleSuggestion(rule('a', '500', ['sales'])).ok, true)
  assert.equal(validateRuleSuggestion({ ...rule('a', '500', ['sales']), threshold: '800' }).ok, false)
  assert.equal(validateRuleSuggestion({ ...rule('a', '500', ['sales']), sourceRef: '' }).ok, false)
})

test('矛盾只在业务对象、时间和适用范围可能重叠时列为待裁决', () => {
  const a = rule('a', '500', ['sales'])
  const b = rule('b', '800', ['sales'])
  const c = rule('c', '800', ['legal'])
  const d = { ...rule('d', '800', ['sales'], '2027-01-01T00:00:00Z'), effectiveTo: '2027-12-31T00:00:00Z' }
  assert.deepEqual(findRuleConflicts([a, b, c]).map((item) => [item.left.id, item.right.id]), [['a', 'b']])
  assert.deepEqual(findRuleConflicts([{ ...a, effectiveTo: '2027-01-01T00:00:00Z' }, d]), [])
  assert.deepEqual(findRuleConflicts([a, { ...b, approvedExceptionOf: 'a' }]), [])
})

test('近重复候选保留数字、单位、否定词和适用部门差异', () => {
  assert.equal(compareCriticalText('法务部住宿上限500元，不得超额', '法务部住宿上限800元，不得超额').safeToMarkDuplicate, false)
  assert.equal(compareCriticalText('法务部住宿上限500元，不得超额', '法务部住宿上限500元，可以超额').safeToMarkDuplicate, false)
  assert.equal(compareCriticalText('法务部住宿上限500元', '市场部住宿上限500元').safeToMarkDuplicate, false)
  assert.equal(compareCriticalText('法务部住宿上限500元。', '法务部 住宿上限 500 元').safeToMarkDuplicate, true)
})
