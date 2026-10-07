import type { CurveTemplate, FiringLedger, FiringPoint, KilnSession, RawSample } from '../types/firing'
import { createActualSamples } from '../utils/curve'
import { buildSegment } from '../utils/ledger'

function points(values: Array<[number, number]>, prefix: string): FiringPoint[] {
  return values.map(([timeMin, tempC], index) => ({
    id: `point-${prefix}-${index}`,
    timeMin,
    tempC,
  }))
}

function templatePoints(values: Array<[number, number]>) {
  return values.map(([timeMin, tempC]) => ({ timeMin, tempC }))
}

export const MOCK_TEMPLATES: CurveTemplate[] = [
  {
    id: 'template-celadon',
    name: '青瓷标准烧成',
    clay: '青瓷泥',
    glaze: '天青釉',
    peakTempC: 1260,
    description: '慢速氧化升温，1260 ℃ 保温 25 分钟，300–700 ℃ 区间缓冷。',
    points: templatePoints([
      [0, 22],
      [90, 520],
      [120, 520],
      [240, 980],
      [300, 980],
      [410, 1260],
      [435, 1260],
      [720, 80],
    ]),
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'template-stoneware',
    name: '炻器高温还原',
    clay: '炻器泥',
    glaze: '柴烧落灰釉',
    peakTempC: 1285,
    description: '前段稳定脱水，后段提升升温速率，峰值保温 20 分钟后自然缓冷。',
    points: templatePoints([
      [0, 24],
      [65, 460],
      [100, 460],
      [235, 1000],
      [285, 1000],
      [385, 1285],
      [405, 1285],
      [680, 90],
    ]),
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'template-crystal',
    name: '结晶釉控温曲线',
    clay: '高白泥',
    glaze: '结晶釉',
    peakTempC: 1210,
    description: '达到峰值后快速降至析晶温度，并保留 50 分钟晶体生长平台。',
    points: templatePoints([
      [0, 20],
      [85, 520],
      [115, 520],
      [230, 1040],
      [275, 1040],
      [370, 1210],
      [425, 1080],
      [475, 1080],
      [620, 80],
    ]),
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'template-raku',
    name: '乐烧快速烧成',
    clay: '粗陶泥',
    glaze: '乐烧釉',
    peakTempC: 980,
    description: '短周期快速升温至 980 ℃，出窑后迅速还原冷却。',
    points: templatePoints([
      [0, 20],
      [35, 380],
      [55, 720],
      [85, 980],
      [100, 980],
      [115, 120],
    ]),
    updatedAt: new Date().toISOString(),
  },
]

const sessionDefinitions: Array<{
  id: string
  name: string
  kiln: string
  clay: string
  glaze: string
  firedAt: string
  status: KilnSession['status']
  pointValues: Array<[number, number]>
  offset: number
  /** 停电断网缺口（分钟），仅演示窑次使用 */
  gap?: { from: number; to: number }
  /** 班组长手工校订的演示点（经过时间，修正温度） */
  correction?: { timeMin: number; tempC: number; reason: string }
  legacy?: boolean
}> = [
  {
    id: 'kiln-session-20261002',
    name: '青瓷三号窑次',
    kiln: '气窑 3 号',
    clay: '青瓷泥',
    glaze: '天青釉',
    firedAt: '2026-10-02 18:30',
    status: 'completed',
    pointValues: [
      [0, 22],
      [82, 480],
      [115, 480],
      [220, 930],
      [280, 930],
      [395, 1260],
      [420, 1260],
      [700, 85],
    ],
    offset: 3,
    // 212–247 分钟停电断网，记录仪各导出一段
    gap: { from: 212, to: 247 },
    correction: { timeMin: 180, tempC: 792, reason: '热电偶读数跳变，按邻段趋势校正' },
  },
  {
    id: 'kiln-session-20260928',
    name: '柴烧六号窑次',
    kiln: '柴窑 6 号',
    clay: '炻器泥',
    glaze: '柴烧落灰釉',
    firedAt: '2026-09-28 09:10',
    status: 'review',
    pointValues: [
      [0, 26],
      [70, 520],
      [95, 520],
      [235, 1000],
      [270, 1000],
      [370, 1285],
      [390, 1285],
      [650, 95],
    ],
    offset: -4,
  },
  {
    id: 'kiln-session-20260920',
    name: '结晶釉试验窑次',
    kiln: '电窑 1 号',
    clay: '高白泥',
    glaze: '结晶釉',
    firedAt: '2026-09-20 14:00',
    status: 'draft',
    pointValues: [
      [0, 20],
      [78, 520],
      [105, 520],
      [220, 1040],
      [255, 1040],
      [340, 1210],
      [380, 1080],
      [420, 1080],
      [560, 80],
    ],
    offset: 6,
    // 该窑次演示旧版整份采样升级为一段记录
    legacy: true,
  },
]

/** 把一条连续采样按停电区间拆成两段，模拟记录仪断电断网后各自导出的 CSV */
function splitSamplesByGap(samples: RawSample[], gap: { from: number; to: number }, seed: number) {
  const before: RawSample[] = []
  const after: RawSample[] = []
  samples.forEach((sample) => {
    if (sample.timeMin <= gap.from) {
      before.push({ ...sample, id: `seg-a-${seed}-${sample.timeMin}` })
    } else if (sample.timeMin >= gap.to) {
      after.push({ ...sample, id: `seg-b-${seed}-${sample.timeMin}` })
    }
  })
  return [before, after]
}

function ledgerFor(definition: (typeof sessionDefinitions)[number], allSamples: RawSample[]): FiringLedger {
  if (definition.legacy) {
    return {
      migratedFromLegacy: true,
      segments: [
        {
          id: `segment-legacy-${definition.id}`,
          fileName: '升级前整份采样.csv',
          sourceLabel: '旧数据迁移',
          importedAt: '2026-09-20T15:00:00.000Z',
          firstAtMin: allSamples[0].timeMin,
          lastAtMin: allSamples.at(-1)!.timeMin,
          sampleCount: allSamples.length,
          rawSamples: allSamples,
        },
      ],
      corrections: [],
    }
  }

  let segmentSamples: RawSample[][]
  if (definition.gap) {
    segmentSamples = splitSamplesByGap(allSamples, definition.gap, definition.id.length)
  } else {
    const cut = Math.floor(allSamples.length * 0.55)
    segmentSamples = [
      allSamples.slice(0, cut).map((sample) => ({ ...sample, id: `seg-a-${sample.id}` })),
      allSamples.slice(cut).map((sample) => ({ ...sample, id: `seg-b-${sample.id}` })),
    ]
  }

  const first = buildSegment(segmentSamples[0], '记录仪-第1段.csv', '记录仪导出（停电前）')
  const second = buildSegment(segmentSamples[1], '记录仪-第2段.csv', '记录仪导出（复电后）')
  const ledger: FiringLedger = { segments: [first!, second!].filter(Boolean), corrections: [] }
  if (first) {
    first.importedAt = '2026-10-02T10:00:00.000Z'
  }
  if (second) {
    second.importedAt = '2026-10-02T16:00:00.000Z'
  }
  if (definition.correction) {
    ledger.corrections.push({
      id: `correction-${definition.id}`,
      timeMin: definition.correction.timeMin,
      tempC: definition.correction.tempC,
      reason: definition.correction.reason,
      updatedAt: '2026-10-03T08:30:00.000Z',
    })
  }
  return ledger
}

export function createMockSessions(): KilnSession[] {
  return sessionDefinitions.map((definition, index) => {
    const sessionPoints = points(definition.pointValues, definition.id)
    const allSamples = createActualSamples(sessionPoints, index + 3)
    return {
      id: definition.id,
      name: definition.name,
      kiln: definition.kiln,
      clay: definition.clay,
      glaze: definition.glaze,
      firedAt: definition.firedAt,
      status: definition.status,
      timeOffsetMin: definition.offset,
      points: sessionPoints,
      ledger: ledgerFor(definition, allSamples),
    }
  })
}
