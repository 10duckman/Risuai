<script lang="ts">
    import { language } from 'src/lang';
    import { DBState } from 'src/ts/stores.svelte';
    import { getModelInfo } from 'src/ts/model/modellist';
    import { LLMFlags } from 'src/ts/model/types';
    import SliderInput from 'src/lib/UI/GUI/SliderInput.svelte';
    import SelectInput from 'src/lib/UI/GUI/SelectInput.svelte';
    import OptionInput from 'src/lib/UI/GUI/OptionInput.svelte';
    import type { SeparateParameters } from 'src/ts/storage/database.svelte';

    type AuxModelKey = keyof typeof DBState.db.seperateModels

    let {
        value = $bindable(),
        paramKey,
    }:{
        value: SeparateParameters
        paramKey?: string
    } = $props()

    const auxModelKeys: AuxModelKey[] = ['memory', 'emotion', 'translate', 'otherAx']

    let effectiveModel = $derived.by(() => {
        if (!paramKey) return DBState.db.subModel
        if (auxModelKeys.includes(paramKey as AuxModelKey)) {
            if (DBState.db.seperateModelsForAxModels) {
                return DBState.db.seperateModels[paramKey as AuxModelKey] || DBState.db.subModel
            }
            return DBState.db.subModel
        }
        return paramKey
    })
    let modelInfo = $derived(getModelInfo(effectiveModel))

    let hasXHighEffort = $derived(modelInfo.flags.includes(LLMFlags.claudeXHighEffort))
    let hasAdaptive = $derived(modelInfo.flags.includes(LLMFlags.claudeAdaptiveThinking))
    let hasBudget = $derived(modelInfo.flags.includes(LLMFlags.claudeThinking))

    let adaptiveThinkingEffortOptions = $derived([
        { value: 'low', label: 'Low' },
        { value: 'medium', label: 'Medium' },
        { value: 'high', label: 'High' },
        ...(hasXHighEffort ? [{ value: 'xhigh', label: 'XHigh' }] : []),
        { value: 'max', label: 'Max' },
    ])

    $effect(() => {
        if (value.adaptive_thinking_effort === 'xhigh' && !hasXHighEffort) {
            value.adaptive_thinking_effort = 'high'
        }
        // Demote stale adaptive selection when the model no longer supports it
        // (e.g. switched from 4.7 → 4.6). Falls back to budget when available.
        if (value.thinking_type === 'adaptive' && !hasAdaptive) {
            value.thinking_type = hasBudget ? 'budget' : 'off'
        }
    })
</script>

<span class="text-textcolor">{language.thinkingType ?? 'Thinking Mode'}</span>
<SelectInput bind:value={value.thinking_type}>
    <OptionInput value="off">Off</OptionInput>
    {#if hasBudget}
        <OptionInput value="budget">Budget (Manual Tokens)</OptionInput>
    {/if}
    {#if hasAdaptive}
        <OptionInput value="adaptive">Adaptive</OptionInput>
    {/if}
</SelectInput>
{#if value.thinking_type === 'budget'}
    <span class="text-textcolor">{language.thinkingTokens}</span>
    <SliderInput min={0} max={64000} marginBottom step={200} fixed={0} bind:value={value.thinking_tokens} disableable/>
{/if}
{#if value.thinking_type === 'adaptive'}
    <span class="text-textcolor">{language.adaptiveThinkingEffort ?? 'Adaptive Thinking Effort'}</span>
    <SelectInput bind:value={value.adaptive_thinking_effort}>
        {#each adaptiveThinkingEffortOptions as option}
            <OptionInput value={option.value}>{option.label}</OptionInput>
        {/each}
    </SelectInput>
{/if}
{#if value.deepseek_thinking_type !== undefined}
    <span class="text-textcolor">DeepSeek Thinking Mode</span>
    <SelectInput bind:value={value.deepseek_thinking_type}>
        <OptionInput value="off">Off</OptionInput>
        <OptionInput value="enabled">Enabled</OptionInput>
    </SelectInput>
{/if}
{#if value.deepseek_thinking_type === 'enabled'}
    <span class="text-textcolor">DeepSeek Reasoning Effort</span>
    <SelectInput bind:value={value.deepseek_reasoning_effort}>
        <OptionInput value="high">High</OptionInput>
        <OptionInput value="max">Max</OptionInput>
    </SelectInput>
{/if}
