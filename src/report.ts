import { readFileSync } from 'node:fs'
import Handlebars from 'handlebars'

export interface ReportItem {
  text: string
  sourceRefs: string[]
}

export interface WeeklyReportInput {
  period: string
  completed: ReportItem[]
  risks: ReportItem[]
  nextWeek: ReportItem[]
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${name} 必须是对象`)
  }
  return value as Record<string, unknown>
}

function text(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength || /[\r\n]/.test(value)) {
    throw new Error(`${name} 必须是单行非空文本，最多 ${maxLength} 字符`)
  }
  return value.trim()
}

function items(value: unknown, name: string): ReportItem[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error(`${name} 必须是最多 100 项的数组`)
  return value.map((raw, index) => {
    const item = object(raw, `${name}[${index}]`)
    if (!Array.isArray(item.sourceRefs) || item.sourceRefs.length < 1 || item.sourceRefs.length > 16) {
      throw new Error(`${name}[${index}] 必须提供 1 至 16 个来源`)
    }
    return {
      text: text(item.text, `${name}[${index}].text`, 2000),
      sourceRefs: item.sourceRefs.map((ref, refIndex) =>
        text(ref, `${name}[${index}].sourceRefs[${refIndex}]`, 512)),
    }
  })
}

export function validateWeeklyReportInput(value: unknown): WeeklyReportInput {
  const input = object(value, '周报输入')
  return {
    period: text(input.period, 'period', 200),
    completed: items(input.completed, 'completed'),
    risks: items(input.risks, 'risks'),
    nextWeek: items(input.nextWeek, 'nextWeek'),
  }
}

const templateText = readFileSync(new URL('../../templates/weekly.md.hbs', import.meta.url), 'utf8')
const handlebars = Handlebars.create()
handlebars.registerHelper('joinSources', (sources: string[]) => sources.join('、'))
const template = handlebars.compile(templateText)

export function renderWeeklyReport(input: WeeklyReportInput): string {
  const allSources = [...new Set([...input.completed, ...input.risks, ...input.nextWeek]
    .flatMap((item) => item.sourceRefs))]
  return `${template({ ...input, allSources }).trim()}\n`
}
