import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { renderFeedbackWorkbench } from '../dist/src/knowledge/feedback-workbench.js'

const html = renderFeedbackWorkbench({
  knowledgeBaseId: 'demo-policy', datasetRevision: 3,
  feedback: [
    { id: 'demo-feedback-1', category: 'conflict', status: 'pending',
      comment: '华东事业部的报销上限与总部制度不一致，请复核适用范围。',
      traceId: 'demo-trace-1', createdAt: '2026-09-27T09:00:00Z' },
    { id: 'demo-feedback-2', category: 'citation_error', status: 'promoted',
      comment: '引用页码与合同条款不一致，已转入回归样本。',
      traceId: 'demo-trace-2', createdAt: '2026-09-27T09:30:00Z' },
  ],
  runs: [{ id: 'demo-run-1', status: 'failed', caseCount: 16,
    configFingerprint: 'demo-config-v3', approvedBy: null,
    createdAt: '2026-09-27T10:00:00Z' }],
})

const output = resolve('examples/knowledge-p5-feedback-preview.html')
writeFileSync(output, html, 'utf8')
process.stdout.write(`${output}\n`)
