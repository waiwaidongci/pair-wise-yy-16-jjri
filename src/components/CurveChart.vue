<script setup lang="ts">
import { computed, ref } from 'vue'
import type { FiringPoint, KilnSession, LedgerMerge, MergedSample } from '../types/firing'
import { sessionDomain, sortPoints } from '../utils/curve'
import { mergeLedger } from '../utils/ledger'

const props = withDefaults(
  defineProps<{
    sessions: KilnSession[]
    activeSessionId: string
    selectedPointId?: string | null
    interactive?: boolean
    showActual?: boolean
    /** 曲线/偏差/风险/对比共用同一份合并结果；缺省时按账即时合并 */
    actualProvider?: (session: KilnSession) => LedgerMerge
  }>(),
  {
    selectedPointId: null,
    interactive: true,
    showActual: true,
    actualProvider: undefined,
  },
)

const emit = defineEmits<{
  selectPoint: [pointId: string]
  updatePoint: [pointId: string, timeMin: number, tempC: number]
  beginDrag: []
  endDrag: []
}>()

const svgRef = ref<SVGSVGElement>()
const draggingId = ref<string | null>(null)
const width = 1060
const height = 520
const padding = { top: 26, right: 30, bottom: 54, left: 62 }
const plotWidth = width - padding.left - padding.right
const plotHeight = height - padding.top - padding.bottom
const domain = computed(() => sessionDomain(props.sessions))
const activeSession = computed(
  () => props.sessions.find((session) => session.id === props.activeSessionId) ?? props.sessions[0],
)

function mergedOf(session: KilnSession): LedgerMerge {
  return props.actualProvider ? props.actualProvider(session) : mergeLedger(session.ledger)
}

/**
 * 应用时间偏移后的实测序列：
 * - 缺口处断线，绝不跨缺口插值连线；
 * - 缺口内的人工校订（manual-only）只作标记，不参与折线；
 * - 校订点单独收集用于圆点/菱形标记。
 */
const actualSeries = computed(() =>
  props.sessions.map((session) => {
    const merged = mergedOf(session)
    const offset = session.timeOffsetMin
    const lineSamples = merged.samples
      .filter((sample) => sample.source !== 'manual-only')
      .map((sample) => ({ ...sample, plotTime: sample.timeMin + offset }))
    const withinGap = (timeMin: number) =>
      merged.gaps.some((gap) => timeMin > gap.startMin && timeMin < gap.endMin && gap.missingDurationMin > 0)
    const crossesGap = (a: { timeMin: number }, b: { timeMin: number }) =>
      merged.gaps.some((gap) => a.timeMin <= gap.startMin + 0.001 && b.timeMin >= gap.endMin - 0.001)

    const paths: string[] = []
    let buffer: typeof lineSamples = []
    lineSamples.forEach((sample, index) => {
      if (index > 0 && crossesGap(lineSamples[index - 1], sample)) {
        paths.push(toPath(buffer))
        buffer = []
      }
      buffer.push(sample)
    })
    if (buffer.length) paths.push(toPath(buffer))

    const corrections = merged.samples
      .filter((sample) => sample.corrected && !withinGap(sample.timeMin) && sample.source !== 'manual-only')
      .map((sample) => ({ ...sample, plotTime: sample.timeMin + offset }))
    const gapCorrections = merged.samples
      .filter((sample) => sample.source === 'manual-only' || (sample.corrected && withinGap(sample.timeMin)))
      .map((sample) => ({ ...sample, plotTime: sample.timeMin + offset }))
    return { session, paths, corrections, gapCorrections }
  }),
)

function xScale(timeMin: number) {
  return padding.left + (timeMin / domain.value.maxTime) * plotWidth
}

function yScale(tempC: number) {
  return padding.top + plotHeight - (tempC / domain.value.maxTemp) * plotHeight
}

function path(points: FiringPoint[]) {
  return sortPoints(points)
    .map((point, index) => `${index ? 'L' : 'M'} ${xScale(point.timeMin).toFixed(2)} ${yScale(point.tempC).toFixed(2)}`)
    .join(' ')
}

function toPath(samples: Array<MergedSample & { plotTime: number }>) {
  return samples
    .map((sample, index) => `${index ? 'L' : 'M'} ${xScale(sample.plotTime).toFixed(2)} ${yScale(sample.tempC).toFixed(2)}`)
    .join(' ')
}

const timeTicks = computed(() => {
  const step = domain.value.maxTime > 720 ? 120 : 60
  return Array.from({ length: Math.floor(domain.value.maxTime / step) + 1 }, (_, index) => index * step)
})
const tempTicks = computed(() => [0, 200, 400, 600, 800, 1000, 1200, 1400])

function localPoint(event: PointerEvent) {
  const svg = svgRef.value
  if (!svg) return { timeMin: 0, tempC: 0 }
  const rect = svg.getBoundingClientRect()
  const x = ((event.clientX - rect.left) / rect.width) * width
  const y = ((event.clientY - rect.top) / rect.height) * height
  return {
    timeMin: Math.max(0, ((x - padding.left) / plotWidth) * domain.value.maxTime),
    tempC: Math.max(0, ((padding.top + plotHeight - y) / plotHeight) * domain.value.maxTemp),
  }
}

function startDrag(pointId: string, event: PointerEvent) {
  if (!props.interactive) return
  draggingId.value = pointId
  emit('selectPoint', pointId)
  emit('beginDrag')
  ;(event.currentTarget as SVGElement).setPointerCapture(event.pointerId)
}

function moveDrag(event: PointerEvent) {
  if (!draggingId.value || !props.interactive) return
  const next = localPoint(event)
  emit('updatePoint', draggingId.value, next.timeMin, next.tempC)
}

function endDrag() {
  if (!draggingId.value) return
  draggingId.value = null
  emit('endDrag')
}

function sessionColor(index: number) {
  return ['#b6532f', '#447f8a', '#8a6d3b', '#76568c', '#3f8f58'][index % 5]
}
</script>

<template>
  <div class="curve-chart">
    <svg
      ref="svgRef"
      :viewBox="`0 0 ${width} ${height}`"
      role="img"
      aria-label="窑炉目标曲线与实际温度曲线"
      @pointermove="moveDrag"
      @pointerup="endDrag"
      @pointercancel="endDrag"
      @pointerleave="endDrag"
    >
      <defs>
        <linearGradient id="heatZone" x1="0" y1="1" x2="0" y2="0">
          <stop offset="0" stop-color="#f4efe5" />
          <stop offset="1" stop-color="#f7e4d3" />
        </linearGradient>
        <filter id="pointShadow" x="-50%" y="-50%" width="200%" height="200%">
          <feDropShadow dx="0" dy="2" stdDeviation="2" flood-color="#4a271d" flood-opacity=".28" />
        </filter>
      </defs>
      <rect :x="padding.left" :y="padding.top" :width="plotWidth" :height="plotHeight" fill="url(#heatZone)" rx="5" />

      <g class="grid-lines">
        <g v-for="tick in tempTicks" :key="`temp-${tick}`">
          <line :x1="padding.left" :x2="width - padding.right" :y1="yScale(tick)" :y2="yScale(tick)" />
          <text :x="padding.left - 12" :y="yScale(tick) + 4" text-anchor="end">{{ tick }}</text>
        </g>
        <g v-for="tick in timeTicks" :key="`time-${tick}`">
          <line :x1="xScale(tick)" :x2="xScale(tick)" :y1="padding.top" :y2="height - padding.bottom" />
          <text :x="xScale(tick)" :y="height - padding.bottom + 23" text-anchor="middle">{{ (tick / 60).toFixed(0) }}h</text>
        </g>
      </g>

      <g class="axis-labels">
        <text :x="padding.left - 42" :y="padding.top + 8">℃</text>
        <text :x="width - padding.right" :y="height - 15" text-anchor="end">烧成经过时间（小时）</text>
      </g>

      <g v-for="(series, index) in actualSeries" :key="`actual-${series.session.id}`" class="curve-series">
        <template v-if="showActual">
          <path
            v-for="(d, pathIndex) in series.paths"
            :key="pathIndex"
            :d="d"
            fill="none"
            :stroke="series.session.id === activeSessionId ? '#2e6f76' : sessionColor(index + 1)"
            :stroke-width="series.session.id === activeSessionId ? 2.2 : 1.3"
            :opacity="series.session.id === activeSessionId ? .9 : .25"
            class="actual-curve"
          />
          <!-- 人工校订点：覆盖段上的为圆点，缺口内单独保留的为菱形 -->
          <template v-if="series.session.id === activeSessionId">
            <circle
              v-for="sample in series.corrections"
              :key="`corr-${sample.correctionId}`"
              :cx="xScale(sample.plotTime)"
              :cy="yScale(sample.tempC)"
              r="4.5"
              class="correction-mark"
            >
              <title>人工校订 {{ (sample.timeMin / 60).toFixed(2) }}h：{{ sample.rawTempC?.toFixed(0) }}℃ → {{ sample.tempC.toFixed(0) }}℃</title>
            </circle>
            <rect
              v-for="sample in series.gapCorrections"
              :key="`gapcorr-${sample.correctionId}`"
              :x="xScale(sample.plotTime) - 4.5"
              :y="yScale(sample.tempC) - 4.5"
              width="9"
              height="9"
              transform="rotate(45)"
              :transform-origin="`${xScale(sample.plotTime)} ${yScale(sample.tempC)}`"
              class="correction-mark correction-mark--gap"
            >
              <title>缺口内人工校订 {{ (sample.timeMin / 60).toFixed(2) }}h：{{ sample.tempC.toFixed(0) }}℃（未插值补齐）</title>
            </rect>
          </template>
        </template>
      </g>

      <g v-for="(session, index) in sessions" :key="session.id" class="curve-series">
        <path
          v-if="session.id !== activeSessionId"
          :d="path(session.points)"
          fill="none"
          :stroke="sessionColor(index + 1)"
          stroke-width="2"
          stroke-dasharray="7 5"
          opacity=".55"
          class="overlay-curve"
        />
        <path
          v-if="session.id === activeSessionId"
          :d="path(session.points)"
          fill="none"
          :stroke="sessionColor(index)"
          stroke-width="3.2"
          class="target-curve"
        />
      </g>

      <g v-if="activeSession" class="point-layer">
        <g
          v-for="point in activeSession.points"
          :key="point.id"
          class="curve-point"
          :class="{ 'curve-point--selected': point.id === selectedPointId }"
        >
          <circle
            :cx="xScale(point.timeMin)"
            :cy="yScale(point.tempC)"
            :r="point.id === selectedPointId ? 9 : 7"
            @pointerdown="startDrag(point.id, $event)"
          />
          <text
            v-if="point.id === selectedPointId"
            :x="xScale(point.timeMin)"
            :y="yScale(point.tempC) - 16"
            text-anchor="middle"
          >
            {{ point.tempC }}℃ · {{ (point.timeMin / 60).toFixed(2) }}h
          </text>
        </g>
      </g>
    </svg>
    <div class="chart-legend">
      <span><i class="legend-target" />目标曲线</span>
      <span><i class="legend-actual" />实际记录</span>
      <span><i class="legend-correction" />人工校订</span>
      <span><i class="legend-overlay" />叠加窑次</span>
      <span class="chart-hint">虚线缺口为停电断网，未插值补齐；拖动圆点调整温度与到达时间</span>
    </div>
  </div>
</template>

<style scoped>
.curve-chart { width: 100%; }
svg { display: block; width: 100%; height: auto; overflow: visible; touch-action: none; user-select: none; }
.grid-lines line { stroke: rgba(83, 61, 45, .12); stroke-width: 1; }
.grid-lines text, .axis-labels text { fill: #8a7366; font-size: 11px; }
.axis-labels text { font-weight: 600; }
.target-curve { filter: drop-shadow(0 2px 3px rgba(182, 83, 47, .18)); }
.actual-curve { stroke-dasharray: 5 4; }
.correction-mark { fill: #e08a2b; stroke: #fff8f1; stroke-width: 1.6; }
.correction-mark--gap { fill: #c0452f; }
.curve-point circle {
  fill: #fff8f1;
  stroke: #aa4e2d;
  stroke-width: 2.5;
  cursor: grab;
  filter: url(#pointShadow);
}
.curve-point circle:active { cursor: grabbing; }
.curve-point--selected circle { fill: #b6532f; stroke: #fff; stroke-width: 3; }
.curve-point text { fill: #653521; font-size: 11px; font-weight: 700; }
.chart-legend { display: flex; align-items: center; gap: 18px; padding: 0 12px 4px 60px; color: #7f6b60; font-size: 11px; }
.chart-legend span { display: flex; align-items: center; gap: 6px; }
.chart-legend i { display: inline-block; width: 24px; height: 3px; border-radius: 2px; }
.legend-target { background: #b6532f; }
.legend-actual { background: repeating-linear-gradient(90deg, #2e6f76 0 6px, transparent 6px 10px); }
.legend-correction { width: 10px; height: 10px; border-radius: 50%; background: #e08a2b; }
.legend-overlay { background: #447f8a; opacity: .5; }
.chart-hint { margin-left: auto; }
</style>
