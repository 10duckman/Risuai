/**
 * 추출 오케스트레이션.
 *
 * LLM 호출은 주입받는다 (`requestChat`) — 그래야 테스트에서 실제 모델 없이
 * 전체 흐름을 검증할 수 있다. 실제 호출은 UI 쪽에서 requestChatData로 감싼다.
 */

import { splitIntoChunks, type ChunkMessage } from './chunking'
import { CHUNK_PROMPT, MERGE_PROMPT } from './prompts'
import { validateChunkResult } from './validate'
import { buildPreview } from './assemble'
import { EVALUATIVE_DENYLIST } from './validate'
import { jsonOutputTrimmer } from 'src/ts/util/jsonOutputTrimmer'
import type { ChunkResult, DroppedItem, ExportPreview, MergeResult, MergedEntry } from './types'

/** (프롬프트, 원문) → 모델 응답 텍스트. */
export type RequestChatFn = (prompt: string, sourceText: string) => Promise<string>

export interface RunOptions{
    messages: ChunkMessage[]
    requestChat: RequestChatFn
    onProgress?: (done: number, total: number) => void
    targetTurns?: number
    /**
     * true를 돌려주면 다음 청크를 시작하지 않고 지금까지 모은 것으로 끝낸다.
     *
     * 실측으로 필요해졌다: 긴 대화 하나가 15청크 × Opus 5 호출이고 40분,
     * 입력 100만 토큰 규모다. 모달을 닫아도 이 루프는 계속 돌아 남은 호출이
     * 그대로 나갔다 — 사용자가 멈출 방법이 없었다.
     *
     * 이미 보낸 요청은 취소하지 않는다(게이트웨이가 응답을 기록해야 한다).
     * 다음 요청을 보내지 않는 것까지가 이 신호의 범위다.
     */
    isCancelled?: () => boolean
}

/**
 * 코드블록으로 감싼 JSON, 그리고 그 앞에 붙는 `<Thoughts>` 블록을 걷어내고
 * 파싱한다. thinking이 켜진 모델(Opus 5 Bedrock 기본값)은 응답을
 * `<Thoughts>...</Thoughts>`로 시작하므로, 이걸 벗기지 않으면 모든 청크가
 * JSON.parse에서 깨진다. jsonOutputTrimmer(원래 util.ts:1213, 이제
 * src/ts/util/jsonOutputTrimmer.ts로 분리된 leaf 모듈)에 위임한다 — util.ts는
 * DBState/Tauri/Svelte 컴포넌트를 끌어오는 무거운 모듈이라 그대로 import하면
 * DOM/DBState 없이 도는 이 모듈의 vitest가 $effect 컨텍스트 밖에서 깨진다.
 */
function parseJson<T>(text: string): T | null{
    const stripped = jsonOutputTrimmer(text)
    try{
        return JSON.parse(stripped) as T
    }
    catch(e){
        return null
    }
}

/**
 * 파싱 실패가 길이 상한 때문인지 짚는다.
 *
 * 잘린 JSON은 여는 괄호가 닫는 괄호보다 많다. 문법이 틀려서 깨진 것과 대처가
 * 다르다 — 잘림은 maxTokens를 올리거나 구간을 줄여야 하고, 문법 오류는
 * 프롬프트를 봐야 한다. 정확한 판정이 목적이 아니라 사용자에게 방향을
 * 알려주는 것이 목적이므로 괄호 수만 센다. 문자열 안의 괄호까지 제외하려면
 * 파서를 다시 쓰는 셈이고, 오판해도 결과는 "파싱 실패"로 같다.
 */
function looksTruncated(raw: string): boolean{
    const open = (raw.match(/[{[]/g) ?? []).length
    const close = (raw.match(/[}\]]/g) ?? []).length
    return open > close
}

/**
 * 파싱된 청크 응답이 ChunkResult 모양인지 확인한다.
 *
 * JSON.parse는 성공하지만 `{"error":"..."}`나 `[]`처럼 스키마와 무관한
 * 값도 통과시킨다 — truthy 검사만으로는 이런 응답이 collected에도
 * dropped에도 들어가지 않고 조용히 사라진다.
 */
function isChunkResultShape(value: unknown): value is ChunkResult{
    if(!value || typeof value !== 'object' || Array.isArray(value)){
        return false
    }
    const v = value as Record<string, unknown>
    return Array.isArray(v.people) || Array.isArray(v.places)
        || Array.isArray(v.state) || Array.isArray(v.objects)
}

export async function runExport(opts: RunOptions): Promise<ExportPreview>{
    const chunks = splitIntoChunks(opts.messages, { targetTurns: opts.targetTurns })
    if(chunks.length === 0){
        return buildPreview({ entries: [], dropped: [] })
    }

    const collected: ChunkResult[] = []
    const dropped: DroppedItem[] = []

    // 루프에 들어가기 전에 총 개수를 먼저 알린다. 청크 하나에 2~3분이 걸리므로
    // (실측: 입력 6만 토큰, 출력 1만 토큰) 첫 응답을 기다리는 동안 진행 표시가
    // "0/0"으로 남아 멈춘 것처럼 보인다.
    opts.onProgress?.(0, chunks.length)

    let cancelled = false
    for(let i = 0; i < chunks.length; i++){
        if(opts.isCancelled?.()){
            // 지금까지 모은 것으로 끝낸다. 이미 쓴 호출을 버리지 않는다.
            cancelled = true
            dropped.push({
                what: `청크 ${i + 1}~${chunks.length}`,
                why: '사용자가 중단',
            })
            break
        }
        const chunk = chunks[i]
        const raw = await opts.requestChat(CHUNK_PROMPT, chunk.text)
        const parsed = parseJson<ChunkResult>(raw)

        if(!parsed){
            // 청크 하나가 깨져도 전체를 포기하지 않는다.
            // 잘림은 원인이 다르고 대처도 다르므로 구분해서 알린다 — 실측에서
            // 10구간 중 하나가 maxTokens 상한에 닿아 문자열 중간에서 끊겼다.
            dropped.push({
                what: `청크 ${chunk.startIndex}~${chunk.endIndex}`,
                why: looksTruncated(raw) ? '응답이 중간에 끊김 (길이 상한)' : 'JSON 파싱 실패',
            })
        }
        else if(!isChunkResultShape(parsed)){
            // JSON은 파싱됐지만 스키마와 다른 형태 — 파싱 실패와는 구분해서 남긴다.
            dropped.push({
                what: `청크 ${chunk.startIndex}~${chunk.endIndex}`,
                why: '예상과 다른 형태',
            })
        }
        else{
            const checked = validateChunkResult(parsed, chunk.text)
            collected.push(checked.result)
            dropped.push(...checked.dropped)
        }

        opts.onProgress?.(i + 1, chunks.length)
    }

    // 살아남은 청크가 하나도 없으면 merge를 부를 이유가 없다 — 합칠 재료가
    // 없는데 모델 호출 하나를 더 쓰고, 그 응답을 무조건 신뢰하게 된다.
    //
    // 중단했을 때도 merge를 부르지 않는다. 중단은 "호출을 더 쓰지 말라"는
    // 뜻이고, merge는 입력이 가장 큰 호출이다 (청크 결과 전체가 입력).
    if(collected.length === 0 || cancelled){
        return buildPreview({ entries: [], dropped })
    }

    const mergeInput = JSON.stringify(collected)
    const mergeRaw = await opts.requestChat(MERGE_PROMPT, mergeInput)
    const merged = parseJson<MergeResult>(mergeRaw)
    if(!merged || !Array.isArray(merged.entries)){
        // 디버깅에 필요한 최소 정보 — 응답 길이와 앞부분 일부. 한 줄로 유지해
        // alert 다이얼로그에서도 읽힌다.
        const excerpt = mergeRaw.slice(0, 200)
        throw new Error(`merge 응답을 파싱할 수 없습니다 (길이 ${mergeRaw.length}자): ${excerpt}`)
    }

    // C2/M5: chunk 단계의 fact 검증은 chunk 원문에서만 돌았다 — merge 모델이
    // content를 새로 쓰면서 그 검증을 우회해 평가어를 다시 끼워넣거나(C2)
    // content 자체를 빼먹을(M5) 수 있다. 출하되는 것은 content이므로 그것을
    // 다시 검사한다. 평가어 매치는 하나라도 있으면 항목 전체를 버린다 —
    // "요약이 아니라 사실"이 이 기능의 존재 이유이므로(design doc) 부분
    // 오염을 허용하지 않는다.
    const finalDropped = [...dropped, ...(merged.dropped ?? [])]
    const entries: MergedEntry[] = []
    for(const entry of merged.entries){
        if(!entry.content){
            finalDropped.push({ what: `항목: ${entry.comment}`, why: 'content 없음' })
            continue
        }
        const match = entry.content.match(EVALUATIVE_DENYLIST)
        if(match){
            finalDropped.push({ what: `항목: ${entry.comment}`, why: `평가어 포함 ("${match[0]}")` })
            continue
        }
        entries.push(entry)
    }

    return buildPreview({ entries, dropped: finalDropped })
}
