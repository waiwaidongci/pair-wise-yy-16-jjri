<script setup lang="ts">
import { computed, ref } from 'vue'
import { storeToRefs } from 'pinia'
import Button from 'primevue/button'
import InputText from 'primevue/inputtext'
import Tag from 'primevue/tag'
import { useFiringStore } from '../stores/firingStore'
import { parseTemperatureCsv } from '../utils/csv'
import type { KilnSession } from '../types/firing'

const props = defineProps<{ session: KilnSession }>()

const store = useFiringStore()
const { activeAccount, lastFailedImport } = storeToRefs(store)

const fileInput = ref<HTMLInputElement>()
const importMessage = ref('')
const importError = ref('')
const correctionTime = ref('')
const correctionTemp = ref('')
const correctionNote = ref('')

const account = computed(() =>
  store.accountBySession.get(props.session.id) ?? activeAccount.value,
)
const segments = computed(() =>
  [...(props.session.segments ?? [])].sort((a, b) => b.importedAt.localeCompare(a.importedAt)),
)
const corrections = computed(() =>
  [...(props.session.corrections ?? [])].sort((a, b) => a.timeMin - b.timeMin),
)
const hasData = computed(() => account.value.samples.length > 0)

function openFile() {
  fileInput.value?.click()
}

async function importCsv(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return
  const content = await file.text()
  const result = store.importCsvSegment(file.name, content)
  if (result.ok) {
    importError.value = ''
    importMessage.value = `已导入 ${file.name}：${result.warning ? '' : ''}${result.warning ?? ''} 当前共 ${account.value.samples.length} 个采样点（${segments.value.length} 段）。`
  } else {
    importError.value = result.error ?? '导入失败，原账未改动。'
    importMessage.value = ''
  }
  ;(event.target as HTMLInputElement).value = ''
}

function retryImport() {
  const result = store.retryLastImport()
  if (result.ok) {
    importError.value = ''
    importMessage.value = `重试成功：当前共 ${account.value.samples.length} 个采样点（${segments.value.length} 段）。`
  } else {
    importError.value = result.error ?? '重试失败，原账未改动。'
  }
}

function addCorrection() {
  const timeMin = Number(correctionTime.value)
  const tempC = Number(correctionTemp.value)
  if (Number.isNaN(timeMin) || Number.isNaN(tempC)) return
  store.addCorrection(timeMin, tempC, correctionNote.value)
  correctionTime.value = ''
  correctionTemp.value = ''
  correctionNote.value = ''
}

function formatTime(min: number) {
  const hours = Math.floor(min / 60)
  const minutes = Math.round(min % 60)
  return hours > 0 ? `${hours}h${minutes.toString().padStart(2, '0')}` : `${minutes}min`
}

function formatRange(range: [number, number] | null) {
  if (!range) return '—'
  return `${formatTime(range[0])} → ${formatTime(range[1])}`
}
</script>

<template>
  <section class="ledger">
    <div class="ledger__head">
      <div>
        <strong>烧成账</strong>
        <span>分段记录按时间与来源合并，人工校订优先，缺口单独保留</span>
      </div>
      <Tag v-if="hasData" :value="`${segments.length} 段 · ${account.samples.length} 点`" severity="info" />
      <Tag v-else value="无数据" severity="secondary" />
    </div>

    <div class="import-box">
      <input ref="fileInput" class="hidden-input" type="file" accept=".csv,text/csv" @change="importCsv" />
      <div class="import-icon"><i class="pi pi-file-import" /></div>
      <div>
        <strong>导入记录仪 CSV（一段）</strong>
        <span>停电断网后重导一段不会整批替换，而是并入同一窑次；支持 time,temp 或 时间,温度。</span>
      </div>
      <Button label="选择文件" icon="pi pi-upload" outlined @click="openFile" />
      <Button
        v-if="lastFailedImport"
        label="重试导入"
        icon="pi pi-replay"
        severity="warn"
        outlined
        @click="retryImport"
      />
    </div>
    <p v-if="importError" class="import-message import-message--error">
      <i class="pi pi-exclamation-triangle" /> {{ importError }}
    </p>
    <p v-else-if="importMessage" class="import-message">{{ importMessage }}</p>

    <div class="ledger-grid">
      <article class="ledger-block">
        <div class="ledger-block__head">
          <strong>分段记录</strong>
          <span>{{ segments.length }} 段 · 归并前后均可见来源</span>
        </div>
        <div v-if="segments.length" class="segment-list">
          <div v-for="segment in segments" :key="segment.id" class="segment-row">
            <span class="segment-row__main">
              <i class="pi pi-file" />
              <span>
                <strong>{{ segment.source }}</strong>
                <small>{{ formatRange(segment.timeRange) }} · {{ segment.sampleCount }} 点 · {{ new Date(segment.importedAt).toLocaleString('zh-CN', { hour12: false }) }}</small>
              </span>
            </span>
            <Button icon="pi pi-times" text rounded severity="danger" @click="store.removeSegment(segment.id)" />
          </div>
        </div>
        <div v-else class="ledger-empty">尚未导入分段记录。</div>
      </article>

      <article class="ledger-block">
        <div class="ledger-block__head">
          <strong>缺口</strong>
          <span>{{ account.gaps.length }} 处 · 无数据区间单独保留</span>
        </div>
        <div v-if="account.gaps.length" class="gap-list">
          <div v-for="gap in account.gaps" :key="gap.id" class="gap-row">
            <i class="pi pi-minus-circle" />
            <span>
              <strong>{{ formatTime(gap.fromMin) }} → {{ formatTime(gap.toMin) }}</strong>
              <small>缺口 {{ gap.durationMin.toFixed(0) }} 分钟（停电/断网区间）</small>
            </span>
          </div>
        </div>
        <div v-else class="ledger-empty">合并后无缺口。</div>
      </article>
    </div>

    <article class="ledger-block">
      <div class="ledger-block__head">
        <strong>人工校订点</strong>
        <span>{{ corrections.length }} 点 · 重叠处优先于分段采样</span>
      </div>
      <div v-if="corrections.length" class="correction-list">
        <div v-for="correction in corrections" :key="correction.id" class="correction-row">
          <span class="correction-row__main">
            <i class="pi pi-pencil" />
            <span>
              <strong>{{ formatTime(correction.timeMin) }} · {{ correction.tempC.toFixed(0) }} ℃</strong>
              <small v-if="correction.note">{{ correction.note }}</small>
              <small v-else>校订于 {{ new Date(correction.correctedAt).toLocaleString('zh-CN', { hour12: false }) }}</small>
            </span>
          </span>
          <Button icon="pi pi-times" text rounded severity="danger" @click="store.removeCorrection(correction.id)" />
        </div>
      </div>
      <div class="correction-form">
        <label>
          <span>时间 (min)</span>
          <InputText v-model="correctionTime" type="number" placeholder="例如 120" />
        </label>
        <label>
          <span>温度 (℃)</span>
          <InputText v-model="correctionTemp" type="number" placeholder="例如 980" />
        </label>
        <label class="correction-form__note">
          <span>备注（可选）</span>
          <InputText v-model="correctionNote" placeholder="例如 热电偶偏差修正" />
        </label>
        <Button label="添加校订" icon="pi pi-check" outlined @click="addCorrection" />
      </div>
    </article>

    <div class="sample-summary">
      <strong>合并实测</strong>
      <span v-if="hasData">
        {{ account.samples.length }} 点 · {{ account.sources.length }} 段来源 · {{ account.gaps.length }} 处缺口 · 校订 {{ account.correctionCount }} 点
      </span>
      <span v-else>尚未导入实测温度</span>
    </div>
  </section>
</template>

<style scoped>
.ledger { display: grid; gap: 14px; margin-top: 15px; }
.ledger__head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.ledger__head strong, .ledger__head span { display: block; }
.ledger__head strong { color: #4b352c; font-size: 14px; }
.ledger__head span { margin-top: 3px; color: #9a877d; font-size: 10px; }
.import-box { display: grid; align-items: center; gap: 13px; padding: 14px; border: 1px dashed #d8c3b8; border-radius: 8px; background: #fdf9f6; grid-template-columns: 42px 1fr auto auto; }
.import-icon { display: grid; width: 40px; height: 40px; place-items: center; border-radius: 8px; background: #f3dfd4; color: #b4512f; font-size: 18px; }
.import-box strong, .import-box span { display: block; }
.import-box strong { color: #5c4034; font-size: 12px; }
.import-box span { margin-top: 3px; color: #997f73; font-size: 9px; }
.import-message { display: flex; align-items: center; gap: 6px; margin: 0; padding: 9px 11px; border-radius: 6px; background: #eef5f2; color: #4f7669; font-size: 10px; }
.import-message--error { background: #fdece8; color: #b14733; }
.ledger-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.ledger-block { border: 1px solid #eee4dd; border-radius: 8px; background: #fcfaf8; }
.ledger-block__head { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 11px 13px; border-bottom: 1px solid #eee4dd; }
.ledger-block__head strong { color: #5c4034; font-size: 12px; }
.ledger-block__head span { color: #9a877d; font-size: 9px; }
.ledger-empty { padding: 16px; color: #a8968d; font-size: 10px; }
.segment-list, .gap-list, .correction-list { display: grid; gap: 1px; }
.segment-row, .gap-row, .correction-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 9px 13px; border-bottom: 1px solid #f0e9e4; }
.segment-row:last-child, .gap-row:last-child, .correction-row:last-child { border-bottom: 0; }
.segment-row__main, .correction-row__main { display: flex; align-items: center; gap: 9px; min-width: 0; }
.segment-row__main > i { color: #b4512f; }
.gap-row > i { color: #c98a3a; }
.correction-row__main > i { color: #447f8a; }
.segment-row__main span, .gap-row span, .correction-row__main span { display: grid; gap: 2px; min-width: 0; }
.segment-row__main strong, .gap-row strong, .correction-row__main strong { color: #50382e; font-size: 11px; }
.segment-row__main small, .gap-row small, .correction-row__main small { color: #9b897f; font-size: 9px; }
.correction-form { display: grid; grid-template-columns: 1fr 1fr auto; gap: 9px; padding: 11px 13px; border-top: 1px solid #eee4dd; }
.correction-form label { display: grid; gap: 4px; color: #816b60; font-size: 9px; }
.correction-form input { height: 32px; padding: 0 8px; border: 1px solid #d9cbc1; border-radius: 6px; font-size: 11px; }
.correction-form__note { grid-column: span 2; }
.sample-summary { display: flex; align-items: center; justify-content: space-between; padding-top: 12px; border-top: 1px solid #eee7e2; color: #8c776c; font-size: 10px; }
.sample-summary strong { color: #554037; font-size: 11px; }
.hidden-input { display: none; }
</style>
