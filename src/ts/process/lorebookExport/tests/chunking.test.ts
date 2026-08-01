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
