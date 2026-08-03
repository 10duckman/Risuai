# 대화 → 로어북 추출 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 긴 대화를 로어북 항목으로 추출해 사용자가 취사선택하게 하고, 추출된 구간을 채팅에서 지워도 필요할 때 되살아나게 한다.

**Architecture:** 대화를 20~30턴 청크로 나눠 각각에서 `fact`를 추출하고(Opus 5, 순차), 코드 검증 5단계로 걸러낸 뒤 merge로 통합한다(Opus 5, 1회). 추출·검증·조립 로직은 순수 함수로 분리해 DOM과 DBState를 모르게 유지하고, UI는 그 결과를 미리보기로 보여준 뒤 사용자가 고른 것만 `globalLore`/`localLore`에 넣는다.

**Tech Stack:** Svelte 5 (runes), TypeScript, Vitest, `requestChatData` (기존 LLM 호출 경로)

## Global Constraints

- 설계 문서: `docs/superpowers/specs/2026-08-01-lorebook-export-design.md` — 충돌 시 스펙이 우선한다
- 프롬프트 전문: `.superpowers/sdd/lorebook-export/final-prompts.md` — 프롬프트 텍스트는 이 파일에서 **그대로** 옮긴다. 요약하거나 다듬지 마라
- 평가어를 결과에 남기지 않는다 — 이 기능의 존재 이유다. `무심하다` 류가 나오면 실패다
- 검증은 `src`(앵커)가 아니라 `v`(출하 텍스트)를 대상으로 한다
- 통과 조건 미달 인물은 **버린다. 재요청하지 않는다** — 재요청은 날조를 유발한다
- always-on 항목 `content` 합계 상한 5,000자
- 인물 항목 2,000~3,000자, 장소 1,000~2,000자, 관계 상태 1,000자 이하
- 청크 추출과 merge 모두 메인 모델. `requestChatData(arg, 'model')`
- 주석은 한국어. 코드·식별자·타입은 영어
- 커밋 메시지는 영어, 마지막 줄에 정확히:
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`
- 테스트: `npx vitest run <파일>`. 전체: `npx vitest run`
- 현재 기준선: **220 passed / 3 skipped**. 각 태스크가 이 수를 늘린다
- 빌드: `npx vite build` exit 0

## File Structure

| 파일 | 책임 | 변경 |
|---|---|---|
| `src/ts/process/lorebookExport/types.ts` | `Fact`, `PersonDraft`, `ChunkResult`, `MergedEntry` 등 타입 | 생성 |
| `src/ts/process/lorebookExport/chunking.ts` | 대화를 청크로 나눈다. 순수 함수 | 생성 |
| `src/ts/process/lorebookExport/validate.ts` | 코드 검증 5단계. 순수 함수 | 생성 |
| `src/ts/process/lorebookExport/assemble.ts` | merge 결과를 `loreBook`으로 조립. 순수 함수 | 생성 |
| `src/ts/process/lorebookExport/prompts.ts` | 프롬프트 상수 2개와 스키마 2개 | 생성 |
| `src/ts/process/lorebookExport/run.ts` | 오케스트레이션. LLM 호출 담당 | 생성 |
| `src/ts/process/lorebookExport/tests/*.test.ts` | 위 순수 함수들의 테스트 | 생성 |
| `src/lib/Others/LorebookExportModal.svelte` | 미리보기 + 선택 UI | 생성 |
| `src/lib/Others/AlertComp.svelte:693` | chatOptions에 메뉴 항목 추가 | 수정 |
| `src/lib/SideBars/SideChatList.svelte:264,375` | `case 3` 분기 2곳 | 수정 |
| `src/lang/ko.ts`, `src/lang/en.ts` | i18n | 수정 |

디렉토리를 새로 만드는 이유: 파일 7개가 한 기능에 속하고 서로만 참조한다.
`src/ts/process/` 최상위에 흩뿌리면 기존 파일들과 섞여 경계가 흐려진다.

**순서 의존:** Task 1(타입) → 2(청크) → 3(검증) → 4(조립)은 순차. Task 5(프롬프트)는
독립. Task 6(오케스트레이션)은 1~5 전부 필요. Task 7(UI)은 6 필요. Task 8(배선)은 7 필요.

---

### Task 1: 타입 정의

**Files:**
- Create: `src/ts/process/lorebookExport/types.ts`

**Interfaces:**
- Consumes: `loreBook` from `src/ts/storage/database.svelte.ts`
- Produces: `FactType`, `Fact`, `SlotMap`, `PersonDraft`, `PlaceDraft`, `ObjectDraft`, `ChunkResult`, `MergedEntry`, `ExportPreview`

- [ ] **Step 1: 타입 파일 작성**

`src/ts/process/lorebookExport/types.ts`:

```typescript
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
```

- [ ] **Step 2: 타입 검사**

Run: `npx vite build`
Expected: exit 0. `loreBook` import 경로가 맞는지 여기서 잡힌다.

- [ ] **Step 3: Commit**

```bash
git add src/ts/process/lorebookExport/types.ts
git commit -m "feat: add types for lorebook extraction

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: 청크 분할

**Files:**
- Create: `src/ts/process/lorebookExport/chunking.ts`
- Test: `src/ts/process/lorebookExport/tests/chunking.test.ts`

**Interfaces:**
- Consumes: 없음 (타입만)
- Produces:
  - `interface ChunkMessage { role: 'user' | 'char', data: string, index: number }`
  - `interface Chunk { messages: ChunkMessage[], startIndex: number, endIndex: number, text: string }`
  - `function splitIntoChunks(messages: ChunkMessage[], opts?: { targetTurns?: number, maxChars?: number }): Chunk[]`

- [ ] **Step 1: 실패하는 테스트 작성**

`src/ts/process/lorebookExport/tests/chunking.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'

import { splitIntoChunks, type ChunkMessage } from '../chunking'

/** n개의 메시지를 만든다. user/char 교대. */
function makeMessages(n: number, charsEach = 100): ChunkMessage[] {
    return Array.from({ length: n }, (_, i) => ({
        role: i % 2 === 0 ? 'user' as const : 'char' as const,
        data: 'x'.repeat(charsEach),
        index: i,
    }))
}

describe('splitIntoChunks', () => {
    it('209 메시지를 25턴 단위로 나눈다', () => {
        // 실측: 웬디스 대화가 209 메시지다.
        const chunks = splitIntoChunks(makeMessages(209))

        expect(chunks.length).toBe(9)
        expect(chunks[0].startIndex).toBe(0)
        expect(chunks[0].endIndex).toBe(24)
        expect(chunks[8].endIndex).toBe(208)
    })

    it('모든 메시지가 정확히 한 청크에 들어간다', () => {
        const chunks = splitIntoChunks(makeMessages(100))
        const covered = chunks.flatMap(c => c.messages.map(m => m.index))

        expect(covered).toEqual(Array.from({ length: 100 }, (_, i) => i))
    })

    it('청크 text에 메시지 인덱스와 역할이 붙는다', () => {
        // 추출 프롬프트가 msg 번호를 fact에 달아야 하므로 원문에 인덱스가 보여야 한다.
        const chunks = splitIntoChunks([
            { role: 'user', data: '안녕', index: 0 },
            { role: 'char', data: '반가워', index: 1 },
        ])

        expect(chunks[0].text).toContain('[0]')
        expect(chunks[0].text).toContain('[1]')
        expect(chunks[0].text).toContain('안녕')
        expect(chunks[0].text).toContain('반가워')
    })

    it('maxChars를 넘으면 targetTurns보다 일찍 자른다', () => {
        // 긴 메시지가 몰리면 25턴이 컨텍스트를 넘길 수 있다.
        const chunks = splitIntoChunks(makeMessages(50, 10000), { maxChars: 30000 })

        chunks.forEach(c => {
            expect(c.text.length).toBeLessThanOrEqual(35000)
        })
        expect(chunks.length).toBeGreaterThan(2)
    })

    it('빈 배열은 빈 청크 목록을 낸다', () => {
        expect(splitIntoChunks([])).toEqual([])
    })

    it('메시지 1개도 청크 1개가 된다', () => {
        const chunks = splitIntoChunks(makeMessages(1))

        expect(chunks).toHaveLength(1)
        expect(chunks[0].messages).toHaveLength(1)
    })

    it('targetTurns를 지정할 수 있다', () => {
        const chunks = splitIntoChunks(makeMessages(60), { targetTurns: 20 })

        expect(chunks).toHaveLength(3)
    })

    it('빈 data 메시지도 인덱스를 유지한다', () => {
        // 스트림 실패로 남은 빈 메시지가 있을 수 있다.
        const chunks = splitIntoChunks([
            { role: 'user', data: '질문', index: 0 },
            { role: 'char', data: '', index: 1 },
            { role: 'user', data: '다시', index: 2 },
        ])

        expect(chunks[0].messages.map(m => m.index)).toEqual([0, 1, 2])
    })
})
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run src/ts/process/lorebookExport/tests/chunking.test.ts`
Expected: FAIL — `Failed to resolve import "../chunking"`

- [ ] **Step 3: 최소 구현**

`src/ts/process/lorebookExport/chunking.ts`:

```typescript
/**
 * 대화를 추출 단위로 나눈다.
 *
 * 청크 크기는 두 가지로 제한한다: 턴 수(기본 25)와 문자 수(기본 60,000).
 * 문자 수 제한이 필요한 이유는 메시지 길이가 고르지 않아서다 — 실측으로
 * 웬디스 대화의 assistant 메시지가 6,000~20,000자 사이를 오간다.
 */

const DEFAULT_TARGET_TURNS = 25
const DEFAULT_MAX_CHARS = 60000

export interface ChunkMessage{
    role: 'user' | 'char'
    data: string
    /** 원본 message 배열에서의 인덱스. fact의 msg 필드가 이것을 가리킨다. */
    index: number
}

export interface Chunk{
    messages: ChunkMessage[]
    startIndex: number
    endIndex: number
    /** LLM에 넘길 텍스트. 인덱스와 역할이 붙는다. */
    text: string
}

/** 청크 하나의 텍스트를 만든다. `[12] char: ...` 형태. */
function renderChunk(messages: ChunkMessage[]): string{
    return messages.map(m => `[${m.index}] ${m.role}: ${m.data}`).join('\n\n')
}

export function splitIntoChunks(
    messages: ChunkMessage[],
    opts: { targetTurns?: number, maxChars?: number } = {},
): Chunk[]{
    const targetTurns = opts.targetTurns ?? DEFAULT_TARGET_TURNS
    const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS

    const chunks: Chunk[] = []
    let current: ChunkMessage[] = []
    let currentChars = 0

    const flush = () => {
        if(current.length === 0){
            return
        }
        chunks.push({
            messages: current,
            startIndex: current[0].index,
            endIndex: current[current.length - 1].index,
            text: renderChunk(current),
        })
        current = []
        currentChars = 0
    }

    for(const m of messages){
        const cost = m.data.length
        // 이미 담은 게 있고, 하나 더 넣으면 상한을 넘는다면 먼저 끊는다.
        if(current.length > 0 && (current.length >= targetTurns || currentChars + cost > maxChars)){
            flush()
        }
        current.push(m)
        currentChars += cost
    }
    flush()

    return chunks
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run src/ts/process/lorebookExport/tests/chunking.test.ts`
Expected: PASS — 8 tests

- [ ] **Step 5: 전체 스위트**

Run: `npx vitest run`
Expected: 228 passed / 3 skipped (220 + 8)

- [ ] **Step 6: Commit**

```bash
git add src/ts/process/lorebookExport/chunking.ts src/ts/process/lorebookExport/tests/chunking.test.ts
git commit -m "feat: split a conversation into extraction chunks

Two limits, not one: 25 turns and 60,000 characters. Turn count alone is not
enough because message length is uneven — the measured conversation swings
between 6,000 and 20,000 characters per assistant turn, so 25 turns can be
either well within a context window or far past it.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: 코드 검증 5단계

**Files:**
- Create: `src/ts/process/lorebookExport/validate.ts`
- Test: `src/ts/process/lorebookExport/tests/validate.test.ts`

**Interfaces:**
- Consumes: `Fact`, `PersonDraft`, `ChunkResult` (Task 1), `Chunk` (Task 2)
- Produces:
  - `const EVALUATIVE_DENYLIST: RegExp`
  - `function validateFact(fact: Fact, sourceText: string): boolean`
  - `function validatePerson(person: PersonDraft, sourceText: string): { person: PersonDraft | null, reason?: string }`
  - `function validateChunkResult(result: ChunkResult, sourceText: string): { result: ChunkResult, dropped: DroppedItem[] }`
  - `function checkAlwaysOnBudget(entries: MergedEntry[]): { chars: number, overflow: boolean }`
  - `const ALWAYS_ON_LIMIT = 5000`

- [ ] **Step 1: 실패하는 테스트 작성**

`src/ts/process/lorebookExport/tests/validate.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'

import {
    ALWAYS_ON_LIMIT,
    checkAlwaysOnBudget,
    EVALUATIVE_DENYLIST,
    validateChunkResult,
    validateFact,
    validatePerson,
} from '../validate'
import type { Fact, MergedEntry, PersonDraft } from '../types'

const SRC = `[10] char: 그는 대답도 없이 방으로 들어갔다. 17년째 무직이다.
[11] user: 뭐 하고 있어?
[12] char: "네가 없으면 난 아무것도 아니야" 그가 취해서 말했다.`

const fact = (o: Partial<Fact>): Fact => ({
    t: 'plain', v: 'x', src: '17년째 무직', msg: 10, ...o,
})

describe('validateFact — 1단계: src verbatim', () => {
    it('src가 원문에 있으면 통과한다', () => {
        expect(validateFact(fact({ t: 'num', v: '17년 무직', src: '17년째 무직' }), SRC)).toBe(true)
    })

    it('src가 원문에 없으면 버린다', () => {
        expect(validateFact(fact({ t: 'num', v: '20년 무직', src: '20년째 무직' }), SRC)).toBe(false)
    })

    it('absence는 verbatim 검사를 면제한다', () => {
        // 부재는 원문에 "없다"고 적혀 있지 않다. 장면에서 추론된다.
        expect(validateFact(fact({
            t: 'absence', v: '전희 없음', src: '그는 대답도 없이 방으로', msg: 10,
        }), SRC)).toBe(true)
    })
})

describe('validateFact — 2단계: src → v 연결', () => {
    it('num: src의 숫자가 v에도 있어야 한다', () => {
        expect(validateFact(fact({ t: 'num', v: '17년 무직', src: '17년째 무직' }), SRC)).toBe(true)
    })

    it('num: src에 있는 숫자가 v에 없으면 버린다', () => {
        // 이것이 C1이 지적한 구멍이다 — 앵커는 원문에 있지만 v가 그것에서 나오지 않았다.
        expect(validateFact(fact({
            t: 'num', v: '무직 상태다', src: '17년째 무직',
        }), SRC)).toBe(false)
    })

    it('quote: src 전문이 v의 인용부호 안에 그대로 있어야 한다', () => {
        expect(validateFact(fact({
            t: 'quote',
            v: '취하면: "네가 없으면 난 아무것도 아니야"',
            src: '네가 없으면 난 아무것도 아니야',
            msg: 12,
        }), SRC)).toBe(true)
    })

    it('quote: 인용부호가 없으면 버린다', () => {
        expect(validateFact(fact({
            t: 'quote',
            v: '네가 없으면 난 아무것도 아니야',
            src: '네가 없으면 난 아무것도 아니야',
            msg: 12,
        }), SRC)).toBe(false)
    })

    it('quote: 다듬은 인용은 버린다', () => {
        expect(validateFact(fact({
            t: 'quote',
            v: '취하면: "네가 없으면 아무것도 아니야"',
            src: '네가 없으면 난 아무것도 아니야',
            msg: 12,
        }), SRC)).toBe(false)
    })

    it('trigger: 조건과 반응이 구분자로 나뉘어야 한다', () => {
        expect(validateFact(fact({
            t: 'trigger',
            v: '술 취하면: "네가 없으면 난 아무것도 아니야"',
            src: '네가 없으면 난 아무것도 아니야',
            msg: 12,
        }), SRC)).toBe(true)
    })

    it('trigger: 화살표 구분자도 허용한다', () => {
        expect(validateFact(fact({
            t: 'trigger',
            v: '진지한 얘기 → 한숨',
            src: '대답도 없이 방으로',
            msg: 10,
        }), SRC)).toBe(true)
    })

    it('trigger: 구분자가 없으면 버린다', () => {
        expect(validateFact(fact({
            t: 'trigger',
            v: '술 취하면 말이 많아진다',
            src: '대답도 없이 방으로',
            msg: 10,
        }), SRC)).toBe(false)
    })
})

describe('validateFact — 3단계: 평가어 denylist', () => {
    it('무심하다를 버린다', () => {
        // C1이 지적한 정확한 조합: 앵커는 실재하는데 v가 평가어다.
        expect(validateFact(fact({
            t: 'plain', v: '무심하다', src: '대답도 없이 방으로', msg: 10,
        }), SRC)).toBe(false)
    })

    it('~한 편이다를 버린다', () => {
        expect(validateFact(fact({
            t: 'plain', v: '조용한 편이다', src: '대답도 없이 방으로', msg: 10,
        }), SRC)).toBe(false)
    })

    it('~경향이 있다를 버린다', () => {
        expect(validateFact(fact({
            t: 'plain', v: '회피하는 경향이 있다', src: '대답도 없이 방으로', msg: 10,
        }), SRC)).toBe(false)
    })

    it('헌신적이다를 버린다', () => {
        expect(validateFact(fact({
            t: 'plain', v: '헌신적이다', src: '대답도 없이 방으로', msg: 10,
        }), SRC)).toBe(false)
    })

    it('관찰된 명사구는 통과한다', () => {
        expect(validateFact(fact({
            t: 'plain', v: '송진 냄새', src: '대답도 없이 방으로', msg: 10,
        }), SRC)).toBe(true)
    })

    it('denylist가 정규식으로 직접 노출된다', () => {
        expect(EVALUATIVE_DENYLIST.test('무심하다')).toBe(true)
        expect(EVALUATIVE_DENYLIST.test('맥주 1-2캔')).toBe(false)
    })
})

describe('validatePerson — 4단계: 통과 조건', () => {
    const goodPerson = (): PersonDraft => ({
        name: '김만세',
        slots: {
            Identity: [
                fact({ t: 'num', v: '17년 무직', src: '17년째 무직' }),
            ],
            Speech: [
                fact({ t: 'quote', v: '취하면: "네가 없으면 난 아무것도 아니야"', src: '네가 없으면 난 아무것도 아니야', msg: 12 }),
                fact({ t: 'quote', v: '"네가 없으면 난 아무것도 아니야"', src: '네가 없으면 난 아무것도 아니야', msg: 12 }),
            ],
            Reactions: [
                fact({ t: 'trigger', v: '진지한 얘기 → 한숨', src: '대답도 없이 방으로', msg: 10 }),
                fact({ t: 'trigger', v: '술 취하면: 방으로', src: '대답도 없이 방으로', msg: 10 }),
            ],
            Habits: [
                fact({ t: 'habit', v: '대답 없이 방으로 들어간다', src: '대답도 없이 방으로', msg: 10 }),
                fact({ t: 'num', v: '17년', src: '17년째 무직' }),
                fact({ t: 'plain', v: '송진 냄새', src: '대답도 없이 방으로', msg: 10 }),
            ],
        },
    })

    it('조건을 만족하면 인물을 통과시킨다', () => {
        const out = validatePerson(goodPerson(), SRC)

        expect(out.person).not.toBeNull()
        expect(out.person!.name).toBe('김만세')
    })

    it('trigger+quote가 3개 미만이면 버린다', () => {
        const p = goodPerson()
        p.slots.Speech = []
        p.slots.Reactions = [p.slots.Reactions[0]]

        const out = validatePerson(p, SRC)

        expect(out.person).toBeNull()
        expect(out.reason).toContain('trigger')
    })

    it('fact 총합이 8개 미만이면 버린다', () => {
        const p = goodPerson()
        p.slots.Habits = []

        const out = validatePerson(p, SRC)

        expect(out.person).toBeNull()
        expect(out.reason).toContain('8')
    })

    it('분포된 슬롯이 3개 미만이면 버린다', () => {
        const p = goodPerson()
        // 모든 fact를 한 슬롯에 몰아넣는다.
        const all = Object.values(p.slots).flat()
        p.slots = { Misc: all }

        const out = validatePerson(p, SRC)

        expect(out.person).toBeNull()
        expect(out.reason).toContain('슬롯')
    })

    it('검증에서 걸러진 fact는 조건 계산에서 빠진다', () => {
        const p = goodPerson()
        // Habits 3개를 전부 평가어로 바꾼다 → 총합 8 미달
        p.slots.Habits = [
            fact({ t: 'plain', v: '무심하다', src: '대답도 없이 방으로', msg: 10 }),
            fact({ t: 'plain', v: '다정하다', src: '대답도 없이 방으로', msg: 10 }),
            fact({ t: 'plain', v: '차갑다', src: '대답도 없이 방으로', msg: 10 }),
        ]

        const out = validatePerson(p, SRC)

        expect(out.person).toBeNull()
    })

    it('통과한 인물의 fact에서 걸러진 것이 제거된다', () => {
        const p = goodPerson()
        p.slots.Misc = [fact({ t: 'plain', v: '무심하다', src: '대답도 없이 방으로', msg: 10 })]

        const out = validatePerson(p, SRC)

        expect(out.person).not.toBeNull()
        expect(out.person!.slots.Misc ?? []).toHaveLength(0)
    })
})

describe('validateChunkResult', () => {
    it('버려진 인물을 dropped에 기록한다', () => {
        const result = {
            people: [{ name: '단역', slots: { Misc: [fact({})] } }],
            places: [],
            state: [],
            objects: [],
        }

        const out = validateChunkResult(result, SRC)

        expect(out.result.people).toHaveLength(0)
        expect(out.dropped).toHaveLength(1)
        expect(out.dropped[0].what).toContain('단역')
    })

    it('장소와 사물의 fact도 검증한다', () => {
        const result = {
            people: [],
            places: [{ name: '카페', facts: [
                fact({ t: 'plain', v: '무심하다', src: '대답도 없이 방으로', msg: 10 }),
                fact({ t: 'num', v: '17년', src: '17년째 무직' }),
            ] }],
            state: [],
            objects: [],
        }

        const out = validateChunkResult(result, SRC)

        expect(out.result.places[0].facts).toHaveLength(1)
        expect(out.result.places[0].facts[0].v).toBe('17년')
    })

    it('state fact도 검증한다', () => {
        const result = {
            people: [], places: [], objects: [],
            state: [
                fact({ t: 'plain', v: '헌신적이다', src: '대답도 없이 방으로', msg: 10 }),
                fact({ t: 'num', v: '17년', src: '17년째 무직' }),
            ],
        }

        const out = validateChunkResult(result, SRC)

        expect(out.result.state).toHaveLength(1)
    })
})

describe('checkAlwaysOnBudget — 5단계', () => {
    const entry = (chars: number, alwaysActive: boolean): MergedEntry => ({
        comment: 'x', content: 'y'.repeat(chars), key: '', secondkey: '',
        insertorder: 100, mode: 'normal', alwaysActive, selective: false,
        useRegex: false, category: 'person',
    })

    it('always-on 항목의 content만 합산한다', () => {
        const out = checkAlwaysOnBudget([entry(1000, true), entry(9000, false)])

        expect(out.chars).toBe(1000)
        expect(out.overflow).toBe(false)
    })

    it('상한을 넘으면 overflow를 알린다', () => {
        const out = checkAlwaysOnBudget([entry(3000, true), entry(3000, true)])

        expect(out.chars).toBe(6000)
        expect(out.overflow).toBe(true)
    })

    it('상한이 5,000자다', () => {
        expect(ALWAYS_ON_LIMIT).toBe(5000)
    })

    it('정확히 상한이면 넘지 않은 것으로 본다', () => {
        const out = checkAlwaysOnBudget([entry(5000, true)])

        expect(out.overflow).toBe(false)
    })
})
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run src/ts/process/lorebookExport/tests/validate.test.ts`
Expected: FAIL — `Failed to resolve import "../validate"`

- [ ] **Step 3: 최소 구현**

`src/ts/process/lorebookExport/validate.ts`:

```typescript
/**
 * 코드 검증 5단계.
 *
 * 프롬프트만으로는 평가어를 막을 수 없다. 특히 2단계가 중요하다 — 앵커가
 * 원문에 있다는 것만 검사하면 src:"대답도 없이 방으로" + v:"무심하다" 조합이
 * 통과한다. 검사 대상은 출하되는 텍스트(v)여야 한다.
 */

import type { DroppedItem, Fact, MergedEntry, PersonDraft } from './types'

export const ALWAYS_ON_LIMIT = 5000

/** 평가어. 매치되면 그 fact를 버린다. */
export const EVALUATIVE_DENYLIST =
    /무심|다정|순수|차갑|따뜻|냉정|헌신적|성실|가정적|착하|나쁘|훌륭|(적|스러운|로운)이다|한 편이다|경향이 있다|편이다|같다|보인다/

/** 인물 통과 조건. */
const MIN_TRIGGER_QUOTE = 3
const MIN_FACTS = 8
const MIN_SLOTS = 3

/** v에서 숫자열을 뽑는다. */
function digitsOf(s: string): string[]{
    return s.match(/\d+/g) ?? []
}

/**
 * fact 하나를 검증한다. 1~3단계를 순서대로 적용한다.
 */
export function validateFact(fact: Fact, sourceText: string): boolean{
    // 3단계를 먼저 본다 — 평가어는 타입과 무관하게 즉시 탈락이다.
    if(EVALUATIVE_DENYLIST.test(fact.v)){
        return false
    }

    // 1단계: src verbatim. absence는 면제한다 (부재는 원문에 진술되지 않는다).
    if(fact.t !== 'absence' && !sourceText.includes(fact.src)){
        return false
    }

    // 2단계: src → v 연결.
    switch(fact.t){
        case 'num': {
            const srcDigits = digitsOf(fact.src)
            if(srcDigits.length === 0){
                return false
            }
            // src의 숫자 중 하나라도 v에 나타나야 한다.
            return srcDigits.some(d => fact.v.includes(d))
        }
        case 'quote': {
            // src 전문이 v의 인용부호 안에 글자 그대로 있어야 한다.
            const quoted = fact.v.match(/"([^"]*)"/g) ?? []
            return quoted.some(q => q.slice(1, -1).includes(fact.src))
        }
        case 'trigger': {
            // 조건부와 반응부가 구분자로 나뉘어야 한다.
            if(!/[:→]/.test(fact.v)){
                return false
            }
            const [cond, ...rest] = fact.v.split(/[:→]/)
            return cond.trim().length > 0 && rest.join('').trim().length > 0
        }
        default:
            return true
    }
}

/** SlotMap에서 검증을 통과한 fact만 남긴다. */
function filterSlots(slots: Record<string, Fact[]>, sourceText: string): Record<string, Fact[]>{
    const out: Record<string, Fact[]> = {}
    for(const [label, facts] of Object.entries(slots)){
        out[label] = (facts ?? []).filter(f => validateFact(f, sourceText))
    }
    return out
}

/**
 * 인물을 검증한다. 통과 조건을 못 넘으면 버린다 — 재요청하지 않는다.
 * 재요청은 쿼터를 채우려는 날조를 유발한다.
 */
export function validatePerson(
    person: PersonDraft,
    sourceText: string,
): { person: PersonDraft | null, reason?: string }{
    const slots = filterSlots(person.slots, sourceText)
    const all = Object.values(slots).flat()

    const triggerQuote = all.filter(f => f.t === 'trigger' || f.t === 'quote').length
    if(triggerQuote < MIN_TRIGGER_QUOTE){
        return { person: null, reason: `trigger+quote ${triggerQuote}개 (최소 ${MIN_TRIGGER_QUOTE})` }
    }
    if(all.length < MIN_FACTS){
        return { person: null, reason: `fact ${all.length}개 (최소 ${MIN_FACTS})` }
    }
    const filledSlots = Object.values(slots).filter(fs => fs.length > 0).length
    if(filledSlots < MIN_SLOTS){
        return { person: null, reason: `슬롯 ${filledSlots}개 (최소 ${MIN_SLOTS})` }
    }

    return { person: { ...person, slots } }
}

/** 청크 결과 전체를 검증한다. */
export function validateChunkResult(
    result: { people: PersonDraft[], places: { name: string, facts: Fact[] }[], state: Fact[], objects: { name: string, aliases?: string[], facts: Fact[] }[] },
    sourceText: string,
){
    const dropped: DroppedItem[] = []

    const people: PersonDraft[] = []
    for(const p of result.people ?? []){
        const out = validatePerson(p, sourceText)
        if(out.person){
            people.push(out.person)
        }
        else{
            dropped.push({ what: `인물: ${p.name}`, why: out.reason ?? '통과 조건 미달' })
        }
    }

    const places = (result.places ?? []).map(pl => ({
        ...pl,
        facts: (pl.facts ?? []).filter(f => validateFact(f, sourceText)),
    }))
    const objects = (result.objects ?? []).map(ob => ({
        ...ob,
        facts: (ob.facts ?? []).filter(f => validateFact(f, sourceText)),
    }))
    const state = (result.state ?? []).filter(f => validateFact(f, sourceText))

    return { result: { people, places, state, objects }, dropped }
}

/** always-on 총량을 검사한다. */
export function checkAlwaysOnBudget(entries: MergedEntry[]): { chars: number, overflow: boolean }{
    const chars = entries
        .filter(e => e.alwaysActive)
        .reduce((s, e) => s + e.content.length, 0)
    return { chars, overflow: chars > ALWAYS_ON_LIMIT }
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run src/ts/process/lorebookExport/tests/validate.test.ts`
Expected: PASS — 28 tests

- [ ] **Step 5: 전체 스위트**

Run: `npx vitest run`
Expected: 256 passed / 3 skipped (228 + 28)

- [ ] **Step 6: Commit**

```bash
git add src/ts/process/lorebookExport/validate.ts src/ts/process/lorebookExport/tests/validate.test.ts
git commit -m "feat: validate extracted facts against their source anchors

The check that matters is stage 2. Verifying only that an anchor exists in the
source proves nothing about the sentence being stored: src \"대답도 없이 방으로\"
is genuinely in the text, and v \"무심하다\" passes alongside it while carrying
none of it. So each type is checked against its own anchor — a num must carry a
digit from its anchor, a quote must contain the anchor verbatim inside quotation
marks, a trigger must have both a condition and a response.

Persons that miss the floor are dropped, never re-requested. Re-requesting to
fill a quota is how a model learns to fabricate.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: 항목 조립

**Files:**
- Create: `src/ts/process/lorebookExport/assemble.ts`
- Test: `src/ts/process/lorebookExport/tests/assemble.test.ts`

**Interfaces:**
- Consumes: `MergedEntry`, `EntryCategory`, `LoreBookEntry`, `ExportPreview`, `EntryDestination` (Task 1), `checkAlwaysOnBudget` (Task 3)
- Produces:
  - `function toLoreBook(entry: MergedEntry): LoreBookEntry`
  - `function defaultDestination(category: EntryCategory): EntryDestination`
  - `function buildPreview(merge: MergeResult): ExportPreview`
  - `const INSERT_ORDER: Record<EntryCategory, number>`

- [ ] **Step 1: 실패하는 테스트 작성**

`src/ts/process/lorebookExport/tests/assemble.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'

import { buildPreview, defaultDestination, INSERT_ORDER, toLoreBook } from '../assemble'
import type { MergedEntry } from '../types'

const entry = (o: Partial<MergedEntry> = {}): MergedEntry => ({
    comment: '김만세',
    content: '### 김만세\n- Identity: 41세. 자칭 화가.',
    key: '',
    secondkey: '',
    insertorder: 100,
    mode: 'normal',
    alwaysActive: true,
    selective: false,
    useRegex: false,
    category: 'person',
    ...o,
})

describe('toLoreBook', () => {
    it('MergedEntry를 loreBook 필드로 변환한다', () => {
        const lb = toLoreBook(entry())

        expect(lb.comment).toBe('김만세')
        expect(lb.content).toContain('41세')
        expect(lb.key).toBe('')
        expect(lb.alwaysActive).toBe(true)
        expect(lb.mode).toBe('normal')
        expect(lb.insertorder).toBe(100)
        expect(lb.selective).toBe(false)
        expect(lb.useRegex).toBe(false)
    })

    it('category는 loreBook에 넘기지 않는다', () => {
        // category는 미리보기 분류용이고 RisuAI 타입에는 없다.
        const lb = toLoreBook(entry()) as Record<string, unknown>

        expect('category' in lb).toBe(false)
    })

    it('bookVersion 2를 붙인다', () => {
        // 실물 로어북이 bookVersion: 2다.
        const lb = toLoreBook(entry())

        expect(lb.bookVersion).toBe(2)
    })

    it('사물은 key를 유지한다', () => {
        const lb = toLoreBook(entry({
            category: 'object', key: '반지,결혼반지', alwaysActive: false, insertorder: 50,
        }))

        expect(lb.key).toBe('반지,결혼반지')
        expect(lb.alwaysActive).toBe(false)
    })
})

describe('INSERT_ORDER', () => {
    it('스펙의 값과 일치한다', () => {
        expect(INSERT_ORDER.state).toBe(110)
        expect(INSERT_ORDER.person).toBe(100)
        expect(INSERT_ORDER.place).toBe(90)
        expect(INSERT_ORDER.object).toBe(50)
    })
})

describe('defaultDestination', () => {
    it('인물과 장소는 캐릭터 로어북이 기본이다', () => {
        // 캐릭터의 모든 채팅에서 유효하다.
        expect(defaultDestination('person')).toBe('global')
        expect(defaultDestination('place')).toBe('global')
    })

    it('관계 상태는 채팅 로어북이 기본이다', () => {
        // 이 채팅에서만 유효하다. 다른 채팅은 다른 관계다.
        expect(defaultDestination('state')).toBe('local')
    })

    it('사물은 채팅 로어북이 기본이다', () => {
        expect(defaultDestination('object')).toBe('local')
    })
})

describe('buildPreview', () => {
    it('항목마다 기본 목적지를 정한다', () => {
        const preview = buildPreview({
            entries: [
                entry({ category: 'person' }),
                entry({ category: 'state', comment: '관계' }),
            ],
            dropped: [],
        })

        expect(preview.destinations).toEqual(['global', 'local'])
    })

    it('always-on 총량을 계산한다', () => {
        const preview = buildPreview({
            entries: [
                entry({ content: 'x'.repeat(3000), alwaysActive: true }),
                entry({ content: 'y'.repeat(1000), alwaysActive: false }),
            ],
            dropped: [],
        })

        expect(preview.alwaysOnChars).toBe(3000)
        expect(preview.alwaysOnOverflow).toBe(false)
    })

    it('상한을 넘으면 overflow를 표시한다', () => {
        const preview = buildPreview({
            entries: [
                entry({ content: 'x'.repeat(4000), alwaysActive: true }),
                entry({ content: 'y'.repeat(2000), alwaysActive: true, comment: '두번째' }),
            ],
            dropped: [],
        })

        expect(preview.alwaysOnChars).toBe(6000)
        expect(preview.alwaysOnOverflow).toBe(true)
    })

    it('dropped를 그대로 전달한다', () => {
        const preview = buildPreview({
            entries: [],
            dropped: [{ what: '인물: 단역', why: 'fact 4개 (최소 8)' }],
        })

        expect(preview.dropped).toHaveLength(1)
        expect(preview.dropped[0].why).toContain('최소 8')
    })

    it('빈 merge 결과를 처리한다', () => {
        const preview = buildPreview({ entries: [], dropped: [] })

        expect(preview.entries).toHaveLength(0)
        expect(preview.destinations).toHaveLength(0)
        expect(preview.alwaysOnChars).toBe(0)
        expect(preview.alwaysOnOverflow).toBe(false)
    })
})
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run src/ts/process/lorebookExport/tests/assemble.test.ts`
Expected: FAIL — `Failed to resolve import "../assemble"`

- [ ] **Step 3: 최소 구현**

`src/ts/process/lorebookExport/assemble.ts`:

```typescript
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

/** MergedEntry에서 loreBook으로. category는 RisuAI 타입에 없으므로 뺀다. */
export function toLoreBook(entry: MergedEntry): LoreBookEntry{
    return {
        key: entry.key,
        secondkey: entry.secondkey,
        insertorder: entry.insertorder,
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
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run src/ts/process/lorebookExport/tests/assemble.test.ts`
Expected: PASS — 14 tests

- [ ] **Step 5: 전체 스위트**

Run: `npx vitest run`
Expected: 270 passed / 3 skipped (256 + 14)

- [ ] **Step 6: Commit**

```bash
git add src/ts/process/lorebookExport/assemble.ts src/ts/process/lorebookExport/tests/assemble.test.ts
git commit -m "feat: assemble merged entries into loreBook records

Default destination follows scope: people and places hold for the character
across every chat, so globalLore; relationship state and objects belong to the
conversation that produced them, so localLore. The user can override either way
in the preview.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: 프롬프트 상수

**Files:**
- Create: `src/ts/process/lorebookExport/prompts.ts`

**Interfaces:**
- Consumes: 없음
- Produces: `CHUNK_PROMPT: string`, `MERGE_PROMPT: string`, `CHUNK_SCHEMA: object`, `MERGE_SCHEMA: object`

- [ ] **Step 1: 프롬프트를 설계 문서에서 그대로 옮긴다**

`.superpowers/sdd/lorebook-export/final-prompts.md`의 `## chunk_prompt`와
`## merge_prompt` 블록, 그리고 `## output_schema`의 두 스키마를 **글자 그대로**
`src/ts/process/lorebookExport/prompts.ts`에 옮긴다.

파일 형태:

```typescript
/**
 * 추출 프롬프트.
 *
 * 원본: .superpowers/sdd/lorebook-export/final-prompts.md
 * 여기서 직접 고치지 말고 그 문서를 먼저 고친 뒤 옮긴다 — 설계 근거가 거기 있다.
 */

/** 청크 하나당 실행. 약 9~11회 호출되므로 짧게 유지한다. */
export const CHUNK_PROMPT = `대화 기록에서 로어북 항목의 재료를 추출한다. 요약하지 마라.
... (final-prompts.md의 chunk_prompt 전문)
`

/** 전체 청크 결과를 받아 1회 실행. */
export const MERGE_PROMPT = `여러 구간에서 추출된 fact들을 로어북 항목으로 합친다.
... (final-prompts.md의 merge_prompt 전문)
`

export const CHUNK_SCHEMA = {
    // final-prompts.md의 청크 단계 스키마
} as const

export const MERGE_SCHEMA = {
    // final-prompts.md의 merge 단계 스키마
} as const
```

주의:
- 백틱 문자열 안에 `${`가 있으면 이스케이프해야 한다. 프롬프트에는 없지만 확인하라
- 프롬프트를 요약하거나 다듬지 마라. 판정 기준의 예시(`41세 / 17년 무직`)가
  캘리브레이션이므로 하나라도 빠지면 품질이 떨어진다

- [ ] **Step 2: 옮긴 내용이 원본과 같은지 확인**

```bash
node -e '
const fs = require("fs");
const md = fs.readFileSync(".superpowers/sdd/lorebook-export/final-prompts.md", "utf8");
const ts = fs.readFileSync("src/ts/process/lorebookExport/prompts.ts", "utf8");
// 캘리브레이션 예시가 전부 옮겨졌는지
const markers = ["41세", "17년 무직", "맥주 1-2캔", "전희 없음", "무심하다", "trigger", "absence"];
markers.forEach(m => {
  const inMd = md.includes(m), inTs = ts.includes(m);
  console.log((inMd === inTs ? "OK  " : "MISS") + "  " + m + "  md=" + inMd + " ts=" + inTs);
});
'
```
Expected: 모두 `OK`

- [ ] **Step 3: 빌드 검사**

Run: `npx vite build`
Expected: exit 0. 백틱 이스케이프 오류가 있으면 여기서 잡힌다.

- [ ] **Step 4: Commit**

```bash
git add src/ts/process/lorebookExport/prompts.ts
git commit -m "feat: add extraction and merge prompts

Copied verbatim from the design document; the calibration examples in the prompt
body are what set the quality bar, so they are not summarised or trimmed.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: 오케스트레이션

**Files:**
- Create: `src/ts/process/lorebookExport/run.ts`
- Test: `src/ts/process/lorebookExport/tests/run.test.ts`

**Interfaces:**
- Consumes: 전부 (Task 1~5)
- Produces:
  - `interface RunOptions { messages: ChunkMessage[], onProgress?: (done: number, total: number) => void, requestChat: RequestChatFn, targetTurns?: number }`
  - `type RequestChatFn = (prompt: string, sourceText: string) => Promise<string>`
  - `function runExport(opts: RunOptions): Promise<ExportPreview>`

- [ ] **Step 1: 실패하는 테스트 작성**

`src/ts/process/lorebookExport/tests/run.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest'

import { runExport } from '../run'
import type { ChunkMessage } from '../chunking'

const messages = (n: number): ChunkMessage[] =>
    Array.from({ length: n }, (_, i) => ({
        role: i % 2 === 0 ? 'user' as const : 'char' as const,
        data: `메시지 ${i}: 17년째 무직이다. "네가 없으면 난 아무것도 아니야"`,
        index: i,
    }))

/** 통과 조건을 만족하는 청크 응답. */
const goodChunkResponse = (msgIdx: number) => JSON.stringify({
    people: [{
        name: '김만세',
        slots: {
            Identity: [{ t: 'num', v: '17년 무직', src: '17년째 무직', msg: msgIdx }],
            Speech: [
                { t: 'quote', v: '"네가 없으면 난 아무것도 아니야"', src: '네가 없으면 난 아무것도 아니야', msg: msgIdx },
                { t: 'quote', v: '취하면: "네가 없으면 난 아무것도 아니야"', src: '네가 없으면 난 아무것도 아니야', msg: msgIdx },
            ],
            Reactions: [
                { t: 'trigger', v: '술 취하면: 방으로', src: '17년째 무직', msg: msgIdx },
                { t: 'trigger', v: '진지한 얘기 → 침묵', src: '17년째 무직', msg: msgIdx },
            ],
            Habits: [
                { t: 'habit', v: '매일 같은 시간에 나간다', src: '17년째 무직', msg: msgIdx },
                { t: 'num', v: '17년', src: '17년째 무직', msg: msgIdx },
                { t: 'plain', v: '송진 냄새', src: '17년째 무직', msg: msgIdx },
            ],
        },
    }],
    places: [], state: [], objects: [],
})

const mergeResponse = JSON.stringify({
    entries: [{
        comment: '김만세',
        content: '### 김만세\n- Identity: 41세. 17년 무직.',
        key: '', secondkey: '', insertorder: 100, mode: 'normal',
        alwaysActive: true, selective: false, useRegex: false, category: 'person',
    }],
    dropped: [],
})

describe('runExport', () => {
    it('청크마다 호출하고 마지막에 merge한다', async () => {
        const requestChat = vi.fn()
            .mockImplementation(async (prompt: string) => {
                // merge 프롬프트인지 청크 프롬프트인지로 구분한다.
                if(prompt.includes('합친다')){
                    return mergeResponse
                }
                return goodChunkResponse(0)
            })

        const preview = await runExport({
            messages: messages(50),
            requestChat,
            targetTurns: 25,
        })

        // 청크 2개 + merge 1회
        expect(requestChat).toHaveBeenCalledTimes(3)
        expect(preview.entries).toHaveLength(1)
        expect(preview.entries[0].comment).toBe('김만세')
    })

    it('진행 상황을 알린다', async () => {
        const onProgress = vi.fn()
        const requestChat = vi.fn().mockImplementation(async (p: string) =>
            p.includes('합친다') ? mergeResponse : goodChunkResponse(0))

        await runExport({ messages: messages(75), requestChat, onProgress, targetTurns: 25 })

        // 청크 3개 처리
        expect(onProgress).toHaveBeenCalledWith(1, 3)
        expect(onProgress).toHaveBeenCalledWith(3, 3)
    })

    it('검증에서 걸러진 인물을 dropped에 담는다', async () => {
        const thinPerson = JSON.stringify({
            people: [{ name: '단역', slots: { Misc: [{ t: 'plain', v: '송진 냄새', src: '17년째 무직', msg: 0 }] } }],
            places: [], state: [], objects: [],
        })
        const requestChat = vi.fn().mockImplementation(async (p: string) =>
            p.includes('합친다') ? JSON.stringify({ entries: [], dropped: [] }) : thinPerson)

        const preview = await runExport({ messages: messages(25), requestChat })

        expect(preview.dropped.length).toBeGreaterThan(0)
        expect(preview.dropped[0].what).toContain('단역')
    })

    it('청크 응답이 JSON이 아니면 그 청크를 건너뛰고 계속한다', async () => {
        let call = 0
        const requestChat = vi.fn().mockImplementation(async (p: string) => {
            if(p.includes('합친다')) return mergeResponse
            call++
            return call === 1 ? '설명하는 문장입니다' : goodChunkResponse(0)
        })

        const preview = await runExport({ messages: messages(50), requestChat, targetTurns: 25 })

        // 첫 청크는 버려지고 둘째만 merge에 간다 — 전체가 실패하지 않는다
        expect(preview.dropped.some(d => d.why.includes('파싱'))).toBe(true)
        expect(preview.entries).toHaveLength(1)
    })

    it('코드블록으로 감싼 JSON을 파싱한다', async () => {
        const requestChat = vi.fn().mockImplementation(async (p: string) =>
            p.includes('합친다')
                ? '```json\n' + mergeResponse + '\n```'
                : '```json\n' + goodChunkResponse(0) + '\n```')

        const preview = await runExport({ messages: messages(25), requestChat })

        expect(preview.entries).toHaveLength(1)
    })

    it('merge 응답이 깨지면 던진다', async () => {
        const requestChat = vi.fn().mockImplementation(async (p: string) =>
            p.includes('합친다') ? '실패' : goodChunkResponse(0))

        await expect(runExport({ messages: messages(25), requestChat }))
            .rejects.toThrow(/merge/)
    })

    it('메시지가 없으면 빈 미리보기를 낸다', async () => {
        const requestChat = vi.fn()

        const preview = await runExport({ messages: [], requestChat })

        expect(preview.entries).toHaveLength(0)
        expect(requestChat).not.toHaveBeenCalled()
    })

    it('청크 프롬프트에 원문이 들어간다', async () => {
        const requestChat = vi.fn().mockImplementation(async (p: string) =>
            p.includes('합친다') ? mergeResponse : goodChunkResponse(0))

        await runExport({ messages: messages(25), requestChat })

        const chunkCall = requestChat.mock.calls.find(c => !c[0].includes('합친다'))
        expect(chunkCall![1]).toContain('메시지 0')
    })
})
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run src/ts/process/lorebookExport/tests/run.test.ts`
Expected: FAIL — `Failed to resolve import "../run"`

- [ ] **Step 3: 최소 구현**

`src/ts/process/lorebookExport/run.ts`:

```typescript
/**
 * 추출 오케스트레이션.
 *
 * LLM 호출은 주입받는다 (`requestChat`) — 그래야 테스트에서 실제 모델 없이
 * 전체 흐름을 검증할 수 있다. 실제 호출은 UI 쪽에서 requestChatData로 감싼다.
 */

import { splitIntoChunks, type ChunkMessage } from './chunking'
import { CHUNK_PROMPT, MERGE_PROMPT } from './prompts'
import { validateChunkResult } from './validate'
import { buildPreview } from './assemble'
import type { ChunkResult, DroppedItem, ExportPreview, MergeResult } from './types'

/** (프롬프트, 원문) → 모델 응답 텍스트. */
export type RequestChatFn = (prompt: string, sourceText: string) => Promise<string>

export interface RunOptions{
    messages: ChunkMessage[]
    requestChat: RequestChatFn
    onProgress?: (done: number, total: number) => void
    targetTurns?: number
}

/** 코드블록으로 감싼 JSON도 파싱한다. 모델이 종종 그렇게 낸다. */
function parseJson<T>(text: string): T | null{
    const stripped = text.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')
    try{
        return JSON.parse(stripped) as T
    }
    catch(e){
        return null
    }
}

export async function runExport(opts: RunOptions): Promise<ExportPreview>{
    const chunks = splitIntoChunks(opts.messages, { targetTurns: opts.targetTurns })
    if(chunks.length === 0){
        return buildPreview({ entries: [], dropped: [] })
    }

    const collected: ChunkResult[] = []
    const dropped: DroppedItem[] = []

    for(let i = 0; i < chunks.length; i++){
        const chunk = chunks[i]
        const raw = await opts.requestChat(CHUNK_PROMPT, chunk.text)
        const parsed = parseJson<ChunkResult>(raw)

        if(!parsed){
            // 청크 하나가 깨져도 전체를 포기하지 않는다.
            dropped.push({
                what: `청크 ${chunk.startIndex}~${chunk.endIndex}`,
                why: 'JSON 파싱 실패',
            })
        }
        else{
            const checked = validateChunkResult(parsed, chunk.text)
            collected.push(checked.result)
            dropped.push(...checked.dropped)
        }

        opts.onProgress?.(i + 1, chunks.length)
    }

    const mergeInput = JSON.stringify(collected)
    const mergeRaw = await opts.requestChat(MERGE_PROMPT, mergeInput)
    const merged = parseJson<MergeResult>(mergeRaw)
    if(!merged){
        throw new Error('merge 응답을 파싱할 수 없습니다')
    }

    return buildPreview({
        entries: merged.entries ?? [],
        dropped: [...dropped, ...(merged.dropped ?? [])],
    })
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run src/ts/process/lorebookExport/tests/run.test.ts`
Expected: PASS — 8 tests

- [ ] **Step 5: 전체 스위트**

Run: `npx vitest run`
Expected: 278 passed / 3 skipped (270 + 8)

- [ ] **Step 6: Commit**

```bash
git add src/ts/process/lorebookExport/run.ts src/ts/process/lorebookExport/tests/run.test.ts
git commit -m "feat: orchestrate chunked extraction and merge

The LLM call is injected rather than imported, so the whole pipeline —
chunking, validation, merge, preview assembly — is testable without a model.

A chunk whose response fails to parse is recorded in dropped and skipped; the
run continues. Losing one of nine chunks is better than losing the export.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: 미리보기 UI

**Files:**
- Create: `src/lib/Others/LorebookExportModal.svelte`
- Modify: `src/lang/ko.ts` (`"branch"` 뒤), `src/lang/en.ts` (`branch:` 뒤)

**Interfaces:**
- Consumes: `runExport`, `RequestChatFn` (Task 6), `toLoreBook`, `buildPreview` (Task 4), `ExportPreview`, `EntryDestination` (Task 1), `ALWAYS_ON_LIMIT` (Task 3)
- Produces: 기본 export한 Svelte 컴포넌트. props: `{ charIndex: number, chatIndex: number, onClose: () => void }`

- [ ] **Step 1: i18n 추가**

`src/lang/ko.ts`에서 `"branch": "분기점",` 뒤에 추가:

```typescript
    "lorebookExport": "로어북으로 추출",
    "lorebookExportRunning": (done:number, total:number) => `추출 중... (${done}/${total} 구간)`,
    "lorebookExportMerging": "통합 중...",
    "lorebookExportEmpty": "추출할 내용이 없습니다.",
    "lorebookExportDropped": "제외된 항목",
    "lorebookExportToGlobal": "캐릭터 로어북",
    "lorebookExportToLocal": "채팅 로어북",
    "lorebookExportDiscard": "버리기",
    "lorebookExportApply": "선택한 항목 추가",
    "lorebookExportApplied": (n:number) => `${n}개 항목을 추가했습니다.`,
    "lorebookExportOverflow": (chars:number, limit:number) => `상시 활성 항목이 ${chars}자입니다 (권장 ${limit}자). 일부를 버리거나 채팅 로어북으로 옮기세요.`,
    "lorebookExportRange": "추출 범위",
    "lorebookExportRangeAll": "전체 대화",
    "lorebookExportRangeRecent": (n:number) => `최근 ${n}턴`,
```

`src/lang/en.ts`에서 `branch:` 항목 뒤에 추가 (키에 따옴표 없음):

```typescript
    lorebookExport: "Export to Lorebook",
    lorebookExportRunning: (done:number, total:number) => `Extracting... (${done}/${total} chunks)`,
    lorebookExportMerging: "Merging...",
    lorebookExportEmpty: "Nothing to extract.",
    lorebookExportDropped: "Excluded",
    lorebookExportToGlobal: "Character Lorebook",
    lorebookExportToLocal: "Chat Lorebook",
    lorebookExportDiscard: "Discard",
    lorebookExportApply: "Add Selected",
    lorebookExportApplied: (n:number) => `Added ${n} entries.`,
    lorebookExportOverflow: (chars:number, limit:number) => `Always-active entries total ${chars} characters (recommended ${limit}). Discard some or move them to the chat lorebook.`,
    lorebookExportRange: "Range",
    lorebookExportRangeAll: "Entire conversation",
    lorebookExportRangeRecent: (n:number) => `Last ${n} turns`,
```

- [ ] **Step 2: 컴포넌트 작성**

`src/lib/Others/LorebookExportModal.svelte`:

```svelte
<script lang="ts">
    import { language } from 'src/lang'
    import { alertError, alertNormal } from 'src/ts/alert'
    import { requestChatData } from 'src/ts/process/request/request'
    import { runExport } from 'src/ts/process/lorebookExport/run'
    import { toLoreBook } from 'src/ts/process/lorebookExport/assemble'
    import { ALWAYS_ON_LIMIT } from 'src/ts/process/lorebookExport/validate'
    import type { ChunkMessage } from 'src/ts/process/lorebookExport/chunking'
    import type { EntryDestination, ExportPreview } from 'src/ts/process/lorebookExport/types'
    import { DBState } from 'src/ts/stores.svelte'
    import { XIcon } from '@lucide/svelte'

    interface Props {
        charIndex: number
        chatIndex: number
        onClose: () => void
    }
    let { charIndex, chatIndex, onClose }: Props = $props()

    let stage: 'range' | 'running' | 'preview' = $state('range')
    let progress = $state({ done: 0, total: 0 })
    let merging = $state(false)
    let preview: ExportPreview | null = $state(null)
    let recentTurns = $state(0)

    const chat = $derived(DBState.db.characters[charIndex].chats[chatIndex])
    const totalMessages = $derived(chat.message.length)

    /** 대화를 ChunkMessage로 옮긴다. 빈 메시지도 인덱스를 유지한다. */
    function collectMessages(limit: number): ChunkMessage[] {
        const all = chat.message.map((m, i) => ({
            role: m.role === 'user' ? 'user' as const : 'char' as const,
            data: m.data ?? '',
            index: i,
        }))
        return limit > 0 ? all.slice(-limit) : all
    }

    /** requestChatData를 runExport가 기대하는 형태로 감싼다. */
    async function requestChat(prompt: string, sourceText: string): Promise<string> {
        const res = await requestChatData({
            formated: [
                { role: 'system', content: prompt },
                { role: 'user', content: sourceText },
            ],
            bias: {},
            useStreaming: false,
            noMultiGen: true,
        }, 'model')

        if(res.type === 'success' || res.type === 'multiline'){
            return typeof res.result === 'string' ? res.result : JSON.stringify(res.result)
        }
        throw new Error(`추출 요청 실패: ${res.type === 'fail' ? res.result : res.type}`)
    }

    async function start() {
        stage = 'running'
        progress = { done: 0, total: 0 }
        merging = false
        try {
            const result = await runExport({
                messages: collectMessages(recentTurns),
                requestChat,
                onProgress: (done, total) => {
                    progress = { done, total }
                    if(done === total){
                        merging = true
                    }
                },
            })
            preview = result
            stage = 'preview'
        }
        catch(e) {
            alertError(String(e))
            onClose()
        }
    }

    function setDestination(i: number, d: EntryDestination) {
        if(!preview) return
        preview.destinations[i] = d
        // Svelte 5 반응성: 배열 자체를 갈아준다.
        preview = { ...preview, destinations: [...preview.destinations] }
    }

    function apply() {
        if(!preview) return
        const char = DBState.db.characters[charIndex]
        const target = char.chats[chatIndex]
        char.globalLore ??= []
        target.localLore ??= []

        let added = 0
        preview.entries.forEach((entry, i) => {
            const dest = preview!.destinations[i]
            if(dest === 'discard') return
            const lb = toLoreBook(entry)
            if(dest === 'global'){
                char.globalLore.push(lb)
            }
            else{
                target.localLore.push(lb)
            }
            added++
        })

        DBState.db.characters[charIndex].reloadKeys += 1
        alertNormal(language.lorebookExportApplied(added))
        onClose()
    }
</script>

<div class="fixed top-0 left-0 h-full w-full bg-black/50 flex items-center justify-center z-50">
    <div class="bg-darkbg rounded-md p-4 w-3xl max-w-full max-h-[85vh] flex flex-col">
        <div class="flex items-center mb-4">
            <h1 class="text-xl font-bold flex-1">{language.lorebookExport}</h1>
            <button onclick={onClose} class="text-textcolor2 hover:text-textcolor">
                <XIcon size={20} />
            </button>
        </div>

        {#if stage === 'range'}
            <span class="text-textcolor2 text-sm mb-2">{language.lorebookExportRange}</span>
            <button class="border-darkborderc border py-2 px-4 rounded-md hover:ring-2 mt-2 text-left"
                onclick={() => { recentTurns = 0; start() }}>
                {language.lorebookExportRangeAll} ({totalMessages})
            </button>
            {#each [30, 50, 100] as n}
                {#if n < totalMessages}
                    <button class="border-darkborderc border py-2 px-4 rounded-md hover:ring-2 mt-2 text-left"
                        onclick={() => { recentTurns = n; start() }}>
                        {language.lorebookExportRangeRecent(n)}
                    </button>
                {/if}
            {/each}

        {:else if stage === 'running'}
            <span class="text-textcolor2">
                {merging ? language.lorebookExportMerging : language.lorebookExportRunning(progress.done, progress.total)}
            </span>

        {:else if stage === 'preview' && preview}
            {#if preview.entries.length === 0}
                <span class="text-textcolor2">{language.lorebookExportEmpty}</span>
            {:else}
                {#if preview.alwaysOnOverflow}
                    <div class="text-yellow-400 text-sm mb-3">
                        {language.lorebookExportOverflow(preview.alwaysOnChars, ALWAYS_ON_LIMIT)}
                    </div>
                {/if}
                <div class="flex-1 overflow-y-auto">
                    {#each preview.entries as entry, i}
                        <div class="border-darkborderc border rounded-md p-3 mb-2">
                            <div class="flex items-center mb-2">
                                <span class="font-bold flex-1">{entry.comment}</span>
                                <span class="text-textcolor2 text-xs">
                                    {entry.category} · {entry.content.length}자
                                    {entry.alwaysActive ? ' · always-on' : ''}
                                </span>
                            </div>
                            <pre class="text-xs text-textcolor2 whitespace-pre-wrap max-h-32 overflow-y-auto mb-2">{entry.content}</pre>
                            <div class="flex gap-2">
                                {#each [['global', language.lorebookExportToGlobal], ['local', language.lorebookExportToLocal], ['discard', language.lorebookExportDiscard]] as [value, label]}
                                    <button
                                        class="text-xs px-2 py-1 rounded border {preview.destinations[i] === value ? 'border-blue-500 text-blue-400' : 'border-darkborderc text-textcolor2'}"
                                        onclick={() => setDestination(i, value as EntryDestination)}>
                                        {label}
                                    </button>
                                {/each}
                            </div>
                        </div>
                    {/each}

                    {#if preview.dropped.length > 0}
                        <details class="mt-3">
                            <summary class="text-textcolor2 text-sm cursor-pointer">
                                {language.lorebookExportDropped} ({preview.dropped.length})
                            </summary>
                            <ul class="text-xs text-textcolor2 mt-2">
                                {#each preview.dropped as d}
                                    <li>{d.what} — {d.why}</li>
                                {/each}
                            </ul>
                        </details>
                    {/if}
                </div>
                <button class="border-darkborderc border py-2 px-4 rounded-md hover:ring-2 mt-3" onclick={apply}>
                    {language.lorebookExportApply}
                </button>
            {/if}
        {/if}
    </div>
</div>
```

- [ ] **Step 3: 빌드 검사**

Run: `npx vite build`
Expected: exit 0

Run: `npx svelte-check --tsconfig ./tsconfig.json 2>&1 | grep -c "LorebookExportModal"`
Expected: `0` — 이 파일에 타입 오류가 없어야 한다

- [ ] **Step 4: 전체 스위트**

Run: `npx vitest run`
Expected: 278 passed / 3 skipped (변화 없음 — UI는 유닛 테스트를 추가하지 않는다)

`requestChatData`가 실제 모델을 호출하므로 유닛 테스트로 검증할 수 없다. Task 6이
`requestChat`을 주입받는 구조로 만든 이유가 이것이다 — 로직은 이미 테스트됐고,
이 컴포넌트는 배선과 렌더링만 한다.

- [ ] **Step 5: Commit**

```bash
git add src/lib/Others/LorebookExportModal.svelte src/lang/ko.ts src/lang/en.ts
git commit -m "feat: add lorebook export preview modal

Three stages: pick a range, watch progress, then decide each entry's
destination. Excluded items are listed with the reason they were dropped —
without that the user cannot tell a thin side character from a validation bug.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: 메뉴 배선

**Files:**
- Modify: `src/lib/Others/AlertComp.svelte:693` (chatOptions 메뉴에 버튼 추가)
- Modify: `src/lib/SideBars/SideChatList.svelte:264,375` (`case 3` 분기 2곳)

**Interfaces:**
- Consumes: `LorebookExportModal` (Task 7), `language.lorebookExport` (Task 7)
- Produces: 없음 (UI 종단)

- [ ] **Step 1: chatOptions 메뉴에 버튼 추가**

`src/lib/Others/AlertComp.svelte`에서 experimental 블록(`{#if DBState.db.useExperimental}` ...
`{/if}`, 694~708행)이 끝난 **직후**, cancel 버튼 **앞**에 추가:

```svelte
                    <button class="border-darkborderc border py-2 px-8 flex rounded-md hover:ring-2 items-center mt-2" onclick={() => {
                        alertStore.set({
                            type: 'none',
                            msg: '3'
                        })
                    }}>
                        <div class="flex flex-col justify-start items-start">
                            <span>{language.lorebookExport}</span>
                        </div>
                        <div class="ml-9 float-right flex-1 flex justify-end">
                            <ChevronRightIcon />
                        </div>
                    </button>
```

인덱스 `3`을 쓰는 이유: 기존 항목이 `0`(createCopy), `1`(bindPersona),
`2`(createMultiuserRoom, experimental)이다. experimental이 꺼져 있어도 인덱스는
고정이어야 한다 — 조건부로 번호를 바꾸면 호출부 분기가 깨진다.

- [ ] **Step 2: SideChatList에 모달 상태와 분기 추가**

`src/lib/SideBars/SideChatList.svelte` `<script>` 안에 추가:

```typescript
    import LorebookExportModal from "src/lib/Others/LorebookExportModal.svelte";

    let exportTarget: { charIndex: number, chatIndex: number } | null = $state(null)
```

`case 2` 블록 뒤(296~300행 근처, 첫 번째 `switch`)에 추가:

```typescript
                                    case 3:{
                                        exportTarget = {
                                            charIndex: $selectedCharID,
                                            chatIndex: chara.chats.indexOf(chat),
                                        }
                                        break
                                    }
```

두 번째 `switch`(408~412행 근처)의 `case 2` 뒤에도 추가:

```typescript
                            case 3:{
                                exportTarget = { charIndex: $selectedCharID, chatIndex: i }
                                break
                            }
```

**주의:** 기존 `case 2`에 `break`가 없다 (switch 마지막이라 생략됐다). `case 3`을
그 뒤에 넣으면 `case 2`가 fall through 한다. `case 2` 블록 끝에 `break`를 추가해야
한다 — 두 곳 모두.

- [ ] **Step 3: 모달 렌더링 추가**

`src/lib/SideBars/SideChatList.svelte`의 마크업 최상단 또는 최하단에 추가:

```svelte
{#if exportTarget}
    <LorebookExportModal
        charIndex={exportTarget.charIndex}
        chatIndex={exportTarget.chatIndex}
        onClose={() => { exportTarget = null }}
    />
{/if}
```

- [ ] **Step 4: 기존 메뉴가 안 깨졌는지 확인**

```bash
grep -n "case 2:" -A 6 src/lib/SideBars/SideChatList.svelte
```
Expected: 두 곳 모두 `case 2` 블록이 `break`로 끝나고, 그 뒤에 `case 3`이 있다.

- [ ] **Step 5: 빌드 검사**

Run: `npx vite build`
Expected: exit 0

Run: `npx vitest run`
Expected: 278 passed / 3 skipped

번들에 코드가 들어갔는지:
```bash
grep -rl "로어북으로 추출" dist/assets/*.js
```
Expected: 최소 1개 파일

- [ ] **Step 6: Commit**

```bash
git add src/lib/Others/AlertComp.svelte src/lib/SideBars/SideChatList.svelte
git commit -m "feat: wire lorebook export into the chat options menu

Index 3 is fixed rather than computed, because index 2 is behind an
experimental flag and a shifting number would break the call sites. Both
switch statements needed the same case, and case 2 needed a break it had been
getting away without as the final clause.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: 배포와 실환경 검증

**Files:** 없음 (배포 작업)

**Interfaces:**
- Consumes: Task 1~8 전부
- Produces: 없음

- [ ] **Step 1: 전체 검증**

```bash
npx vitest run
npx vite build
npx svelte-check --tsconfig ./tsconfig.json 2>&1 | tail -3
```
Expected: 278 passed / 3 skipped, 빌드 exit 0, svelte-check 신규 오류 0

- [ ] **Step 2: 배포**

`risuai-deploy` 스킬을 쓴다. 검증 키워드는 `로어북으로 추출`(클라이언트 번들).
`--no-cache`를 반드시 쓴다 — 프론트엔드 변경이다.

서버 코드(`server.cjs`)는 이 기능에서 변경되지 않는다. 배포 후 기존 키워드
(`Stream ended without metadata`)가 여전히 1건인지 확인해 회귀가 없음을 본다.

- [ ] **Step 3: 실환경 검증 — 사용자 확인 항목**

스펙의 검증 기준 1~12 중 사람이 눌러봐야 하는 것:

1. 채팅 목록에서 메뉴를 열면 "로어북으로 추출"이 보인다
2. 범위를 고르면 진행 표시가 나타나고 구간 수가 맞다
3. 추출 결과에 인물 항목이 생성된다
4. 생성된 항목에 `무심하다` 류 평가어가 없다
5. 각 인물 항목에 대사(`"..."`)나 조건-반응(`... : ...`)이 3개 이상 있다
6. 항목별로 캐릭터/채팅/버리기를 고를 수 있다
7. 제외된 항목에 이유가 표시된다
8. "선택한 항목 추가"를 누르면 로어북에 들어간다
9. 추가된 항목이 기존 로어북 편집 UI에서 열린다
10. always-on 합이 5,000자를 넘으면 경고가 뜬다

- [ ] **Step 4: 에이전트 확인 항목**

```bash
# 로어북 항목이 DB에 실제로 들어갔는지
ssh rpi 'docker exec risuai node -e "
const fs=require(\"fs\");
const h=Buffer.from(\"database/database.bin\").toString(\"hex\");
const d=fs.readFileSync(\"/app/save/\"+h);
let o=9;
while(o<d.length){
  const t=d[o]; o+=2; const nl=d[o]; o+=1; o+=nl;
  const dl=d.readUInt32LE(o); o+=4;
  if(t===2){
    try{
      const c=JSON.parse(d.subarray(o,o+dl).toString(\"utf8\"));
      const g=(c.globalLore||[]).length;
      const l=(c.chats||[]).reduce((s,ch)=>s+(ch.localLore||[]).length,0);
      if(g||l) console.log(c.name+\": globalLore \"+g+\", localLore \"+l);
    }catch(e){}
  }
  o+=dl;
}
"'
```

추출한 캐릭터의 `globalLore` 또는 `localLore` 수가 늘어야 한다.

```bash
# 평가어가 실제로 안 들어갔는지 (검증 기준 4의 기계 확인)
# 위 스크립트를 수정해 globalLore content에 denylist를 걸어 매치 수를 센다.
# 0이어야 한다.
```

- [ ] **Step 5: 결과 보고**

검증 결과를 사용자에게 보고한다. 실패한 항목은 숨기지 않고 그대로 보고한다.

특히 확인할 것: **추출 품질이 micro-detail 수준인가.** 항목이 생성됐지만 내용이
요약이면 이 기능은 목적을 달성하지 못했다. 그 경우 프롬프트를
`.superpowers/sdd/lorebook-export/final-prompts.md`에서 조정하고 재배포한다.

---

## 자체 검토 결과

**스펙 커버리지:**

| 스펙 항목 | 담당 |
|---|---|
| 1. 처리 흐름 | Task 6 (오케스트레이션), Task 7 (UI 단계) |
| 2. 추출 단위 fact 6종 | Task 1 (타입), Task 5 (프롬프트) |
| 3. 슬롯 라벨 9개 | Task 5 (프롬프트 안에 정의) |
| 4. 인물 통과 조건 | Task 3 (`validatePerson`) |
| 5. 코드 검증 5단계 | Task 3 (1~4단계), Task 3+4 (5단계) |
| 6. merge 규칙 | Task 5 (merge 프롬프트) |
| 7. 카드 설정과 겹칠 때 | Task 5 (chunk 프롬프트 제외 절) |
| 8. 활성화 방식 | Task 4 (`INSERT_ORDER`, `defaultDestination`), Task 5 (merge 프롬프트) |
| 9. 모델 | Task 7 (`requestChatData(..., 'model')`) |
| 10. UI | Task 7 (모달), Task 8 (진입점) |
| 검증 기준 1~12 | Task 9 |

누락 없음.

**타입 일관성:** `Fact.t` 값 6종이 Task 1 정의와 Task 3 `validateFact` switch에서
일치한다. `MergedEntry.category` 4종이 Task 1과 Task 4 `INSERT_ORDER` 키에서
일치한다. `EntryDestination` 3종이 Task 1, Task 4 `defaultDestination`, Task 7
버튼 배열에서 일치한다.

**순서 의존:** Task 1→2→3→4는 순차(각각 앞의 타입/함수를 씀). Task 5는 독립.
Task 6은 1~5 전부 필요. Task 7은 6 필요. Task 8은 7 필요. Task 9는 전부 필요.

**Task 8의 위험:** 기존 `case 2`에 `break`가 없어서 `case 3` 추가 시 fall through
한다. 계획에 명시했지만 실행 시 놓치기 쉬운 지점이다.
