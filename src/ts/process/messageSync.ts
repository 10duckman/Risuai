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
