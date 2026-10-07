<script setup lang="ts">
import { storeToRefs } from 'pinia'
import Button from 'primevue/button'
import InputText from 'primevue/inputtext'
import Select from 'primevue/select'
import Tag from 'primevue/tag'
import { useFiringStore } from '../stores/firingStore'
import LedgerPanel from '../components/LedgerPanel.vue'

const store = useFiringStore()
const { activeSession } = storeToRefs(store)
</script>

<template>
  <div class="page-stack">
    <section class="page-heading">
      <div>
        <span class="eyebrow">窑次档案</span>
        <h2>窑次与烧成账</h2>
        <p>维护泥料、釉料和烧成参数；导入分段记录后按时间与来源合并，人工校订优先，缺口单独保留。</p>
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
            <span>{{ session.points.length }} 个目标关键点</span>
            <span>{{ session.actualSamples.length }} 个实测点</span>
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

        <LedgerPanel :session="activeSession" />
      </article>
    </section>
  </div>
</template>
