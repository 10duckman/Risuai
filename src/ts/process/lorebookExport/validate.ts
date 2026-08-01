/**
 * 코드 검증 5단계.
 *
 * 프롬프트만으로는 평가어를 막을 수 없다. 특히 2단계가 중요하다 — 앵커가
 * 원문에 있다는 것만 검사하면 src:"대답도 없이 방으로" + v:"무심하다" 조합이
 * 통과한다. 검사 대상은 출하되는 텍스트(v)여야 한다.
 */

import type { ChunkResult, DroppedItem, Fact, MergedEntry, PersonDraft } from './types'

export const ALWAYS_ON_LIMIT = 5000

/**
 * src 앵커의 최소 길이. 설계 스펙(5~60자)의 하한을 그대로 강제한다 — 빈
 * 문자열이나 한두 글자짜리 앵커는 sourceText.includes()를 항상(또는 거의
 * 항상) 통과시켜 검증 자체를 무력화한다. absence는 이 검사도 면제된다.
 */
const MIN_SRC_LENGTH = 5

/**
 * 평가어. 매치되면 그 fact를 버린다.
 * 알려진 오탐(광범위한 어간 매칭의 트레이드오프로 받아들인다): 무심코, 똑같다,
 * 물 같다, 불성실하다 등도 걸린다.
 */
export const EVALUATIVE_DENYLIST =
    /무심|다정|순수|차갑|따뜻|냉정|헌신적|성실|가정적|착하|나쁘|훌륭|(적|스러운|로운)이다|경향이 있다|편이다|같다|보인다/

/** 인물 통과 조건. */
const MIN_TRIGGER_QUOTE = 3
const MIN_FACTS = 8
const MIN_SLOTS = 3

/** v에서 숫자열을 뽑는다. */
function digitsOf(s: string): string[]{
    return s.match(/\d+/g) ?? []
}

/**
 * v에서 인용부호로 감싸인 구간들을 뽑는다. ASCII(")와 커브(" ") 인용부호를
 * 모두 인정한다 — 한국어 문장에 커브 인용부호가 흔해서, ASCII만 인정하면
 * 원문 그대로인 인용도 탈락한다.
 *
 * src 자체에 인용부호 문자가 들어있는 경우는 지원하지 않는다 — 지원하려면
 * 탐욕적 매칭이 필요한데, 그러면 v 안에 서로 다른 두 인용이 있을 때 그 사이
 * 전체를 하나로 묶어버려 더 흔한 경우(인용이 여러 개인 v)를 깨뜨린다.
 */
function extractQuoted(v: string): string[]{
    const ascii = v.match(/"([^"]*)"/g) ?? []
    const curly = v.match(/“([^”]*)”/g) ?? []
    return [...ascii, ...curly].map(q => q.slice(1, -1))
}

/**
 * fact 하나를 검증한다. 3 → 1 → 2 순서로 적용한다 — 평가어 탈락(3단계)을
 * 가장 먼저 본다.
 */
export function validateFact(fact: Fact, sourceText: string): boolean{
    // 3단계를 먼저 본다 — 평가어는 타입과 무관하게 즉시 탈락이다.
    if(EVALUATIVE_DENYLIST.test(fact.v)){
        return false
    }

    // 1단계: src verbatim. absence는 면제한다 (부재는 원문에 진술되지 않는다).
    // 앵커 길이도 여기서 강제한다 — 빈 문자열은 sourceText.includes('')가
    // 항상 true라서 검증을 통째로 무력화한다.
    if(fact.t !== 'absence' && (fact.src.length < MIN_SRC_LENGTH || !sourceText.includes(fact.src))){
        return false
    }

    // 2단계: src → v 연결.
    switch(fact.t){
        case 'num':{
            const srcDigits = digitsOf(fact.src)
            if(srcDigits.length === 0){
                return false
            }
            const vDigits = digitsOf(fact.v)
            // src의 숫자 런과 v의 숫자 런이 정확히 일치해야 한다 — 부분
            // 문자열 매치는 170이 17을 포함하는 식으로 자릿수를 부풀릴 수 있다.
            return srcDigits.some(d => vDigits.includes(d))
        }
        case 'quote':{
            // src 전문이 v의 인용부호 안에 (트림 후) 정확히 일치해야 한다.
            // includes였다면 인용 뒤에 날조를 이어붙여도 통과했다.
            const quoted = extractQuoted(fact.v)
            return quoted.some(q => q.trim() === fact.src.trim())
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
    // slots가 없는 인물(LLM JSON 오류)은 형제 필드들처럼 ?? []로 감쌀 수 없다
    // — Object.entries(undefined)가 던진다. 여기서 걸러서 원인을 밝힌다.
    if(!person.slots){
        return { person: null, reason: 'slots 필드 없음' }
    }

    const slots = filterSlots(person.slots, sourceText)
    const all = Object.values(slots).flat()

    const triggerQuote = all.filter(f => f.t === 'trigger' || f.t === 'quote').length
    if(triggerQuote < MIN_TRIGGER_QUOTE){
        return { person: null, reason: `trigger+quote ${triggerQuote}개 (최소 ${MIN_TRIGGER_QUOTE})` }
    }
    // absence는 검증(1단계)이 면제되어 있으므로 최소 fact 수에는 넣지 않는다
    // — 그러지 않으면 미검증 주장으로 쿼터의 절반 넘게 채울 수 있다. 결과에는
    // 그대로 남긴다 (merge 단계로 넘겨야 하니까).
    const countable = all.filter(f => f.t !== 'absence')
    if(countable.length < MIN_FACTS){
        return { person: null, reason: `fact ${countable.length}개 (최소 ${MIN_FACTS})` }
    }
    const filledSlots = Object.values(slots).filter(fs => fs.length > 0).length
    if(filledSlots < MIN_SLOTS){
        return { person: null, reason: `슬롯 ${filledSlots}개 (최소 ${MIN_SLOTS})` }
    }

    return { person: { ...person, slots } }
}

/** 청크 결과 전체를 검증한다. */
export function validateChunkResult(
    result: ChunkResult,
    sourceText: string,
): { result: ChunkResult, dropped: DroppedItem[] }{
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
