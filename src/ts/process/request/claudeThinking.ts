/**
 * Claude thinking 모드 결정 로직.
 *
 * Claude 5.0(Opus 5 / Sonnet 5)부터 `thinking`을 생략하면 adaptive로 동작한다.
 * 4.8 이하는 생략 = thinking 없음이었으므로, 유저가 Off를 골랐을 때
 * `delete body.thinking`만 하면 5.0에서는 오히려 thinking이 켜진 채 돈다.
 * 5.0 모델에는 `{type:'disabled'}`를 명시해야 실제로 꺼진다.
 *
 * 주의: Opus 5는 disabled와 effort `xhigh`/`max` 조합을 400으로 거절하므로
 * off 경로에서는 `output_config`를 붙이지 않는다.
 */

import { LLMFlags } from '../../model/types'

export interface ClaudeThinkingSettings{
    thinkingType?: string
    adaptiveThinkingEffort?: string
}

/**
 * `body`를 제자리에서 수정한다. `applyParameters`가 이미 채워둔
 * `thinking.budget_tokens`를 읽으므로 그 뒤에 호출해야 한다.
 */
export function applyClaudeThinking(
    body:any,
    settings:ClaudeThinkingSettings,
    flags:readonly number[],
):void{
    const thinkingOnByDefault = flags.includes(LLMFlags.claudeThinkingOnByDefault)

    // 생략만으로는 꺼지지 않는 모델을 위해 명시적으로 끈다.
    const disableThinking = () => {
        delete body.thinking
        if(thinkingOnByDefault){
            body.thinking = { type: 'disabled' }
        }
    }

    if(settings.thinkingType === 'off'){
        disableThinking()
        return
    }

    if(settings.thinkingType === 'adaptive' && flags.includes(LLMFlags.claudeAdaptiveThinking)){
        delete body.thinking
        body.thinking = { type: 'adaptive' }
        body.output_config = { effort: settings.adaptiveThinkingEffort ?? 'high' }
        return
    }

    if(body?.thinking?.budget_tokens === 0 || body?.thinking?.budget_tokens === null){
        disableThinking()
        return
    }

    if(body?.thinking?.budget_tokens && body.thinking.budget_tokens > 0){
        body.thinking.type = 'enabled'
    }
}
