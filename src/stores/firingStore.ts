import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { createMockSessions, MOCK_TEMPLATES } from '../data/mockSessions'
import type {
  CurveTemplate,
  DerivedResults,
  FailedImport,
  KilnSession,
  ManualCorrection,
  RawSample,
} from '../types/firing'
import { cloneSession, templateToPoints, validateCurve } from '../utils/curve'
import { getDerivedResults } from '../utils/derived'
import { buildSegment, emptyLedger, legacySamplesToLedger } from '../utils/ledger'

const STORAGE_KEY = 'pair-wise-yy-16-firing-studio'

interface PersistedState {
  sessions: KilnSession[]
  templates: CurveTemplate[]
  activeSessionId: string
  overlaySessionIds: string[]
  failedImports?: Record<string, FailedImport[]>
}

/** 旧版窑次（actualSamples 平铺）升级：整份采样迁成一段记录，保留迁移痕迹 */
function normalizeSession(raw: KilnSession & { actualSamples?: RawSample[] }): KilnSession {
  const legacy = raw.actualSamples ?? []
  return {
    ...raw,
    ledger: legacy.length ? legacySamplesToLedger(legacy) : emptyLedger(),
  }
}

function loadState(): PersistedState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as PersistedState
    return { ...parsed, sessions: (parsed.sessions ?? []).map(normalizeSession) }
  } catch {
    return null
  }
}

export const useFiringStore = defineStore('firing-studio', () => {
  const persisted = loadState()
  const sessions = ref<KilnSession[]>(persisted?.sessions?.length ? persisted.sessions : createMockSessions())
  const templates = ref<CurveTemplate[]>(persisted?.templates?.length ? persisted.templates : MOCK_TEMPLATES)
  const activeSessionId = ref(
    persisted?.activeSessionId && sessions.value.some((item) => item.id === persisted.activeSessionId)
      ? persisted.activeSessionId
      : sessions.value[0].id,
  )
  const overlaySessionIds = ref<string[]>(
    persisted?.overlaySessionIds?.filter((id) => sessions.value.some((item) => item.id === id))
      ?? sessions.value.slice(1, 3).map((item) => item.id),
  )
  const selectedPointId = ref<string | null>(sessions.value[0].points[0]?.id ?? null)
  const selectedStageIndex = ref<number | null>(0)
  const undoStack = ref<Array<{ sessions: KilnSession[]; activeSessionId: string }>>([])
  const redoStack = ref<Array<{ sessions: KilnSession[]; activeSessionId: string }>>([])
  const dragHistoryPending = ref(false)
  /** 导入失败的原始内容按窑次暂存：原账不动，修正后可重试 */
  const failedImports = ref<Record<string, FailedImport[]>>(persisted?.failedImports ?? {})
  /** 偏差/风险/对比的派生结果缓存：签名不匹配即重算（非响应式，按需读取） */
  const derivedCache = new Map<string, DerivedResults>()

  const activeSession = computed(
    () => sessions.value.find((session) => session.id === activeSessionId.value) ?? sessions.value[0],
  )
  const validationIssues = computed(() => validateCurve(activeSession.value))
  const visibleSessions = computed(() => {
    const ids = new Set([activeSessionId.value, ...overlaySessionIds.value])
    return sessions.value.filter((session) => ids.has(session.id))
  })
  const canUndo = computed(() => undoStack.value.length > 0)
  const canRedo = computed(() => redoStack.value.length > 0)
  const activeFailedImports = computed(() => failedImports.value[activeSessionId.value] ?? [])

  function persist() {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        sessions: sessions.value,
        templates: templates.value,
        activeSessionId: activeSessionId.value,
        overlaySessionIds: overlaySessionIds.value,
        failedImports: failedImports.value,
      } satisfies PersistedState),
    )
  }

  function snapshot() {
    return {
      sessions: sessions.value.map(cloneSession),
      activeSessionId: activeSessionId.value,
    }
  }

  function recordHistory() {
    undoStack.value.push(snapshot())
    if (undoStack.value.length > 40) undoStack.value.shift()
    redoStack.value = []
  }

  function restore(snapshotState: { sessions: KilnSession[]; activeSessionId: string }) {
    sessions.value = snapshotState.sessions.map(cloneSession)
    activeSessionId.value = snapshotState.activeSessionId
    selectedPointId.value = activeSession.value.points[0]?.id ?? null
    selectedStageIndex.value = 0
    persist()
  }

  function undo() {
    const previous = undoStack.value.pop()
    if (!previous) return
    redoStack.value.push(snapshot())
    restore(previous)
  }

  function redo() {
    const next = redoStack.value.pop()
    if (!next) return
    undoStack.value.push(snapshot())
    restore(next)
  }

  function beginDrag() {
    if (!dragHistoryPending.value) {
      recordHistory()
      dragHistoryPending.value = true
    }
  }

  function endDrag() {
    dragHistoryPending.value = false
    persist()
  }

  function setActiveSession(id: string) {
    if (!sessions.value.some((session) => session.id === id)) return
    activeSessionId.value = id
    selectedPointId.value = activeSession.value.points[0]?.id ?? null
    selectedStageIndex.value = 0
    persist()
  }

  function updatePoint(pointId: string, timeMin: number, tempC: number, record = true) {
    if (record) recordHistory()
    const session = activeSession.value
    const sorted = [...session.points].sort((a, b) => a.timeMin - b.timeMin)
    const index = sorted.findIndex((point) => point.id === pointId)
    const previous = sorted[index - 1]
    const next = sorted[index + 1]
    const minTime = previous ? previous.timeMin + 1 : 0
    const maxTime = next ? next.timeMin - 1 : 1440
    session.points = session.points.map((point) =>
      point.id === pointId
        ? {
            ...point,
            timeMin: Math.round(Math.min(maxTime, Math.max(minTime, timeMin))),
            tempC: Math.round(Math.min(1450, Math.max(0, tempC))),
          }
        : point,
    )
    sessions.value = [...sessions.value]
    persist()
  }

  function addPointAfterStage(stageIndex: number) {
    recordHistory()
    const stages = [...activeSession.value.points].sort((a, b) => a.timeMin - b.timeMin)
    const start = stages[stageIndex]
    const end = stages[stageIndex + 1]
    if (!start || !end) return
    const middleTime = Math.round((start.timeMin + end.timeMin) / 2)
    const middleTemp = Math.round((start.tempC + end.tempC) / 2)
    const point = {
      id: `point-${crypto.randomUUID()}`,
      timeMin: middleTime,
      tempC: middleTemp,
    }
    activeSession.value.points = [...activeSession.value.points, point]
    selectedPointId.value = point.id
    selectedStageIndex.value = stageIndex + 1
    persist()
  }

  function removePoint(pointId: string) {
    if (activeSession.value.points.length <= 3) return
    recordHistory()
    activeSession.value.points = activeSession.value.points.filter((point) => point.id !== pointId)
    selectedPointId.value = activeSession.value.points[0]?.id ?? null
    selectedStageIndex.value = 0
    persist()
  }

  function applyTemplate(templateId: string) {
    const template = templates.value.find((item) => item.id === templateId)
    if (!template) return
    recordHistory()
    activeSession.value.points = templateToPoints(template, activeSession.value.id)
    activeSession.value.clay = template.clay
    activeSession.value.glaze = template.glaze
    selectedPointId.value = activeSession.value.points[0]?.id ?? null
    selectedStageIndex.value = 0
    persist()
  }

  function saveTemplateFromSession(name: string) {
    const template: CurveTemplate = {
      id: crypto.randomUUID(),
      name: name.trim() || `${activeSession.value.name} 模板`,
      clay: activeSession.value.clay,
      glaze: activeSession.value.glaze,
      peakTempC: Math.max(...activeSession.value.points.map((point) => point.tempC)),
      description: `从 ${activeSession.value.name} 保存，包含 ${activeSession.value.points.length} 个关键点。`,
      points: activeSession.value.points.map(({ timeMin, tempC }) => ({ timeMin, tempC })),
      updatedAt: new Date().toISOString(),
    }
    templates.value.unshift(template)
    persist()
  }

  // ── 烧成账：分段导入 ─────────────────────────────────────────────

  /**
   * 并入一段记录仪 CSV 的解析结果。
   * 同名文件重导只替换该段，其余分段与人工校订原样保留；
   * 解析在调用方完成，解析失败不会走到这里，原账自然不动。
   */
  function importSegment(samples: RawSample[], fileName: string, sourceLabel = '记录仪导出') {
    const segment = buildSegment(samples, fileName, sourceLabel)
    if (!segment) return
    recordHistory()
    const ledger = activeSession.value.ledger
    const existingIndex = ledger.segments.findIndex((item) => item.fileName === fileName)
    if (existingIndex >= 0) {
      ledger.segments.splice(existingIndex, 1, segment)
    } else {
      ledger.segments.push(segment)
    }
    ledger.segments.sort((a, b) => a.firstAtMin - b.firstAtMin)
    activeSession.value.status = 'review'
    sessions.value = [...sessions.value]
    persist()
  }

  function removeSegment(segmentId: string) {
    recordHistory()
    const ledger = activeSession.value.ledger
    ledger.segments = ledger.segments.filter((segment) => segment.id !== segmentId)
    persist()
  }

  function clearLedger() {
    recordHistory()
    activeSession.value.ledger = emptyLedger()
    failedImports.value = { ...failedImports.value, [activeSessionId.value]: [] }
    persist()
  }

  // ── 烧成账：人工校订 ─────────────────────────────────────────────

  function addCorrection(input: { timeMin: number; tempC: number; reason: string }) {
    recordHistory()
    const correction: ManualCorrection = {
      id: `correction-${crypto.randomUUID()}`,
      timeMin: Number(input.timeMin.toFixed(2)),
      tempC: input.tempC,
      reason: input.reason.trim() || '班组长手工修正',
      updatedAt: new Date().toISOString(),
    }
    // 同一时刻只保留最新校订
    const ledger = activeSession.value.ledger
    ledger.corrections = ledger.corrections.filter((item) => item.timeMin !== correction.timeMin)
    ledger.corrections.push(correction)
    ledger.corrections.sort((a, b) => a.timeMin - b.timeMin)
    sessions.value = [...sessions.value]
    persist()
  }

  function updateCorrection(correctionId: string, patch: Partial<Pick<ManualCorrection, 'timeMin' | 'tempC' | 'reason'>>) {
    const correction = activeSession.value.ledger.corrections.find((item) => item.id === correctionId)
    if (!correction) return
    recordHistory()
    Object.assign(correction, patch, { updatedAt: new Date().toISOString() })
    activeSession.value.ledger.corrections = [...activeSession.value.ledger.corrections]
    persist()
  }

  function removeCorrection(correctionId: string) {
    recordHistory()
    activeSession.value.ledger.corrections = activeSession.value.ledger.corrections.filter(
      (item) => item.id !== correctionId,
    )
    persist()
  }

  // ── 导入失败：保留原账，留档可重试 ───────────────────────────────

  function recordImportFailure(fileName: string, reason: string, content: string) {
    const failed: FailedImport = {
      id: `failed-${crypto.randomUUID()}`,
      fileName,
      reason,
      content,
      at: new Date().toISOString(),
    }
    const list = failedImports.value[activeSessionId.value] ?? []
    failedImports.value = {
      ...failedImports.value,
      [activeSessionId.value]: [failed, ...list],
    }
    persist()
  }

  /** 重试成功后由导入流程调用，清掉对应留档 */
  function dismissFailedImport(failedId: string) {
    const list = failedImports.value[activeSessionId.value] ?? []
    failedImports.value = {
      ...failedImports.value,
      [activeSessionId.value]: list.filter((item) => item.id !== failedId),
    }
    persist()
  }

  // ── 时间偏移 ─────────────────────────────────────────────────────

  function setTimeOffset(offsetMin: number) {
    activeSession.value.timeOffsetMin = Number(offsetMin.toFixed(1))
    sessions.value = [...sessions.value]
    persist()
  }

  function updateSessionMeta(patch: Partial<Pick<KilnSession, 'name' | 'kiln' | 'clay' | 'glaze' | 'firedAt' | 'status'>>) {
    recordHistory()
    Object.assign(activeSession.value, patch)
    persist()
  }

  function addSession() {
    recordHistory()
    const source = activeSession.value
    const session: KilnSession = {
      ...cloneSession(source),
      id: crypto.randomUUID(),
      name: `新窑次 ${sessions.value.length + 1}`,
      firedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
      status: 'draft',
      ledger: emptyLedger(),
      points: source.points.map((point, index) => ({
        ...point,
        id: `point-new-${Date.now()}-${index}`,
      })),
    }
    sessions.value.unshift(session)
    activeSessionId.value = session.id
    selectedPointId.value = session.points[0]?.id ?? null
    persist()
  }

  function removeSession(id: string) {
    if (sessions.value.length <= 1) return
    recordHistory()
    sessions.value = sessions.value.filter((session) => session.id !== id)
    overlaySessionIds.value = overlaySessionIds.value.filter((sessionId) => sessionId !== id)
    delete failedImports.value[id]
    if (activeSessionId.value === id) activeSessionId.value = sessions.value[0].id
    selectedPointId.value = activeSession.value.points[0]?.id ?? null
    persist()
  }

  function toggleOverlay(id: string) {
    if (id === activeSessionId.value) return
    overlaySessionIds.value = overlaySessionIds.value.includes(id)
      ? overlaySessionIds.value.filter((sessionId) => sessionId !== id)
      : [...overlaySessionIds.value, id]
    persist()
  }

  /**
   * 取窑次的合并实测、偏差与风险。目标曲线/时间偏移/烧成账任一变化，
   * 签名不命中即整体重算并替换缓存；命中则复用同一份结果。
   */
  function getDerived(session: KilnSession): DerivedResults {
    const previous = derivedCache.get(session.id)
    const next = getDerivedResults(session, previous)
    if (previous !== next) {
      derivedCache.set(session.id, next)
    }
    return next
  }

  function exportSessionJson() {
    const derived = getDerived(activeSession.value)
    const payload = {
      schema: 'kiln-firing-curve/v2',
      exportedAt: new Date().toISOString(),
      session: activeSession.value,
      mergedActual: derived.merged,
      deviation: derived.deviation,
      risks: derived.risks,
      resultSignature: derived.signature,
      timeAlignment: {
        offsetMin: activeSession.value.timeOffsetMin,
        basis: 'actual elapsed time + offset vs target arrival time',
      },
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${activeSession.value.name}-烧成数据.json`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  return {
    sessions,
    templates,
    activeSessionId,
    activeSession,
    selectedPointId,
    selectedStageIndex,
    overlaySessionIds,
    visibleSessions,
    validationIssues,
    canUndo,
    canRedo,
    failedImports,
    activeFailedImports,
    undo,
    redo,
    beginDrag,
    endDrag,
    setActiveSession,
    updatePoint,
    addPointAfterStage,
    removePoint,
    applyTemplate,
    saveTemplateFromSession,
    importSegment,
    removeSegment,
    clearLedger,
    addCorrection,
    updateCorrection,
    removeCorrection,
    recordImportFailure,
    dismissFailedImport,
    setTimeOffset,
    updateSessionMeta,
    addSession,
    removeSession,
    toggleOverlay,
    getDerived,
    exportSessionJson,
  }
})
