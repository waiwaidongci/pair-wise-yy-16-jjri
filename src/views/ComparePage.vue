<script setup lang="ts">
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import Button from 'primevue/button'
import Checkbox from 'primevue/checkbox'
import Tag from 'primevue/tag'
import { useFiringStore } from '../stores/firingStore'
import type { KilnSession, LedgerMerge } from '../types/firing'
import CurveChart from '../components/CurveChart.vue'

const store = useFiringStore()
const { visibleSessions, activeSession } = storeToRefs(store)
const provideMerged = (session: KilnSession): LedgerMerge => store.getDerived(session).merged
const comparisonRows = computed(() =>
  visibleSessions.value.map((session) => {
    const derived = store.getDerived(session)
    const peak = Math.max(...session.points.map((point) => point.tempC))
    return {
      session,
      deviation: derived.deviation,
      risks: derived.risks,
      gapCount: derived.merged.gaps.length,
      segmentCount: session.ledger.segments.length,
      correctedCount: derived.merged.samples.filter((sample) => sample.corrected).length,
      peak,
    }
  }),
)
</script>

<template>
  <div class="page-stack">
    <section class="page-heading">
      <div>
        <span class="eyebrow">多窑次叠加</span>
        <h2>曲线对齐与偏差比较</h2>
        <p>每窑次按分段记录与人工校订合并为同一份账，虚线缺口不插值；偏移变化立即重算。</p>
      </div>
      <Button label="返回编辑" icon="pi pi-pencil" outlined @click="$router.push('/editor')" />
    </section>

    <section class="compare-layout">
      <article class="compare-card">
        <CurveChart
          :sessions="visibleSessions"
          :active-session-id="activeSession.id"
          :interactive="false"
          :show-actual="true"
          :actual-provider="provideMerged"
        />
      </article>
      <aside class="compare-side">
        <div class="panel-title">
          <strong>叠加窑次</strong>
          <span>最多可选择全部窑次</span>
        </div>
        <label
          v-for="session in store.sessions"
          :key="session.id"
          class="session-toggle"
          :class="{ 'session-toggle--active': session.id === activeSession.id }"
        >
          <Checkbox
            :model-value="session.id === activeSession.id || store.overlaySessionIds.includes(session.id)"
            binary
            :disabled="session.id === activeSession.id"
            @update:model-value="store.toggleOverlay(session.id)"
          />
          <span>
            <strong>{{ session.name }}</strong>
            <small>{{ session.clay }} / {{ session.glaze }} · {{ session.ledger.segments.length }} 段</small>
          </span>
          <Tag v-if="session.id === activeSession.id" value="当前" severity="danger" />
        </label>
      </aside>
    </section>

    <section class="content-card">
      <div class="panel-title panel-title--row">
        <div><strong>窑次对比明细</strong><span>偏差、风险与曲线均由同一份烧成账即时重算，不再各留旧结果</span></div>
      </div>
      <div class="comparison-table">
        <div class="comparison-row comparison-row--header">
          <span>窑次</span><span>泥料 / 釉料</span><span>峰值</span><span>平均偏差</span><span>最大偏差</span><span>来源 / 校订 / 缺口</span><span>风险</span><span>状态</span>
        </div>
        <div v-for="row in comparisonRows" :key="row.session.id" class="comparison-row">
          <strong>{{ row.session.name }}</strong>
          <span>{{ row.session.clay }} / {{ row.session.glaze }}</span>
          <span>{{ row.peak }} ℃</span>
          <span>{{ row.deviation.meanAbs.toFixed(1) }} ℃</span>
          <span>{{ row.deviation.maxAbs.toFixed(1) }} ℃</span>
          <span class="ledger-cell">{{ row.segmentCount }} 段 / {{ row.correctedCount }} 校订 / {{ row.gapCount }} 缺口</span>
          <Tag :value="row.risks.length ? `${row.risks.length} 项` : '通过'" :severity="row.risks.length ? 'warn' : 'success'" />
          <Tag :value="row.session.status === 'completed' ? '已完成' : row.session.status === 'review' ? '待复核' : '草稿'" :severity="row.session.status === 'completed' ? 'success' : row.session.status === 'review' ? 'warn' : 'secondary'" />
        </div>
      </div>
    </section>
  </div>
</template>
