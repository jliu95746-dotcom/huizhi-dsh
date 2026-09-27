export interface GovernanceRule {
  id: string
  sourceRef: string
  subjectId: string
  action: string
  modality: 'allow' | 'require' | 'prohibit'
  condition: string
  threshold: string | null
  unit: string | null
  departmentIds: string[]
  regionIds: string[]
  effectiveFrom: string
  effectiveTo: string | null
  originalText: string
  approvedExceptionOf?: string
}

const validUtc = (value: string) => typeof value === 'string' && value.endsWith('Z') && !Number.isNaN(Date.parse(value))
const overlap = (left: string[], right: string[]) => !left.length || !right.length || left.some((item) => right.includes(item))
const overlapTime = (left: GovernanceRule, right: GovernanceRule) =>
  (left.effectiveTo === null || left.effectiveTo > right.effectiveFrom) &&
  (right.effectiveTo === null || right.effectiveTo > left.effectiveFrom)

export function validateRuleSuggestion(rule: GovernanceRule): { ok: boolean; reason: string } {
  if (!rule?.id || !/^knowledge:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/.test(rule.sourceRef) ||
      !rule.subjectId?.trim() || !rule.action?.trim() || !['allow', 'require', 'prohibit'].includes(rule.modality) ||
      !rule.originalText?.trim() || !Array.isArray(rule.departmentIds) || !Array.isArray(rule.regionIds) ||
      !validUtc(rule.effectiveFrom) || rule.effectiveTo !== null &&
      (!validUtc(rule.effectiveTo) || rule.effectiveTo <= rule.effectiveFrom)) {
    return { ok: false, reason: 'RULE_INPUT_INVALID' }
  }
  if (rule.threshold !== null && (!rule.threshold.trim() || !rule.originalText.replace(/\s+/g, '').includes(
    `${rule.threshold}${rule.unit ?? ''}`.replace(/\s+/g, '')))) {
    return { ok: false, reason: 'RULE_THRESHOLD_NOT_IN_SOURCE' }
  }
  return { ok: true, reason: 'VALID' }
}

export interface RuleConflict { left: GovernanceRule; right: GovernanceRule; reason: 'threshold' | 'modality' }
export function findRuleConflicts(rules: GovernanceRule[]): RuleConflict[] {
  const output: RuleConflict[] = []
  for (let i = 0; i < rules.length; i++) {
    const left = rules[i]
    if (!validateRuleSuggestion(left).ok) continue
    for (let j = i + 1; j < rules.length; j++) {
      const right = rules[j]
      if (!validateRuleSuggestion(right).ok || left.subjectId !== right.subjectId || left.action !== right.action ||
          left.approvedExceptionOf === right.id || right.approvedExceptionOf === left.id ||
          !overlap(left.departmentIds, right.departmentIds) || !overlap(left.regionIds, right.regionIds) ||
          !overlapTime(left, right)) continue
      if (left.modality !== right.modality) output.push({ left, right, reason: 'modality' })
      else if (left.threshold !== right.threshold || left.unit !== right.unit) {
        output.push({ left, right, reason: 'threshold' })
      }
    }
  }
  return output
}

function criticalTokens(text: string): string[] {
  const compact = text.replace(/\s+/g, '')
  return [...compact.matchAll(/\d+(?:\.\d+)?(?:亿元|万元|元|%|天|日|月|年)?|[\u4e00-\u9fa5]{2,12}(?:事业部|中心|部门|部)|不得|禁止|必须|可以|无需|除外|不|无|未/g)]
    .map((match) => match[0])
}
export function compareCriticalText(left: string, right: string): { safeToMarkDuplicate: boolean; left: string[]; right: string[] } {
  const leftTokens = criticalTokens(left)
  const rightTokens = criticalTokens(right)
  return { safeToMarkDuplicate: !!left.trim() && !!right.trim() &&
    JSON.stringify(leftTokens) === JSON.stringify(rightTokens), left: leftTokens, right: rightTokens }
}
