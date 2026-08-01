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
        else{
            const checked = validateChunkResult(parsed, chunk.text)
            collected.push(checked.result)
            dropped.push(...checked.dropped)
        }

        opts.onProgress?.(i + 1, chunks.length)
    }

    const mergeInput = JSON.stringify(collected)
    const mergeRaw = await opts.requestChat(MERGE_PROMPT, mergeInput)
    const merged = parseJson<MergeResult>(mergeRaw)
    if(!merged){
        throw new Error('merge 응답을 파싱할 수 없습니다')
    }

    return buildPreview({
        entries: merged.entries ?? [],
        dropped: [...dropped, ...(merged.dropped ?? [])],
    })
}
