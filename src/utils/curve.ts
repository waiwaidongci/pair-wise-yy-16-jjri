import type {
  CurveTemplate,
  DeviationSummary,
  FiringPoint,
  FiringStage,
  KilnSession,
  LedgerMerge,
  RawSample,
  RiskIssue,
  SamplePoint,
} from '../types/firing'
import { mergeLedger } from './ledger'

export function sortPoints(points: FiringPoint[]) {
  return [...points].sort((a, b) => a.timeMin - b.timeMin)
}

export function buildStages(points: FiringPoint[]): FiringStage[] {
  const sorted = sortPoints(points)
  return sorted.slice(0, -1).map((start, index) => {
    const end = sorted[index + 1]
    const deltaTemp = end.tempC - start.tempC
    const durationMin = Math.max(0.1, end.timeMin - start.timeMin)
    const ratePerMin = deltaTemp / durationMin
    const type = Math.abs(deltaTemp) <= 1 ? 'hold' : deltaTemp > 0 ? 'heat' : 'cool'
    return {
      id: `${start.id}-${end.id}`,
      index,
      type,
      start,
      end,
      durationMin,
      deltaTemp,
      ratePerMin,
    }
  })
}

const CLAY_HEAT_LIMITS: Record<string, number> = {
  青瓷泥: 4.2,
  高白泥: 6,
  粗陶泥: 5,
  紫砂泥: 3.2,
  炻器泥: 5.5,
}

const GLAZE_RULES: Record<string, { minHold: number; coolLimit: number; peakRange: [number, number] }> = {
  天青釉: { minHold: 14, coolLimit: 1.8, peakRange: [1220, 1270] },
  柴烧落灰釉: { minHold: 20, coolLimit: 2.2, peakRange: [1240, 1320] },
  月白釉: { minHold: 12, coolLimit: 2, peakRange: [1250, 1300] },
  结晶釉: { minHold: 18, coolLimit: 1.5, peakRange: [1180, 1240] },
  乐烧釉: { minHold: 5, coolLimit: 8, peakRange: [900, 1050] },
}

export function validateCurve(session: KilnSession): RiskIssue[] {
  const issues: RiskIssue[] = []
  const stages = buildStages(session.points)
  const heatLimit = CLAY_HEAT_LIMITS[session.clay] ?? 5
  const glazeRule = GLAZE_RULES[session.glaze] ?? { minHold: 10, coolLimit: 2.5, peakRange: [1180, 1300] as [number, number] }

  stages.forEach((stage) => {
    if (stage.type === 'heat' && stage.ratePerMin > heatLimit) {
      issues.push({
        id: `heat-${stage.index}`,
        stageIndex: stage.index,
        severity: 'error',
        title: '升温速率超过泥料限制',
        message: `${session.clay}建议不超过 ${heatLimit.toFixed(1)} ℃/min，当前为 ${stage.ratePerMin.toFixed(2)} ℃/min。急剧升温可能导致胎体开裂，釉面针孔风险同步升高。`,
        metric: `${stage.ratePerMin.toFixed(2)} / ${heatLimit.toFixed(1)} ℃/min`,
      })
    }
    if (stage.type === 'hold' && stage.durationMin < glazeRule.minHold) {
      issues.push({
        id: `hold-${stage.index}`,
        stageIndex: stage.index,
        severity: 'warning',
        title: '保温时长不足',
        message: `${session.glaze}的成熟保温建议至少 ${glazeRule.minHold} 分钟，当前 ${stage.durationMin.toFixed(1)} 分钟，可能导致釉面生烧或光泽不均。`,
        metric: `${stage.durationMin.toFixed(1)} / ${glazeRule.minHold} min`,
      })
    }
    if (stage.type === 'cool' && Math.abs(stage.ratePerMin) > glazeRule.coolLimit) {
      issues.push({
        id: `cool-${stage.index}`,
        stageIndex: stage.index,
        severity: 'error',
        title: '降温速度可能造成釉面开裂',
        message: `${session.glaze}降温不应快于 ${glazeRule.coolLimit.toFixed(1)} ℃/min，当前为 ${Math.abs(stage.ratePerMin).toFixed(2)} ℃/min。晶体收缩差异会形成应力，建议增加缓冷台阶。`,
        metric: `${Math.abs(stage.ratePerMin).toFixed(2)} / ${glazeRule.coolLimit.toFixed(1)} ℃/min`,
      })
    }
  })

  const peak = Math.max(...session.points.map((point) => point.tempC))
  if (peak < glazeRule.peakRange[0] || peak > glazeRule.peakRange[1]) {
    issues.push({
      id: 'peak-temp',
      stageIndex: stages.length - 1,
      severity: peak > glazeRule.peakRange[1] ? 'error' : 'warning',
      title: peak > glazeRule.peakRange[1] ? '最高温度超过釉料安全范围' : '最高温度低于成熟温度',
      message: `${session.glaze}建议最高温度为 ${glazeRule.peakRange[0]}–${glazeRule.peakRange[1]} ℃，当前峰值 ${peak.toFixed(0)} ℃。`,
      metric: `${peak.toFixed(0)} ℃`,
    })
  }
  return issues
}

/** 基于合并后的实测账检查风险；时间偏移已体现在调用方传入的采样上 */
function assessActualRisks(session: KilnSession, merged: LedgerMerge): RiskIssue[] {
  const issues: RiskIssue[] = []
  const heatLimit = CLAY_HEAT_LIMITS[session.clay] ?? 5
  const coolLimit = GLAZE_RULES[session.glaze]?.coolLimit ?? 2.5
  const samples = merged.samples

  // 缺口内不插值，逐段计算相邻实测点的升降温速率
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1]
    const current = samples[index]
    const deltaMin = current.timeMin - previous.timeMin
    if (deltaMin < 1) continue
    if (merged.gaps.some((gap) => previous.timeMin >= gap.startMin && current.timeMin <= gap.endMin && gap.missingDurationMin > 0)) {
      continue
    }
    const rate = (current.tempC - previous.tempC) / deltaMin
    if (rate > heatLimit) {
      issues.push({
        id: `actual-heat-${current.timeMin}`,
        stageIndex: -1,
        severity: 'warning',
        title: '实测升温偏快',
        message: `${(current.timeMin / 60).toFixed(2)}h 处实测升温 ${rate.toFixed(2)} ℃/min，超过 ${session.clay}建议的 ${heatLimit.toFixed(1)} ℃/min，请关注该段胎体应力。`,
        metric: `${rate.toFixed(2)} / ${heatLimit.toFixed(1)} ℃/min`,
      })
    }
    if (Math.abs(rate) > coolLimit && rate < 0) {
      issues.push({
        id: `actual-cool-${current.timeMin}`,
        stageIndex: -1,
        severity: 'warning',
        title: '实测降温偏快',
        message: `${(current.timeMin / 60).toFixed(2)}h 处实测降温 ${Math.abs(rate).toFixed(2)} ℃/min，快于 ${session.glaze}建议的 ${coolLimit.toFixed(1)} ℃/min。`,
        metric: `${Math.abs(rate).toFixed(2)} / ${coolLimit.toFixed(1)} ℃/min`,
      })
    }
  }

  merged.gaps.forEach((gap, index) => {
    issues.push({
      id: `gap-${gap.startMin}-${gap.endMin}-${index}`,
      stageIndex: -1,
      severity: 'warning',
      title: '记录仪缺口已单独保留',
      message: `${(gap.startMin / 60).toFixed(2)}h–${(gap.endMin / 60).toFixed(2)}h 停电断网约 ${gap.missingDurationMin.toFixed(0)} 分钟（${gap.lastObservedC.toFixed(0)}℃→${gap.nextObservedC.toFixed(0)}℃），该段未插值补齐，偏差统计不含缺口内部。`,
      metric: `${gap.missingDurationMin.toFixed(0)} min`,
    })
  })

  return issues
}

/** 风险结果 = 目标曲线规则 + 实测账规则，共用同一份账，随签名统一失效重算 */
export function assessSessionRisks(session: KilnSession, merged: LedgerMerge): RiskIssue[] {
  return [...validateCurve(session), ...assessActualRisks(session, merged)]
}

export function interpolateTemperature(points: FiringPoint[], timeMin: number) {
  const sorted = sortPoints(points)
  if (!sorted.length) return 0
  if (timeMin <= sorted[0].timeMin) return sorted[0].tempC
  if (timeMin >= sorted.at(-1)!.timeMin) return sorted.at(-1)!.tempC
  for (let index = 0; index < sorted.length - 1; index += 1) {
    const current = sorted[index]
    const next = sorted[index + 1]
    if (timeMin >= current.timeMin && timeMin <= next.timeMin) {
      const duration = next.timeMin - current.timeMin || 1
      const ratio = (timeMin - current.timeMin) / duration
      return current.tempC + (next.tempC - current.tempC) * ratio
    }
  }
  return sorted.at(-1)!.tempC
}

export function calculateDeviation(
  points: FiringPoint[],
  samples: ReadonlyArray<SamplePoint>,
  offsetMin: number,
): DeviationSummary {
  if (!samples.length) {
    return {
      sampleCount: 0,
      meanAbs: 0,
      maxAbs: 0,
      maxAtMin: 0,
      maxTarget: 0,
      maxActual: 0,
    }
  }
  const deviations = samples.map((sample) => {
    const actual = sample.tempC
    const target = interpolateTemperature(points, sample.timeMin + offsetMin)
    return { timeMin: sample.timeMin, target, actual, deviation: actual - target }
  })
  const max = deviations.reduce((largest, item) =>
    Math.abs(item.deviation) > Math.abs(largest.deviation) ? item : largest,
  )
  return {
    sampleCount: samples.length,
    meanAbs:
      deviations.reduce((sum, item) => sum + Math.abs(item.deviation), 0) / deviations.length,
    maxAbs: Math.abs(max.deviation),
    maxAtMin: max.timeMin,
    maxTarget: max.target,
    maxActual: max.actual,
  }
}

export function createActualSamples(points: FiringPoint[], seed = 1): RawSample[] {
  const end = Math.max(...points.map((point) => point.timeMin))
  const samples: RawSample[] = []
  for (let time = 0; time <= end; time += 5) {
    const target = interpolateTemperature(points, time)
    const shift = Math.sin((time + seed * 7) / 35) * 12
    const sensorLag = time > 120 && time < 330 ? -16 : 0
    const noise = Math.sin((time + seed) * 1.73) * 4
    samples.push({
      id: `sample-${seed}-${time}`,
      timeMin: time,
      tempC: Math.max(20, target + shift + sensorLag + noise),
    })
  }
  return samples
}

export function cloneSession(session: KilnSession): KilnSession {
  return JSON.parse(JSON.stringify(session)) as KilnSession
}

export function templateToPoints(template: CurveTemplate, targetSessionId: string): FiringPoint[] {
  return template.points.map((point, index) => ({
    ...point,
    id: `point-${targetSessionId}-${index}-${crypto.randomUUID().slice(0, 6)}`,
  }))
}

export function sessionDomain(sessions: KilnSession[]) {
  const points = sessions.flatMap((session) => session.points)
  const samples = sessions.flatMap((session) =>
    mergeLedger(session.ledger).samples.map((sample) => ({
      ...sample,
      timeMin: sample.timeMin + session.timeOffsetMin,
    })),
  )
  return {
    maxTime: Math.max(480, ...points.map((point) => point.timeMin), ...samples.map((sample) => sample.timeMin)) * 1.04,
    maxTemp: Math.max(1300, ...points.map((point) => point.tempC), ...samples.map((sample) => sample.tempC)) * 1.04,
  }
}
