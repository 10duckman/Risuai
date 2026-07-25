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
