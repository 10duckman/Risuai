/**
 * 프롬프트가 약속하는 출력 형태가 코드가 읽는 형태와 같은지 검증한다.
 *
 * 이 테스트가 존재하는 이유: 배포 후 실제 Opus 5 응답이 `characters`/`type`/
 * `text`로 왔고 코드는 `people`/`t`/`v`를 읽어서 인물·장소·사물이 전부 조용히
 * 버려졌다. 원인은 프롬프트가 "스키마는 별도로 주어진다"고 적어놨는데 정작
 * 스키마를 아무도 붙이지 않은 것이었다 — 모델은 필드명을 추측할 수밖에 없고,
 * 더 자연스러운 긴 이름(characters/type/text)을 골랐다.
 *
 * 문자열을 grep하는 대신 프롬프트에 박힌 JSON 예시를 실제로 파싱해서
 * runExport에 흘린다. 예시와 코드가 어긋나면 결과가 비어서 바로 걸린다.
 */

import { describe, expect, it } from 'vitest'
import { CHUNK_PROMPT, MERGE_PROMPT } from '../prompts'
import { runExport } from '../run'

/** 프롬프트 본문의 ```json 블록을 꺼낸다. */
function exampleFrom(prompt: string): string{
    const m = prompt.match(/```json\n([\s\S]+?)\n```/)
    if(!m){
        throw new Error('프롬프트에 ```json 예시 블록이 없다')
    }
    return m[1]
}

describe('프롬프트의 JSON 예시', () => {
    it('청크 프롬프트의 예시가 파싱된다', () => {
        expect(() => JSON.parse(exampleFrom(CHUNK_PROMPT))).not.toThrow()
    })

    it('merge 프롬프트의 예시가 파싱된다', () => {
        expect(() => JSON.parse(exampleFrom(MERGE_PROMPT))).not.toThrow()
    })

    it('청크 예시의 최상위 키가 코드가 읽는 네 개다', () => {
        // characters/states로 오면 people/state가 비어 인물이 통째로 사라진다.
        const ex = JSON.parse(exampleFrom(CHUNK_PROMPT))

        expect(Object.keys(ex).sort()).toEqual(['objects', 'people', 'places', 'state'])
    })

    it('청크 예시의 fact 키가 t/v/src/msg다', () => {
        // type/text로 오면 검증 1단계에서 전부 탈락한다.
        const ex = JSON.parse(exampleFrom(CHUNK_PROMPT))
        const fact = ex.people[0].slots.Identity[0]

        expect(Object.keys(fact).sort()).toEqual(['msg', 'src', 't', 'v'])
    })

    it('청크 예시에서 인물은 slots, 장소·사물은 facts를 쓴다', () => {
        // 실제 응답은 장소·사물에도 slots를 써서 안이 통째로 비었다.
        const ex = JSON.parse(exampleFrom(CHUNK_PROMPT))

        expect(ex.people[0]).toHaveProperty('slots')
        expect(ex.places[0]).toHaveProperty('facts')
        expect(ex.objects[0]).toHaveProperty('facts')
    })

    it('merge 예시가 MergedEntry의 필수 필드를 모두 갖는다', () => {
        const ex = JSON.parse(exampleFrom(MERGE_PROMPT))

        expect(Object.keys(ex.entries[0]).sort()).toEqual([
            'alwaysActive', 'category', 'comment', 'content', 'insertorder',
            'key', 'mode', 'secondkey', 'selective', 'useRegex',
        ])
    })

    it('두 예시를 그대로 응답으로 주면 runExport가 항목을 만든다', async () => {
        // 프롬프트 예시가 코드의 계약과 맞는지를 끝까지 흘려서 확인한다.
        // 청크 예시의 fact는 src가 원문에 없으면 탈락하므로, 원문을 예시의
        // src들로 만들어 준다.
        const chunkExample = JSON.parse(exampleFrom(CHUNK_PROMPT))
        const mergeExample = exampleFrom(MERGE_PROMPT)

        // 예시 fact들의 src가 대화 원문에 있어야 검증을 통과한다.
        const srcs: string[] = []
        for(const p of chunkExample.people){
            for(const facts of Object.values(p.slots as Record<string, { src: string }[]>)){
                facts.forEach(f => srcs.push(f.src))
            }
        }
        for(const group of [...chunkExample.places, ...chunkExample.objects]){
            group.facts.forEach((f: { src: string }) => srcs.push(f.src))
        }
        chunkExample.state.forEach((f: { src: string }) => srcs.push(f.src))

        let call = 0
        const preview = await runExport({
            messages: [{ role: 'char', data: srcs.join(' '), index: 0 }],
            requestChat: async () => {
                call++
                return call === 1 ? JSON.stringify(chunkExample) : mergeExample
            },
        })

        // merge 예시의 항목이 평가어 스캔과 content 검사를 통과해 살아남는다.
        expect(preview.entries).toHaveLength(1)
        expect(preview.entries[0].comment).toBe('만세')
        expect(preview.entries[0].category).toBe('person')
    })
})
