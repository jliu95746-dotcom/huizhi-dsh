import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { renderGovernanceWorkbench } from '../dist/src/knowledge/workbench.js'

const preview = renderGovernanceWorkbench({
  knowledgeBaseId: 'demo-policy',
  canReview: true,
  canPublish: false,
  reviewCases: [{
    caseId: 'demo-review-1', kind: 'conflict', status: 'pending', revision: 1,
    leftRef: 'knowledge:demo-policy:version-a:build-a:section-1',
    rightRef: 'knowledge:demo-policy:version-b:build-b:section-1',
    createdAt: '2026-09-27T00:00:00Z',
  }],
  proposals: [{
    proposalId: 'demo-proposal-1', status: 'draft', reason: '差旅制度更新待复核',
    preview: { added: [], removed: [], changed: [{
      before: { documentId: 'demo-policy', versionId: 'version-a', buildId: 'build-a',
        effectiveFrom: '2026-01-01T00:00:00Z', effectiveTo: null },
      after: { documentId: 'demo-policy', versionId: 'version-b', buildId: 'build-b',
        effectiveFrom: '2026-10-01T00:00:00Z', effectiveTo: null },
    }], unchanged: [], affectedDerivedIds: ['demo-faq-1'] },
    publishNotBefore: '2026-10-01T00:00:00Z',
  }],
})

const output = resolve('examples/knowledge-p4-workbench-preview.html')
writeFileSync(output, preview, 'utf8')
process.stdout.write(`${output}\n`)
