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
