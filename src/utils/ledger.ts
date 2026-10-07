import type {
  FiringLedger,
  LedgerGap,
  LedgerMerge,
  ManualCorrection,
  MergedSample,
  RawSample,
  SampleSegment,
} from '../types/firing'

/** 相邻采样点间隔超过基准间隔的多少倍，视为段内停电断网 */
const GAP_FACTOR = 8
/** 不足该净缺失时长不单独列为缺口（分钟） */
const MIN_GAP_MINUTES = 2

export function emptyLedger(): FiringLedger {
  return { segments: [], corrections: [] }
}

/** 由旧版整份采样迁成一段记录，保留升级痕迹 */
export function legacySamplesToLedger(samples: RawSample[], fileName = '旧版整份采样（自动迁移）'): FiringLedger {
  const segment = buildSegment(samples, fileName, '旧数据迁移')
  return { migratedFromLegacy: true, segments: segment ? [segment] : [], corrections: [] }
}

export function buildSegment(samples: RawSample[], fileName: string, sourceLabel: string): SampleSegment | null {
  const sorted = dedupeByTime([...samples].sort((a, b) => a.timeMin - b.timeMin))
  if (!sorted.length) return null
  return {
    id: `segment-${crypto.randomUUID()}`,
    fileName,
    sourceLabel,
    importedAt: new Date().toISOString(),
    firstAtMin: sorted[0].timeMin,
    lastAtMin: sorted.at(-1)!.timeMin,
    sampleCount: sorted.length,
    rawSamples: sorted,
  }
}

function dedupeByTime(samples: RawSample[]) {
  const result: RawSample[] = []
  for (const sample of samples) {
    const last = result.at(-1)
    if (last && last.timeMin === sample.timeMin) {
      // 同一时刻重复读数，后到的（重新导出的）覆盖旧值
      result[result.length - 1] = sample
    } else {
      result.push(sample)
    }
  }
  return result
}

/** 采样基准间隔：全部相邻正间隔的众数，稀疏头尾不会拉偏判断 */
function typicalInterval(samples: RawSample[]) {
  if (samples.length < 2) return 5
  const diffs: number[] = []
  for (let index = 1; index < samples.length; index += 1) {
    const diff = Number((samples[index].timeMin - samples[index - 1].timeMin).toFixed(2))
    if (diff > 0) diffs.push(diff)
  }
  if (!diffs.length) return 5
  const counts = new Map<number, number>()
  diffs.forEach((diff) => counts.set(diff, (counts.get(diff) ?? 0) + 1))
  let best = diffs[0]
  let bestCount = 0
  counts.forEach((count, diff) => {
    if (count > bestCount) {
      best = diff
      bestCount = count
    }
  })
  return best
}

/** 由各段覆盖范围推算停电断网缺口，缺口本身不入库、始终按现状重算 */
export function deriveGaps(segments: SampleSegment[]): LedgerGap[] {
  const gaps: LedgerGap[] = []
  const coverage = segments
    .map((segment) => {
      const samples = segment.rawSamples
      return {
        startMin: samples[0].timeMin,
        endMin: samples.at(-1)!.timeMin,
        lastObservedC: samples.at(-1)!.tempC,
        firstObservedC: samples[0].tempC,
        interval: typicalInterval(samples),
      }
    })
    .sort((a, b) => a.startMin - b.startMin)

  // 段间断网：两段不重叠且间隔超出两侧一个正常采样间隔的余量
  for (let index = 1; index < coverage.length; index += 1) {
    const previous = coverage[index - 1]
    const current = coverage[index]
    if (current.startMin <= previous.endMin) continue // 段间重叠，不产生缺口
    const allowance = Math.max(previous.interval, current.interval)
    const missing = current.startMin - previous.endMin - allowance
    if (missing >= MIN_GAP_MINUTES) {
      gaps.push({
        startMin: previous.endMin,
        lastObservedC: previous.lastObservedC,
        endMin: current.startMin,
        nextObservedC: current.firstObservedC,
        missingDurationMin: Number(missing.toFixed(1)),
      })
    }
  }

  // 段内断档（单个 CSV 里记录仪自己停过一段）
  segments.forEach((segment) => {
    const interval = typicalInterval(segment.rawSamples)
    for (let index = 1; index < segment.rawSamples.length; index += 1) {
      const previous = segment.rawSamples[index - 1]
      const current = segment.rawSamples[index]
      const delta = current.timeMin - previous.timeMin
      if (delta > interval * GAP_FACTOR && delta - interval >= MIN_GAP_MINUTES) {
        gaps.push({
          startMin: previous.timeMin,
          lastObservedC: previous.tempC,
          endMin: current.timeMin,
          nextObservedC: current.tempC,
          missingDurationMin: Number((delta - interval).toFixed(1)),
        })
      }
    }
  })
  return gaps.sort((a, b) => a.startMin - b.startMin)
}

/**
 * 合并烧成账：
 * - 多段按时间归并，重叠处人工校订优先，其次后导入的分段覆盖先导入的；
 * - 缺口单独保留：缺口内的人工校订作为 manual-only 点，不插值补齐；
 * - 每个点都带得出来源分段，归并前后都能看见来源。
 */
export function mergeLedger(ledger: FiringLedger): LedgerMerge {
  const byTime = new Map<number, MergedSample>()

  const orderedSegments = [...ledger.segments].sort(
    (a, b) => a.importedAt.localeCompare(b.importedAt),
  )
  orderedSegments.forEach((segment) => {
    segment.rawSamples.forEach((raw) => {
      byTime.set(raw.timeMin, {
        timeMin: raw.timeMin,
        tempC: raw.tempC,
        source: 'segment',
        segmentId: segment.id,
        segmentFileName: segment.fileName,
        corrected: false,
      })
    })
  })

  const corrections = [...ledger.corrections].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
  corrections.forEach((correction) => {
    const existing = byTime.get(correction.timeMin)
    if (existing) {
      byTime.set(correction.timeMin, {
        ...existing,
        tempC: correction.tempC,
        corrected: true,
        correctionId: correction.id,
        rawTempC: existing.tempC,
      })
    } else {
      // 缺口内的人工校订：单独保留，绝不拿分段数据插值补齐
      byTime.set(correction.timeMin, {
        timeMin: correction.timeMin,
        tempC: correction.tempC,
        source: 'manual-only',
        corrected: true,
        correctionId: correction.id,
        isolatedInGap: true,
      })
    }
  })

  const samples = [...byTime.values()].sort((a, b) => a.timeMin - b.timeMin)
  const gaps = deriveGaps(ledger.segments)

  // 进一步确认 manual-only 点是否确实落在某个缺口内
  if (gaps.length) {
    samples.forEach((sample) => {
      if (sample.source === 'manual-only') {
        sample.isolatedInGap = gaps.some(
          (gap) => sample.timeMin > gap.startMin && sample.timeMin < gap.endMin,
        )
      }
    })
  }

  return { samples, gaps }
}

export function ledgerCoverageText(ledger: FiringLedger) {
  const merge = mergeLedger(ledger)
  if (!merge.samples.length) return '尚未导入实测温度'
  const first = merge.samples[0].timeMin
  const last = merge.samples.at(-1)!.timeMin
  return `${merge.samples.length} 点 · ${(first / 60).toFixed(1)}h–${(last / 60).toFixed(1)}h · ${ledger.segments.length} 段 · 缺口 ${merge.gaps.length} 处`
}

export function correctionSummary(correction: ManualCorrection) {
  return `${(correction.timeMin / 60).toFixed(2)}h → ${correction.tempC.toFixed(0)}℃`
}
