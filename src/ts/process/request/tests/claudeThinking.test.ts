import { describe, expect, it } from 'vitest'

import { applyClaudeThinking } from '../claudeThinking'
import { LLMFlags } from '../../../model/types'

const ADAPTIVE = [LLMFlags.claudeAdaptiveThinking]
const ADAPTIVE_DEFAULT_ON = [LLMFlags.claudeAdaptiveThinking, LLMFlags.claudeThinkingOnByDefault]
const BUDGET = [LLMFlags.claudeThinking]

describe('applyClaudeThinking', () => {
    describe("thinkingType 'off'", () => {
        it('4.8 이하에서는 thinking을 빼기만 한다 (생략 = off)', () => {
            const body:any = { thinking: { budget_tokens: 8000 } }

            applyClaudeThinking(body, { thinkingType: 'off' }, ADAPTIVE)

            expect(body.thinking).toBeUndefined()
            expect(body.output_config).toBeUndefined()
        })

        it('5.0에서는 disabled를 명시한다 (생략하면 adaptive로 돌아감)', () => {
            const body:any = { thinking: { budget_tokens: 8000 } }

            applyClaudeThinking(body, { thinkingType: 'off' }, ADAPTIVE_DEFAULT_ON)

            expect(body.thinking).toEqual({ type: 'disabled' })
        })

        it('5.0에서 off일 때 effort를 보내지 않는다', () => {
            // Opus 5는 disabled + xhigh/max 조합을 400으로 거절한다.
            const body:any = {}

            applyClaudeThinking(body, { thinkingType: 'off', adaptiveThinkingEffort: 'xhigh' }, ADAPTIVE_DEFAULT_ON)

            expect(body.thinking).toEqual({ type: 'disabled' })
            expect(body.output_config).toBeUndefined()
        })
    })

    describe("thinkingType 'adaptive'", () => {
        it('adaptive와 effort를 설정한다', () => {
            const body:any = { thinking: { budget_tokens: 8000 } }

            applyClaudeThinking(body, { thinkingType: 'adaptive', adaptiveThinkingEffort: 'xhigh' }, ADAPTIVE)

            expect(body.thinking).toEqual({ type: 'adaptive' })
            expect(body.output_config).toEqual({ effort: 'xhigh' })
        })

        it('effort 미설정 시 high로 기본값을 준다', () => {
            const body:any = {}

            applyClaudeThinking(body, { thinkingType: 'adaptive' }, ADAPTIVE)

            expect(body.output_config).toEqual({ effort: 'high' })
        })

        it('adaptive 미지원 모델은 budget 경로로 폴백한다', () => {
            const body:any = { thinking: { budget_tokens: 8000 } }

            applyClaudeThinking(body, { thinkingType: 'adaptive' }, BUDGET)

            expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 8000 })
            expect(body.output_config).toBeUndefined()
        })
    })

    describe("thinkingType 'budget'", () => {
        it('양수 budget은 enabled로 바꾼다', () => {
            const body:any = { thinking: { budget_tokens: 8000 } }

            applyClaudeThinking(body, { thinkingType: 'budget' }, BUDGET)

            expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 8000 })
        })

        it('budget 0이면 thinking을 뺀다', () => {
            const body:any = { thinking: { budget_tokens: 0 } }

            applyClaudeThinking(body, { thinkingType: 'budget' }, BUDGET)

            expect(body.thinking).toBeUndefined()
        })

        it('budget null이면 thinking을 뺀다', () => {
            const body:any = { thinking: { budget_tokens: null } }

            applyClaudeThinking(body, { thinkingType: 'budget' }, BUDGET)

            expect(body.thinking).toBeUndefined()
        })

        it('5.0에서 budget 0이면 disabled를 명시한다', () => {
            // 5.0은 budget_tokens를 아예 거절하지만, 프리셋을 옮겨온 유저가
            // budget 모드로 남아있을 수 있다. thinking이 켜지는 것보다
            // disabled가 유저 의도에 가깝다.
            const body:any = { thinking: { budget_tokens: 0 } }

            applyClaudeThinking(body, { thinkingType: 'budget' }, ADAPTIVE_DEFAULT_ON)

            expect(body.thinking).toEqual({ type: 'disabled' })
        })
    })
})
