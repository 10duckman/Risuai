/**
 * 대화 → 로어북 추출의 데이터 타입.
 *
 * 설계: docs/superpowers/specs/2026-08-01-lorebook-export-design.md
 */

import type { loreBook } from 'src/ts/storage/database.svelte'

/** fact의 여섯 형태. 각각 검증 규칙이 다르다. */
export type FactType = 'num' | 'quote' | 'trigger' | 'habit' | 'absence' | 'plain'

/**
 * 추출의 최소 단위.
 *
 * `src`는 원문에서 그대로 옮긴 근거 조각이다. `v`가 그 근거에서 나왔는지를
 * 코드가 검사한다 — 앵커가 원문에 있다는 것만으로는 부족하다.
 */
export interface Fact{
    t: FactType
    v: string
    src: string
    msg: number
}

/** 슬롯 라벨 → fact 배열. 라벨은 9종이지만 타입은 열지 않는다 (장소/사물도 같은 구조를 쓴다). */
export type SlotMap = Record<string, Fact[]>

export interface PersonDraft{
    name: string
    aliases?: string[]
    slots: SlotMap
}

export interface PlaceDraft{
    name: string
    facts: Fact[]
}

export interface ObjectDraft{
    name: string
    aliases?: string[]
    facts: Fact[]
}

/** 청크 하나의 추출 결과. LLM이 이 형태로 돌려준다. */
export interface ChunkResult{
    people: PersonDraft[]
    places: PlaceDraft[]
    state: Fact[]
    objects: ObjectDraft[]
}

export type EntryCategory = 'person' | 'place' | 'state' | 'object'

/** merge가 조립한 항목. `loreBook`으로 바로 변환된다. */
export interface MergedEntry{
    comment: string
    content: string
    key: string
    secondkey: string
    insertorder: number
    mode: 'normal' | 'constant' | 'multiple'
    alwaysActive: boolean
    selective: boolean
    useRegex: boolean
    category: EntryCategory
}

export interface DroppedItem{
    what: string
    why: string
}

/** merge 결과. 사용자에게 이 형태로 보여준다. */
export interface MergeResult{
    entries: MergedEntry[]
    dropped: DroppedItem[]
}

/** 미리보기에서 사용자가 항목별로 고르는 값. */
export type EntryDestination = 'global' | 'local' | 'discard'

export interface ExportPreview{
    entries: MergedEntry[]
    dropped: DroppedItem[]
    /** entries와 같은 인덱스. 기본값은 category에 따라 정한다. */
    destinations: EntryDestination[]
    /** always-on 총량이 상한을 넘었는지. */
    alwaysOnOverflow: boolean
    alwaysOnChars: number
}

/** MergedEntry를 loreBook으로 변환한 결과. */
export type LoreBookEntry = loreBook
