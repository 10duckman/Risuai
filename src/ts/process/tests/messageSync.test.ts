import { describe, expect, it } from 'vitest'

import { classifySyncResult } from '../messageSync'

describe('classifySyncResult', () => {
    it('서버 텍스트가 더 길면 replaced로 분류한다', () => {
        // 실측 사고: 12,393자 중 7,487자만 받았다.
        const outcome = classifySyncResult(
            { ok: true, status: 200, responseText: 'a'.repeat(12393), done: true },
            'a'.repeat(7487),
        )

        expect(outcome).toEqual({
            kind: 'replaced',
            text: 'a'.repeat(12393),
            from: 7487,
            to: 12393,
        })
    })

    it('길이가 같으면 already-complete로 분류한다', () => {
        const outcome = classifySyncResult(
            { ok: true, status: 200, responseText: 'same text', done: true },
            'same text',
        )

        expect(outcome).toEqual({ kind: 'already-complete', length: 9 })
    })

    it('기존 텍스트가 더 길면 already-complete로 분류한다', () => {
        // 후처리 스크립트가 텍스트를 늘렸을 수 있다 — 회귀시키지 않는다.
        const outcome = classifySyncResult(
            { ok: true, status: 200, responseText: 'short', done: true },
            'much longer after post-processing',
        )

        expect(outcome).toEqual({ kind: 'already-complete', length: 33 })
    })

    it('서버가 아직 생성 중이면 in-progress로 분류한다', () => {
        const outcome = classifySyncResult(
            { ok: true, status: 200, responseText: 'partial', done: false },
            'part',
        )

        expect(outcome).toEqual({ kind: 'in-progress', length: 7 })
    })

    it('생성 중이면서 기존이 더 길어도 in-progress로 분류한다', () => {
        // done이 아니면 교체하지 않는다. 사용자가 다시 누르게 안내한다.
        const outcome = classifySyncResult(
            { ok: true, status: 200, responseText: 'ab', done: false },
            'abcdef',
        )

        expect(outcome).toEqual({ kind: 'in-progress', length: 2 })
    })

    it('404는 not-found로 분류한다', () => {
        const outcome = classifySyncResult({ ok: false, status: 404 }, 'partial')

        expect(outcome).toEqual({ kind: 'not-found' })
    })

    it('그 외 오류는 error로 분류한다', () => {
        const outcome = classifySyncResult({ ok: false, status: 500 }, 'partial')

        expect(outcome).toEqual({ kind: 'error', status: 500 })
    })

    it('done이지만 텍스트가 비어 있으면 not-found로 분류한다', () => {
        // 서버 기록이 껍데기만 있는 경우 — 적용할 것이 없다.
        const outcome = classifySyncResult(
            { ok: true, status: 200, responseText: '', done: true },
            'partial',
        )

        expect(outcome).toEqual({ kind: 'not-found' })
    })

    it('responseText가 undefined여도 던지지 않는다', () => {
        const outcome = classifySyncResult({ ok: true, status: 200, done: true }, 'partial')

        expect(outcome).toEqual({ kind: 'not-found' })
    })
})
