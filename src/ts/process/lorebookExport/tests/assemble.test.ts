import { describe, expect, it } from 'vitest'

import { buildPreview, defaultDestination, INSERT_ORDER, toLoreBook } from '../assemble'
import type { MergedEntry } from '../types'

const entry = (o: Partial<MergedEntry> = {}): MergedEntry => ({
    comment: '김만세',
    content: '### 김만세\n- Identity: 41세. 자칭 화가.',
    key: '',
    secondkey: '',
    insertorder: 100,
    mode: 'normal',
    alwaysActive: true,
    selective: false,
    useRegex: false,
    category: 'person',
    ...o,
})

describe('toLoreBook', () => {
    it('MergedEntry를 loreBook 필드로 변환한다', () => {
        const lb = toLoreBook(entry())

        expect(lb.comment).toBe('김만세')
        expect(lb.content).toContain('41세')
        expect(lb.key).toBe('')
        expect(lb.alwaysActive).toBe(true)
        expect(lb.mode).toBe('normal')
        expect(lb.insertorder).toBe(100)
        expect(lb.selective).toBe(false)
        expect(lb.useRegex).toBe(false)
    })

    it('category는 loreBook에 넘기지 않는다', () => {
        // category는 미리보기 분류용이고 RisuAI 타입에는 없다.
        const lb = toLoreBook(entry()) as Record<string, unknown>

        expect('category' in lb).toBe(false)
    })

    it('bookVersion 2를 붙인다', () => {
        // 실물 로어북이 bookVersion: 2다.
        const lb = toLoreBook(entry())

        expect(lb.bookVersion).toBe(2)
    })

    it('사물은 key를 유지한다', () => {
        const lb = toLoreBook(entry({
            category: 'object', key: '반지,결혼반지', alwaysActive: false, insertorder: 50,
        }))

        expect(lb.key).toBe('반지,결혼반지')
        expect(lb.alwaysActive).toBe(false)
    })

    it('M1: 잘못된 insertorder를 category 기준값으로 덮어쓴다', () => {
        // merge가 0처럼 틀린 insertorder를 보내도, person/place/state/object의
        // 레이어링 순서(INSERT_ORDER)를 강제해야 한다. 고치기 전에는
        // entry.insertorder를 그대로 복사했으므로 이 값(0)이 그대로 나가
        // 이 테스트가 실패한다.
        const lb = toLoreBook(entry({ category: 'person', insertorder: 0 }))

        expect(lb.insertorder).toBe(INSERT_ORDER.person)
        expect(lb.insertorder).not.toBe(0)
    })
})

describe('defaultDestination', () => {
    it('인물과 장소는 캐릭터 로어북이 기본이다', () => {
        // 캐릭터의 모든 채팅에서 유효하다.
        expect(defaultDestination('person')).toBe('global')
        expect(defaultDestination('place')).toBe('global')
    })

    it('관계 상태는 채팅 로어북이 기본이다', () => {
        // 이 채팅에서만 유효하다. 다른 채팅은 다른 관계다.
        expect(defaultDestination('state')).toBe('local')
    })

    it('사물은 채팅 로어북이 기본이다', () => {
        expect(defaultDestination('object')).toBe('local')
    })
})

describe('buildPreview', () => {
    it('항목마다 기본 목적지를 정한다', () => {
        const preview = buildPreview({
            entries: [
                entry({ category: 'person' }),
                entry({ category: 'state', comment: '관계' }),
            ],
            dropped: [],
        })

        expect(preview.destinations).toEqual(['global', 'local'])
    })

    it('always-on 총량을 계산한다', () => {
        const preview = buildPreview({
            entries: [
                entry({ content: 'x'.repeat(3000), alwaysActive: true }),
                entry({ content: 'y'.repeat(1000), alwaysActive: false }),
            ],
            dropped: [],
        })

        expect(preview.alwaysOnChars).toBe(3000)
        expect(preview.alwaysOnOverflow).toBe(false)
    })

    it('상한을 넘으면 overflow를 표시한다', () => {
        const preview = buildPreview({
            entries: [
                entry({ content: 'x'.repeat(4000), alwaysActive: true }),
                entry({ content: 'y'.repeat(2000), alwaysActive: true, comment: '두번째' }),
            ],
            dropped: [],
        })

        expect(preview.alwaysOnChars).toBe(6000)
        expect(preview.alwaysOnOverflow).toBe(true)
    })

    it('dropped를 그대로 전달한다', () => {
        const preview = buildPreview({
            entries: [],
            dropped: [{ what: '인물: 단역', why: 'fact 4개 (최소 8)' }],
        })

        expect(preview.dropped).toHaveLength(1)
        expect(preview.dropped[0].why).toContain('최소 8')
    })

    it('빈 merge 결과를 처리한다', () => {
        const preview = buildPreview({ entries: [], dropped: [] })

        expect(preview.entries).toHaveLength(0)
        expect(preview.destinations).toHaveLength(0)
        expect(preview.alwaysOnChars).toBe(0)
        expect(preview.alwaysOnOverflow).toBe(false)
    })
})
