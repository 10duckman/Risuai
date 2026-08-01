<script lang="ts">
    import { language } from 'src/lang'
    import { alertError, alertNormal } from 'src/ts/alert'
    import { requestChatData, type StreamResponseChunk } from 'src/ts/process/request/request'
    import { runExport } from 'src/ts/process/lorebookExport/run'
    import { toLoreBook } from 'src/ts/process/lorebookExport/assemble'
    import { ALWAYS_ON_LIMIT } from 'src/ts/process/lorebookExport/validate'
    import type { ChunkMessage } from 'src/ts/process/lorebookExport/chunking'
    import type { EntryDestination, ExportPreview } from 'src/ts/process/lorebookExport/types'
    import { DBState } from 'src/ts/stores.svelte'
    import { XIcon } from '@lucide/svelte'

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

    const chat = $derived(DBState.db.characters[charIndex].chats[chatIndex])
    const totalMessages = $derived(chat.message.length)

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
        const char = DBState.db.characters[charIndex]
        const target = char.chats[chatIndex]
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

        DBState.db.characters[charIndex].reloadKeys += 1
        alertNormal(language.lorebookExportApplied(added))
        onClose()
    }
</script>

<div class="fixed top-0 left-0 h-full w-full bg-black/50 flex items-center justify-center z-50">
    <div class="bg-darkbg rounded-md p-4 w-3xl max-w-full max-h-[85vh] flex flex-col">
        <div class="flex items-center mb-4">
            <h1 class="text-xl font-bold flex-1">{language.lorebookExport}</h1>
            <button onclick={onClose} class="text-textcolor2 hover:text-textcolor">
                <XIcon size={20} />
            </button>
        </div>

        {#if stage === 'range'}
            <span class="text-textcolor2 text-sm mb-2">{language.lorebookExportRange}</span>
            <button class="border-darkborderc border py-2 px-4 rounded-md hover:ring-2 mt-2 text-left"
                onclick={() => { recentTurns = 0; start() }}>
                {language.lorebookExportRangeAll} ({totalMessages})
            </button>
            {#each [30, 50, 100] as n}
                {#if n < totalMessages}
                    <button class="border-darkborderc border py-2 px-4 rounded-md hover:ring-2 mt-2 text-left"
                        onclick={() => { recentTurns = n; start() }}>
                        {language.lorebookExportRangeRecent(n)}
                    </button>
                {/if}
            {/each}

        {:else if stage === 'running'}
            <span class="text-textcolor2">
                {merging ? language.lorebookExportMerging : language.lorebookExportRunning(progress.done, progress.total)}
            </span>

        {:else if stage === 'preview' && preview}
            {#if preview.entries.length === 0}
                <span class="text-textcolor2">{language.lorebookExportEmpty}</span>
            {:else}
                {#if preview.alwaysOnOverflow}
                    <div class="text-yellow-400 text-sm mb-3">
                        {language.lorebookExportOverflow(preview.alwaysOnChars, ALWAYS_ON_LIMIT)}
                    </div>
                {/if}
                <div class="flex-1 overflow-y-auto">
                    {#each preview.entries as entry, i}
                        <div class="border-darkborderc border rounded-md p-3 mb-2">
                            <div class="flex items-center mb-2">
                                <span class="font-bold flex-1">{entry.comment}</span>
                                <span class="text-textcolor2 text-xs">
                                    {entry.category} · {entry.content.length}자
                                    {entry.alwaysActive ? ' · always-on' : ''}
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

                    {#if preview.dropped.length > 0}
                        <details class="mt-3">
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
                <button class="border-darkborderc border py-2 px-4 rounded-md hover:ring-2 mt-3" onclick={apply}>
                    {language.lorebookExportApply}
                </button>
            {/if}
        {/if}
    </div>
</div>
