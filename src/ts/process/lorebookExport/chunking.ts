/**
 * 대화를 추출 단위로 나눈다.
 *
 * 청크 크기는 두 가지로 제한한다: 턴 수(기본 25)와 문자 수(기본 60,000).
 * 문자 수 제한이 필요한 이유는 메시지 길이가 고르지 않아서다 — 실측으로
 * 웬디스 대화의 assistant 메시지가 6,000~20,000자 사이를 오간다.
 */

const DEFAULT_TARGET_TURNS = 25
const DEFAULT_MAX_CHARS = 60000

export interface ChunkMessage {
    role: 'user' | 'char'
    data: string
    /** 원본 message 배열에서의 인덱스. fact의 msg 필드가 이것을 가리킨다. */
    index: number
}

export interface Chunk {
    messages: ChunkMessage[]
    startIndex: number
    endIndex: number
    /** LLM에 넘길 텍스트. 인덱스와 역할이 붙는다. */
    text: string
}

/** 청크 하나의 텍스트를 만든다. `[12] char: ...` 형태. */
function renderChunk(messages: ChunkMessage[]): string {
    return messages.map(m => `[${m.index}] ${m.role}: ${m.data}`).join('\n\n')
}

export function splitIntoChunks(
    messages: ChunkMessage[],
    opts: { targetTurns?: number; maxChars?: number } = {},
): Chunk[] {
    const targetTurns = opts.targetTurns ?? DEFAULT_TARGET_TURNS
    const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS

    const chunks: Chunk[] = []
    let current: ChunkMessage[] = []
    let currentChars = 0

    const flush = () => {
        if (current.length === 0) {
            return
        }
        chunks.push({
            messages: current,
            startIndex: current[0].index,
            endIndex: current[current.length - 1].index,
            text: renderChunk(current),
        })
        current = []
        currentChars = 0
    }

    for (const m of messages) {
        const cost = m.data.length
        // 이미 담은 게 있고, 하나 더 넣으면 상한을 넘는다면 먼저 끊는다.
        if (current.length > 0 && (current.length >= targetTurns || currentChars + cost > maxChars)) {
            flush()
        }
        current.push(m)
        currentChars += cost
    }
    flush()

    return chunks
}
