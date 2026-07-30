# 수동 메시지 동기화 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 잘린 응답을 사용자가 버튼 한 번으로 서버에서 되찾을 수 있게 하고, 계속 실패해온 자동 복구를 제거한다.

**Architecture:** RPi 서버는 Bedrock 응답을 `activeStreams` 메모리 버퍼(30분)와 `gateway-logs/*_res.json`(무기한)에 남긴다. 클라이언트는 메시지의 `chatId`로 `/gateway/recover`를 단발 조회해 더 긴 텍스트가 있으면 교체한다. 판단 시점을 코드의 추측에서 사용자의 눈으로 옮기는 것이 이 변경의 핵심이다.

**Tech Stack:** Svelte 5 (runes), TypeScript, Vitest, Express (`server.cjs`, CommonJS)

## Global Constraints

- 설계 문서: `docs/superpowers/specs/2026-07-30-manual-message-sync-design.md` — 충돌 시 스펙이 우선한다
- 폴링 금지 — 모든 서버 조회는 단발이다. 재시도는 사용자가 버튼을 다시 눌러서 한다
- 텍스트를 짧게 되돌리지 않는다 — 기존 텍스트가 서버 텍스트와 같거나 더 길면 교체하지 않는다
- `chatId` 불일치 시 거부한다 — 인덱스가 흔들렸을 수 있으므로 안전 장치를 반드시 통과해야 한다
- 스트림 실패 시 메시지를 삭제하지 않는다 — 빈 말풍선이어도 남긴다. `chatId`가 사라지면 수동 복구가 불가능하다
- 전송 계층(SSE resume 12회, 10초 하트비트, 25초 idle 타임아웃)은 건드리지 않는다
- 주석은 한국어로 쓴다 (`gatewayRecovery.ts` 기존 스타일)
- 커밋 메시지는 영어로 쓰고 `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`로 끝낸다
- 테스트: `npx vitest run src/ts/process/tests/gatewayRecovery.test.ts`
- 전체 테스트: `npx vitest run` — 기준선은 239 passed / 3 skipped
- 서버 문법 검사: `node --check server/node/server.cjs`

## File Structure

| 파일 | 책임 | 변경 |
|---|---|---|
| `src/ts/process/gatewayRecovery.ts` | 순수 복구 로직. DOM/DBState를 모른다 | 인덱스 지정 교체 함수 추가, 폴링·pending registry 제거 |
| `src/ts/process/tests/gatewayRecovery.test.ts` | 위 모듈의 유닛 테스트 | 새 함수 테스트 추가, 제거된 함수 테스트 삭제 |
| `src/ts/process/messageSync.ts` | **신규.** 서버 조회 + 결과 분류. fetch를 주입받아 테스트 가능하게 유지 | 생성 |
| `src/ts/process/tests/messageSync.test.ts` | **신규.** 위 모듈의 유닛 테스트 | 생성 |
| `src/lib/ChatScreens/Chat.svelte` | 메시지 UI. 동기화 버튼 진입점 | `minorIconButtonsBody`에 버튼 추가 |
| `src/ts/process/index.svelte.ts` | 채팅 엔진 | 자동 복구 3층 제거, 실패 시 부분 텍스트 보존 |
| `src/ts/bootstrap.ts` | 앱 부팅 | 부팅 복구 호출 제거 |
| `src/lang/ko.ts`, `src/lang/en.ts` | i18n | 버튼 라벨 + 결과 메시지 |
| `server/node/server.cjs` | 게이트웨이 | `res.json` 저장 보장 |

`messageSync.ts`를 새로 만드는 이유: `gatewayRecovery.ts`는 폴링 중심으로 설계됐고 이 변경에서 대부분이 제거된다. 단발 조회 + 결과 분류는 성격이 다르므로 별도 파일에 두고, 순수 함수로 유지해 UI 없이 테스트한다.

**작업 순서 주의:** Task 1~3(순수 로직)은 독립적이다. Task 4(UI)는 Task 2·3에 의존한다. Task 5·6(제거)은 Task 4 이후에 해야 한다 — 먼저 지우면 그 사이 사고가 나도 복구 수단이 없다. Task 7(서버)은 독립적이다.

---

### Task 1: 서버 응답 분류 함수

`/gateway/recover` 응답을 5가지 결과로 분류하는 순수 함수를 만든다. UI가 이 결과만 보고 알림을 띄운다.

**Files:**
- Create: `src/ts/process/messageSync.ts`
- Test: `src/ts/process/tests/messageSync.test.ts`

**Interfaces:**
- Consumes: 없음 (첫 작업)
- Produces:
  - `interface RecoverResponse { ok: boolean, status: number, responseText?: string, done?: boolean }`
  - `type SyncOutcome = { kind: 'replaced', text: string, from: number, to: number } | { kind: 'already-complete', length: number } | { kind: 'in-progress', length: number } | { kind: 'not-found' } | { kind: 'error', status: number }`
  - `function classifySyncResult(res: RecoverResponse, currentText: string): SyncOutcome`

- [ ] **Step 1: Write the failing test**

`src/ts/process/tests/messageSync.test.ts`를 만든다:

```typescript
import { describe, expect, it } from 'vitest'

import { classifySyncResult } from '../messageSync'

describe('classifySyncResult', () => {
    it('서버 텍스트가 더 길면 replaced로 분류한다', () => {
        // 실측 사고: 12,393자 중 7,487자만 받았다.
        const outcome = classifySyncResult(
            { ok: true, status: 200, responseText: 'a'.repeat(12393), done: true },
            'a'.repeat(7487),
        )

        expect(outcome).toEqual({
            kind: 'replaced',
            text: 'a'.repeat(12393),
            from: 7487,
            to: 12393,
        })
    })

    it('길이가 같으면 already-complete로 분류한다', () => {
        const outcome = classifySyncResult(
            { ok: true, status: 200, responseText: 'same text', done: true },
            'same text',
        )

        expect(outcome).toEqual({ kind: 'already-complete', length: 9 })
    })

    it('기존 텍스트가 더 길면 already-complete로 분류한다', () => {
        // 후처리 스크립트가 텍스트를 늘렸을 수 있다 — 회귀시키지 않는다.
        const outcome = classifySyncResult(
            { ok: true, status: 200, responseText: 'short', done: true },
            'much longer after post-processing',
        )

        expect(outcome).toEqual({ kind: 'already-complete', length: 32 })
    })

    it('서버가 아직 생성 중이면 in-progress로 분류한다', () => {
        const outcome = classifySyncResult(
            { ok: true, status: 200, responseText: 'partial', done: false },
            'part',
        )

        expect(outcome).toEqual({ kind: 'in-progress', length: 7 })
    })

    it('생성 중이면서 기존이 더 길어도 in-progress로 분류한다', () => {
        // done이 아니면 교체하지 않는다. 사용자가 다시 누르게 안내한다.
        const outcome = classifySyncResult(
            { ok: true, status: 200, responseText: 'ab', done: false },
            'abcdef',
        )

        expect(outcome).toEqual({ kind: 'in-progress', length: 2 })
    })

    it('404는 not-found로 분류한다', () => {
        const outcome = classifySyncResult({ ok: false, status: 404 }, 'partial')

        expect(outcome).toEqual({ kind: 'not-found' })
    })

    it('그 외 오류는 error로 분류한다', () => {
        const outcome = classifySyncResult({ ok: false, status: 500 }, 'partial')

        expect(outcome).toEqual({ kind: 'error', status: 500 })
    })

    it('done이지만 텍스트가 비어 있으면 not-found로 분류한다', () => {
        // 서버 기록이 껍데기만 있는 경우 — 적용할 것이 없다.
        const outcome = classifySyncResult(
            { ok: true, status: 200, responseText: '', done: true },
            'partial',
        )

        expect(outcome).toEqual({ kind: 'not-found' })
    })

    it('responseText가 undefined여도 던지지 않는다', () => {
        const outcome = classifySyncResult({ ok: true, status: 200, done: true }, 'partial')

        expect(outcome).toEqual({ kind: 'not-found' })
    })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ts/process/tests/messageSync.test.ts`
Expected: FAIL — `Failed to resolve import "../messageSync"`

- [ ] **Step 3: Write minimal implementation**

`src/ts/process/messageSync.ts`를 만든다:

```typescript
/**
 * 수동 메시지 동기화.
 *
 * 서버(`/gateway/recover`)는 Bedrock 응답을 메모리 버퍼(30분)와
 * `gateway-logs/*_res.json`(무기한)에 들고 있다. 클라이언트가 SSE로 못 받은
 * 응답을 사용자가 버튼으로 되찾을 때 쓴다.
 *
 * 폴링하지 않는다 — 단발 조회하고 결과를 사용자에게 보여준다. 생성 중이면
 * 사용자가 다시 누른다. 자동 폴링은 이 설계가 없애려는 추측이다.
 */

/** `/gateway/recover` 응답. */
export interface RecoverResponse{
    ok: boolean
    status: number
    responseText?: string
    done?: boolean
}

/** 조회 결과. UI는 이것만 보고 알림을 띄운다. */
export type SyncOutcome =
    | { kind: 'replaced', text: string, from: number, to: number }
    | { kind: 'already-complete', length: number }
    | { kind: 'in-progress', length: number }
    | { kind: 'not-found' }
    | { kind: 'error', status: number }

/**
 * 서버 응답을 결과로 분류한다.
 *
 * `done`이 아니면 교체하지 않는다 — 아직 늘어날 텍스트를 확정본으로
 * 저장하면 다음 조회에서 already-complete로 막힌다.
 */
export function classifySyncResult(res: RecoverResponse, currentText: string): SyncOutcome{
    if(!res.ok){
        return res.status === 404
            ? { kind: 'not-found' }
            : { kind: 'error', status: res.status }
    }

    const serverText = res.responseText ?? ''

    if(!res.done){
        return { kind: 'in-progress', length: serverText.length }
    }
    if(!serverText){
        return { kind: 'not-found' }
    }
    if(serverText.length <= currentText.length){
        return { kind: 'already-complete', length: currentText.length }
    }

    return {
        kind: 'replaced',
        text: serverText,
        from: currentText.length,
        to: serverText.length,
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/ts/process/tests/messageSync.test.ts`
Expected: PASS — 9 tests

- [ ] **Step 5: Commit**

```bash
git add src/ts/process/messageSync.ts src/ts/process/tests/messageSync.test.ts
git commit -m "feat: classify gateway recover responses for manual sync

Pure function that maps a /gateway/recover response plus the message's current
text onto one of five outcomes. Keeping the decision out of the UI means the
five branches are testable without a DOM, and the caller only renders.

Refuses to replace while done is false: text that is still growing must not be
stored as final, or the next sync would see already-complete and stop.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: 인덱스 지정 메시지 교체

사용자가 지목한 인덱스의 메시지만 교체하는 함수를 만든다. 기존 `applyRecoveredMessage()`는 `chatId`로 메시지를 탐색하지만, 수동 버튼은 인덱스가 이미 확정이므로 그 메시지만 건드리는 게 안전하다.

**Files:**
- Modify: `src/ts/process/gatewayRecovery.ts` (파일 끝에 추가)
- Test: `src/ts/process/tests/gatewayRecovery.test.ts` (파일 끝에 추가)

**Interfaces:**
- Consumes: `RecoverableMessage` (`gatewayRecovery.ts`에 이미 있음 — `{ role: 'user'|'char', data: string, chatId?: string, [key: string]: unknown }`)
- Produces:
  - `type SyncMessageOutcome = { action: 'replaced' } | { action: 'refused', reason: 'index-out-of-range' | 'chat-id-mismatch' | 'not-char-message' | 'not-longer' }`
  - `function syncMessageAtIndex(opts: { messages: RecoverableMessage[], index: number, chatId: string, responseText: string }): SyncMessageOutcome`

- [ ] **Step 1: Write the failing test**

`src/ts/process/tests/gatewayRecovery.test.ts` 끝에 추가한다. import 문에 `syncMessageAtIndex`를 넣는다:

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ts/process/tests/gatewayRecovery.test.ts`
Expected: FAIL — `syncMessageAtIndex is not a function`

- [ ] **Step 3: Write minimal implementation**

`src/ts/process/gatewayRecovery.ts` 끝에 추가한다:

```typescript
export type SyncMessageOutcome =
    | { action: 'replaced' }
    | { action: 'refused', reason: 'index-out-of-range' | 'chat-id-mismatch' | 'not-char-message' | 'not-longer' }

export interface SyncMessageAtIndexOptions{
    messages: RecoverableMessage[]
    index: number
    /** 버튼을 누른 시점에 그 메시지가 갖고 있던 chatId. */
    chatId: string
    responseText: string
}

/**
 * 지정한 인덱스의 메시지를 서버 텍스트로 교체한다.
 *
 * 사용자가 지목한 그 메시지만 건드린다. chatId를 다시 확인하는 이유는,
 * 버튼을 누른 뒤 조회를 기다리는 사이 메시지가 삭제/재배열될 수 있어서다.
 * 불일치면 엉뚱한 메시지를 덮어쓰게 되므로 거부한다.
 */
export function syncMessageAtIndex(opts: SyncMessageAtIndexOptions): SyncMessageOutcome{
    const { messages, index, chatId, responseText } = opts

    if(index < 0 || index >= messages.length){
        return { action: 'refused', reason: 'index-out-of-range' }
    }

    const target = messages[index]
    if(target.chatId !== chatId){
        return { action: 'refused', reason: 'chat-id-mismatch' }
    }
    if(target.role !== 'char'){
        return { action: 'refused', reason: 'not-char-message' }
    }
    if(responseText.length <= target.data.length){
        return { action: 'refused', reason: 'not-longer' }
    }

    target.data = responseText
    return { action: 'replaced' }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/ts/process/tests/gatewayRecovery.test.ts`
Expected: PASS — 기존 22개 + 신규 9개 = 31 tests

- [ ] **Step 5: Commit**

```bash
git add src/ts/process/gatewayRecovery.ts src/ts/process/tests/gatewayRecovery.test.ts
git commit -m "feat: replace a single message by index for manual sync

applyRecoveredMessage searches by chatId, which is right for the automatic path
where the index is unknown. Manual sync already knows the index the user
pointed at, so it only touches that one message.

It re-checks chatId anyway: the message could be deleted or reordered between
the click and the server response, and the index would then point at a
different conversation turn.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: i18n 라벨

버튼 라벨과 결과 메시지를 한국어·영어에 추가한다.

**Files:**
- Modify: `src/lang/ko.ts` (`"branch"` 항목 뒤, 1441행 근처)
- Modify: `src/lang/en.ts` (`branch` 항목 근처)

**Interfaces:**
- Consumes: 없음
- Produces: `language.syncFromServer`, `language.syncFromServerReplaced`, `language.syncFromServerAlreadyComplete`, `language.syncFromServerInProgress`, `language.syncFromServerNotFound` — Task 4에서 쓴다. `Replaced`와 `InProgress`는 함수다.

- [ ] **Step 1: 한국어 라벨 추가**

`src/lang/ko.ts`에서 `"branch": "분기점",` 를 찾아 그 뒤에 추가한다:

```typescript
    "syncFromServer": "서버에서 동기화",
    "syncFromServerReplaced": (from:number, to:number) => `${from}자 → ${to}자로 복구했습니다.`,
    "syncFromServerAlreadyComplete": "이미 최신 상태입니다.",
    "syncFromServerInProgress": (length:number) => `서버가 아직 생성 중입니다 (현재 ${length}자). 잠시 후 다시 시도하세요.`,
    "syncFromServerNotFound": "서버에 이 응답 기록이 없습니다.",
```

- [ ] **Step 2: 영어 라벨 추가**

`src/lang/en.ts`에서 `branch:` 항목을 찾아 그 뒤에 추가한다:

```typescript
    syncFromServer: "Sync from Server",
    syncFromServerReplaced: (from:number, to:number) => `Restored from ${from} to ${to} characters.`,
    syncFromServerAlreadyComplete: "Already up to date.",
    syncFromServerInProgress: (length:number) => `The server is still generating (${length} characters so far). Try again shortly.`,
    syncFromServerNotFound: "The server has no record of this response.",
```

- [ ] **Step 3: 타입 검사**

Run: `npx vitest run`
Expected: PASS — 239 passed / 3 skipped (기준선 유지)

`en.ts`가 언어 타입의 원본이므로 두 파일의 키가 일치해야 한다. 불일치하면 다른 언어 파일에서 타입 오류가 난다. 오류가 나면 해당 파일에도 같은 키를 추가한다 — 값은 영어를 그대로 쓴다.

- [ ] **Step 4: Commit**

```bash
git add src/lang/ko.ts src/lang/en.ts
git commit -m "feat: add i18n strings for manual message sync

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: 동기화 버튼 UI

메시지 메뉴에 버튼을 추가하고 조회·교체·알림을 배선한다.

**Files:**
- Modify: `src/lib/ChatScreens/Chat.svelte`

**Interfaces:**
- Consumes: `classifySyncResult` (Task 1), `syncMessageAtIndex` (Task 2), `language.syncFromServer*` (Task 3)
- Produces: 없음 (UI 종단)

- [ ] **Step 1: import 추가**

`src/lib/ChatScreens/Chat.svelte` 최상단 `<script lang="ts">` 안에 추가한다. 아이콘은 기존 lucide import 줄에 `CloudDownloadIcon`을 넣는다:

```typescript
    import { classifySyncResult } from "src/ts/process/messageSync"
    import { syncMessageAtIndex } from "src/ts/process/gatewayRecovery"
    import { processScriptFull } from "src/ts/process/scripts"
    import { isNodeServer } from "src/ts/platform"
    import { NodeStorage } from "src/ts/storage/nodeStorage"
    import { alertError } from "../../ts/alert"
```

`alertNormal`, `alertWait`, `alertClear`는 기존 import 줄(18행)에 이미 있다.

- [ ] **Step 2: 동기화 함수 추가**

`<script>` 블록 안, `let translating = $state(false)` 선언들 아래에 추가한다:

```typescript
    /**
     * 서버에서 이 메시지의 완성본을 가져온다.
     *
     * 폴링하지 않는다 — 한 번 조회하고 결과를 보여준다. 생성 중이면 사용자가
     * 다시 누른다.
     */
    async function syncFromServer(){
        const chat = DBState.db.characters[selIdState.selId].chats[DBState.db.characters[selIdState.selId].chatPage]
        const target = chat.message[idx]
        if(!target?.chatId){
            return
        }
        const chatId = target.chatId
        const currentText = target.data

        alertWait(language.loading)
        try{
            const nodeStorage = new NodeStorage()
            const auth = await nodeStorage.createAuth()
            const res = await fetch(`/gateway/recover?chatId=${encodeURIComponent(chatId)}`, {
                headers: { 'risu-auth': auth }
            })

            let outcome
            if(!res.ok){
                outcome = classifySyncResult({ ok: false, status: res.status }, currentText)
            }
            else{
                const data = await res.json()
                outcome = classifySyncResult({
                    ok: true,
                    status: res.status,
                    responseText: data.responseText || '',
                    done: !!data.done,
                }, currentText)
            }

            alertClear()

            switch(outcome.kind){
                case 'replaced': {
                    // 정상 스트리밍과 같은 후처리를 거쳐야 표시가 일관된다.
                    const processed = await processScriptFull(
                        getCurrentCharacter(),
                        outcome.text.trim(),
                        'editoutput',
                        idx,
                    )
                    const applied = syncMessageAtIndex({
                        messages: chat.message as any,
                        index: idx,
                        chatId,
                        responseText: processed.data,
                    })
                    if(applied.action === 'refused'){
                        alertNormal(language.syncFromServerAlreadyComplete)
                        break
                    }
                    DBState.db.characters[selIdState.selId].reloadKeys += 1
                    alertNormal(language.syncFromServerReplaced(outcome.from, outcome.to))
                    break
                }
                case 'already-complete':
                    alertNormal(language.syncFromServerAlreadyComplete)
                    break
                case 'in-progress':
                    alertNormal(language.syncFromServerInProgress(outcome.length))
                    break
                case 'not-found':
                    alertNormal(language.syncFromServerNotFound)
                    break
                case 'error':
                    alertError(`Sync failed: HTTP ${outcome.status}`)
                    break
            }
        }
        catch(e){
            alertClear()
            alertError(`Sync failed: ${e}`)
        }
    }
```

- [ ] **Step 3: 버튼 추가**

`{#snippet minorIconButtonsBody(showNames:boolean)}` 안, 북마크 블록 바로 뒤에 추가한다:

```svelte
    {#if isNodeServer && role === 'char' && DBState.db.characters[selIdState.selId]?.chats[DBState.db.characters[selIdState.selId]?.chatPage]?.message[idx]?.chatId}
        <button class="flex items-center hover:text-blue-500 transition-colors" onclick={async () => {
            await sleep(1)
            await syncFromServer()
        }}>
            <CloudDownloadIcon size={20}/>
            {#if showNames}
                <span class="ml-1">{language.syncFromServer}</span>
            {/if}
        </button>
    {/if}
```

- [ ] **Step 4: 빌드 검증**

Run: `npx vite build`
Expected: exit 0. Svelte 컴파일 오류가 없어야 한다.

Run: `npx vitest run`
Expected: PASS — 239 passed / 3 skipped + Task 1·2에서 추가한 테스트

- [ ] **Step 5: 수동 검증**

로컬에서 확인할 수 없다 (게이트웨이가 RPi에 있다). 배포 후 검증하되, 지금은 빌드 결과물에 코드가 들어갔는지만 확인한다:

```bash
grep -rl "gateway/recover" dist/assets/*.js
```
Expected: 최소 1개 파일에서 발견

- [ ] **Step 6: Commit**

```bash
git add src/lib/ChatScreens/Chat.svelte
git commit -m "feat: add per-message sync button to the message menu

Sits alongside bookmark and branch, shown only for char messages that carry a
chatId on a node server — those are the only ones the gateway can look up.

Applies the same editoutput post-processing the streaming path runs, so a
synced message renders identically to one that arrived normally. The automatic
recovery path skipped this, which is why recovered messages used to come back
without their regex scripts applied.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: 스트림 실패 시 부분 텍스트 보존

실패해도 메시지를 삭제하지 않게 바꾼다. `chatId`가 남아야 Task 4의 버튼이 동작한다.

**Files:**
- Modify: `src/ts/process/index.svelte.ts:1774~1781` (`if(!recovered)` 블록)

**Interfaces:**
- Consumes: 없음
- Produces: 없음

- [ ] **Step 1: 삭제 로직 제거**

`src/ts/process/index.svelte.ts`에서 이 부분을 찾는다:

```typescript
            if(!recovered){
                if(isNewMessage){
                    DBState.db.characters[selectedChar].chats[selectedChat].message.splice(msgIndex, 1)
                }
                throwError('Stream connection lost. Please try again.')
                return false
            }
```

이렇게 바꾼다:

```typescript
            if(!recovered){
                // 메시지를 지우지 않는다. 지우면 chatId가 사라져 수동 동기화조차
                // 불가능해진다. 부분 텍스트(빈 것이라도)를 남겨두면 사용자가
                // 메시지 메뉴의 "서버에서 동기화"로 완성본을 가져올 수 있다.
                throwError('Stream connection lost. Use "Sync from Server" on the message to recover it.')
                return false
            }
```

`isNewMessage` 변수가 이 블록에서만 쓰였다면 orphan이 된다. 다른 참조가 있는지 확인한다:

```bash
grep -n "isNewMessage" src/ts/process/index.svelte.ts
```

선언(`const isNewMessage = !arg.continue`) 외에 참조가 없으면 선언도 제거한다.

- [ ] **Step 2: 빌드 검증**

Run: `npx vite build`
Expected: exit 0

Run: `npx vitest run`
Expected: PASS — 회귀 없음

- [ ] **Step 3: Commit**

```bash
git add src/ts/process/index.svelte.ts
git commit -m "fix: keep the partial message when a stream fails

Deleting the message took its chatId with it, and the chatId is the only key
/gateway/recover accepts. So the one case that most needed recovery — a stream
that died mid-response — was also the case that destroyed its own recovery
path.

Leave the message in place, empty bubble included, and point the error at the
sync button. The user can delete it by hand if the response is genuinely gone.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: 자동 복구 제거

인라인 폴링, visibilitychange 세이프티넷, 부팅 스윕, pending registry를 지운다.

**Files:**
- Modify: `src/ts/process/index.svelte.ts`
- Modify: `src/ts/bootstrap.ts`
- Modify: `src/ts/process/gatewayRecovery.ts`
- Modify: `src/ts/process/tests/gatewayRecovery.test.ts`

**Interfaces:**
- Consumes: 없음
- Produces: `gatewayRecovery.ts`가 `syncMessageAtIndex`, `RecoverableMessage`, `SyncMessageOutcome`만 export하게 된다

- [ ] **Step 1: index.svelte.ts에서 인라인 복구 블록 제거**

`needsRecovery` 계산부터 `if(needsRecovery){...}` 블록 전체를 지운다 (1724~1783행 근처). 지우고 나면 이렇게 된다:

```typescript
        if(streamAborted || abortSignal.aborted){
            clearGenerationPending(generationId)
            return false
        }

        addRerolls(generationId, Object.values(lastResponseChunk))
```

`clearGenerationPending(generationId)` 호출 2곳도 제거한다 (registry 자체가 없어진다).

- [ ] **Step 2: visibilitychange 세이프티넷과 부팅 복구 제거**

`src/ts/process/index.svelte.ts`에서 지운다:
- `runVisibilityRecovery()` 함수 전체 (2249~2340행 근처, 주석 포함)
- `document.addEventListener('visibilitychange', ...)` 블록 (2357~2367행 근처)
- `runBootRecovery()` 함수 (있는 경우)
- `fetchGatewayRecover()` 함수 (141~158행) — 폴링 전용이었다
- `gatewayRecovery` import에서 `applyRecoveredMessage`, `clearGenerationPending`, `INLINE_RECOVERY_TIMEOUT_MS`, `markGenerationPending`, `pollGatewayRecovery`, `takePendingGenerations`, `VISIBILITY_RECOVERY_TIMEOUT_MS` 제거
- `markGenerationPending({...})` 호출 블록 (1658~1668행)

- [ ] **Step 3: bootstrap.ts에서 부팅 복구 호출 제거**

`import { runBootRecovery } from "./process/index.svelte";` 와 `void runBootRecovery()` 를 지운다. (앞서 되돌렸으므로 없을 수 있다 — `grep -n runBootRecovery src/ts/bootstrap.ts`로 확인하고, 없으면 이 단계를 건너뛴다.)

- [ ] **Step 4: gatewayRecovery.ts에서 폴링과 registry 제거**

지운다:
- `INLINE_RECOVERY_TIMEOUT_MS`, `VISIBILITY_RECOVERY_TIMEOUT_MS`, `DEFAULT_INTERVAL_MS`, `DEFAULT_NOTFOUND_TOLERANCE`
- `GatewayRecoverResponse`, `GatewayRecoveryResult`, `PollGatewayRecoveryOptions`
- `pollGatewayRecovery()`
- `applyRecoveredMessage()`, `ApplyRecoveredMessageOptions`, `ApplyRecoveredMessageOutcome`
- `PendingGeneration`, `pendingGenerations` Map, `markGenerationPending`, `clearGenerationPending`, `takePendingGenerations`, `__resetPendingGenerations`

남기는 것: `RecoverableMessage`, `SyncMessageOutcome`, `SyncMessageAtIndexOptions`, `syncMessageAtIndex`

파일 상단 주석을 수동 동기화 기준으로 고친다:

```typescript
/**
 * 수동 메시지 동기화의 텍스트 교체 로직.
 *
 * 서버(`/gateway/recover`)는 Bedrock 응답을 메모리 버퍼(30분)와
 * `gateway-logs/*_res.json`(무기한)에 들고 있다. 사용자가 메시지 메뉴에서
 * 동기화를 누르면 그 응답을 가져와 이 함수로 반영한다.
 *
 * DOM과 DBState를 모르는 순수 로직만 담는다 — 그래서 유닛 테스트가 가능하다.
 */
```

- [ ] **Step 5: 테스트에서 제거된 함수의 테스트 삭제**

`src/ts/process/tests/gatewayRecovery.test.ts`에서 지운다:
- `describe('pollGatewayRecovery', ...)` 전체
- `describe('applyRecoveredMessage', ...)` 전체
- `describe('pending generation registry', ...)` 전체
- `fakeClock()` 헬퍼 (폴링 테스트 전용)
- import에서 제거된 심볼들

남기는 것: `describe('syncMessageAtIndex', ...)` (Task 2에서 추가한 것)

- [ ] **Step 6: 검증**

Run: `npx vitest run`
Expected: PASS. 총 개수가 줄어든다 (폴링/registry 테스트 삭제). `syncMessageAtIndex` 9개 + `classifySyncResult` 9개는 남아야 한다.

Run: `npx vite build`
Expected: exit 0. 사용하지 않는 import가 남아 있으면 여기서 잡힌다.

제거가 완전한지 확인한다:

```bash
grep -rn "pollGatewayRecovery\|markGenerationPending\|takePendingGenerations\|runVisibilityRecovery\|runBootRecovery\|applyRecoveredMessage" src/
```
Expected: 결과 없음

- [ ] **Step 7: Commit**

```bash
git add src/ts/process/index.svelte.ts src/ts/bootstrap.ts src/ts/process/gatewayRecovery.ts src/ts/process/tests/gatewayRecovery.test.ts
git commit -m "refactor: drop automatic stream recovery in favour of manual sync

Four layers of automatic recovery still missed the 2026-07-29 truncation: a
reload mid-stream destroyed the JS context, and every polling path went with
it. Each layer added state to reason about without closing the gap.

A survey of gateway-logs shows 1,540 of 1,564 chatIds still hold a complete
response server-side. The response was never the missing piece — the timing
was. Code has to infer that a stream failed; the user can see it.

Transport-level retry stays (SSE resume, heartbeat, idle timeout): those handle
brief drops that would be tedious to sync by hand.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: 서버 `res.json` 저장 보장

`metadata` 이벤트가 없어도 `res.json`을 쓰게 한다. 조사한 24건(1.5%)이 이 때문에 영구 유실됐다.

**Files:**
- Modify: `server/node/server.cjs`

**Interfaces:**
- Consumes: 없음
- Produces: 없음 (서버 내부)

- [ ] **Step 1: 저장 헬퍼 추출**

`server/node/server.cjs`의 `/gateway/bedrock-stream` 핸들러에서, `const gatewayLog = process.env.GATEWAY_LOG === 'true';` 블록 뒤에 헬퍼를 추가한다:

```javascript
        // res.json 저장. 여러 지점에서 부를 수 있게 분리한다 — metadata
        // 이벤트가 오지 않고 스트림이 끝나는 경우가 실제로 있어서(조사 결과
        // 1,564건 중 24건), 그때도 영구 기록을 남겨야 한다. 메모리 버퍼는
        // 30분 뒤 만료되므로 파일이 없으면 응답이 완전히 사라진다.
        let resLogWritten = false;
        const writeResLog = (usage, text) => {
            if (!gatewayLog || !logId || !text) {
                return;
            }
            resLogWritten = true;
            const logDir = path.join(process.cwd(), 'save', 'gateway-logs');
            fs.writeFile(
                path.join(logDir, `${logId}_res.json`),
                JSON.stringify({ usage: usage || null, responseText: text, chatId, timestamp: new Date().toISOString() }, null, 2)
            ).catch(() => {});
        };
```

- [ ] **Step 2: metadata 핸들러를 헬퍼로 교체**

이 부분을 찾는다:

```javascript
            } else if (event.metadata) {
                const usage = event.metadata.usage;
                console.log(`[Gateway] Usage: input=${usage?.inputTokens} output=${usage?.outputTokens} cacheRead=${usage?.cacheReadInputTokens || 0} cacheWrite=${usage?.cacheWriteInputTokens || 0}`);
                if (gatewayLog && logId) {
                    const logDir = path.join(process.cwd(), 'save', 'gateway-logs');
                    fs.writeFile(path.join(logDir, `${logId}_res.json`), JSON.stringify({ usage, responseText, chatId, timestamp: new Date().toISOString() }, null, 2)).catch(() => {});
                }
```

이렇게 바꾼다:

```javascript
            } else if (event.metadata) {
                const usage = event.metadata.usage;
                console.log(`[Gateway] Usage: input=${usage?.inputTokens} output=${usage?.outputTokens} cacheRead=${usage?.cacheReadInputTokens || 0} cacheWrite=${usage?.cacheWriteInputTokens || 0}`);
                writeResLog(usage, responseText);
```

- [ ] **Step 3: 스트림 종료 후 폴백 저장 추가**

`for await` 루프가 끝난 직후, `stream_complete` emit 앞에 추가한다:

```javascript
        // metadata 없이 스트림이 끝났다면 여기서 남긴다.
        if (!resLogWritten) {
            console.warn(`[Gateway] Stream ended without metadata (chatId=${chatId}, ${responseText.length} chars) — writing res log anyway`);
            writeResLog(null, responseText);
        }

        // Send explicit stream completion marker before ending
```

- [ ] **Step 4: 에러 경로에도 저장 추가**

`catch (err) {` 블록 안, `console.error` 다음 줄에 추가한다:

```javascript
    } catch (err) {
        console.error(`[Gateway] Bedrock error:`, err.message || err);
        // 부분 텍스트라도 남긴다 — 아무것도 없는 것보다 낫다.
        if (typeof writeResLog === 'function' && !resLogWritten) {
            try { writeResLog(null, responseText); } catch (e) {}
        }
```

`responseText`와 `writeResLog`가 `try` 블록 안에 선언되어 catch에서 안 보일 수 있다. 그 경우 둘의 선언을 `try` 앞으로 올린다 — `streamEntry`와 `emitEvent`가 이미 그렇게 hoist되어 있으니 같은 패턴을 따른다:

```javascript
    // Hoisted so the catch block can reach them (used to broadcast errors to
    // every attached resume-client, not just this connection).
    let streamEntry = null;
    let emitEvent = null;
    let responseText = '';
    let writeResLog = null;
    let resLogWritten = false;
```

`try` 안의 선언은 재선언 대신 대입으로 바꾼다 (`let responseText = ''` → `responseText = ''`).

- [ ] **Step 5: 문법 검사**

Run: `node --check server/node/server.cjs`
Expected: 출력 없음 (성공)

hoist가 필요했는지 확인한다:

```bash
grep -n "let responseText\|responseText = ''" server/node/server.cjs
```
선언이 한 곳(hoist 위치)에만 있어야 한다.

- [ ] **Step 6: Commit**

```bash
git add server/node/server.cjs
git commit -m "fix: always persist a gateway response log

res.json was written only from the metadata event handler. When a Bedrock
stream ends without emitting metadata — 24 of 1,564 logged chatIds — no file
was written, the in-memory buffer expired after 30 minutes, and the response
was gone for good. The 2026-07-29 14:44 loss happened exactly this way: no
usage line, no error line, no file.

Write the log after the stream loop and from the catch path too, so a partial
response is still recoverable. This is what takes manual sync from covering
98.5% of interruptions to all of them.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: 배포와 실환경 검증

빌드·배포하고 스펙의 검증 기준을 실제로 확인한다.

**Files:** 없음 (배포 작업)

**Interfaces:**
- Consumes: Task 1~7 전부
- Produces: 없음

- [ ] **Step 1: 전체 검증**

```bash
npx vitest run
npx vite build
node --check server/node/server.cjs
```
Expected: 테스트 PASS, 빌드 exit 0, 문법 검사 무출력

- [ ] **Step 2: 배포**

`risuai-deploy` 스킬을 쓴다. 검증 키워드는 `gateway/recover` (클라이언트 번들)와 `Stream ended without metadata` (서버).

`--no-cache`를 반드시 쓴다 — 프론트엔드 변경이 있다.

- [ ] **Step 3: 실환경 검증**

스펙의 검증 기준 11개를 확인한다. 사용자에게 확인을 요청할 항목:

1. 잘린 char 메시지에서 버튼 → 전체 텍스트로 교체, 후처리 적용됨
2. 정상 char 메시지에서 버튼 → "이미 최신 상태입니다"
3. 서버 기록 없는 메시지 → "서버에 이 응답 기록이 없습니다"
4. 생성 중인 메시지 → "서버가 아직 생성 중입니다 (현재 N자)"
5. user 메시지 → 버튼이 안 보임
6. chatId 없는 옛 메시지 → 버튼이 안 보임
7. 스트림 실패 시 부분 텍스트가 남고 메시지가 삭제되지 않음

에이전트가 직접 확인할 항목:

```bash
# 8. 자동 복구가 동작하지 않는다 — 폴링 요청이 없어야 한다
ssh rpi 'docker logs risuai 2>&1 | grep -c "gateway/recover"'
# 스트림 실패 후에도 증가하지 않아야 한다 (사용자가 버튼을 누를 때만 증가)

# 9. SSE resume은 여전히 동작한다
ssh rpi 'docker logs risuai 2>&1 | grep "Resume attach" | tail -3'

# 10·11. metadata 없이 끝난 스트림도 res.json이 생긴다
ssh rpi 'docker logs risuai 2>&1 | grep "Stream ended without metadata"'
# 이 경고가 찍힌 경우, 대응하는 res.json이 있는지 확인한다
```

- [ ] **Step 4: 결과 보고**

검증 결과를 사용자에게 보고한다. 실패한 항목은 숨기지 않고 그대로 보고한다.

---

## 자체 검토 결과

**스펙 커버리지:**

| 스펙 항목 | 담당 |
|---|---|
| 1. 수동 동기화 버튼 (위치·노출 조건) | Task 4 |
| 2. 동작 (5가지 결과 분기, 폴링 금지) | Task 1, Task 4 |
| 3. 텍스트 교체 규칙 (인덱스 지정, 후처리) | Task 2, Task 4 |
| 4. 자동 복구 제거 (3층 + registry) | Task 6 |
| 5. 실패 시 부분 텍스트 보존 | Task 5 |
| 6. 서버 res.json 저장 보장 | Task 7 |
| 검증 기준 1~7 (수동) | Task 8 |
| 검증 기준 8~11 (자동) | Task 8 |
| i18n | Task 3 |

누락 없음.

**타입 일관성:** `SyncOutcome`(Task 1)의 `kind` 값과 Task 4의 `switch` 분기가 일치한다 — `replaced`, `already-complete`, `in-progress`, `not-found`, `error`. `SyncMessageOutcome`(Task 2)의 `action`은 `replaced`/`refused`로 별개 타입이며 Task 4에서 `applied.action === 'refused'`로만 검사한다.

**순서 의존:** Task 5·6은 Task 4 이후에 실행해야 한다. 자동 복구를 먼저 지우면 버튼이 없는 상태에서 복구 수단이 사라진다.
