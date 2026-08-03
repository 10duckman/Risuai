import { describe, expect, it } from 'vitest'

import { syncMessageAtIndex } from '../gatewayRecovery'

describe('syncMessageAtIndex', () => {
    it('지정한 인덱스의 메시지를 서버 텍스트로 교체한다', () => {
        const messages = [
            { role: 'user' as const, data: 'hello' },
            { role: 'char' as const, data: 'partial', chatId: 'gen-1' },
        ]

        const outcome = syncMessageAtIndex({
            messages,
            index: 1,
            chatId: 'gen-1',
            responseText: 'partial response completed',
        })

        expect(outcome).toEqual({ action: 'replaced' })
        expect(messages[1].data).toBe('partial response completed')
        expect(messages).toHaveLength(2)
    })

    it('chatId가 다르면 거부한다 (인덱스가 흔들렸다)', () => {
        // 사용자가 버튼을 누른 뒤 메시지가 삭제/재배열됐을 수 있다.
        const messages = [
            { role: 'user' as const, data: 'hello' },
            { role: 'char' as const, data: 'other message', chatId: 'gen-2' },
        ]

        const outcome = syncMessageAtIndex({
            messages,
            index: 1,
            chatId: 'gen-1',
            responseText: 'recovered',
        })

        expect(outcome).toEqual({ action: 'refused', reason: 'chat-id-mismatch' })
        expect(messages[1].data).toBe('other message')
    })

    it('인덱스가 범위를 벗어나면 거부한다', () => {
        const messages = [{ role: 'user' as const, data: 'hello' }]

        const outcome = syncMessageAtIndex({
            messages,
            index: 5,
            chatId: 'gen-1',
            responseText: 'recovered',
        })

        expect(outcome).toEqual({ action: 'refused', reason: 'index-out-of-range' })
    })

    it('음수 인덱스를 거부한다', () => {
        const messages = [{ role: 'char' as const, data: 'x', chatId: 'gen-1' }]

        const outcome = syncMessageAtIndex({
            messages,
            index: -1,
            chatId: 'gen-1',
            responseText: 'recovered',
        })

        expect(outcome).toEqual({ action: 'refused', reason: 'index-out-of-range' })
    })

    it('user 메시지는 거부한다', () => {
        // 서버에는 AI 응답만 있다.
        const messages = [{ role: 'user' as const, data: 'my input', chatId: 'gen-1' }]

        const outcome = syncMessageAtIndex({
            messages,
            index: 0,
            chatId: 'gen-1',
            responseText: 'recovered',
        })

        expect(outcome).toEqual({ action: 'refused', reason: 'not-char-message' })
        expect(messages[0].data).toBe('my input')
    })

    it('기존 텍스트가 같거나 더 길면 거부한다', () => {
        const messages = [
            { role: 'char' as const, data: 'already longer text', chatId: 'gen-1' },
        ]

        const outcome = syncMessageAtIndex({
            messages,
            index: 0,
            chatId: 'gen-1',
            responseText: 'short',
        })

        expect(outcome).toEqual({ action: 'refused', reason: 'not-longer' })
        expect(messages[0].data).toBe('already longer text')
    })

    it('빈 메시지도 교체한다 (한 글자도 못 받은 경우)', () => {
        // 스트림이 0자로 끊겨도 서버에는 응답이 있다.
        const messages = [{ role: 'char' as const, data: '', chatId: 'gen-1' }]

        const outcome = syncMessageAtIndex({
            messages,
            index: 0,
            chatId: 'gen-1',
            responseText: 'full response',
        })

        expect(outcome).toEqual({ action: 'replaced' })
        expect(messages[0].data).toBe('full response')
    })

    it('chatId 없는 메시지는 거부한다 (옛 메시지)', () => {
        const messages = [{ role: 'char' as const, data: 'legacy' }]

        const outcome = syncMessageAtIndex({
            messages,
            index: 0,
            chatId: 'gen-1',
            responseText: 'recovered',
        })

        expect(outcome).toEqual({ action: 'refused', reason: 'chat-id-mismatch' })
    })

    it('다른 메시지를 건드리지 않는다', () => {
        const messages = [
            { role: 'user' as const, data: 'first' },
            { role: 'char' as const, data: 'partial', chatId: 'gen-1' },
            { role: 'user' as const, data: 'third' },
        ]

        syncMessageAtIndex({
            messages,
            index: 1,
            chatId: 'gen-1',
            responseText: 'partial completed',
        })

        expect(messages[0].data).toBe('first')
        expect(messages[2].data).toBe('third')
        expect(messages).toHaveLength(3)
    })
})
