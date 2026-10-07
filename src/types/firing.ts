export interface FiringPoint {
  id: string
  timeMin: number
  tempC: number
}

export interface FiringSample {
  id: string
  timeMin: number
  tempC: number
}

/** 一段记录仪记录：一次 CSV 导入对应一段，保留来源与原始采样 */
export interface SegmentRecord {
  id: string
  sessionId: string
  /** 来源（文件名） */
  source: string
  importedAt: string
  /** 该段原始采样（未合并、未校订） */
  samples: FiringSample[]
  sampleCount: number
  /** 该段覆盖的时间区间 [min, max] */
  timeRange: [number, number] | null
  status: 'ok' | 'failed'
  errorMessage?: string
}

/** 班组长手工校订点：重叠处优先于分段采样 */
export interface CorrectionPoint {
  id: string
  sessionId: string
  timeMin: number
  tempC: number
  correctedAt: string
  note?: string
}

/** 合并后的采样，带来源标记 */
export interface MergedSample extends FiringSample {
  source: 'segment' | 'correction'
  sourceId: string
  sourceLabel: string
}

/** 缺口：相邻采样时间跨度过大的无数据区间 */
export interface DataGap {
  id: string
  sessionId: string
  fromMin: number
  toMin: number
  durationMin: number
}

/** 来源信息（用于烧成账展示） */
export interface SourceInfo {
  id: string
  label: string
  importedAt: string
  sampleCount: number
  timeRange: [number, number] | null
  status: 'ok' | 'failed'
}

/** 一份烧成账：窑次 + 分段 + 校订 + 缺口 + 偏差/风险结果 */
export interface SessionAccount {
  sessionId: string
  samples: MergedSample[]
  gaps: DataGap[]
  sources: SourceInfo[]
  correctionCount: number
  deviation: DeviationSummary
  issues: RiskIssue[]
}

/** CSV 解析结果 */
export interface CsvParseResult {
  samples: FiringSample[]
  skippedCount: number
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
  /** 合并后的实测采样（派生缓存，由 recomputeSession 维护；真实来源见 segments） */
  actualSamples: FiringSample[]
  /** 分段记录：一次导入一段，按时间与来源合并 */
  segments?: SegmentRecord[]
  /** 人工校订点：重叠处优先于分段采样 */
  corrections?: CorrectionPoint[]
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
