import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { createMockSessions, MOCK_TEMPLATES } from '../data/mockSessions'
import type {
  CorrectionPoint,
  CurveTemplate,
  FiringPoint,
  FiringSample,
  KilnSession,
  SegmentRecord,
  SessionAccount,
} from '../types/firing'
import { cloneSession, templateToPoints } from '../utils/curve'
import {
  computeSessionAccount,
  createCorrection,
  createSegmentFromImport,
  migrateSession,
  recomputeSessionDerived,
} from '../utils/ledger'
import { parseTemperatureCsv } from '../utils/csv'

const STORAGE_KEY = 'pair-wise-yy-16-firing-studio'

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) as {
      sessions: KilnSession[]
      templates: CurveTemplate[]
      activeSessionId: string
      overlaySessionIds: string[]
    } : null
  } catch {
    return null
  }
}

export const useFiringStore = defineStore('firing-studio', () => {
  const persisted = loadState()
  // 旧数据升级：把整份采样迁成一段记录；归并前后都能看见来源与缺口
  const loadedSessions = (persisted?.sessions?.length ? persisted.sessions : createMockSessions()).map(migrateSession)
  const sessions = ref<KilnSession[]>(loadedSessions)
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
  /** 导入失败的文件，保留原账并可重试 */
  const lastFailedImport = ref<{ filename: string; content: string } | null>(null)

  const activeSession = computed(
    () => sessions.value.find((session) => session.id === activeSessionId.value) ?? sessions.value[0],
  )
  const visibleSessions = computed(() => {
    const ids = new Set([activeSessionId.value, ...overlaySessionIds.value])
    return sessions.value.filter((session) => ids.has(session.id))
  })
  const canUndo = computed(() => undoStack.value.length > 0)
  const canRedo = computed(() => redoStack.value.length > 0)

  /**
   * 同一份烧成账：窑次 + 分段 + 校订 + 缺口 + 偏差/风险结果。
   * 偏差、风险、对比都从这里取，目标曲线或时间偏移变化时立即失效重算。
   */
  const accountBySession = computed(() => {
    const map = new Map<string, SessionAccount>()
    for (const session of sessions.value) {
      map.set(session.id, computeSessionAccount(session))
    }
    return map
  })
  const activeAccount = computed(
    () => accountBySession.value.get(activeSessionId.value) ?? computeSessionAccount(activeSession.value),
  )

  function persist() {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        sessions: sessions.value,
        templates: templates.value,
        activeSessionId: activeSessionId.value,
        overlaySessionIds: overlaySessionIds.value,
      }),
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
    for (const session of sessions.value) recomputeSessionDerived(session)
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

  /**
   * 导入一段 CSV 记录。失败时保留原账、不改任何数据，并记住文件以便重试。
   * 成功则新增一段（不替换整批），合并后校订优先、缺口保留。
   */
  function importCsvSegment(
    filename: string,
    content: string,
  ): { ok: boolean; error?: string; warning?: string } {
    const session = activeSession.value
    const parsed = parseTemperatureCsv(content)
    if (!parsed.samples.length) {
      lastFailedImport.value = { filename, content }
      return {
        ok: false,
        error: '未解析到有效记录：请确认 CSV 含 time,temp（或 时间,温度）列，且数值为有效数字。原账未改动，可重试。',
      }
    }
    recordHistory()
    const segment = createSegmentFromImport(session.id, filename, parsed.samples)
    session.segments = [...(session.segments ?? []), segment]
    recomputeSessionDerived(session)
    session.status = 'review'
    lastFailedImport.value = null
    sessions.value = [...sessions.value]
    persist()
    const warning = parsed.skippedCount > 0 ? `有 ${parsed.skippedCount} 行因时间或温度无效被跳过。` : undefined
    return { ok: true, warning }
  }

  /** 重试上次失败的导入 */
  function retryLastImport(): { ok: boolean; error?: string; warning?: string } {
    const last = lastFailedImport.value
    if (!last) return { ok: false, error: '没有可重试的导入。' }
    return importCsvSegment(last.filename, last.content)
  }

  function clearActualSamples() {
    recordHistory()
    const session = activeSession.value
    session.actualSamples = []
    session.segments = []
    session.corrections = []
    sessions.value = [...sessions.value]
    persist()
  }

  function setTimeOffset(offsetMin: number) {
    activeSession.value.timeOffsetMin = Number(offsetMin.toFixed(1))
    persist()
  }

  function updateSessionMeta(patch: Partial<Pick<KilnSession, 'name' | 'kiln' | 'clay' | 'glaze' | 'firedAt' | 'status'>>) {
    recordHistory()
    Object.assign(activeSession.value, patch)
    persist()
  }

  /** 新增一条人工校订点，重叠处优先于分段采样 */
  function addCorrection(timeMin: number, tempC: number, note?: string) {
    recordHistory()
    const session = activeSession.value
    session.corrections = [...(session.corrections ?? []), createCorrection(session.id, timeMin, tempC, note)]
    recomputeSessionDerived(session)
    sessions.value = [...sessions.value]
    persist()
  }

  function removeCorrection(id: string) {
    recordHistory()
    const session = activeSession.value
    session.corrections = (session.corrections ?? []).filter((item) => item.id !== id)
    recomputeSessionDerived(session)
    sessions.value = [...sessions.value]
    persist()
  }

  function removeSegment(id: string) {
    recordHistory()
    const session = activeSession.value
    session.segments = (session.segments ?? []).filter((item) => item.id !== id)
    recomputeSessionDerived(session)
    sessions.value = [...sessions.value]
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
      actualSamples: [],
      segments: [],
      corrections: [],
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

  function exportSessionJson() {
    const account = activeAccount.value
    const payload = {
      schema: 'kiln-firing-curve/v1',
      exportedAt: new Date().toISOString(),
      session: activeSession.value,
      ledger: {
        sources: account.sources,
        gaps: account.gaps,
        correctionCount: account.correctionCount,
        deviation: account.deviation,
        issues: account.issues,
      },
      timeAlignment: {
        offsetMin: activeSession.value.timeOffsetMin,
        basis: 'actual elapsed time + offset vs target arrival time',
      },
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${activeSession.value.name}-烧成账.json`
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
    canUndo,
    canRedo,
    accountBySession,
    activeAccount,
    lastFailedImport,
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
    importCsvSegment,
    retryLastImport,
    clearActualSamples,
    setTimeOffset,
    updateSessionMeta,
    addCorrection,
    removeCorrection,
    removeSegment,
    addSession,
    removeSession,
    toggleOverlay,
    exportSessionJson,
  }
})
