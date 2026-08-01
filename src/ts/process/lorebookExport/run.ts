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
import type { ChunkResult, DroppedItem, ExportPreview, MergeResult } from './types'

/** (프롬프트, 원문) → 모델 응답 텍스트. */
export type RequestChatFn = (prompt: string, sourceText: string) => Promise<string>

export interface RunOptions{
    messages: ChunkMessage[]
    requestChat: RequestChatFn
    onProgress?: (done: number, total: number) => void
    targetTurns?: number
}

/** 코드블록으로 감싼 JSON도 파싱한다. 모델이 종종 그렇게 낸다. */
function parseJson<T>(text: string): T | null{
    const stripped = text.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')
    try{
        return JSON.parse(stripped) as T
    }
    catch(e){
        return null
    }
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

    for(let i = 0; i < chunks.length; i++){
        const chunk = chunks[i]
        const raw = await opts.requestChat(CHUNK_PROMPT, chunk.text)
        const parsed = parseJson<ChunkResult>(raw)

        if(!parsed){
            // 청크 하나가 깨져도 전체를 포기하지 않는다.
            dropped.push({
                what: `청크 ${chunk.startIndex}~${chunk.endIndex}`,
                why: 'JSON 파싱 실패',
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
    if(collected.length === 0){
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

    return buildPreview({
        entries: merged.entries,
        dropped: [...dropped, ...(merged.dropped ?? [])],
    })
}
