---
name: charcard-build
description: RisuAI 캐릭터카드(.charx) 빌드 파이프라인. 참조 카드 분석 → 템플릿 적용 → spec v3 검증 → 빌드. customscript/CSS 호환성 보장.
trigger: 캐릭터카드 생성/빌드/수정 요청 시
---

# /charcard-build — 캐릭터카드 빌드 파이프라인

## Step 0: 참조 카드 분석 (필수 — 건너뛰기 금지)

빌드 전에 **반드시** 동작하는 기존 카드의 실제 데이터를 분석합니다.

```bash
# RPi DB에서 참조 카드 추출 (한유진, Song Hari 등)
ssh rpi 'docker exec risuai node -e "
const fs = require(\"fs\");
const hexName = Buffer.from(\"database/database.bin\").toString(\"hex\");
const data = fs.readFileSync(\"/app/save/\" + hexName);
let offset = 9;
while (offset < data.length) {
    const type = data[offset]; offset += 2;
    const nl = data[offset]; offset += 1;
    const name = data.subarray(offset, offset+nl).toString(\"utf8\"); offset += nl;
    const dl = data.readUInt32LE(offset); offset += 4;
    if (type === 2) {
        const c = JSON.parse(data.subarray(offset, offset+dl).toString(\"utf8\"));
        if (c.name === \"참조카드이름\") {
            console.log(\"customscript:\", JSON.stringify(c.customscript?.map(s => ({comment:s.comment, type:s.type, ableFlag:s.ableFlag})),null,2));
            console.log(\"customCSS length:\", (c.customCSS||\"\").length);
            console.log(\"lorebook count:\", c.globalLore?.length);
            c.globalLore?.forEach((l,i) => console.log(\"  entry\",i,\"keys:\",JSON.stringify(l.key),\"always:\",l.alwaysActive,\"len:\",l.content?.length));
        }
    }
    offset += dl;
}
"'
```

**확인 사항:**
- customscript의 `type` 값 (editdisplay vs editoutput vs editinput)
- customscript의 `ableFlag`, `flag` 값
- lorebook 엔트리 수와 구조 패턴
- customCSS가 별도 필드인지 inline인지

## Step 1: 소스 파일 작성/확인

옵시디언 `risuai/characters/{캐릭터이름}/` 폴더에:
- `01_description.md` — 영문 description (표면만)
- `03_lorebook.md` — 통합 lorebook (3~4개 엔트리)
- `04_first_message.md` — first_mes (CBS 변수 초기화 포함)
- `06_customscript.md` — regex 스크립트
- `07_customCSS.md` — CSS (inline용)

## Step 2: 빌드 전 검증 체크리스트

| # | 항목 | 검증 방법 |
|---|------|----------|
| 1 | first_mes에 `{{#if}}` 래퍼 없음 | grep |
| 2 | customscript type이 참조 카드와 동일 | Step 0 결과 대조 |
| 3 | customscript key = `customScripts` (대문자 S) | JSON 키 확인 |
| 4 | customCSS는 `<style>` 태그로 customscript out에 inline | charx import 시 customCSS 필드 안 읽힘 |
| 5 | `@@move_top` 지시자 포함 (상태창 상단 이동) | out 시작 확인 |
| 6 | editdisplay 스크립트에 CBS `{{setvar}}` 없음 | CBS는 editoutput에서만 작동 |
| 7 | spec v3 필수 필드 전부 존재 | 빌드 스크립트에서 자동 검증 |

## Step 3: card.json 빌드

```javascript
// 필수 구조:
{
  spec: "chara_card_v3",
  spec_version: "3.0",
  data: {
    name, description, personality, scenario,
    first_mes, mes_example, system_prompt,
    post_history_instructions,
    creator_notes, creator_notes_multilingual: {ko, en},
    tags, creator, character_version,
    alternate_greetings: [],
    group_only_greetings: [],
    extensions: {
      risuai: {
        customScripts: [...]  // 대문자 S!
        // customCSS는 여기 넣지 않음 — import 시 안 읽힘
      }
    },
    character_book: { entries: [...] },
    assets: [{type:"icon", uri:"ccdefault:", name:"main", ext:"png"}],
    creation_date, modification_date
  }
}
```

## Step 4: .charx 패키징
```bash
cd /tmp/charx_build
zip -r "/Users/sanghyun/Workspace/{이름}.charx" card.json
```

## Step 5: 빌드 후 검증
```bash
unzip -o {이름}.charx -d /tmp/charx_verify
node -e '
const d = JSON.parse(require("fs").readFileSync("/tmp/charx_verify/card.json","utf8"));
const required = ["name","description","tags","creator","character_version","mes_example","extensions","system_prompt","post_history_instructions","first_mes","alternate_greetings","personality","scenario","creator_notes","group_only_greetings"];
const missing = required.filter(f => !(f in d.data));
console.log("Missing:", missing.length === 0 ? "NONE ✅" : missing.join(", ") + " ❌");
console.log("first_mes has #if:", d.data.first_mes.includes("#if") ? "❌" : "✅");
console.log("customScripts (S):", d.data.extensions?.risuai?.customScripts?.length ?? "❌ missing");
console.log("script type:", d.data.extensions?.risuai?.customScripts?.[0]?.type);
console.log("has @@move_top:", d.data.extensions?.risuai?.customScripts?.[0]?.out?.includes("@@move_top") ? "✅" : "❌");
console.log("lorebook entries:", d.data.character_book?.entries?.length);
'
rm -rf /tmp/charx_verify
```

**하나라도 ❌면 수정 후 재빌드.**

## RisuAI customscript 규칙 (참고)

| 필드 | 의미 | 주의 |
|---|---|---|
| `type: "editdisplay"` | 화면 렌더링 시 실행 (firstMessage 포함) | CBS 처리 안 됨 |
| `type: "editoutput"` | AI 응답 수신 시 실행 | CBS 처리 됨, firstMessage에는 미적용 |
| `type: "editinput"` | 유저 입력 시 실행 | |
| `ableFlag: false` | flag 필드 무시, 기본 'g' 사용 | |
| `ableFlag: true` | flag 필드 사용 (예: 'gi') | |
| charx import 시 | `extensions.risuai.customScripts` → `character.customscript` | 대문자 S 필수 |
| charx import 시 | `customCSS` 필드 **안 읽힘** | inline `<style>` 사용 |
