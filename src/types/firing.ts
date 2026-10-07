export interface FiringPoint {
  id: string
  timeMin: number
  tempC: number
}

/** 时间-温度读数，分段原始采样、人工校订点与合并结果共用的最小结构 */
export interface SamplePoint {
  timeMin: number
  tempC: number
}

export interface RawSample extends SamplePoint {
  id: string
}

/** 记录仪导出的一段 CSV（停电断网后同一窑次常拆成多段） */
export interface SampleSegment {
  id: string
  fileName: string
  sourceLabel: string
  importedAt: string
  firstAtMin: number
  lastAtMin: number
  sampleCount: number
  rawSamples: RawSample[]
}

/** 班组长手工校订的温度点，按烧成经过时间定位 */
export interface ManualCorrection {
  id: string
  timeMin: number
  tempC: number
  reason: string
  updatedAt: string
}

/** 相邻分段之间停电断网造成的缺口 */
export interface LedgerGap {
  startMin: number
  lastObservedC: number
  endMin: number
  nextObservedC: number
  /** 断档时长（扣除正常采样间隔后净缺失的分钟数） */
  missingDurationMin: number
}

/**
 * 烧成账：窑次下实测数据的唯一事实来源。
 * 分段记录 + 人工校订点合并而成；缺口由分段覆盖情况推算，不入库。
 */
export interface FiringLedger {
  /** 旧版 actualSamples 升级而来：整份采样迁成一段 */
  migratedFromLegacy?: boolean
  segments: SampleSegment[]
  corrections: ManualCorrection[]
}

/** 合并后的单个实测点，带来源与校订标记，曲线/偏差/对比共用 */
export interface MergedSample extends SamplePoint {
  source: 'segment' | 'manual-only'
  segmentId?: string
  segmentFileName?: string
  corrected: boolean
  correctionId?: string
  /** 校订前的记录仪原始温度 */
  rawTempC?: number
  /** 落在缺口内部（只有人工校订、两侧无分段采样） */
  isolatedInGap?: boolean
}

export interface LedgerMerge {
  samples: MergedSample[]
  gaps: LedgerGap[]
}

/** 导入失败的暂存记录：原账不动，内容留着可重试 */
export interface FailedImport {
  id: string
  fileName: string
  reason: string
  content: string
  at: string
}

export type StageType = 'heat' | 'hold' | 'cool'

export interface FiringStage {
  id: string
  index: number
  type: StageType
  start: FiringPoint
  end: FiringPoint
  durationMin: number
  deltaTemp: number
  ratePerMin: number
}

export interface CurveTemplate {
  id: string
  name: string
  clay: string
  glaze: string
  peakTempC: number
  description: string
  points: Array<Omit<FiringPoint, 'id'>>
  updatedAt: string
}

export interface KilnSession {
  id: string
  name: string
  kiln: string
  clay: string
  glaze: string
  firedAt: string
  status: 'draft' | 'completed' | 'review'
  timeOffsetMin: number
  points: FiringPoint[]
  /** 烧成账：分段记录与人工校订的唯一归属 */
  ledger: FiringLedger
}

export interface RiskIssue {
  id: string
  stageIndex: number
  severity: 'error' | 'warning'
  title: string
  message: string
  metric: string
}

export interface DeviationSummary {
  sampleCount: number
  meanAbs: number
  maxAbs: number
  maxAtMin: number
  maxTarget: number
  maxActual: number
}

/** 曲线编辑、偏差、风险与对比共用的派生结果；签名变化即失效重算 */
export interface DerivedResults {
  signature: string
  recomputedAt: string
  merged: LedgerMerge
  deviation: DeviationSummary
  risks: RiskIssue[]
}
