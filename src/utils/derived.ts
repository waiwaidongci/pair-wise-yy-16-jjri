import type { DerivedResults, KilnSession } from '../types/firing'
import { mergeLedger } from './ledger'
import { assessSessionRisks, calculateDeviation } from './curve'

/**
 * 派生结果的失效签名：目标曲线、时间偏移或烧成账任一处变化，
 * 签名都会变，旧的偏差/风险/对比结果立即失效。
 */
export function resultSignature(session: KilnSession) {
  const ledgerPayload = {
    s: session.ledger.segments.map((segment) => ({
      id: segment.id,
      at: segment.importedAt,
      rows: segment.rawSamples.map((sample) => [sample.timeMin, sample.tempC]),
    })),
    c: session.ledger.corrections.map((correction) => [
      correction.id,
      correction.timeMin,
      correction.tempC,
      correction.updatedAt,
    ]),
  }
  const payload = JSON.stringify({
    p: session.points.map((point) => [point.timeMin, point.tempC]),
    o: session.timeOffsetMin,
    clay: session.clay,
    glaze: session.glaze,
    l: ledgerPayload,
  })
  return fnv1a(payload)
}

function fnv1a(text: string) {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}

/** 签名未变则复用旧结果；签名变化时由同一份账重算偏差与风险 */
export function getDerivedResults(
  session: KilnSession,
  previous?: DerivedResults,
): DerivedResults {
  const signature = resultSignature(session)
  if (previous && previous.signature === signature) return previous
  const merged = mergeLedger(session.ledger)
  return {
    signature,
    recomputedAt: new Date().toISOString(),
    merged,
    deviation: calculateDeviation(session.points, merged.samples, session.timeOffsetMin),
    risks: assessSessionRisks(session, merged),
  }
}
