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
 * LLM이 보낸 category를 알려진 넷 중 하나로 정규화한다.
 *
 * 실측: merge가 category를 아예 빼먹은 응답을 냈다 (14개 항목 전부 undefined).
 * 그러면 INSERT_ORDER[undefined]가 undefined가 되어 로어북에 undefined
 * insertorder가 저장되고, defaultDestination도 전부 local로 떨어지고, UI의
 * 분류 라벨도 undefined로 렌더된다.
 *
 * category가 없을 때 `alwaysActive`로 추론한다. 같은 실측에서 merge는
 * category를 빼먹었어도 alwaysActive는 스펙대로 넣었다 — 장소인 "붉은 방"과
 * "여의도 아파트"는 true, 사물인 "까르띠에 러브링"과 "딸기우유"는 false였다.
 * 스펙이 always-on으로 규정한 것은 인물·장소·관계 상태이고 키워드로 규정한
 * 것은 사물뿐이므로, alwaysActive는 "사물이 아니다"를 가리키는 신호가 된다.
 *
 * always-on이면 place로 본다. 인물이었다면 그게 더 정확하겠지만 구별할 단서가
 * 없고, place는 person과 같은 global 목적지에 insertorder만 10 낮다 — 인물을
 * place로 잘못 놓는 비용이 장소를 object로 놓는 비용(insertorder 50 + 채팅
 * 로어북)보다 작다. always-on이 아니면 object다.
 */
export function normalizeCategory(value: unknown, alwaysActive?: boolean): EntryCategory{
    if(value === 'person' || value === 'place' || value === 'state' || value === 'object'){
        return value
    }
    return alwaysActive ? 'place' : 'object'
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
        insertorder: INSERT_ORDER[normalizeCategory(entry.category, entry.alwaysActive)],
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
    // category를 여기서 한 번 정규화한다 — 미리보기와 toLoreBook이 모두 이
    // 결과를 쓰므로, 쓰레기 값이 insertorder와 목적지로 새어나가는 경로를
    // 한 곳에서 막는다.
    const entries = merge.entries.map(e => ({ ...e, category: normalizeCategory(e.category, e.alwaysActive) }))
    const budget = checkAlwaysOnBudget(entries)
    return {
        entries,
        dropped: merge.dropped,
        destinations: entries.map(e => defaultDestination(e.category)),
        alwaysOnChars: budget.chars,
        alwaysOnOverflow: budget.overflow,
    }
}
