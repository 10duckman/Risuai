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
