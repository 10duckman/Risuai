/**
 * merge 결과를 loreBook 항목과 미리보기로 조립한다.
 */

import { checkAlwaysOnBudget } from './validate'
import type {
    EntryCategory,
    EntryDestination,
    ExportPreview,
    LoreBookEntry,
    MergedEntry,
    MergeResult,
} from './types'

/** 프롬프트에 삽입되는 순서. 관계 상태가 가장 뒤(=최신 정보). */
export const INSERT_ORDER: Record<EntryCategory, number> = {
    state: 110,
    person: 100,
    place: 90,
    object: 50,
}

/**
 * MergedEntry에서 loreBook으로. category는 RisuAI 타입에 없으므로 뺀다.
 *
 * insertorder는 LLM이 보낸 값을 쓰지 않고 category로 강제한다 — merge가
 * 잘못된(예: 0) insertorder를 내면 person/place/state 레이어링이 조용히
 * 무너지기 때문이다. INSERT_ORDER가 신뢰 가능한 유일한 소스다.
 */
export function toLoreBook(entry: MergedEntry): LoreBookEntry{
    return {
        key: entry.key,
        secondkey: entry.secondkey,
        insertorder: INSERT_ORDER[entry.category],
        comment: entry.comment,
        content: entry.content,
        mode: entry.mode,
        alwaysActive: entry.alwaysActive,
        selective: entry.selective,
        useRegex: entry.useRegex,
        bookVersion: 2,
    }
}

/**
 * 기본 목적지.
 *
 * 인물과 장소는 캐릭터 단위로 유효하므로 globalLore. 관계 상태와 사물은
 * 이 채팅에서만 유효하므로 localLore — 다른 채팅은 다른 관계다.
 */
export function defaultDestination(category: EntryCategory): EntryDestination{
    return category === 'person' || category === 'place' ? 'global' : 'local'
}

export function buildPreview(merge: MergeResult): ExportPreview{
    const budget = checkAlwaysOnBudget(merge.entries)
    return {
        entries: merge.entries,
        dropped: merge.dropped,
        destinations: merge.entries.map(e => defaultDestination(e.category)),
        alwaysOnChars: budget.chars,
        alwaysOnOverflow: budget.overflow,
    }
}
