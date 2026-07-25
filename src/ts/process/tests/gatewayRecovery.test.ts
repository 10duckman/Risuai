import { describe, expect, it, vi } from 'vitest'

import { pollGatewayRecovery } from '../gatewayRecovery'

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
