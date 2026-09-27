import assert from 'node:assert/strict'
import { test } from 'node:test'
import { renderWeeklyReport, validateWeeklyReportInput } from '../src/report.js'

test('weekly report preserves sections and supplied source references', () => {
  const input = validateWeeklyReportInput({
    period: '2026-09-21 至 2026-09-25',
    completed: [{ text: '整理常见问题 20 条', sourceRefs: ['fixture-weekly:1'] }],
    risks: [{ text: '退款时效说明待审批', sourceRefs: ['fixture-weekly:3'] }],
    nextWeek: [{ text: '补齐知识条目', sourceRefs: ['fixture-weekly:5'] }],
  })
  const report = renderWeeklyReport(input)
  assert.match(report, /本周完成/)
  assert.match(report, /问题与风险/)
  assert.match(report, /下周计划/)
  assert.match(report, /fixture-weekly:3/)
})

test('weekly report refuses unsupported facts without sources', () => {
  assert.throws(() => validateWeeklyReportInput({
    period: '2026-09-21 至 2026-09-25',
    completed: [{ text: '销售额翻倍', sourceRefs: [] }],
    risks: [],
    nextWeek: [],
  }), /来源/)
})
