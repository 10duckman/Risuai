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
        case 'num':{
            const srcDigits = digitsOf(fact.src)
            if(srcDigits.length === 0){
                return false
            }
            // src의 숫자 중 하나라도 v에 나타나야 한다.
            return srcDigits.some(d => fact.v.includes(d))
        }
        case 'quote':{
            // src 전문이 v의 인용부호 안에 글자 그대로 있어야 한다.
            const quoted = fact.v.match(/"([^"]*)"/g) ?? []
            return quoted.some(q => q.slice(1, -1).includes(fact.src))
        }
        case 'trigger':{
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
