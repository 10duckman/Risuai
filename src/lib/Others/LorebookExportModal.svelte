<script lang="ts">
    import { language } from 'src/lang'
    import { alertError, alertNormal } from 'src/ts/alert'
    import { requestChatData, type StreamResponseChunk } from 'src/ts/process/request/request'
    import { runExport } from 'src/ts/process/lorebookExport/run'
    import { toLoreBook } from 'src/ts/process/lorebookExport/assemble'
    import { ALWAYS_ON_LIMIT } from 'src/ts/process/lorebookExport/validate'
    import { splitIntoChunks, type ChunkMessage } from 'src/ts/process/lorebookExport/chunking'
    import type { EntryDestination, ExportPreview } from 'src/ts/process/lorebookExport/types'
    import { DBState } from 'src/ts/stores.svelte'
    import { XIcon } from '@lucide/svelte'
    import { v4 } from 'uuid'

    /**
     * 응답 하나가 인물 여러 명의 슬롯(각 2,000~3,000자, design doc)을 JSON으로
     * 담을 수 있다 — 코드 기본값(300)이나 db.maxResponse로는 매 청크가 중간에
     * 잘린다(I2). translator.ts:558과 같은 이유로 명시적 값을 준다.
     * anthropic.ts:806의 8192 초과 시 128k 베타 헤더가 자동으로 붙으므로
     * 이 값을 그대로 써도 막히지 않는다.
     *
     * 처음 16,000으로 잡았다가 실측으로 올렸다. Wendy's 대화 10구간의 출력
     * 토큰이 5,113 / 5,902 / 6,570 / 7,559 / 8,954 / 9,652 / 11,686 / 12,537 /
     * 13,121 / **16,000** 이었다 — 마지막 하나가 상한에 정확히 닿아 JSON이
     * 문자열 중간에서 끊겼고(`Unterminated string at position 15905`) 그 구간의
     * Opus 호출이 통째로 낭비됐다. 상위 분포가 이미 13,000대라 16,000은 여유가
     * 없다. thinking을 켜면 사고 내용이 같은 예산을 나눠 쓰므로 더 빠듯해진다.
     */
    const EXPORT_MAX_TOKENS = 32000

    interface Props {
        charIndex: number
        chatIndex: number
        onClose: () => void
    }
    let { charIndex, chatIndex, onClose }: Props = $props()

    let stage: 'range' | 'running' | 'preview' = $state('range')
    let progress = $state({ done: 0, total: 0 })
    let merging = $state(false)
    let preview: ExportPreview | null = $state(null)
    let recentTurns = $state(0)
    /**
     * 중단 요청. 이미 보낸 요청은 취소하지 않고, 다음 청크를 시작하지 않는다.
     *
     * 긴 대화 하나가 Opus 5 호출 15회에 40분, 입력 100만 토큰 규모다(실측).
     * 이 신호가 없으면 모달을 닫아도 남은 호출이 그대로 나간다.
     */
    let cancelled = $state(false)

    // 모달을 열 때의 신원을 고정한다. 추출은 수 분이 걸리고 그 사이 채팅이
    // 삭제되면 인덱스가 앞으로 밀린다 (SideChatList/ChatList의 splice) —
    // 인덱스를 다시 쓰면 엉뚱한 채팅의 localLore에 조용히 써버린다.
    // 초기값만 잡는 것이 의도다.
    // svelte-ignore state_referenced_locally
    const pinnedCharId = DBState.db.characters[charIndex].chaId
    // 구버전 채팅은 id가 없을 수 있다. bootstrap의 assignIds가 시작 시 채워주므로
    // 실제로는 거의 없지만, 없을 때의 인덱스 폴백은 위 시나리오를 막지 못한다 —
    // 검증할 방법이 없는 폴백이다.
    // svelte-ignore state_referenced_locally
    const pinnedChatId = DBState.db.characters[charIndex].chats[chatIndex].id

    const chat = $derived(DBState.db.characters[charIndex].chats[chatIndex])
    const totalMessages = $derived(chat.message.length)

    /**
     * 그 범위가 구간 몇 개인지 미리 계산한다.
     *
     * 추정하지 않고 실제 분할기를 돌린다 — 청크 경계는 턴 수(25)와 문자
     * 수(60,000) 둘 중 먼저 걸리는 쪽이라 메시지 수만으로는 알 수 없다.
     * 실측: 구간당 Opus 5 호출 1회, 1~3분, 입력 5~6만 토큰.
     */
    function chunkCount(limit: number): number{
        return splitIntoChunks(collectMessages(limit)).length
    }

    /** 대화를 ChunkMessage로 옮긴다. 빈 메시지도 인덱스를 유지한다. */
    function collectMessages(limit: number): ChunkMessage[]{
        const all = chat.message.map((m, i) => ({
            role: m.role === 'user' ? 'user' as const : 'char' as const,
            data: m.data ?? '',
            index: i,
        }))
        return limit > 0 ? all.slice(-limit) : all
    }

    /**
     * 스트림을 끝까지 읽어 최종 텍스트를 얻는다.
     *
     * 청크는 누적값이다 — 마지막 청크의 `"0"`이 전체 응답이다 (index.svelte.ts의
     * 스트리밍 루프와 같은 규약). 이어붙이면 응답이 중복된다.
     */
    async function drainStream(stream: ReadableStream<StreamResponseChunk>): Promise<string>{
        const reader = stream.getReader()
        let text = ''
        try{
            while(true){
                const { done, value } = await reader.read()
                if(done){
                    break
                }
                if(typeof value?.['0'] === 'string'){
                    text = value['0']
                }
            }
        }
        finally{
            reader.releaseLock()
        }
        return text
    }

    /**
     * requestChatData를 runExport가 기대하는 형태로 감싼다.
     *
     * `useStreaming: false`를 줘도 streaming이 올 수 있다 — Bedrock
     * converse-stream 경로(anthropic.ts)는 이 플래그를 보지 않고 항상 게이트웨이
     * SSE 스트림을 돌려준다. 이 포크의 주 경로가 그것이라 streaming을 실패로
     * 취급하면 모든 추출이 실패한다.
     *
     * chatId(I3): 호출마다 새 v4()를 준다. anthropic.ts:591의 SSE resume은
     * `arg.chatId && lastEventId`가 있어야 동작하는데, chatId가 없으면 이
     * 포크의 12회 드롭 복구가 통째로 무력화된다. 채팅 하나가 최대 31회
     * 순차 호출(666메시지 실측)이라 끊김 노출이 크다. 실제 채팅 chatId를
     * 재사용하지 않는 이유: 그건 메시지 하나에 매핑되는 키인데, 이 추출은
     * 청크/merge 호출마다 별개의 응답이라 하나로 묶으면 게이트웨이 로그에서
     * 어느 호출의 로그인지 구분할 수 없다 — 매 호출 새 id가 맞다.
     */
    async function requestChat(prompt: string, sourceText: string): Promise<string>{
        const res = await requestChatData({
            formated: [
                { role: 'system', content: prompt },
                { role: 'user', content: sourceText },
            ],
            bias: {},
            useStreaming: false,
            noMultiGen: true,
            maxTokens: EXPORT_MAX_TOKENS,
            chatId: v4(),
        }, 'model')

        if(res.type === 'success'){
            return res.result
        }
        if(res.type === 'streaming'){
            return await drainStream(res.result)
        }
        if(res.type === 'multiline'){
            // noMultiGen으로 막았지만 형태상 가능하다. 텍스트만 이어붙인다.
            return res.result.map(([, text]) => text).join('\n')
        }
        throw new Error(`추출 요청 실패: ${res.result}`)
    }

    async function start(){
        stage = 'running'
        progress = { done: 0, total: 0 }
        merging = false
        cancelled = false
        try{
            const result = await runExport({
                messages: collectMessages(recentTurns),
                requestChat,
                onProgress: (done, total) => {
                    progress = { done, total }
                    if(done === total){
                        merging = true
                    }
                },
                isCancelled: () => cancelled,
            })
            preview = result
            stage = 'preview'
        }
        catch(e){
            alertError(String(e))
            onClose()
        }
    }

    function setDestination(i: number, d: EntryDestination){
        if(!preview) return
        preview.destinations[i] = d
        // Svelte 5 반응성: 배열 자체를 갈아준다.
        preview = { ...preview, destinations: [...preview.destinations] }
    }

    function apply(){
        if(!preview) return

        // 인덱스가 아니라 고정해둔 신원으로 다시 찾는다. 못 찾으면 아무것도
        // 쓰지 않는다 — 엉뚱한 곳에 조용히 쓰는 것이 막아야 할 결과다.
        const char = DBState.db.characters.find(c => c.chaId === pinnedCharId)
        const target = pinnedChatId
            ? char?.chats.find(c => c.id === pinnedChatId)
            : char?.chats[chatIndex]
        if(!char || !target){
            alertError(language.lorebookExportTargetGone)
            onClose()
            return
        }

        char.globalLore ??= []
        target.localLore ??= []

        let added = 0
        preview.entries.forEach((entry, i) => {
            const dest = preview!.destinations[i]
            if(dest === 'discard') return
            const lb = toLoreBook(entry)
            if(dest === 'global'){
                char.globalLore.push(lb)
            }
            else{
                target.localLore.push(lb)
            }
            added++
        })

        char.reloadKeys += 1
        alertNormal(language.lorebookExportApplied(added))
        onClose()
    }
</script>

<div class="fixed top-0 left-0 h-full w-full bg-black/50 flex items-center justify-center z-50">
    <div class="bg-darkbg rounded-md p-4 w-3xl max-w-full max-h-[85vh] flex flex-col">
        <div class="flex items-center mb-4">
            <h1 class="text-xl font-bold flex-1">{language.lorebookExport}</h1>
            <button onclick={() => { cancelled = true; onClose() }} class="text-textcolor2 hover:text-textcolor">
                <XIcon size={20} />
            </button>
        </div>

        {#if stage === 'range'}
            <span class="text-textcolor2 text-sm mb-2">{language.lorebookExportRange}</span>
            <button class="border-darkborderc border py-2 px-4 rounded-md hover:ring-2 mt-2 text-left"
                onclick={() => { recentTurns = 0; start() }}>
                {language.lorebookExportRangeAll} ({totalMessages})
                <span class="text-textcolor2 text-sm">— {language.lorebookExportEstimate(chunkCount(0))}</span>
            </button>
            {#each [30, 50, 100] as n}
                {#if n < totalMessages}
                    <button class="border-darkborderc border py-2 px-4 rounded-md hover:ring-2 mt-2 text-left"
                        onclick={() => { recentTurns = n; start() }}>
                        {language.lorebookExportRangeRecent(n)}
                        <span class="text-textcolor2 text-sm">— {language.lorebookExportEstimate(chunkCount(n))}</span>
                    </button>
                {/if}
            {/each}

        {:else if stage === 'running'}
            <span class="text-textcolor2">
                {merging ? language.lorebookExportMerging : language.lorebookExportRunning(progress.done, progress.total)}
            </span>
            <!-- 구간당 1~3분이고 전체가 40분까지 간다. 멈출 수단이 필요하다. -->
            <button class="border-darkborderc border py-2 px-4 rounded-md hover:ring-2 mt-4 text-textcolor2"
                disabled={cancelled}
                onclick={() => { cancelled = true }}>
                {cancelled ? language.lorebookExportCancelling : language.lorebookExportCancel}
            </button>

        {:else if stage === 'preview' && preview}
            {#if preview.entries.length === 0}
                <span class="text-textcolor2 mb-2">{language.lorebookExportEmpty}</span>
            {/if}
            {#if preview.alwaysOnOverflow}
                <div class="text-yellow-400 text-sm mb-3">
                    {language.lorebookExportOverflow(preview.alwaysOnChars, ALWAYS_ON_LIMIT)}
                </div>
            {/if}
            <div class="flex-1 overflow-y-auto">
                {#if preview.entries.length > 0}
                    {#each preview.entries as entry, i}
                        <div class="border-darkborderc border rounded-md p-3 mb-2">
                            <div class="flex items-center mb-2">
                                <span class="font-bold flex-1">{entry.comment}</span>
                                <span class="text-textcolor2 text-xs">
                                    {language.lorebookExportCategory[entry.category]} · {language.lorebookExportChars(entry.content.length)}
                                    {entry.alwaysActive ? ` · ${language.lorebookExportAlwaysOn}` : ''}
                                </span>
                            </div>
                            <pre class="text-xs text-textcolor2 whitespace-pre-wrap max-h-32 overflow-y-auto mb-2">{entry.content}</pre>
                            <div class="flex gap-2">
                                {#each [['global', language.lorebookExportToGlobal], ['local', language.lorebookExportToLocal], ['discard', language.lorebookExportDiscard]] as [value, label]}
                                    <button
                                        class="text-xs px-2 py-1 rounded border {preview.destinations[i] === value ? 'border-blue-500 text-blue-400' : 'border-darkborderc text-textcolor2'}"
                                        onclick={() => setDestination(i, value as EntryDestination)}>
                                        {label}
                                    </button>
                                {/each}
                            </div>
                        </div>
                    {/each}
                {/if}

                <!-- 항목이 하나도 안 남았을 때가 이 목록이 가장 필요한 순간이다 —
                     조연이 얇았던 것과 검증 버그를 구별할 유일한 단서다. -->
                {#if preview.dropped.length > 0}
                    <details class="mt-3" open={preview.entries.length === 0}>
                        <summary class="text-textcolor2 text-sm cursor-pointer">
                            {language.lorebookExportDropped} ({preview.dropped.length})
                        </summary>
                        <ul class="text-xs text-textcolor2 mt-2">
                            {#each preview.dropped as d}
                                <li>{d.what} — {d.why}</li>
                            {/each}
                        </ul>
                    </details>
                {/if}
            </div>
            {#if preview.entries.length > 0}
                <button class="border-darkborderc border py-2 px-4 rounded-md hover:ring-2 mt-3" onclick={apply}>
                    {language.lorebookExportApply}
                </button>
            {/if}
        {/if}
    </div>
</div>
