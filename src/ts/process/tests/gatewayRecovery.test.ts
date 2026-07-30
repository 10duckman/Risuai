import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
    __resetPendingGenerations,
    applyRecoveredMessage,
    clearGenerationPending,
    markGenerationPending,
    pollGatewayRecovery,
    syncMessageAtIndex,
    takePendingGenerations,
} from '../gatewayRecovery'

/**
 * 가짜 시계. sleep 호출이 시간을 진행시키므로 실제로 기다리지 않는다.
 */
function fakeClock(){
    let current = 0
    return {
        now: () => current,
        sleep: async (ms: number) => { current += ms },
        advance: (ms: number) => { current += ms },
    }
}

describe('pollGatewayRecovery', () => {
    it('서버가 done을 주면 즉시 성공으로 끝낸다', async () => {
        const clock = fakeClock()
        const fetchRecover = vi.fn().mockResolvedValue({
            ok: true, status: 200, responseText: 'full response', done: true,
        })

        const result = await pollGatewayRecovery({
            chatId: 'chat-1',
            timeoutMs: 300000,
            fetchRecover,
            now: clock.now,
            sleep: clock.sleep,
        })

        expect(result.status).toBe('done')
        expect(result.responseText).toBe('full response')
        expect(result.attempts).toBe(1)
        expect(fetchRecover).toHaveBeenCalledTimes(1)
    })

    it('서버가 아직 생성 중이면 done이 될 때까지 계속 폴링한다', async () => {
        // 실측 시나리오: 30초 예산으로는 실패했던 케이스.
        // 167초 생성 → 1초 간격이면 약 167회 폴링 후 done.
        const clock = fakeClock()
        let calls = 0
        const fetchRecover = vi.fn().mockImplementation(async () => {
            calls++
            if(calls < 167){
                return { ok: true, status: 200, responseText: 'partial', done: false }
            }
            return { ok: true, status: 200, responseText: 'complete 9040 chars', done: true }
        })

        const result = await pollGatewayRecovery({
            chatId: 'chat-1',
            timeoutMs: 300000,
            fetchRecover,
            now: clock.now,
            sleep: clock.sleep,
        })

        expect(result.status).toBe('done')
        expect(result.responseText).toBe('complete 9040 chars')
        expect(result.attempts).toBe(167)
    })

    it('30초를 넘겨도 포기하지 않는다 (회귀 방지)', async () => {
        const clock = fakeClock()
        let calls = 0
        const fetchRecover = vi.fn().mockImplementation(async () => {
            calls++
            // 60초 지점에서 done — 옛 30초 상한이면 실패했을 케이스
            if(calls < 60){
                return { ok: true, status: 200, responseText: '', done: false }
            }
            return { ok: true, status: 200, responseText: 'late but complete', done: true }
        })

        const result = await pollGatewayRecovery({
            chatId: 'chat-1',
            timeoutMs: 300000,
            fetchRecover,
            now: clock.now,
            sleep: clock.sleep,
        })

        expect(result.status).toBe('done')
        expect(result.responseText).toBe('late but complete')
        expect(clock.now()).toBeGreaterThan(30000)
    })

    it('timeoutMs를 넘기면 timeout으로 끝낸다', async () => {
        const clock = fakeClock()
        const fetchRecover = vi.fn().mockResolvedValue({
            ok: true, status: 200, responseText: 'partial', done: false,
        })

        const result = await pollGatewayRecovery({
            chatId: 'chat-1',
            timeoutMs: 5000,
            fetchRecover,
            now: clock.now,
            sleep: clock.sleep,
        })

        expect(result.status).toBe('timeout')
        // 마지막으로 본 부분 텍스트는 보존한다
        expect(result.responseText).toBe('partial')
    })

    it('404가 허용 횟수를 넘으면 notfound로 끝낸다', async () => {
        const clock = fakeClock()
        const fetchRecover = vi.fn().mockResolvedValue({ ok: false, status: 404 })

        const result = await pollGatewayRecovery({
            chatId: 'chat-1',
            timeoutMs: 300000,
            fetchRecover,
            now: clock.now,
            sleep: clock.sleep,
            notFoundTolerance: 3,
        })

        expect(result.status).toBe('notfound')
        expect(result.attempts).toBe(4)
    })

    it('일시적 404 뒤에 성공하면 복구한다', async () => {
        const clock = fakeClock()
        let calls = 0
        const fetchRecover = vi.fn().mockImplementation(async () => {
            calls++
            if(calls <= 2){
                return { ok: false, status: 404 }
            }
            return { ok: true, status: 200, responseText: 'recovered', done: true }
        })

        const result = await pollGatewayRecovery({
            chatId: 'chat-1',
            timeoutMs: 300000,
            fetchRecover,
            now: clock.now,
            sleep: clock.sleep,
            notFoundTolerance: 3,
        })

        expect(result.status).toBe('done')
        expect(result.responseText).toBe('recovered')
    })

    it('부분 텍스트가 길어질 때마다 onProgress로 알린다', async () => {
        const clock = fakeClock()
        let calls = 0
        const fetchRecover = vi.fn().mockImplementation(async () => {
            calls++
            if(calls === 1) return { ok: true, status: 200, responseText: 'abc', done: false }
            if(calls === 2) return { ok: true, status: 200, responseText: 'abc', done: false }
            if(calls === 3) return { ok: true, status: 200, responseText: 'abcdef', done: false }
            return { ok: true, status: 200, responseText: 'abcdefghi', done: true }
        })
        const onProgress = vi.fn()

        await pollGatewayRecovery({
            chatId: 'chat-1',
            timeoutMs: 300000,
            fetchRecover,
            now: clock.now,
            sleep: clock.sleep,
            onProgress,
        })

        // 같은 길이(2회차)는 알리지 않는다
        expect(onProgress.mock.calls.map(c => c[0])).toEqual(['abc', 'abcdef', 'abcdefghi'])
    })

    it('fetch가 던지면 error로 끝내고 마지막 텍스트를 보존한다', async () => {
        const clock = fakeClock()
        let calls = 0
        const fetchRecover = vi.fn().mockImplementation(async () => {
            calls++
            if(calls === 1){
                return { ok: true, status: 200, responseText: 'partial before crash', done: false }
            }
            throw new Error('network down')
        })

        const result = await pollGatewayRecovery({
            chatId: 'chat-1',
            timeoutMs: 300000,
            fetchRecover,
            now: clock.now,
            sleep: clock.sleep,
        })

        expect(result.status).toBe('error')
        expect(result.responseText).toBe('partial before crash')
    })
})

describe('applyRecoveredMessage', () => {
    const buildMessage = (responseText: string) => ({
        role: 'char' as const,
        data: responseText,
        chatId: 'gen-1',
        saying: 'cha-1',
    })

    it('같은 chatId의 부분 메시지를 완전한 텍스트로 교체한다', () => {
        const messages = [
            { role: 'user' as const, data: 'hello' },
            { role: 'char' as const, data: 'partial resp', chatId: 'gen-1' },
        ]

        const outcome = applyRecoveredMessage({
            messages,
            chatId: 'gen-1',
            responseText: 'partial response completed',
            buildMessage,
        })

        expect(outcome).toEqual({ action: 'patched', index: 1 })
        expect(messages).toHaveLength(2)
        expect(messages[1].data).toBe('partial response completed')
    })

    it('메시지가 삭제된 상태면 새로 추가한다', () => {
        // 인라인 복구가 포기하면서 splice로 지운 상태
        const messages = [
            { role: 'user' as const, data: 'hello' },
        ]

        const outcome = applyRecoveredMessage({
            messages,
            chatId: 'gen-1',
            responseText: 'recovered response',
            buildMessage,
        })

        expect(outcome).toEqual({ action: 'appended', index: 1 })
        expect(messages).toHaveLength(2)
        expect(messages[1]).toMatchObject({
            role: 'char',
            data: 'recovered response',
            chatId: 'gen-1',
        })
    })

    it('이미 같은 텍스트면 아무것도 하지 않는다', () => {
        const messages = [
            { role: 'user' as const, data: 'hello' },
            { role: 'char' as const, data: 'recovered response', chatId: 'gen-1' },
        ]

        const outcome = applyRecoveredMessage({
            messages,
            chatId: 'gen-1',
            responseText: 'recovered response',
            buildMessage,
        })

        expect(outcome).toEqual({ action: 'skipped', reason: 'already-complete' })
        expect(messages).toHaveLength(2)
    })

    it('DB 텍스트가 더 길면 덮어쓰지 않는다', () => {
        // 후처리 스크립트가 텍스트를 늘렸을 수 있다 — 회귀시키지 않는다
        const messages = [
            { role: 'user' as const, data: 'hello' },
            { role: 'char' as const, data: 'recovered response plus post-processing', chatId: 'gen-1' },
        ]

        const outcome = applyRecoveredMessage({
            messages,
            chatId: 'gen-1',
            responseText: 'recovered response',
            buildMessage,
        })

        expect(outcome).toEqual({ action: 'skipped', reason: 'already-complete' })
        expect(messages[1].data).toBe('recovered response plus post-processing')
    })

    it('마지막이 char 메시지면(다른 턴 진행됨) 추가하지 않는다', () => {
        // 유저가 이미 다음 턴을 받았다 — 뒤늦게 끼워넣으면 대화가 깨진다
        const messages = [
            { role: 'user' as const, data: 'hello' },
            { role: 'char' as const, data: 'some other response', chatId: 'gen-2' },
        ]

        const outcome = applyRecoveredMessage({
            messages,
            chatId: 'gen-1',
            responseText: 'recovered response',
            buildMessage,
        })

        expect(outcome).toEqual({ action: 'skipped', reason: 'user-turn-missing' })
        expect(messages).toHaveLength(2)
    })

    it('빈 텍스트는 적용하지 않는다', () => {
        const messages = [{ role: 'user' as const, data: 'hello' }]

        const outcome = applyRecoveredMessage({
            messages,
            chatId: 'gen-1',
            responseText: '',
            buildMessage,
        })

        expect(outcome).toEqual({ action: 'skipped', reason: 'empty' })
        expect(messages).toHaveLength(1)
    })

    it('빈 메시지 배열에는 추가하지 않는다', () => {
        const messages: { role: 'user' | 'char'; data: string; chatId?: string }[] = []

        const outcome = applyRecoveredMessage({
            messages,
            chatId: 'gen-1',
            responseText: 'recovered response',
            buildMessage,
        })

        expect(outcome).toEqual({ action: 'skipped', reason: 'user-turn-missing' })
        expect(messages).toHaveLength(0)
    })
})

describe('pending generation registry', () => {
    beforeEach(() => {
        __resetPendingGenerations()
    })

    it('등록한 generation을 돌려준다', () => {
        markGenerationPending({ chatId: 'gen-1', charIndex: 0, chatIndex: 2, chaId: 'char-a', chatSessionId: 'session-x' })

        expect(takePendingGenerations()).toEqual([
            { chatId: 'gen-1', charIndex: 0, chatIndex: 2, chaId: 'char-a', chatSessionId: 'session-x' },
        ])
    })

    it('take는 목록을 비운다 (중복 복구 방지)', () => {
        markGenerationPending({ chatId: 'gen-1', charIndex: 0, chatIndex: 2, chaId: 'char-a', chatSessionId: 'session-x' })

        expect(takePendingGenerations()).toHaveLength(1)
        expect(takePendingGenerations()).toHaveLength(0)
    })

    it('clear한 generation은 돌려주지 않는다', () => {
        markGenerationPending({ chatId: 'gen-1', charIndex: 0, chatIndex: 2, chaId: 'char-a', chatSessionId: 'session-x' })
        markGenerationPending({ chatId: 'gen-2', charIndex: 1, chatIndex: 0, chaId: 'char-b', chatSessionId: 'session-y' })
        clearGenerationPending('gen-1')

        expect(takePendingGenerations()).toEqual([
            { chatId: 'gen-2', charIndex: 1, chatIndex: 0, chaId: 'char-b', chatSessionId: 'session-y' },
        ])
    })

    it('같은 chatId를 두 번 등록해도 하나만 남는다', () => {
        markGenerationPending({ chatId: 'gen-1', charIndex: 0, chatIndex: 2, chaId: 'char-a', chatSessionId: 'session-x' })
        markGenerationPending({ chatId: 'gen-1', charIndex: 0, chatIndex: 2, chaId: 'char-a', chatSessionId: 'session-x' })

        expect(takePendingGenerations()).toHaveLength(1)
    })

    it('없는 chatId를 clear해도 던지지 않는다', () => {
        expect(() => clearGenerationPending('nope')).not.toThrow()
    })

    it('stable identity 필드를 보존한다', () => {
        markGenerationPending({
            chatId: 'gen-1',
            charIndex: 0,
            chatIndex: 2,
            chaId: 'char-stable-id',
            chatSessionId: 'session-stable-id',
        })

        const entries = takePendingGenerations()
        expect(entries).toHaveLength(1)
        expect(entries[0].chaId).toBe('char-stable-id')
        expect(entries[0].chatSessionId).toBe('session-stable-id')
    })

    it('chatSessionId가 undefined일 수 있다 (older chats)', () => {
        markGenerationPending({
            chatId: 'gen-old',
            charIndex: 0,
            chatIndex: 1,
            chaId: 'char-x',
        })

        const entries = takePendingGenerations()
        expect(entries).toHaveLength(1)
        expect(entries[0].chaId).toBe('char-x')
        expect(entries[0].chatSessionId).toBeUndefined()
    })
})

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
