<script setup lang="ts">
import { computed, ref } from 'vue'
import { storeToRefs } from 'pinia'
import Button from 'primevue/button'
import Select from 'primevue/select'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import { useFiringStore } from '../stores/firingStore'
import type { KilnSession, LedgerMerge } from '../types/firing'
import CurveChart from '../components/CurveChart.vue'
import StagePanel from '../components/StagePanel.vue'
import RiskSummary from '../components/RiskSummary.vue'
import DeviationPanel from '../components/DeviationPanel.vue'
import { buildStages } from '../utils/curve'

const store = useFiringStore()
const { activeSession, selectedPointId, selectedStageIndex, canUndo, canRedo } = storeToRefs(store)
const templateOpen = ref(false)
const templateName = ref('')
const stages = computed(() => buildStages(activeSession.value.points))
// 偏差、风险与图表共用同一份合并账结果；曲线或偏移一变即失效重算
const derived = computed(() => store.getDerived(activeSession.value))
const deviation = computed(() => derived.value.deviation)
const provideMerged = (session: KilnSession): LedgerMerge => store.getDerived(session).merged
const sessionOptions = computed(() =>
  store.sessions.map((session) => ({ label: session.name, value: session.id })),
)

function updateSelectedStage(index: number, field: 'duration' | 'targetTemp', value: number) {
  const stage = stages.value[index]
  if (!stage) return
  if (field === 'duration') {
    store.updatePoint(stage.end.id, stage.start.timeMin + Math.max(1, value), stage.end.tempC)
  } else {
    store.updatePoint(stage.end.id, stage.end.timeMin, value)
  }
  selectedStageIndex.value = index
}

function saveTemplate() {
  store.saveTemplateFromSession(templateName.value)
  templateOpen.value = false
  templateName.value = ''
}
</script>

<template>
  <div class="page-stack">
    <section class="page-heading">
      <div>
        <span class="eyebrow">当前窑次</span>
        <h2>{{ activeSession.name }}</h2>
        <p>{{ activeSession.kiln }} · {{ activeSession.clay }} / {{ activeSession.glaze }} · {{ activeSession.firedAt }}</p>
      </div>
      <div class="heading-actions">
        <Select
          :model-value="store.activeSessionId"
          :options="sessionOptions"
          option-label="label"
          option-value="value"
          class="session-select"
          @update:model-value="store.setActiveSession"
        />
        <Button icon="pi pi-undo" label="撤销" severity="secondary" outlined :disabled="!canUndo" @click="store.undo" />
        <Button icon="pi pi-redo" label="重做" severity="secondary" outlined :disabled="!canRedo" @click="store.redo" />
        <Button icon="pi pi-copy" label="保存模板" outlined @click="templateOpen = true" />
        <Button icon="pi pi-download" label="导出 JSON" @click="store.exportSessionJson" />
      </div>
    </section>

    <section class="editor-grid">
      <article class="chart-card">
        <div class="chart-toolbar">
          <div>
            <strong>目标烧成曲线</strong>
            <span>拖动关键点可同时调整温度与到达时间</span>
          </div>
          <div class="chart-metrics">
            <span>关键点 <strong>{{ activeSession.points.length }}</strong></span>
            <span>阶段 <strong>{{ stages.length }}</strong></span>
            <span>峰值 <strong>{{ Math.max(...activeSession.points.map((point) => point.tempC)) }} ℃</strong></span>
          </div>
        </div>
        <CurveChart
          :sessions="[activeSession]"
          :active-session-id="activeSession.id"
          :selected-point-id="selectedPointId"
          :actual-provider="provideMerged"
          @select-point="selectedPointId = $event"
          @update-point="(id, time, temp) => store.updatePoint(id, time, temp, false)"
          @begin-drag="store.beginDrag"
          @end-drag="store.endDrag"
        />
      </article>

      <aside class="side-panel">
        <StagePanel
          :stages="stages"
          :issues="derived.risks"
          :selected-index="selectedStageIndex"
          @select="selectedStageIndex = $event"
          @update="updateSelectedStage"
          @add-after="store.addPointAfterStage"
        />
      </aside>
    </section>

    <section class="lower-grid">
      <article class="detail-card">
        <DeviationPanel
          :summary="deviation"
          :offset-min="activeSession.timeOffsetMin"
          :gap-count="derived.merged.gaps.length"
          :corrected-count="derived.merged.samples.filter((s) => s.corrected).length"
          :signature="derived.signature"
          :recomputed-at="derived.recomputedAt"
          @update-offset="store.setTimeOffset"
        />
      </article>
      <article class="detail-card">
        <RiskSummary :issues="derived.risks" />
      </article>
    </section>

    <Dialog v-model:visible="templateOpen" header="从当前窑次保存模板" :style="{ width: '460px' }" modal>
      <div class="dialog-field">
        <label>模板名称</label>
        <InputText v-model="templateName" placeholder="例如：天青釉 1260 慢烧" />
      </div>
      <template #footer>
        <Button label="取消" severity="secondary" text @click="templateOpen = false" />
        <Button label="保存模板" @click="saveTemplate" />
      </template>
    </Dialog>
  </div>
</template>
