/**
 * LLM 응답에서 <Thoughts> 블록과 코드펜스를 벗겨내고 순수 JSON 텍스트만 남긴다.
 *
 * util.ts에서 분리한 이유: util.ts는 DBState/Tauri 플러그인/Svelte 컴포넌트를
 * 끌어오는 무거운 모듈이라, DOM과 DBState를 모르는 소비자(예: lorebookExport의
 * run.ts)가 이 함수 하나만 쓰려고 import하면 vitest의 $effect 컨텍스트 밖에서
 * 터진다. 순수 함수만 담은 leaf 모듈로 옮겨 양쪽이 그대로 import할 수 있게 한다.
 */
export function jsonOutputTrimmer(data: string): string{
    data = data.replace(/<Thoughts>(.+?)<\/Thoughts>/gms, '').trim()
    // ```json ... ``` 와 언어 태그 없는 ``` ... ``` 모두 벗긴다.
    data = data.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')
    return data.trim()
}
