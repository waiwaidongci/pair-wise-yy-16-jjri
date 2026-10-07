import type { RawSample } from '../types/firing'

export interface CsvParseOutcome {
  samples: RawSample[]
  timecodeRows: number
}

const TIME_HEADERS = ['time', 'minute', 'minutes', '时间', '分钟', '经过时间']
const TEMP_HEADERS = ['temp', 'temperature', 'temperature_c', '温度', '温度c', '实测温度']

/**
 * 解析记录仪 CSV。任何无法安全导入的情况都抛错，
 * 由调用方保留原账并把失败内容暂存起来供重试。
 */
export function parseTemperatureCsv(content: string, fileName = '记录片段.csv'): CsvParseOutcome {
  const text = content.replace(/^\uFEFF/, '')
  if (!text.trim()) {
    throw new CsvParseError('文件内容为空，未发现任何记录。')
  }
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length < 2) {
    throw new CsvParseError('只有表头或单行内容，至少需要一行温度记录。')
  }

  const headers = lines[0].split(',').map((value) => value.trim().toLowerCase())
  const headerTimeIndex = headers.findIndex((header) => TIME_HEADERS.includes(header))
  const headerTempIndex = headers.findIndex((header) => TEMP_HEADERS.includes(header))
  // 无明确表头时按前两列处理；首行必须长得像数据，否则说明表头无法识别
  let timeIndex = headerTimeIndex
  let tempIndex = headerTempIndex
  let dataStart = 1
  if (timeIndex < 0 || tempIndex < 0) {
    const firstValues = lines[0].split(',')
    const looksLikeData = firstValues.length >= 2 && firstValues.slice(0, 2).every((value) => Number.isFinite(Number(value.trim())))
    if (!looksLikeData) {
      throw new CsvParseError('无法识别表头，请包含 time,temp（或 时间,温度）两列。')
    }
    timeIndex = 0
    tempIndex = 1
    dataStart = 0
  }

  const samples: RawSample[] = []
  const badRows: number[] = []
  let timecodeRows = 0
  lines.slice(dataStart).forEach((line, rowOffset) => {
    const rowNumber = rowOffset + dataStart + 1
    const values = line.split(',')
    const rawTime = values[timeIndex]?.trim() ?? ''
    const rawTemp = values[tempIndex]?.trim() ?? ''
    if (!rawTime && !rawTemp) return
    let timeMin: number
    if (rawTime.includes(':')) {
      const parts = rawTime.split(':').map((value) => Number(value))
      if (parts.some((value) => Number.isNaN(value))) {
        badRows.push(rowNumber)
        return
      }
      timeMin = parts.reduce((total, value) => total * 60 + value, 0) / 60
      timecodeRows += 1
    } else {
      timeMin = Number(rawTime)
    }
    const tempValue = Number(rawTemp)
    if (!Number.isFinite(timeMin) || !Number.isFinite(tempValue) || timeMin < 0) {
      badRows.push(rowNumber)
      return
    }
    samples.push({
      id: `csv-${fileName.slice(0, 24)}-${rowNumber}-${samples.length}`,
      timeMin: Number(timeMin.toFixed(2)),
      tempC: tempValue,
    })
  })

  if (!samples.length) {
    throw new CsvParseError(
      badRows.length
        ? `全部 ${badRows.length} 行数据都无法解析（首个问题行：第 ${badRows[0]} 行）。`
        : '未解析到任何有效的时间/温度数据行。',
    )
  }

  const outcome: CsvParseOutcome = {
    samples: samples.sort((a, b) => a.timeMin - b.timeMin),
    timecodeRows,
  }
  if (badRows.length) {
    // 宁可整段拒绝也不留半笔错账，原账由调用方保留，修正后可重试
    throw new CsvParseError(
      `第 ${badRows.slice(0, 5).join('、')}${badRows.length > 5 ? ' 等' : ''} 行无法解析，为避免错账已整段拒绝，请修正后重试。`,
      outcome,
    )
  }
  return outcome
}

export class CsvParseError extends Error {
  partial?: CsvParseOutcome
  constructor(message: string, partial?: CsvParseOutcome) {
    super(message)
    this.name = 'CsvParseError'
    this.partial = partial
  }
}

export function downloadText(content: string, filename: string, type: string) {
  const blob = new Blob([content], { type })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}
