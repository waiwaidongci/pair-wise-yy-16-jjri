<script setup lang="ts">
import { computed, ref } from 'vue'
import { storeToRefs } from 'pinia'
import Button from 'primevue/button'
import InputText from 'primevue/inputtext'
import Select from 'primevue/select'
import Tag from 'primevue/tag'
import Dialog from 'primevue/dialog'
import { useFiringStore } from '../stores/firingStore'
import { CsvParseError, parseTemperatureCsv } from '../utils/csv'
import { ledgerCoverageText, mergeLedger } from '../utils/ledger'
import type { FailedImport } from '../types/firing'

const store = useFiringStore()
const { activeSession, activeFailedImports } = storeToRefs(store)
const fileInput = ref<HTMLInputElement>()
const importMessage = ref<{ kind: 'ok' | 'error'; text: string } | null>(null)
const correctionOpen = ref(false)
const correctionForm = ref({ timeMin: 0, tempC: 20, reason: '' })

const merged = computed(() => mergeLedger(activeSession.value.ledger))
const segments = computed(() => activeSession.value.ledger.segments)
const corrections = computed(() => activeSession.value.ledger.corrections)
const gaps = computed(() => merged.value.gaps)
/** 校订点在合并账中的落点：用于展示原读数与是否位于缺口内 */
const correctionEffect = computed(() => {
  const map = new Map<string, { rawTempC?: number; isolatedInGap?: boolean }>()
  merged.value.samples.forEach((sample) => {
    if (sample.correctionId) {
      map.set(sample.correctionId, { rawTempC: sample.rawTempC, isolatedInGap: sample.isolatedInGap })
    }
  })
  return map
})

function openFile() {
  fileInput.value?.click()
}

/** 解析并入一段 CSV；任何失败都保留原账，原始内容留档后可一键重试 */
async function importCsv(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (file) await ingest(await file.text(), file.name)
  ;(event.target as HTMLInputElement).value = ''
}

function ingest(content: string, fileName: string) {
  try {
    const { samples } = parseTemperatureCsv(content, fileName)
    // 解析成功才动账：同名文件重导只替换该段，其他段与人工校订不受影响
    store.importSegment(samples, fileName)
    importMessage.value = { kind: 'ok', text: `已并入「${fileName}」${samples.length} 点；重叠处人工校订优先，其余段保持不变。` }
    return true
  } catch (error) {
    const reason = error instanceof CsvParseError ? error.message : (error as Error).message
    store.recordImportFailure(fileName, reason, content)
    importMessage.value = { kind: 'error', text: `「${fileName}」导入失败，原烧成账未改动：${reason}` }
    return false
  }
}

function retryFailed(failed: FailedImport) {
  if (ingest(failed.content, failed.fileName)) {
    store.dismissFailedImport(failed.id)
  }
}

function openCorrectionForm(timeMin?: number) {
  const sample = timeMin === undefined ? undefined : merged.value.samples.find((item) => item.timeMin === timeMin)
  correctionForm.value = {
    timeMin: timeMin ?? merged.value.samples.at(-1)?.timeMin ?? 0,
    tempC: sample?.tempC ?? sample?.rawTempC ?? 20,
    reason: '',
  }
  correctionOpen.value = true
}

function saveCorrection() {
  store.addCorrection({ ...correctionForm.value })
  correctionOpen.value = false
}

function fmtHour(min: number) {
  return `${(min / 60).toFixed(2)}h`
}
</script>

<template>
  <div class="page-stack">
    <section class="page-heading">
      <div>
        <span class="eyebrow">窑次档案</span>
        <h2>窑次与烧成账</h2>
        <p>停电断网后按段导入记录仪 CSV，系统按时间归并；人工校订优先，缺口单独保留，不插值补齐。</p>
      </div>
      <Button label="新建窑次" icon="pi pi-plus" @click="store.addSession" />
    </section>

    <section class="sessions-grid">
      <article class="session-list-card">
        <div class="panel-title panel-title--row">
          <div><strong>全部窑次</strong><span>{{ store.sessions.length }} 条记录</span></div>
        </div>
        <button
          v-for="session in store.sessions"
          :key="session.id"
          type="button"
          class="session-card"
          :class="{ 'session-card--active': session.id === activeSession.id }"
          @click="store.setActiveSession(session.id)"
        >
          <div class="session-card__top">
            <strong>{{ session.name }}</strong>
            <Tag :value="session.status === 'completed' ? '已完成' : session.status === 'review' ? '待复核' : '草稿'" :severity="session.status === 'completed' ? 'success' : session.status === 'review' ? 'warn' : 'secondary'" />
          </div>
          <span>{{ session.kiln }} · {{ session.firedAt }}</span>
          <div class="session-card__meta">
            <span>{{ session.points.length }} 个关键点</span>
            <span>{{ session.ledger.segments.length }} 段 / {{ session.ledger.corrections.length }} 校订</span>
          </div>
        </button>
      </article>

      <article class="session-detail">
        <div class="panel-title panel-title--row">
          <div><strong>{{ activeSession.name }}</strong><span>窑次信息与分段记录</span></div>
          <Button icon="pi pi-trash" label="删除" severity="danger" text :disabled="store.sessions.length <= 1" @click="store.removeSession(activeSession.id)" />
        </div>
        <div class="form-grid">
          <label><span>窑次名称</span><InputText :model-value="activeSession.name" @update:model-value="store.updateSessionMeta({ name: $event })" /></label>
          <label><span>窑炉</span><InputText :model-value="activeSession.kiln" @update:model-value="store.updateSessionMeta({ kiln: $event })" /></label>
          <label><span>泥料</span>
            <Select
              :model-value="activeSession.clay"
              :options="['青瓷泥', '高白泥', '粗陶泥', '紫砂泥', '炻器泥']"
              @update:model-value="store.updateSessionMeta({ clay: $event })"
            />
          </label>
          <label><span>釉料</span>
            <Select
              :model-value="activeSession.glaze"
              :options="['天青釉', '月白釉', '柴烧落灰釉', '结晶釉', '乐烧釉']"
              @update:model-value="store.updateSessionMeta({ glaze: $event })"
            />
          </label>
          <label class="form-span"><span>烧成时间</span><InputText :model-value="activeSession.firedAt" @update:model-value="store.updateSessionMeta({ firedAt: $event })" /></label>
        </div>

        <div class="import-box import-box--stacked">
          <input ref="fileInput" class="hidden-input" type="file" accept=".csv,text/csv" @change="importCsv" />
          <div class="import-box__main">
            <div class="import-icon"><i class="pi pi-file-import" /></div>
            <div>
              <strong>并入一段记录仪 CSV</strong>
              <span>支持 time,temp 或 时间,温度 表头；分钟或 hh:mm:ss。多段按时间合并，重导同名文件只替换该段。</span>
            </div>
          </div>
          <div class="import-box__actions">
            <Button label="选择文件" icon="pi pi-upload" outlined @click="openFile" />
            <Button v-if="segments.length" label="清空整账" severity="danger" text @click="store.clearLedger" />
          </div>
        </div>
        <p v-if="importMessage" class="import-message" :class="`import-message--${importMessage.kind}`">{{ importMessage.text }}</p>

        <!-- 导入失败留档：原账保留，内容暂存可重试 -->
        <div v-if="activeFailedImports.length" class="failed-box">
          <div class="failed-box__title">
            <strong><i class="pi pi-exclamation-triangle" /> 导入失败待处理（原账未受影响）</strong>
            <span>{{ activeFailedImports.length }} 个文件</span>
          </div>
          <div v-for="failed in activeFailedImports" :key="failed.id" class="failed-item">
            <div>
              <strong>{{ failed.fileName }}</strong>
              <span>{{ failed.reason }}</span>
              <small>{{ new Date(failed.at).toLocaleString('zh-CN', { hour12: false }) }}</small>
            </div>
            <div class="failed-item__actions">
              <Button size="small" label="重试导入" icon="pi pi-refresh" @click="retryFailed(failed)" />
              <Button size="small" severity="secondary" text label="放弃" @click="store.dismissFailedImport(failed.id)" />
            </div>
          </div>
        </div>

        <div class="sample-summary">
          <strong>当前烧成账</strong>
          <span>{{ ledgerCoverageText(activeSession.ledger) }}</span>
          <Tag v-if="activeSession.ledger.migratedFromLegacy" value="旧账已迁移" severity="info" />
          <Button size="small" label="新增人工校订" icon="pi pi-pencil" outlined @click="openCorrectionForm()" />
        </div>

        <div class="ledger-grid">
          <section class="ledger-block">
            <div class="ledger-block__head"><strong>分段记录（{{ segments.length }}）</strong><span>归并前后均保留每段来源</span></div>
            <div v-if="!segments.length" class="ledger-empty">尚未导入任何分段。</div>
            <div v-for="segment in segments" :key="segment.id" class="ledger-row">
              <div>
                <strong><i class="pi pi-file" />{{ segment.fileName }}</strong>
                <span>{{ segment.sourceLabel }} · {{ segment.sampleCount }} 点 · {{ fmtHour(segment.firstAtMin) }}–{{ fmtHour(segment.lastAtMin) }}</span>
                <small>{{ new Date(segment.importedAt).toLocaleString('zh-CN', { hour12: false }) }}</small>
              </div>
              <Button size="small" icon="pi pi-trash" severity="danger" text @click="store.removeSegment(segment.id)" />
            </div>
          </section>

          <section class="ledger-block">
            <div class="ledger-block__head"><strong>停电断网缺口（{{ gaps.length }}）</strong><span>单独保留，曲线断线不插值</span></div>
            <div v-if="!gaps.length" class="ledger-empty">各段时间连续，未发现缺口。</div>
            <div v-for="(gap, index) in gaps" :key="`${gap.startMin}-${gap.endMin}-${index}`" class="ledger-row ledger-row--gap">
              <div>
                <strong><i class="pi pi-unlink" />{{ fmtHour(gap.startMin) }} – {{ fmtHour(gap.endMin) }}</strong>
                <span>缺约 {{ gap.missingDurationMin.toFixed(0) }} 分钟 · {{ gap.lastObservedC.toFixed(0) }}℃ → {{ gap.nextObservedC.toFixed(0) }}℃</span>
              </div>
              <Button size="small" label="在缺口补校订" text @click="openCorrectionForm((gap.startMin + gap.endMin) / 2)" />
            </div>
          </section>

          <section class="ledger-block ledger-block--wide">
            <div class="ledger-block__head"><strong>人工校订点（{{ corrections.length }}）</strong><span>重叠处优先于记录仪读数</span></div>
            <div v-if="!corrections.length" class="ledger-empty">班组长尚未修正温度。</div>
            <div class="correction-grid correction-grid--header">
              <span>经过时间</span><span>校订温度</span><span>原读数</span><span>说明</span><span>位置</span><span></span>
            </div>
            <div v-for="correction in corrections" :key="correction.id" class="correction-grid correction-row">
              <strong>{{ fmtHour(correction.timeMin) }}</strong>
              <strong>{{ correction.tempC.toFixed(0) }} ℃</strong>
              <span>{{ correctionEffect.get(correction.id)?.rawTempC?.toFixed(0) ?? '—' }}<template v-if="correctionEffect.get(correction.id)?.rawTempC !== undefined"> ℃</template></span>
              <span class="correction-reason">{{ correction.reason }}</span>
              <Tag
                :value="correctionEffect.get(correction.id)?.isolatedInGap ? '缺口内' : '覆盖段上'"
                :severity="correctionEffect.get(correction.id)?.isolatedInGap ? 'danger' : 'warn'"
              />
              <span class="correction-actions">
                <Button size="small" icon="pi pi-trash" severity="danger" text @click="store.removeCorrection(correction.id)" />
              </span>
            </div>
          </section>
        </div>
      </article>
    </section>

    <Dialog v-model:visible="correctionOpen" header="新增人工校订点" :style="{ width: '440px' }" modal>
      <div class="dialog-field correction-form">
        <label><span>经过时间（分钟）</span><InputText :model-value="String(correctionForm.timeMin)" type="number" step="0.5" @update:model-value="(v) => (correctionForm.timeMin = Number(v))" /></label>
        <label><span>修正温度（℃）</span><InputText :model-value="String(correctionForm.tempC)" type="number" @update:model-value="(v) => (correctionForm.tempC = Number(v))" /></label>
        <label class="dialog-field--full"><span>修正说明</span><InputText v-model="correctionForm.reason" placeholder="例如：热电偶接触不良，按邻段趋势修正" /></label>
      </div>
      <template #footer>
        <Button label="取消" severity="secondary" text @click="correctionOpen = false" />
        <Button label="保存校订" @click="saveCorrection" />
      </template>
    </Dialog>
  </div>
</template>

<style scoped>
.import-box--stacked { display: flex; flex-direction: column; align-items: stretch; gap: 10px; }
.import-box__main { display: grid; grid-template-columns: 42px 1fr; gap: 13px; align-items: center; }
.import-box__actions { display: flex; gap: 8px; justify-content: flex-end; }
.import-message { margin: 10px 16px 0; padding: 9px 11px; border-radius: 6px; font-size: 10px; }
.import-message--ok { background: #eef5f2; color: #4f7669; }
.import-message--error { background: #fdece7; color: #a6452f; }
.failed-box { margin: 12px 16px 0; border: 1px solid #ecc9bd; border-radius: 8px; background: #fdf6f3; }
.failed-box__title { display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; border-bottom: 1px solid #f2ddd3; }
.failed-box__title strong { color: #a2442e; font-size: 11px; }
.failed-box__title i { margin-right: 5px; }
.failed-box__title span { color: #b08d80; font-size: 9px; }
.failed-item { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 9px 12px; }
.failed-item + .failed-item { border-top: 1px solid #f4e4dc; }
.failed-item strong, .failed-item span, .failed-item small { display: block; }
.failed-item strong { color: #6e4738; font-size: 11px; }
.failed-item span { margin-top: 2px; color: #b1644c; font-size: 9px; }
.failed-item small { color: #b7a298; font-size: 8px; }
.failed-item__actions { display: flex; align-items: center; gap: 4px; flex: 0 0 auto; }
.ledger-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; padding: 0 16px; margin-top: 14px; }
.ledger-block { border: 1px solid #ece3dd; border-radius: 8px; background: #fff; }
.ledger-block--wide { grid-column: 1 / -1; }
.ledger-block__head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; padding: 10px 12px; border-bottom: 1px solid #f1eae5; }
.ledger-block__head strong { color: #533d33; font-size: 11px; }
.ledger-block__head span { color: #a79187; font-size: 9px; }
.ledger-empty { padding: 14px 12px; color: #ab988d; font-size: 10px; }
.ledger-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 9px 12px; }
.ledger-row + .ledger-row { border-top: 1px solid #f6f0ec; }
.ledger-row strong, .ledger-row span, .ledger-row small { display: block; }
.ledger-row strong { color: #5c4438; font-size: 10px; }
.ledger-row strong i { margin-right: 6px; color: #c08a6e; }
.ledger-row span { margin-top: 3px; color: #97827a; font-size: 9px; }
.ledger-row small { margin-top: 2px; color: #bdaca2; font-size: 8px; }
.ledger-row--gap strong { color: #a2442e; }
.correction-grid { display: grid; grid-template-columns: 90px 90px 80px 1fr 80px 56px; gap: 8px; align-items: center; padding: 8px 12px; }
.correction-grid--header { color: #a9958a; font-size: 9px; }
.correction-grid--header { padding-bottom: 4px; }
.correction-row + .correction-row { border-top: 1px solid #f6f0ec; }
.correction-row strong { color: #5c4438; font-size: 10px; }
.correction-row span { color: #8e796e; font-size: 9px; }
.correction-reason { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.correction-actions { display: flex; justify-content: flex-end; }
.correction-form { grid-template-columns: 1fr 1fr; }
.correction-form .dialog-field--full { grid-column: 1 / -1; }
@media (max-width: 1400px) {
  .ledger-grid { grid-template-columns: 1fr; }
}
</style>
