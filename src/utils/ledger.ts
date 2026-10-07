import type {
  CorrectionPoint,
  DataGap,
  KilnSession,
  MergedSample,
  SegmentRecord,
  SessionAccount,
  SourceInfo,
} from '../types/firing'
import { calculateDeviation, validateCurve } from './curve'

/** 相邻采样时间跨度超过该阈值（分钟）即记为缺口 */
export const GAP_THRESHOLD_MIN = 10

/** 合并分段采样与人工校订：校订在重叠处优先，缺口单独保留 */
export function mergeSessionData(session: KilnSession): {
  samples: MergedSample[]
  gaps: DataGap[]
  sources: SourceInfo[]
} {
  const segments = [...(session.segments ?? [])]
    .filter((segment) => segment.status === 'ok')
    .sort((a, b) => a.importedAt.localeCompare(b.importedAt))
  const corrections = session.corrections ?? []

  // 以时间为键：分段先入（较新导入覆盖较旧导入），校订后入并覆盖同时间点
  const byTime = new Map<number, MergedSample>()
  for (const segment of segments) {
    for (const sample of segment.samples) {
      byTime.set(sample.timeMin, {
        ...sample,
        source: 'segment',
        sourceId: segment.id,
        sourceLabel: segment.source,
      })
    }
  }
  for (const correction of corrections) {
    byTime.set(correction.timeMin, {
      id: `merged-corr-${correction.id}`,
      timeMin: correction.timeMin,
      tempC: correction.tempC,
      source: 'correction',
      sourceId: correction.id,
      sourceLabel: correction.note ? `人工校订：${correction.note}` : '人工校订',
    })
  }

  const samples = [...byTime.values()].sort((a, b) => a.timeMin - b.timeMin)

  const gaps: DataGap[] = []
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1]
    const current = samples[index]
    const durationMin = current.timeMin - previous.timeMin
    if (durationMin > GAP_THRESHOLD_MIN) {
      gaps.push({
        id: `gap-${session.id}-${previous.timeMin}-${current.timeMin}`,
        sessionId: session.id,
        fromMin: previous.timeMin,
        toMin: current.timeMin,
        durationMin,
      })
    }
  }

  const sources: SourceInfo[] = segments.map((segment) => ({
    id: segment.id,
    label: segment.source,
    importedAt: segment.importedAt,
    sampleCount: segment.sampleCount,
    timeRange: segment.timeRange,
    status: segment.status,
  }))

  return { samples, gaps, sources }
}

/** 派生缓存：把合并结果写回 actualSamples，供图表等视图使用 */
export function recomputeSessionDerived(session: KilnSession): void {
  const { samples } = mergeSessionData(session)
  session.actualSamples = samples
}

/** 一份烧成账：窑次 + 分段 + 校订 + 缺口 + 偏差/风险结果 */
export function computeSessionAccount(session: KilnSession): SessionAccount {
  const { samples, gaps, sources } = mergeSessionData(session)
  return {
    sessionId: session.id,
    samples,
    gaps,
    sources,
    correctionCount: (session.corrections ?? []).length,
    deviation: calculateDeviation(session.points, samples, session.timeOffsetMin),
    issues: validateCurve(session),
  }
}

/** 由一次 CSV 导入创建一段记录 */
export function createSegmentFromImport(
  sessionId: string,
  source: string,
  samples: SegmentRecord['samples'],
  importedAt: string = new Date().toISOString(),
): SegmentRecord {
  const times = samples.map((sample) => sample.timeMin)
  return {
    id: `seg-${sessionId}-${crypto.randomUUID().slice(0, 8)}`,
    sessionId,
    source,
    importedAt,
    samples: samples.map((sample) => ({ ...sample })),
    sampleCount: samples.length,
    timeRange: samples.length ? [Math.min(...times), Math.max(...times)] : null,
    status: 'ok',
  }
}

/** 创建一条人工校订点 */
export function createCorrection(
  sessionId: string,
  timeMin: number,
  tempC: number,
  note?: string,
): CorrectionPoint {
  return {
    id: `corr-${sessionId}-${crypto.randomUUID().slice(0, 8)}`,
    sessionId,
    timeMin,
    tempC,
    correctedAt: new Date().toISOString(),
    note: note?.trim() || undefined,
  }
}

/**
 * 旧数据升级：把整份采样迁成一段记录。
 * 归并前后都能看见来源（分段）与缺口（合并后派生）。
 */
export function migrateSession(session: KilnSession): KilnSession {
  if (!Array.isArray(session.segments)) {
    session.segments = []
    if (Array.isArray(session.actualSamples) && session.actualSamples.length) {
      const samples = session.actualSamples.map((sample) => ({ ...sample }))
      const times = samples.map((sample) => sample.timeMin)
      session.segments.push({
        id: `seg-migrated-${session.id}-${crypto.randomUUID().slice(0, 6)}`,
        sessionId: session.id,
        source: '历史采样（升级迁移）',
        importedAt: new Date().toISOString(),
        samples,
        sampleCount: samples.length,
        timeRange: [Math.min(...times), Math.max(...times)],
        status: 'ok',
      })
    }
  }
  if (!Array.isArray(session.corrections)) {
    session.corrections = []
  }
  recomputeSessionDerived(session)
  return session
}
