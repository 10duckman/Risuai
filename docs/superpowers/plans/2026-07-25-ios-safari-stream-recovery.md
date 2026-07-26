# iOS Safari 스트림 복구 신뢰성 개선 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** iOS Safari에서 탭이 백그라운드로 가며 SSE 스트림이 반복 끊길 때, Bedrock 응답이 서버에 온전히 존재하는데도 클라이언트가 포기하고 메시지를 삭제하는 문제를 없앤다.

**Architecture:** 복구 폴링을 순수 로직 모듈(`gatewayRecovery.ts`)로 분리해 주입 가능한 형태로 만든다. 폴링 종료 조건을 "경과 시간 30초"에서 "서버가 `done:true`를 줄 때까지(상한 5분)"로 바꾼다. 스트리밍 중인 generation을 메모리 레지스트리에 등록하고, `visibilitychange`로 탭이 다시 보일 때 미완료 generation을 새 예산으로 재확인하는 세이프티넷을 얹는다. SSE 재연결 상한(`MAX_RESUME_ATTEMPTS`)도 3 → 12로 올린다.

**Tech Stack:** TypeScript, Svelte 5 (runes, `DBState`), Vitest (happy-dom), 기존 `/gateway/recover` 엔드포인트 (`server/node/server.cjs`)

## 배경: 실측된 실패 시나리오

2026-07-24 RPi 로그에서 확인된 실제 사례 (`chatId=689d214b-43f8-442d-b04b-710a8fa7d42f`):

| 시각 (UTC) | 사건 |
|---|---|
| 15:57:43 | Bedrock 요청 시작 (Opus 4.8, 155 messages) |
| 15:58:52 | 1번째 끊김 → `Resume attach resumeFromSeq=896` |
| 15:59:13 | 2번째 끊김 → `Resume attach resumeFromSeq=1298` |
| 15:59:44 | 3번째 끊김 → `Resume attach resumeFromSeq=1655` (`MAX_RESUME_ATTEMPTS=3` 소진) |
| 16:00:30 | 서버에서 Bedrock 응답 **완료** (9040자, output=9177 tokens, gateway-logs에 저장됨) |

4번째 끊김 시점에 클라이언트는 재연결 예산이 없어 스트리밍 루프를 종료하고 복구 폴링에 진입했다. 그런데 그 시점(≈15:59:50)에 서버는 아직 생성 중(`done:false`)이었고, 폴링 예산 30초는 16:00:20에 만료 — 서버 완료(16:00:30)보다 **10초 먼저** 포기했다. 결과: `recovered=false` → 새 메시지 `splice` 삭제 → `Stream connection lost` 에러. 응답은 서버에 온전히 남아있었고 나중에 수동 복구했다.

핵심 결론 두 가지:
1. 재연결 3회는 iOS 화면 꺼짐/켜짐 반복에 너무 적다.
2. 복구 폴링의 30초 상한이 **서버 생성 시간(167초)보다 짧다** — 이게 지배적 원인이다. `/gateway/recover`는 생성 중에 `done:false`를 계속 반환하므로, 종료 조건은 경과 시간이 아니라 서버 상태여야 한다.

## Global Constraints

- **localStorage 영속화는 이번 범위에서 제외.** pending generation 레지스트리는 메모리(모듈 스코프)만 사용한다. iOS가 탭을 evict하면 복구되지 않는 것을 알려진 한계로 수용한다.
- **인라인 폴링 상한: 5분** (`INLINE_RECOVERY_TIMEOUT_MS = 5 * 60 * 1000`). 이 시간 동안 `doingChat`이 유지돼 새 메시지 전송이 막히는 것을 수용한다.
- **`MAX_RESUME_ATTEMPTS = 12`** (기존 3). 진행 시 카운터 리셋 로직은 넣지 않는다 — 무한 루프 위험과 이중 카운터 복잡도만 늘고, 12회면 관측된 케이스에 충분하다. 서버 버퍼 TTL 30분(`STREAM_TTL`)이 상한 여유를 준다.
- **기존 동작 보존:** 데스크톱/웹 빌드(`isNodeServer === false`)는 `/gateway/recover` 엔드포인트가 없으므로 복구 경로에 진입하지 않아야 한다.
- **서버 코드(`server/node/server.cjs`)는 수정하지 않는다.** 이번 변경은 전부 클라이언트 측이다.
- 새 파일은 프로젝트 관례를 따른다: 탭 4칸 들여쓰기, 세미콜론 없음, `import type` 사용.
- 테스트는 `src/ts/process/tests/` 아래 `*.test.ts`로 두고 `vi.mock`으로 의존성을 끊는다 (`src/ts/process/request/openAI/requests.responses.test.ts` 패턴 참고).

## File Structure

**신규:**
- `src/ts/process/gatewayRecovery.ts` — 복구 폴링 + 메시지 적용 + pending 레지스트리. 순수 로직만 담고, `fetch`/`now`/`sleep`/DB 접근을 인자로 주입받아 테스트 가능하게 한다. DOM·`DBState`를 직접 import 하지 않는다.
- `src/ts/process/tests/gatewayRecovery.test.ts` — 위 모듈의 유닛 테스트.

**수정:**
- `src/ts/process/request/anthropic.ts:490` — `MAX_RESUME_ATTEMPTS` 3 → 12.
- `src/ts/process/index.svelte.ts` — 인라인 30초 폴링(1686-1739행)을 `pollGatewayRecovery` 호출로 교체, streaming 경로에 pending 등록/해제 추가, 모듈 스코프에 `visibilitychange` 리스너 추가.

`gatewayRecovery.ts`가 DOM과 `DBState`를 모르게 유지하는 것이 핵심이다. 이래야 happy-dom 없이도 로직을 테스트할 수 있고, `index.svelte.ts`가 얇은 어댑터로 남는다.

---

### Task 1: `gatewayRecovery.ts` — 폴링 루프

**Files:**
- Create: `src/ts/process/gatewayRecovery.ts`
- Test: `src/ts/process/tests/gatewayRecovery.test.ts`

**Interfaces:**
- Consumes: 없음 (첫 태스크)
- Produces:
  - `export interface GatewayRecoveryResult { status: 'done' | 'timeout' | 'notfound' | 'error'; responseText: string; attempts: number }`
  - `export interface PollGatewayRecoveryOptions { chatId: string; timeoutMs: number; fetchRecover: (chatId: string) => Promise<{ ok: boolean; status: number; responseText?: string; done?: boolean }>; now: () => number; sleep: (ms: number) => Promise<void>; onProgress?: (responseText: string) => void; intervalMs?: number; notFoundTolerance?: number }`
  - `export async function pollGatewayRecovery(opts: PollGatewayRecoveryOptions): Promise<GatewayRecoveryResult>`
  - `export const INLINE_RECOVERY_TIMEOUT_MS: number` (= 300000)
  - `export const VISIBILITY_RECOVERY_TIMEOUT_MS: number` (= 60000)

- [ ] **Step 1: 실패하는 테스트를 작성한다**

`src/ts/process/tests/gatewayRecovery.test.ts` 를 새로 만든다:

```typescript
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
```

- [ ] **Step 2: 테스트가 실패하는 것을 확인한다**

Run: `pnpm vitest run src/ts/process/tests/gatewayRecovery.test.ts`
Expected: FAIL — `Failed to resolve import "../gatewayRecovery"` (파일이 아직 없음)

- [ ] **Step 3: 최소 구현을 작성한다**

`src/ts/process/gatewayRecovery.ts` 를 새로 만든다:

```typescript
/**
 * Gateway 스트림 복구 로직.
 *
 * iOS Safari는 탭이 백그라운드로 가면 JS 실행을 정지시키므로 SSE 연결이
 * 반복적으로 끊긴다. 서버(`/gateway/bedrock-stream`)는 클라이언트가 붙어
 * 있는지와 무관하게 Bedrock 스트림을 끝까지 받아 버퍼에 쌓아두고,
 * `/gateway/recover`로 조회할 수 있게 해준다 (버퍼 TTL 30분).
 *
 * 이 모듈은 그 조회를 폴링하는 순수 로직만 담는다. fetch/시계/sleep을 전부
 * 주입받아 DOM과 DBState를 모르게 유지한다 — 그래서 유닛 테스트가 가능하다.
 */

/** 인라인(스트리밍 직후) 복구가 서버 완료를 기다리는 상한. */
export const INLINE_RECOVERY_TIMEOUT_MS = 5 * 60 * 1000

/** 탭이 다시 보일 때 도는 세이프티넷 복구의 상한. */
export const VISIBILITY_RECOVERY_TIMEOUT_MS = 60 * 1000

const DEFAULT_INTERVAL_MS = 1000
const DEFAULT_NOTFOUND_TOLERANCE = 3

export interface GatewayRecoverResponse{
    ok: boolean
    status: number
    responseText?: string
    done?: boolean
}

export interface GatewayRecoveryResult{
    status: 'done' | 'timeout' | 'notfound' | 'error'
    responseText: string
    attempts: number
}

export interface PollGatewayRecoveryOptions{
    chatId: string
    /** 서버가 done을 줄 때까지 기다리는 상한. */
    timeoutMs: number
    fetchRecover: (chatId: string) => Promise<GatewayRecoverResponse>
    now: () => number
    sleep: (ms: number) => Promise<void>
    /** 부분 텍스트가 길어질 때마다 호출된다 (스트리밍처럼 보이게 하는 용도). */
    onProgress?: (responseText: string) => void
    intervalMs?: number
    /** 이 횟수를 넘게 연속 404면 포기한다. */
    notFoundTolerance?: number
}

/**
 * 서버가 `done:true`를 줄 때까지 `/gateway/recover`를 폴링한다.
 *
 * 중요: 종료 조건은 **서버 상태**다. 예전 구현은 30초 경과로 포기했는데,
 * Bedrock 생성이 그보다 오래 걸리면(실측 167초) 응답이 서버에 온전히
 * 있는데도 실패로 처리돼 메시지가 삭제됐다. timeoutMs는 서버가 정말
 * 멈춘 경우를 위한 안전장치일 뿐이고, 정상 경로에서는 done으로 끝난다.
 */
export async function pollGatewayRecovery(opts: PollGatewayRecoveryOptions): Promise<GatewayRecoveryResult>{
    const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS
    const notFoundTolerance = opts.notFoundTolerance ?? DEFAULT_NOTFOUND_TOLERANCE
    const deadline = opts.now() + opts.timeoutMs

    let attempts = 0
    let notFoundCount = 0
    let lastText = ''

    while(opts.now() < deadline){
        attempts++
        let res: GatewayRecoverResponse
        try{
            res = await opts.fetchRecover(opts.chatId)
        }
        catch(e){
            console.error('[GatewayRecovery] fetch threw:', e)
            return { status: 'error', responseText: lastText, attempts }
        }

        if(res.ok){
            notFoundCount = 0
            const text = res.responseText ?? ''
            if(text.length > lastText.length){
                lastText = text
                opts.onProgress?.(text)
            }
            if(res.done){
                return { status: 'done', responseText: lastText, attempts }
            }
        }
        else if(res.status === 404){
            notFoundCount++
            if(notFoundCount > notFoundTolerance){
                return { status: 'notfound', responseText: lastText, attempts }
            }
        }

        await opts.sleep(intervalMs)
    }

    return { status: 'timeout', responseText: lastText, attempts }
}
```

- [ ] **Step 4: 테스트가 통과하는 것을 확인한다**

Run: `pnpm vitest run src/ts/process/tests/gatewayRecovery.test.ts`
Expected: PASS — 8 tests passed

- [ ] **Step 5: 커밋한다**

```bash
git add src/ts/process/gatewayRecovery.ts src/ts/process/tests/gatewayRecovery.test.ts
git commit -m "feat: add gateway recovery polling that waits for server completion

Poll /gateway/recover until the server reports done instead of giving up
after a fixed 30s. Observed failure: Bedrock took 167s to finish while the
client abandoned recovery at 30s and deleted the message, even though the
full 9040-char response was already buffered server-side."
```

---

### Task 2: `applyRecoveredMessage` — 복구된 텍스트를 메시지 배열에 반영

**Files:**
- Modify: `src/ts/process/gatewayRecovery.ts`
- Test: `src/ts/process/tests/gatewayRecovery.test.ts`

**Interfaces:**
- Consumes: Task 1의 `GatewayRecoveryResult`
- Produces:
  - `export interface RecoverableMessage { role: 'user' | 'char'; data: string; chatId?: string; [key: string]: unknown }`
  - `export interface ApplyRecoveredMessageOptions { messages: RecoverableMessage[]; chatId: string; responseText: string; buildMessage: (responseText: string) => RecoverableMessage }`
  - `export type ApplyRecoveredMessageOutcome = { action: 'patched'; index: number } | { action: 'appended'; index: number } | { action: 'skipped'; reason: 'empty' | 'already-complete' | 'user-turn-missing' }`
  - `export function applyRecoveredMessage(opts: ApplyRecoveredMessageOptions): ApplyRecoveredMessageOutcome`

세이프티넷은 인라인 복구가 이미 메시지를 삭제한 뒤에 돌 수도 있고, 메시지가 부분 텍스트로 남아있는 상태에서 돌 수도 있다. 두 경우를 모두 안전하게 처리해야 하고, **대화가 이미 다음 턴으로 진행됐으면 끼워넣지 않아야** 한다.

- [ ] **Step 1: 실패하는 테스트를 작성한다**

`src/ts/process/tests/gatewayRecovery.test.ts` 파일 끝에 다음을 추가한다. 파일 맨 위 import 문도 함께 고친다:

```typescript
import { applyRecoveredMessage, pollGatewayRecovery } from '../gatewayRecovery'
```

추가할 describe 블록:

```typescript
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
```

- [ ] **Step 2: 테스트가 실패하는 것을 확인한다**

Run: `pnpm vitest run src/ts/process/tests/gatewayRecovery.test.ts`
Expected: FAIL — `applyRecoveredMessage is not a function` (또는 import 해결 실패)

- [ ] **Step 3: 최소 구현을 작성한다**

`src/ts/process/gatewayRecovery.ts` 끝에 추가한다:

```typescript
export interface RecoverableMessage{
    role: 'user' | 'char'
    data: string
    chatId?: string
    [key: string]: unknown
}

export interface ApplyRecoveredMessageOptions{
    messages: RecoverableMessage[]
    chatId: string
    responseText: string
    /** 새로 추가해야 할 때 쓰는 메시지 팩토리 (saying/generationInfo 등을 채운다). */
    buildMessage: (responseText: string) => RecoverableMessage
}

export type ApplyRecoveredMessageOutcome =
    | { action: 'patched', index: number }
    | { action: 'appended', index: number }
    | { action: 'skipped', reason: 'empty' | 'already-complete' | 'user-turn-missing' }

/**
 * 복구된 텍스트를 메시지 배열에 반영한다.
 *
 * 세이프티넷은 두 가지 상태에서 호출될 수 있다:
 *   1. 부분 텍스트를 담은 char 메시지가 남아있다 → 교체(patch)
 *   2. 인라인 복구가 포기하면서 메시지를 지웠다 → 추가(append)
 *
 * 어느 쪽이든 대화가 이미 다음 턴으로 넘어갔으면 건드리지 않는다.
 */
export function applyRecoveredMessage(opts: ApplyRecoveredMessageOptions): ApplyRecoveredMessageOutcome{
    const { messages, chatId, responseText } = opts

    if(!responseText){
        return { action: 'skipped', reason: 'empty' }
    }

    const existingIndex = messages.findIndex((m) => m.role === 'char' && m.chatId === chatId)
    if(existingIndex !== -1){
        // 이미 같거나 더 긴 텍스트가 있으면 회귀시키지 않는다. 후처리
        // 스크립트가 텍스트를 늘렸을 수 있다.
        if(messages[existingIndex].data.length >= responseText.length){
            return { action: 'skipped', reason: 'already-complete' }
        }
        messages[existingIndex].data = responseText
        return { action: 'patched', index: existingIndex }
    }

    // 메시지가 없다 — 마지막 턴이 user일 때만 추가한다. 마지막이 char면
    // 다른 generation이 이미 응답했다는 뜻이라, 뒤늦게 끼워넣으면 대화가 깨진다.
    const last = messages[messages.length - 1]
    if(!last || last.role !== 'user'){
        return { action: 'skipped', reason: 'user-turn-missing' }
    }

    messages.push(opts.buildMessage(responseText))
    return { action: 'appended', index: messages.length - 1 }
}
```

- [ ] **Step 4: 테스트가 통과하는 것을 확인한다**

Run: `pnpm vitest run src/ts/process/tests/gatewayRecovery.test.ts`
Expected: PASS — 15 tests passed

- [ ] **Step 5: 커밋한다**

```bash
git add src/ts/process/gatewayRecovery.ts src/ts/process/tests/gatewayRecovery.test.ts
git commit -m "feat: add applyRecoveredMessage for patch-or-append recovery

The visibility safety net can run after the inline path already deleted the
message, or while a partial one is still present. Handle both, and refuse to
insert when the conversation already moved on to another turn."
```

---

### Task 3: pending generation 레지스트리

**Files:**
- Modify: `src/ts/process/gatewayRecovery.ts`
- Test: `src/ts/process/tests/gatewayRecovery.test.ts`

**Interfaces:**
- Consumes: 없음
- Produces:
  - `export interface PendingGeneration { chatId: string; charIndex: number; chatIndex: number }`
  - `export function markGenerationPending(entry: PendingGeneration): void`
  - `export function clearGenerationPending(chatId: string): void`
  - `export function takePendingGenerations(): PendingGeneration[]`
  - `export function __resetPendingGenerations(): void` (테스트 전용)

`takePendingGenerations`는 목록을 반환하면서 동시에 비운다 — 세이프티넷이 같은 generation을 두 번 처리하지 않게 하고, `visibilitychange`가 연달아 두 번 발생해도 중복 복구가 안 돌게 한다.

- [ ] **Step 1: 실패하는 테스트를 작성한다**

`src/ts/process/tests/gatewayRecovery.test.ts` 의 import를 고친다:

```typescript
import {
    __resetPendingGenerations,
    applyRecoveredMessage,
    clearGenerationPending,
    markGenerationPending,
    pollGatewayRecovery,
    takePendingGenerations,
} from '../gatewayRecovery'
```

파일 끝에 추가한다:

```typescript
describe('pending generation registry', () => {
    beforeEach(() => {
        __resetPendingGenerations()
    })

    it('등록한 generation을 돌려준다', () => {
        markGenerationPending({ chatId: 'gen-1', charIndex: 0, chatIndex: 2 })

        expect(takePendingGenerations()).toEqual([
            { chatId: 'gen-1', charIndex: 0, chatIndex: 2 },
        ])
    })

    it('take는 목록을 비운다 (중복 복구 방지)', () => {
        markGenerationPending({ chatId: 'gen-1', charIndex: 0, chatIndex: 2 })

        expect(takePendingGenerations()).toHaveLength(1)
        expect(takePendingGenerations()).toHaveLength(0)
    })

    it('clear한 generation은 돌려주지 않는다', () => {
        markGenerationPending({ chatId: 'gen-1', charIndex: 0, chatIndex: 2 })
        markGenerationPending({ chatId: 'gen-2', charIndex: 1, chatIndex: 0 })
        clearGenerationPending('gen-1')

        expect(takePendingGenerations()).toEqual([
            { chatId: 'gen-2', charIndex: 1, chatIndex: 0 },
        ])
    })

    it('같은 chatId를 두 번 등록해도 하나만 남는다', () => {
        markGenerationPending({ chatId: 'gen-1', charIndex: 0, chatIndex: 2 })
        markGenerationPending({ chatId: 'gen-1', charIndex: 0, chatIndex: 2 })

        expect(takePendingGenerations()).toHaveLength(1)
    })

    it('없는 chatId를 clear해도 던지지 않는다', () => {
        expect(() => clearGenerationPending('nope')).not.toThrow()
    })
})
```

파일 맨 위 vitest import에 `beforeEach`를 추가한다:

```typescript
import { beforeEach, describe, expect, it, vi } from 'vitest'
```

- [ ] **Step 2: 테스트가 실패하는 것을 확인한다**

Run: `pnpm vitest run src/ts/process/tests/gatewayRecovery.test.ts`
Expected: FAIL — `markGenerationPending is not a function`

- [ ] **Step 3: 최소 구현을 작성한다**

`src/ts/process/gatewayRecovery.ts` 끝에 추가한다:

```typescript
export interface PendingGeneration{
    chatId: string
    charIndex: number
    chatIndex: number
}

/**
 * 아직 완료 처리되지 않은 generation들. 메모리에만 둔다 — iOS가 탭을
 * evict하면 같이 날아가고, 그 경우는 복구되지 않는 알려진 한계다.
 */
const pendingGenerations = new Map<string, PendingGeneration>()

export function markGenerationPending(entry: PendingGeneration): void{
    pendingGenerations.set(entry.chatId, entry)
}

export function clearGenerationPending(chatId: string): void{
    pendingGenerations.delete(chatId)
}

/** 목록을 반환하면서 비운다 — 세이프티넷이 같은 건을 두 번 잡지 않게. */
export function takePendingGenerations(): PendingGeneration[]{
    const entries = Array.from(pendingGenerations.values())
    pendingGenerations.clear()
    return entries
}

/** 테스트 전용. */
export function __resetPendingGenerations(): void{
    pendingGenerations.clear()
}
```

- [ ] **Step 4: 테스트가 통과하는 것을 확인한다**

Run: `pnpm vitest run src/ts/process/tests/gatewayRecovery.test.ts`
Expected: PASS — 20 tests passed

- [ ] **Step 5: 커밋한다**

```bash
git add src/ts/process/gatewayRecovery.ts src/ts/process/tests/gatewayRecovery.test.ts
git commit -m "feat: track pending generations for the visibility safety net

In-memory only; a tab evicted by iOS loses this and cannot be recovered."
```

---

### Task 4: `MAX_RESUME_ATTEMPTS` 상향

**Files:**
- Modify: `src/ts/process/request/anthropic.ts:490`

**Interfaces:**
- Consumes: 없음
- Produces: 없음 (지역 상수)

- [ ] **Step 1: 상수를 바꾼다**

`src/ts/process/request/anthropic.ts` 490행 부근을 찾는다:

```typescript
            // SSE parser — supports Last-Event-ID resume across connection drops.
            const MAX_RESUME_ATTEMPTS = 3
```

다음으로 바꾼다:

```typescript
            // SSE parser — supports Last-Event-ID resume across connection drops.
            // iOS Safari freezes tab JS whenever the screen locks or the tab goes
            // to the background, so a single long generation can drop many times
            // (observed: 3 drops in 2 minutes, which exhausted the old limit of 3
            // while the server still had 40s of generation left). The server keeps
            // its resume buffer for 30 minutes (STREAM_TTL), so a higher ceiling
            // costs nothing when the stream is genuinely alive.
            const MAX_RESUME_ATTEMPTS = 12
```

- [ ] **Step 2: 타입 체크가 통과하는 것을 확인한다**

Run: `pnpm vitest run src/ts/process/request/`
Expected: PASS — 기존 request 테스트가 모두 통과 (회귀 없음)

- [ ] **Step 3: 커밋한다**

```bash
git add src/ts/process/request/anthropic.ts
git commit -m "fix: raise SSE resume attempts from 3 to 12 for iOS Safari

Observed 3 drops within 2 minutes on a single generation, exhausting the
budget 40s before the server finished. The server's resume buffer lives for
30 minutes, so a higher ceiling is safe."
```

---

### Task 5: `index.svelte.ts` 인라인 폴링을 공유 모듈로 교체

**Files:**
- Modify: `src/ts/process/index.svelte.ts` (1686-1739행의 인라인 복구 블록, 그리고 import 구문)

**Interfaces:**
- Consumes: Task 1의 `pollGatewayRecovery`, `INLINE_RECOVERY_TIMEOUT_MS`
- Produces: 없음

이 태스크는 동작 변경(30초 → 5분, 서버 상태 기반 종료)을 담고, 다음 태스크가 얹을 pending 등록의 자리를 마련한다.

- [ ] **Step 1: import를 추가한다**

`src/ts/process/index.svelte.ts` 35행 `import { isNodeServer } from "../platform";` 아래에 추가한다:

```typescript
import { INLINE_RECOVERY_TIMEOUT_MS, pollGatewayRecovery } from "./gatewayRecovery";
```

- [ ] **Step 2: `fetchRecover` 어댑터를 `sendChat` 안에 추가한다**

`src/ts/process/index.svelte.ts` 에서 `function throwError(error:string){` (128행) 바로 위에 다음 헬퍼를 추가한다:

```typescript
    /**
     * `/gateway/recover` 호출 어댑터. pollGatewayRecovery가 fetch를 모르게
     * 유지하기 위해 여기서 감싼다.
     */
    async function fetchGatewayRecover(chatId:string){
        const { NodeStorage } = await import('../storage/nodeStorage')
        const nodeStorage = new NodeStorage()
        const auth = await nodeStorage.createAuth()
        const res = await fetch(`/gateway/recover?chatId=${encodeURIComponent(chatId)}`, {
            headers: { 'risu-auth': auth }
        })
        if(!res.ok){
            return { ok: false, status: res.status }
        }
        const data = await res.json()
        return {
            ok: true,
            status: res.status,
            responseText: data.responseText || '',
            done: !!data.done,
        }
    }
```

- [ ] **Step 3: 인라인 폴링 블록을 교체한다**

`src/ts/process/index.svelte.ts` 의 `if(needsRecovery){` 블록 전체 (1686행부터 `}` 까지, 기존 30초 루프)를 다음으로 바꾼다:

```typescript
        if(needsRecovery){
            let recovered = false
            try{
                // 서버가 done을 줄 때까지 기다린다. 예전에는 30초로 끊었는데,
                // Bedrock 생성이 그보다 오래 걸리면(실측 167초) 응답이 서버에
                // 온전히 있는데도 실패로 처리돼 메시지가 삭제됐다.
                const applyPartial = async (text:string) => {
                    const partial = await processScriptFull(nowChatroom, reformatContent(prefix + text), 'editoutput', msgIndex)
                    DBState.db.characters[selectedChar].chats[selectedChat].message[msgIndex].data = partial.data
                    emoChanged = partial.emoChanged
                    DBState.db.characters[selectedChar].reloadKeys += 1
                }

                const pending:Promise<void>[] = []
                const recovery = await pollGatewayRecovery({
                    chatId: generationId,
                    timeoutMs: INLINE_RECOVERY_TIMEOUT_MS,
                    fetchRecover: fetchGatewayRecover,
                    now: () => Date.now(),
                    sleep: (ms:number) => new Promise(r => setTimeout(r, ms)),
                    onProgress: (text:string) => {
                        // 도착하는 부분 텍스트를 화면에 반영해 스트리밍처럼 보이게 한다.
                        pending.push(applyPartial(text))
                    },
                })
                await Promise.all(pending)

                if(recovery.status === 'done' && recovery.responseText){
                    result = recovery.responseText
                    await applyPartial(result)
                    recovered = true
                    console.log(`[Streaming] Recovered response from gateway (attempts=${recovery.attempts}, length=${result.length}, expected=${expectedLength})`)
                }
                else{
                    console.warn(`[Streaming] Recovery gave up: status=${recovery.status} attempts=${recovery.attempts} length=${recovery.responseText.length}`)
                }
            }
            catch(recoveryErr){
                console.error('[Streaming] Recovery failed:', recoveryErr)
            }

            if(!recovered){
                if(isNewMessage){
                    DBState.db.characters[selectedChar].chats[selectedChat].message.splice(msgIndex, 1)
                }
                throwError('Stream connection lost. Please try again.')
                return false
            }
        }
```

- [ ] **Step 4: 타입 체크와 기존 테스트를 돌린다**

Run: `pnpm vitest run src/ts/process/`
Expected: PASS — 기존 process 테스트가 모두 통과

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "gatewayRecovery|index\.svelte\.ts" || echo "no new type errors in changed files"`
Expected: `no new type errors in changed files` (이 저장소는 기존 타입 에러가 있으므로 변경한 파일만 확인한다)

- [ ] **Step 5: 커밋한다**

```bash
git add src/ts/process/index.svelte.ts
git commit -m "fix: wait for server completion in inline stream recovery

Replace the inline 30s poll with pollGatewayRecovery (5 minute ceiling,
terminates on server done). The old budget expired 10s before Bedrock
finished in the observed failure, deleting a complete 9040-char response."
```

---

### Task 6: pending 등록 + `visibilitychange` 세이프티넷

**Files:**
- Modify: `src/ts/process/index.svelte.ts`

**Interfaces:**
- Consumes: Task 1의 `pollGatewayRecovery` / `VISIBILITY_RECOVERY_TIMEOUT_MS`, Task 2의 `applyRecoveredMessage`, Task 3의 `markGenerationPending` / `clearGenerationPending` / `takePendingGenerations`
- Produces: 없음

- [ ] **Step 1: import를 확장한다**

Task 5에서 추가한 import 줄을 다음으로 바꾼다:

```typescript
import {
    applyRecoveredMessage,
    clearGenerationPending,
    INLINE_RECOVERY_TIMEOUT_MS,
    markGenerationPending,
    pollGatewayRecovery,
    takePendingGenerations,
    VISIBILITY_RECOVERY_TIMEOUT_MS,
} from "./gatewayRecovery";
```

- [ ] **Step 2: 스트리밍 시작 시 pending으로 등록한다**

`src/ts/process/index.svelte.ts` 의 streaming 분기에서 `DBState.db.characters[selectedChar].chats[selectedChat].isStreaming = true` 줄(1621행 부근) 바로 위에 추가한다:

```typescript
        // 탭이 얼어붙어 인라인 복구까지 실패하는 경우를 대비해 등록한다.
        // 정상 완료/중단 시에는 해제하고, 포기한 경우에만 남겨서
        // visibilitychange 세이프티넷이 집어갈 수 있게 한다.
        if(isNodeServer && generationId){
            markGenerationPending({
                chatId: generationId,
                charIndex: selectedChar,
                chatIndex: selectedChat,
            })
        }
```

- [ ] **Step 3: 정상 완료와 중단 시 등록을 해제한다**

같은 streaming 분기에서 `if(streamAborted || abortSignal.aborted){` 블록(1673행 부근)을 다음으로 바꾼다:

```typescript
        if(streamAborted || abortSignal.aborted){
            clearGenerationPending(generationId)
            return false
        }
```

그리고 `addRerolls(generationId, Object.values(lastResponseChunk))` 줄(1741행 부근) 바로 위에 추가한다. 이 지점은 `needsRecovery`가 false였던 정상 경로와 인라인 복구가 성공한 경로가 **둘 다** 지나가므로 여기 한 곳으로 충분하다 — 복구 성공 지점에 따로 넣으면 중복이다:

```typescript
        // 여기까지 왔으면 성공이다 (needsRecovery가 false였거나 복구됐다).
        clearGenerationPending(generationId)
```

인라인 복구가 포기한 경로(`if(!recovered){ ... return false }`)에서는 **의도적으로 해제하지 않는다.** 그 상태로 남겨두는 것이 세이프티넷이 나중에 집어갈 수 있는 조건이다.

주의: 이 `clearGenerationPending` 아래에도 `runTrigger` 등에서 예외가 날 수 있는 코드가 있다. 그 경우 pending이 이미 해제된 상태로 남지만, 응답 자체는 DB에 반영된 뒤이므로 세이프티넷이 필요 없다 — `applyRecoveredMessage`가 `already-complete`로 skip할 상황이라 동작상 차이도 없다.

- [ ] **Step 4: 세이프티넷 리스너를 모듈 스코프에 추가한다**

`src/ts/process/index.svelte.ts` 파일 맨 끝에 추가한다:

```typescript
/**
 * visibilitychange 세이프티넷.
 *
 * iOS Safari는 화면이 꺼지거나 탭이 백그라운드로 가면 JS 실행을 완전히
 * 정지시킨다. 그래서 스트리밍 루프도, 인라인 복구 폴링도 그 자리에서
 * 멈춘다. 탭이 다시 보이면 아직 완료 처리되지 않은 generation에 대해
 * 새 예산으로 서버에 한 번 더 물어본다.
 *
 * 서버는 클라이언트 연결과 무관하게 Bedrock 스트림을 끝까지 받아 30분간
 * 버퍼에 들고 있으므로, 대부분의 경우 여기서 온전한 응답을 되찾는다.
 */
async function runVisibilityRecovery(){
    const entries = takePendingGenerations()
    if(entries.length === 0){
        return
    }

    for(const entry of entries){
        try{
            const { NodeStorage } = await import('../storage/nodeStorage')
            const nodeStorage = new NodeStorage()
            const auth = await nodeStorage.createAuth()

            const recovery = await pollGatewayRecovery({
                chatId: entry.chatId,
                timeoutMs: VISIBILITY_RECOVERY_TIMEOUT_MS,
                now: () => Date.now(),
                sleep: (ms:number) => new Promise(r => setTimeout(r, ms)),
                fetchRecover: async (chatId:string) => {
                    const res = await fetch(`/gateway/recover?chatId=${encodeURIComponent(chatId)}`, {
                        headers: { 'risu-auth': auth }
                    })
                    if(!res.ok){
                        return { ok: false, status: res.status }
                    }
                    const data = await res.json()
                    return {
                        ok: true,
                        status: res.status,
                        responseText: data.responseText || '',
                        done: !!data.done,
                    }
                },
            })

            if(recovery.status !== 'done' || !recovery.responseText){
                console.warn(`[VisibilityRecovery] nothing to apply for ${entry.chatId}: status=${recovery.status}`)
                continue
            }

            const chat = DBState.db?.characters?.[entry.charIndex]?.chats?.[entry.chatIndex]
            if(!chat || !Array.isArray(chat.message)){
                console.warn(`[VisibilityRecovery] chat gone for ${entry.chatId}`)
                continue
            }

            const outcome = applyRecoveredMessage({
                messages: chat.message as any,
                chatId: entry.chatId,
                responseText: recovery.responseText,
                buildMessage: (responseText:string) => ({
                    role: 'char',
                    data: responseText,
                    saying: DBState.db.characters[entry.charIndex]?.chaId,
                    time: Date.now(),
                    chatId: entry.chatId,
                }),
            })

            if(outcome.action === 'skipped'){
                console.log(`[VisibilityRecovery] skipped ${entry.chatId}: ${outcome.reason}`)
                continue
            }

            DBState.db.characters[entry.charIndex].reloadKeys += 1
            console.log(`[VisibilityRecovery] ${outcome.action} ${entry.chatId} (length=${recovery.responseText.length})`)
        }
        catch(e){
            console.error(`[VisibilityRecovery] failed for ${entry.chatId}:`, e)
        }
    }
}

if(isNodeServer && typeof document !== 'undefined'){
    document.addEventListener('visibilitychange', () => {
        if(document.visibilityState !== 'visible'){
            return
        }
        // 아직 sendChat이 돌고 있으면 그쪽 인라인 복구가 처리한다.
        if(get(doingChat)){
            return
        }
        void runVisibilityRecovery()
    })
}
```

- [ ] **Step 5: 타입 체크와 전체 테스트를 돌린다**

Run: `pnpm vitest run`
Expected: PASS — 전체 테스트 통과 (신규 20개 포함)

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "gatewayRecovery|index\.svelte\.ts" || echo "no new type errors in changed files"`
Expected: `no new type errors in changed files`

- [ ] **Step 6: 프로덕션 빌드가 통과하는지 확인한다**

Run: `pnpm build 2>&1 | tail -20`
Expected: 빌드 성공 (`built in ...`). 실패하면 신규 import 경로나 타입을 고친다.

- [ ] **Step 7: 커밋한다**

```bash
git add src/ts/process/index.svelte.ts
git commit -m "feat: recover stalled generations when the tab becomes visible

iOS Safari freezes tab JS on screen lock, stopping both the streaming loop
and the inline recovery poll mid-flight. Re-check any generation that was
never completed once the tab is visible again, with a fresh budget.

In-memory registry only: a tab evicted by iOS still loses the response."
```

---

## 배포 후 검증

배포는 `risuai-deploy` 스킬로 진행한다. 배포 후 RPi에서 확인할 것:

```bash
# 재연결이 3회를 넘어도 스트림이 유지되는지
ssh rpi 'docker logs risuai --tail 100 2>&1 | grep -E "Resume attach|Usage:"'
```

iPhone Safari에서 수동 확인:
1. 긴 응답이 나올 요청을 보낸다.
2. 스트리밍 중 화면을 잠근다. 30초 이상 기다린다.
3. 화면을 켜고 Safari로 돌아온다.
4. 응답이 이어지거나(재연결) 완성된 형태로 채워지는지(복구) 확인한다.
5. 브라우저 콘솔에서 `[Gateway SSE] Resuming after drop` / `[Streaming] Recovered` / `[VisibilityRecovery]` 로그를 확인한다.

기대: `Stream connection lost. Please try again.` 에러와 메시지 삭제가 발생하지 않는다.

## 알려진 한계

- **탭 evict:** iOS가 메모리 압박으로 탭을 통째로 날리면 `pendingGenerations`(메모리)도 사라져 세이프티넷이 돌지 않는다. `localStorage` 영속화가 필요하고, 이번 범위에서 제외했다.
- **서버 버퍼 TTL 30분:** 폰이 30분 넘게 잠겨 있으면 `activeStreams` 엔트리가 만료된다. 단 `GATEWAY_LOG=true`면 `/gateway/recover`가 로그 파일로 폴백하므로 이 경우도 상당 부분 살아난다.
- **5분 인라인 상한 중 UI 블로킹:** 복구를 기다리는 동안 `doingChat`이 유지돼 새 메시지를 보낼 수 없다. 서버가 정말 멈춘 경우 최대 5분 대기한다.
