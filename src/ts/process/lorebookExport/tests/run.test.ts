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

    it('첫 청크를 기다리기 전에 총 개수를 먼저 알린다', async () => {
        // 청크 하나에 2~3분이 걸린다. 루프 안에서만 알리면 그동안 진행 표시가
        // "0/0"으로 남아 멈춘 것처럼 보인다.
        const onProgress = vi.fn()
        const requestChat = vi.fn().mockImplementation(async (p: string) => {
            // 첫 호출 시점에 이미 총 개수가 전달돼 있어야 한다.
            expect(onProgress).toHaveBeenCalledWith(0, 3)
            return p.includes('합친다') ? mergeResponse : goodChunkResponse(0)
        })

        await runExport({ messages: messages(75), requestChat, onProgress, targetTurns: 25 })

        expect(onProgress.mock.calls[0]).toEqual([0, 3])
    })

    it('청크가 없으면 onProgress를 부르지 않는다', async () => {
        // (0, 0)이 가면 모달의 done === total 판정이 merging을 켜버린다.
        const onProgress = vi.fn()
        const requestChat = vi.fn()

        await runExport({ messages: [], requestChat, onProgress })

        expect(onProgress).not.toHaveBeenCalled()
        expect(requestChat).not.toHaveBeenCalled()
    })

    it('중단하면 남은 청크를 호출하지 않는다', async () => {
        // 긴 대화 하나가 Opus 5 호출 15회에 40분이다(실측). 멈출 수단이 없으면
        // 모달을 닫아도 남은 호출이 그대로 나간다.
        let cancelled = false
        const requestChat = vi.fn().mockImplementation(async (p: string) => {
            cancelled = true   // 첫 청크가 끝나자마자 중단
            return p.includes('합친다') ? mergeResponse : goodChunkResponse(0)
        })

        const preview = await runExport({
            messages: messages(75), requestChat, targetTurns: 25,
            isCancelled: () => cancelled,
        })

        // 청크 3개짜리인데 1회만 호출됐다 — merge도 부르지 않는다.
        expect(requestChat).toHaveBeenCalledTimes(1)
        expect(preview.entries).toHaveLength(0)
        expect(preview.dropped.some(d => d.why === '사용자가 중단')).toBe(true)
    })

    it('중단하지 않으면 끝까지 돈다', async () => {
        const requestChat = vi.fn().mockImplementation(async (p: string) =>
            p.includes('합친다') ? mergeResponse : goodChunkResponse(0))

        await runExport({
            messages: messages(75), requestChat, targetTurns: 25,
            isCancelled: () => false,
        })

        // 청크 3회 + merge 1회
        expect(requestChat).toHaveBeenCalledTimes(4)
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

    it('C1: <Thoughts> 블록이 붙은 순수 JSON(코드블록 없음)도 파싱한다', async () => {
        // thinking이 기본으로 켜지는 모델(Opus 5 Bedrock)의 응답은
        // <Thoughts>...</Thoughts>로 시작한다. HEAD의 parseJson은 이걸
        // 전혀 벗기지 않으므로 이 테스트는 HEAD 기준으로 실패한다 —
        // JSON.parse가 앞의 <Thoughts> 텍스트 때문에 깨져 청크가 dropped로
        // 빠지고, entries가 0개가 된다.
        const withThoughts = (json: string) => `<Thoughts>\n추론 중...\n</Thoughts>\n${json}`
        const requestChat = vi.fn().mockImplementation(async (p: string) =>
            p.includes('합친다') ? withThoughts(mergeResponse) : withThoughts(goodChunkResponse(0)))

        const preview = await runExport({ messages: messages(25), requestChat })

        expect(preview.entries).toHaveLength(1)
    })

    it('C1: <Thoughts> 블록이 붙은 코드블록(json 태그) JSON도 파싱한다', async () => {
        // 위와 같은 이유로 HEAD 기준 실패한다 — <Thoughts>가 앞에 있으면
        // HEAD의 fence-strip 정규식(^```(?:json)?\s*)이 문자열 맨 앞에서만
        // 매치되므로 전혀 벗겨지지 않는다.
        const withThoughtsFenced = (json: string) =>
            `<Thoughts>\n추론 중...\n</Thoughts>\n\`\`\`json\n${json}\n\`\`\``
        const requestChat = vi.fn().mockImplementation(async (p: string) =>
            p.includes('합친다') ? withThoughtsFenced(mergeResponse) : withThoughtsFenced(goodChunkResponse(0)))

        const preview = await runExport({ messages: messages(25), requestChat })

        expect(preview.entries).toHaveLength(1)
    })

    it('C1: 언어 태그 없는 코드블록(bare fence)도 파싱한다', async () => {
        // 작업 시작 시점의 깨진 작업 트리(util.ts의 jsonOutputTrimmer에
        // 그대로 위임한 버전)를 기준으로 실패한다 — 그 함수는
        // data.startsWith('```json')만 검사해서 언어 태그 없는 ```만 있는
        // 코드블록은 벗기지 못하고 JSON.parse가 깨진다. (HEAD 자체는 이
        // 케이스를 이미 지원했으므로, 이 테스트는 "이 fix wave에서 옮기며
        // 잃지 말아야 할 커버리지"를 고정한다.)
        const bareFenced = (json: string) => `\`\`\`\n${json}\n\`\`\``
        const requestChat = vi.fn().mockImplementation(async (p: string) =>
            p.includes('합친다') ? bareFenced(mergeResponse) : bareFenced(goodChunkResponse(0)))

        const preview = await runExport({ messages: messages(25), requestChat })

        expect(preview.entries).toHaveLength(1)
    })

    it('C2: merge가 낸 content에 평가어가 있으면 그 항목을 dropped로 돌린다', async () => {
        // fix 전 run.ts는 merged.entries를 검증 없이 그대로 buildPreview에
        // 넘겼다 — chunk 단계 검증은 chunk 원문(fact.src/v)만 봤을 뿐,
        // merge가 새로 쓴 content는 아무도 다시 보지 않았다. 이 테스트는
        // EVALUATIVE_DENYLIST가 실제로 content에 적용되는지 확인한다.
        // fix 전: preview.entries에 그대로 실려 나가 이 테스트가 실패한다.
        const mergeWithEvaluative = JSON.stringify({
            entries: [{
                comment: '김만세',
                content: '### 김만세 — 무심한 남편\n- Personality: 무심하다. 다정하지 않다. 게으른 편이다.',
                key: '', secondkey: '', insertorder: 100, mode: 'normal',
                alwaysActive: true, selective: false, useRegex: false, category: 'person',
            }],
            dropped: [],
        })
        const requestChat = vi.fn().mockImplementation(async (p: string) =>
            p.includes('합친다') ? mergeWithEvaluative : goodChunkResponse(0))

        const preview = await runExport({ messages: messages(25), requestChat })

        expect(preview.entries).toHaveLength(0)
        expect(preview.dropped.some(d => d.what.includes('김만세') && d.why.includes('평가어'))).toBe(true)
    })

    it('M5: content 없는 merge 항목은 TypeError 없이 dropped로 처리된다', async () => {
        // fix 전: buildPreview -> checkAlwaysOnBudget이 e.content.length를
        // 무조건 호출해서, content가 없는 항목(JSON.stringify가 undefined
        // 필드를 통째로 빼버린 경우)을 만나면 던진다 — runExport 전체가
        // reject된다. 이 테스트는 그 예외 없이 정상적으로 미리보기가 나오고,
        // 그 항목이 dropped에 이유와 함께 남는지 확인한다.
        const mergeNoContent = JSON.stringify({
            entries: [{
                comment: '김만세',
                key: '', secondkey: '', insertorder: 100, mode: 'normal',
                alwaysActive: true, selective: false, useRegex: false, category: 'person',
            }],
            dropped: [],
        })
        const requestChat = vi.fn().mockImplementation(async (p: string) =>
            p.includes('합친다') ? mergeNoContent : goodChunkResponse(0))

        const preview = await runExport({ messages: messages(25), requestChat })

        expect(preview.entries).toHaveLength(0)
        expect(preview.dropped.some(d => d.what.includes('김만세') && d.why.includes('content'))).toBe(true)
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

    it('청크 응답이 파싱되지만 예상과 다른 형태면 파싱 실패와 구분해서 dropped에 담는다', async () => {
        const requestChat = vi.fn().mockImplementation(async (p: string) =>
            p.includes('합친다') ? mergeResponse : '{"error":"model refused"}')

        const preview = await runExport({ messages: messages(25), requestChat })

        expect(preview.dropped.some(d => d.why.includes('형태'))).toBe(true)
        expect(preview.dropped.some(d => d.why.includes('파싱'))).toBe(false)
    })

    it('merge 응답이 파싱되지만 entries가 배열이 아니면 던진다', async () => {
        const requestChat = vi.fn().mockImplementation(async (p: string) =>
            p.includes('합친다') ? '{"ok":true}' : goodChunkResponse(0))

        await expect(runExport({ messages: messages(25), requestChat }))
            .rejects.toThrow(/merge/)
    })

    it('merge 파싱 실패 메시지에 응답 길이와 일부 내용이 담긴다', async () => {
        const badMerge = '이건 JSON이 아닌 완전히 깨진 응답입니다'
        const requestChat = vi.fn().mockImplementation(async (p: string) =>
            p.includes('합친다') ? badMerge : goodChunkResponse(0))

        let caught: Error | undefined
        try{
            await runExport({ messages: messages(25), requestChat })
        }
        catch(e){
            caught = e as Error
        }

        expect(caught).toBeDefined()
        expect(caught!.message).toContain(String(badMerge.length))
        expect(caught!.message).toContain(badMerge.slice(0, 10))
    })

    it('모든 청크가 실패하면 merge를 호출하지 않는다', async () => {
        const requestChat = vi.fn().mockImplementation(async () => '이건 JSON이 아닙니다')

        const preview = await runExport({ messages: messages(25), requestChat })

        // 청크 1개, 모두 실패 — merge를 호출할 이유가 없다
        expect(requestChat).toHaveBeenCalledTimes(1)
        expect(preview.entries).toHaveLength(0)
        expect(preview.dropped.length).toBeGreaterThan(0)
    })

    it('검증을 통과한 인물이 merge 호출의 원본 데이터에 포함된다', async () => {
        const requestChat = vi.fn().mockImplementation(async (p: string) =>
            p.includes('합친다') ? mergeResponse : goodChunkResponse(0))

        await runExport({ messages: messages(25), requestChat })

        const mergeCall = requestChat.mock.calls.find(c => c[0].includes('합친다'))
        expect(mergeCall![1]).toContain('김만세')
    })

    it('merge가 보고한 dropped 항목이 검증 단계의 dropped와 함께 preview에 남는다', async () => {
        const droppedByValidation = JSON.stringify({
            people: [{ name: '단역', slots: { Misc: [{ t: 'plain', v: '송진 냄새', src: '17년째 무직', msg: 0 }] } }],
            places: [], state: [], objects: [],
        })
        const mergeWithDropped = JSON.stringify({
            entries: [],
            dropped: [{ what: '장소: 폐가', why: '한 번만 등장' }],
        })
        const requestChat = vi.fn().mockImplementation(async (p: string) =>
            p.includes('합친다') ? mergeWithDropped : droppedByValidation)

        const preview = await runExport({ messages: messages(25), requestChat })

        expect(preview.dropped.some(d => d.what.includes('단역'))).toBe(true)
        expect(preview.dropped.some(d => d.what.includes('폐가'))).toBe(true)
    })

    it('실패한 청크에도 onProgress가 호출된다', async () => {
        const onProgress = vi.fn()
        const requestChat = vi.fn().mockImplementation(async (p: string) =>
            p.includes('합친다') ? JSON.stringify({ entries: [], dropped: [] }) : '이건 JSON이 아닙니다')

        await runExport({ messages: messages(50), requestChat, onProgress, targetTurns: 25 })

        // 청크 2개 모두 실패해도 진행 상황은 둘 다 알린다
        expect(onProgress).toHaveBeenCalledWith(1, 2)
        expect(onProgress).toHaveBeenCalledWith(2, 2)
    })

    it('targetTurns를 청크 분할에 반영한다', async () => {
        const requestChat = vi.fn().mockImplementation(async (p: string) =>
            p.includes('합친다') ? JSON.stringify({ entries: [], dropped: [] }) : goodChunkResponse(0))

        // targetTurns=10 → 50개 메시지가 5개 청크로 나뉜다 (기본값 25라면 2개)
        await runExport({ messages: messages(50), requestChat, targetTurns: 10 })

        // 청크 5개 + merge 1회
        expect(requestChat).toHaveBeenCalledTimes(6)
    })
})
