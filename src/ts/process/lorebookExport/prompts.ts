/**
 * 추출 프롬프트.
 *
 * 원본: .superpowers/sdd/lorebook-export/final-prompts.md
 * 여기서 직접 고치지 말고 그 문서를 먼저 고친 뒤 옮긴다 — 설계 근거가 거기 있다.
 */

/** 청크 하나당 실행. ~11회 호출되므로 짧게 유지한다. */
export const CHUNK_PROMPT = `대화 기록에서 로어북 항목의 재료를 추출한다. 요약하지 마라.

## 판정 기준

통과: 41세 / 17년 무직 / 174cm 78kg / 맥주 1-2캔 / 4분
      술 취하면: "네가 없으면 난 아무것도 아니야"
      전희 없음. 불 끄고. 체위 하나.
      햇빛을 싫어한다
탈락: 무심하다 / 다정하다 / 순수하다 / 헌신적이다 / ~한 편이다 / ~경향이 있다

평가어를 쓰지 마라. 관찰된 것만 쓴다. 숫자가 있으면 숫자를,
말이 있으면 그 말을 그대로, 없는 것은 없다고 쓴다.

## 출력 단위: fact

각 fact는 아래 여섯 형태 중 하나다.

  num      숫자를 포함한다.            "17년 무직", "맥주 1-2캔", "4분"
  quote    대사를 그대로 옮긴다.       "네가 없으면 난 아무것도 아니야"
  trigger  조건 + 그때의 반응/발화.    "술 취하면: '네가 없으면...'"
                                       "진지한 얘기 꺼내면 한숨: '또 돈 얘기야?'"
  habit    반복 관측된 행동.           "매일 문에서 맞이하고 앞치마를 받는다"
  absence  하지 않는 것, 없는 것.      "전희 없음", "5개월간 방에서 안 나옴"
  plain    위에 안 맞는 짧은 사실.     "송진 냄새를 싫어한다", "HG 에어리얼"

\`plain\`은 명사구 한두 개로 끝나는 것만 허용한다. 문장이 되면 평가어가 섞인다.

각 fact에 \`src\`를 단다 — 그 fact의 근거가 되는 원문 조각을 **글자 그대로**
5~60자 옮긴다. 원문에 없는 문자열을 쓰면 그 fact는 버려진다.
\`absence\`는 예외적으로 \`src\`에 그 부재가 드러난 장면의 원문을 옮긴다.

## 슬롯

인물마다 아래 라벨에 fact를 배분한다. 근거 없는 라벨은 빈 배열로 둔다 —
비워두는 것은 허용, 채워 넣는 것은 금지.

  Identity      나이 성별 직업 소속. 숫자 우선.
  Appearance    키 몸무게 눈에 띄는 특징.
  History       과거 사건, 만난 경위. 연도·나이와 함께.
  Habits        반복하는 행동. habit 타입 위주.
  Speech        말투와 실제 대사. quote 2개 이상 넣는다.
  Reactions     어떤 상황에서 어떻게 반응하는가. trigger 타입 위주.
  Relations     다른 인물에 대한 태도. 관찰된 행동으로.
  Absences      하지 않는 것. 없는 것.
  Misc          위에 안 들어가는 것.

장소는 \`Place\`, 관계 상태는 \`State\`, 사물·모티프는 \`Object\`로 같은 방식.

## 통과 조건

인물 하나를 내보내려면:
- \`trigger\` 또는 \`quote\` 타입 fact가 **합쳐서 3개 이상**
- fact 총 8개 이상
- 세 슬롯 이상에 분포

못 넘으면 그 인물을 내보내지 마라. 억지로 채우지 말고 빼라.

## 제외

- 성적 묘사 자체. 빈도·패턴·부재는 사실로 취급하되 행위 서술은 옮기지 않는다.
- 매 턴의 감정 변화. 반복 관측된 반응 패턴만 남긴다.
- 이 청크에서 한 번만 나온 일회성 사건. 단, 관계가 바뀐 순간은 예외.

카드 설정에 이미 있는 내용이라도, 대화가 그것을 **더 구체적으로** 만들었으면
대화 쪽을 쓴다. \`직장인\` → \`마케팅팀 대리 3년차\`. 설정과 글자까지 같은 것만
빼라.

## 형식

JSON. 스키마는 별도로 주어진다. 설명이나 서론 없이 JSON만 출력한다.`

/** 전체 청크 결과를 받아 1회 실행. */
export const MERGE_PROMPT = `여러 구간에서 추출된 fact들을 로어북 항목으로 합친다.

## 합치는 규칙

**인물 / 장소** — 같은 대상의 fact를 하나로 모은다.
  - 중복 제거. 같은 사실의 다른 표현은 더 구체적인 쪽을 남긴다.
  - 모순되면 **둘 다 남기고 시점을 붙인다** — 관계는 변하고, 변화 자체가 정보다.
    "처음에는 존댓말. 100턴 이후 반말."
  - 별칭·애칭은 같은 인물로 묶고 \`key\`에 모두 넣는다.

**관계 상태** — 최신만 남긴다. 과거 상태는 History로 옮긴다.

**사물·모티프** — 누적한다. 등장 시점과 그때의 의미를 함께.

## absence 승격

청크 단계의 \`absence\`는 "이 구간에 없었다"는 뜻일 뿐이다.
전체를 보고 판단한다:
- 여러 구간에서 일관되게 없으면 → 사실로 승격
- 한 구간에만 없으면 → 버린다
- 다른 구간에서 반증되면 → 버린다

승격된 것만 \`Absences\` 슬롯에 남긴다.

## 항목 조립

각 항목의 \`content\`를 이렇게 쓴다:

  ### <이름> — <한 줄 규정: 관계와 위치. 평가어 금지>
  - Identity: <fact들을 마침표로 이어 붙인다>
  - Appearance: ...
  (근거 없는 라벨은 줄 자체를 쓰지 않는다)

fact를 문장으로 다듬지 마라. \`41세. 남성. 자칭 화가. 17년 무직.\` 이 형태를
유지한다. 이어 쓰면 평가어가 들어간다.

## 크기

인물 하나 2,000~3,000자. 장소 1,000~2,000자. 관계 상태 1,000자 이하.
넘으면 덜 구체적인 fact를 버려서 맞춘다 — 요약해서 줄이지 마라.

## key와 활성화

- **인물·장소·관계 상태**: \`alwaysActive: true\`, \`key: ""\`.
  매 턴 필요하다. 단 합쳐서 5,000자를 넘기지 않는다. 넘으면 등장 빈도가
  낮은 인물을 키워드 방식으로 내린다.
- **사물·모티프**: \`alwaysActive: false\`. \`key\`에 그 사물의 이름과 별칭을
  쉼표로 나열한다. 흔한 단어(집, 밤, 손)는 넣지 마라 — 매 턴 발동한다.
- \`insertorder\`: 인물 100, 장소 90, 관계 상태 110, 사물 50.
- \`comment\`에 항목 이름을 넣는다. UI에서 이것으로 식별한다.

## 형식

JSON. 스키마는 별도로 주어진다. JSON만 출력한다.`

export const CHUNK_SCHEMA = {
    type: 'object',
    properties: {
        people: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    name: { type: 'string' },
                    aliases: { type: 'array', items: { type: 'string' } },
                    slots: {
                        type: 'object',
                        additionalProperties: {
                            type: 'array',
                            items: { $ref: '#/$defs/fact' },
                        },
                    },
                },
                required: ['name', 'slots'],
            },
        },
        places: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    name: { type: 'string' },
                    facts: { type: 'array', items: { $ref: '#/$defs/fact' } },
                },
                required: ['name', 'facts'],
            },
        },
        state: { type: 'array', items: { $ref: '#/$defs/fact' } },
        objects: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    name: { type: 'string' },
                    aliases: { type: 'array', items: { type: 'string' } },
                    facts: { type: 'array', items: { $ref: '#/$defs/fact' } },
                },
                required: ['name', 'facts'],
            },
        },
    },
    required: ['people', 'places', 'state', 'objects'],
    $defs: {
        fact: {
            type: 'object',
            properties: {
                t: { enum: ['num', 'quote', 'trigger', 'habit', 'absence', 'plain'] },
                v: { type: 'string', maxLength: 200 },
                src: { type: 'string', minLength: 5, maxLength: 60 },
                msg: { type: 'integer' },
            },
            required: ['t', 'v', 'src', 'msg'],
        },
    },
} as const

export const MERGE_SCHEMA = {
    type: 'object',
    properties: {
        entries: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    comment: { type: 'string' },
                    content: { type: 'string' },
                    key: { type: 'string' },
                    secondkey: { type: 'string' },
                    insertorder: { type: 'integer' },
                    mode: { enum: ['normal', 'constant', 'multiple'] },
                    alwaysActive: { type: 'boolean' },
                    selective: { type: 'boolean' },
                    useRegex: { type: 'boolean' },
                    category: { enum: ['person', 'place', 'state', 'object'] },
                },
                required: [
                    'comment', 'content', 'key', 'insertorder', 'mode',
                    'alwaysActive', 'selective', 'useRegex', 'category',
                ],
            },
        },
        dropped: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    what: { type: 'string' },
                    why: { type: 'string' },
                },
                required: ['what', 'why'],
            },
        },
    },
    required: ['entries', 'dropped'],
} as const
