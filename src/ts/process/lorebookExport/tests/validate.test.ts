import { describe, expect, it } from 'vitest'

import {
    ALWAYS_ON_LIMIT,
    checkAlwaysOnBudget,
    EVALUATIVE_DENYLIST,
    validateChunkResult,
    validateFact,
    validatePerson,
} from '../validate'
import type { ChunkResult, Fact, MergedEntry, ObjectDraft, PersonDraft } from '../types'

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

    it('C1: src가 빈 문자열이면 버린다', () => {
        // sourceText.includes('')는 항상 true라서, 빈 src는 검증 자체를
        // 무력화한다. quote 앵커가 있어도 src가 비면 통과해선 안 된다.
        expect(validateFact(fact({
            t: 'quote', v: '"난 사람을 죽인 적이 있다"', src: '', msg: 10,
        }), SRC)).toBe(false)
    })

    it('C1: src가 5자 미만이면 버린다', () => {
        // 설계 스펙의 src 하한(5자)을 강제한다. 1글자 앵커는 원문 어디에나
        // 있을 수 있어 빈 문자열과 실질적으로 같은 문제다.
        expect(validateFact(fact({
            t: 'plain', v: '방에 있다', src: '그', msg: 10,
        }), SRC)).toBe(false)
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

    it('I1: 숫자 런이 부분 문자열로만 겹치면 버린다 (자릿수 부풀림)', () => {
        // "17"이 "170"에 포함된다고 통과시키면 10배 부풀린 수치가 살아남는다.
        expect(validateFact(fact({
            t: 'num', v: '170년 무직', src: '17년째 무직',
        }), SRC)).toBe(false)
    })

    it('I1: 앵커의 숫자가 v의 다른 수량에 재사용되면 버린다', () => {
        // "17"이 "1700"에도 부분 문자열로 들어있다 — 전혀 다른 수량(원)에
        // 앵커 숫자를 갖다 붙인 경우다.
        expect(validateFact(fact({
            t: 'num', v: '월 1700만원', src: '17년째 무직',
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

    it('I2: 인용부호 안에 날조를 이어붙이면 버린다', () => {
        // 앵커는 인용부호 안에 그대로 있지만, 뒤에 없는 말이 덧붙었다.
        // includes였다면 통과했을 것 — 이제는 정확히 일치해야 한다.
        expect(validateFact(fact({
            t: 'quote',
            v: '"네가 없으면 난 아무것도 아니야 널 죽일거야"',
            src: '네가 없으면 난 아무것도 아니야',
            msg: 12,
        }), SRC)).toBe(false)
    })

    it('I3: 커브 인용부호(" ")도 인정한다', () => {
        // 한국어 문장에서 커브 인용부호가 흔하다. ASCII만 인정하면 원문
        // 그대로인 인용도 부호 형태 때문에 탈락한다.
        expect(validateFact(fact({
            t: 'quote',
            v: '“네가 없으면 난 아무것도 아니야”',
            src: '네가 없으면 난 아무것도 아니야',
            msg: 12,
        }), SRC)).toBe(true)
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

    it('I6: absence는 fact 총합 집계에서 빠진다 — 미검증 주장으로 쿼터를 채울 수 없다', () => {
        const p = goodPerson()
        // Habits를 절대 검증되지 않는 absence 3개로 바꾼다. absence는 1단계가
        // 면제되어 있으므로, 집계에 넣으면 미검증 주장만으로 총합 8을 채울 수
        // 있다. countable(=Identity+Speech+Reactions=5)만 세야 한다.
        p.slots.Habits = [
            fact({ t: 'absence', v: '외출 없음', src: '아무 상관없는 문장', msg: 10 }),
            fact({ t: 'absence', v: '음주 없음', src: '아무 상관없는 문장', msg: 10 }),
            fact({ t: 'absence', v: '갈등 없음', src: '아무 상관없는 문장', msg: 10 }),
        ]

        const out = validatePerson(p, SRC)

        expect(out.person).toBeNull()
        expect(out.reason).toContain('8')
    })

    it('I6: 통과한 인물의 absence fact는 결과에서 제거되지 않는다', () => {
        // 집계에서는 빼지만, merge 단계로는 그대로 넘겨야 한다 — 부재의 진위
        // 판단은 merge의 몫이다.
        const p = goodPerson()
        p.slots.Absences = [
            fact({ t: 'absence', v: '외출 없음', src: '아무 상관없는 문장', msg: 10 }),
        ]

        const out = validatePerson(p, SRC)

        expect(out.person).not.toBeNull()
        expect(out.person!.slots.Absences).toHaveLength(1)
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

    it('I4: slots 필드가 없는 인물은 던지지 않고 dropped로 처리한다', () => {
        // LLM JSON이 slots를 아예 빼먹은 경우. 형제 필드들(places/state/objects)은
        // 전부 ?? []로 감싸져 있지만 person.slots는 그렇지 않았다 — 한 명이
        // 잘못되면 청크 전체가 TypeError로 죽었다.
        const result = {
            people: [{ name: '만세' }],
            places: [],
            state: [],
            objects: [],
        } as unknown as ChunkResult

        const out = validateChunkResult(result, SRC)

        expect(out.result.people).toHaveLength(0)
        expect(out.dropped).toHaveLength(1)
        expect(out.dropped[0].what).toContain('만세')
    })

    it('I5: ObjectDraft에 새 필드를 추가해도 결과에 그대로 실린다 (선언된 타입 사용)', () => {
        // validateChunkResult가 인라인 구조 타입이 아니라 선언된 ChunkResult를
        // 쓰는지 확인한다. 인라인 타입이었다면 ObjectDraft 확장 필드가 반환
        // 타입에서 추론상 잘려나갈 수 있었다 — 런타임에는 spread(...ob)로
        // 실려도 타입은 그 사실을 숨겼을 것이다.
        const objectWithAlias: ObjectDraft = {
            name: '단검', aliases: ['은장도'],
            facts: [fact({ t: 'num', v: '17년', src: '17년째 무직' })],
        }
        const result: ChunkResult = {
            people: [], places: [], state: [],
            objects: [objectWithAlias],
        }

        const out = validateChunkResult(result, SRC)

        expect(out.result.objects[0].aliases).toEqual(['은장도'])
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
