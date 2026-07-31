/**
 * 수동 메시지 동기화의 텍스트 교체 로직.
 *
 * 서버(`/gateway/recover`)는 Bedrock 응답을 메모리 버퍼(30분)와
 * `gateway-logs/*_res.json`(무기한)에 들고 있다. 사용자가 메시지 메뉴에서
 * 동기화를 누르면 그 응답을 가져와 이 함수로 반영한다.
 *
 * DOM과 DBState를 모르는 순수 로직만 담는다 — 그래서 유닛 테스트가 가능하다.
 */

export interface RecoverableMessage{
    role: 'user' | 'char'
    data: string
    chatId?: string
    [key: string]: unknown
}

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
