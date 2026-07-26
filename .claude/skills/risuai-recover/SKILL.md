---
name: risuai-recover
description: RisuAI SSE 스트림 끊김으로 잘린/누락된 응답을 gateway-logs에서 복구. 정확한 캐릭터/채팅/메시지 매칭 보장.
trigger: RisuAI 채팅 응답이 잘리거나 누락됐을 때
---

# /risuai-recover — 응답 복구 파이프라인

## Step 1: 문제 확인
```bash
# 최근 gateway 로그 확인
ssh rpi 'docker exec risuai node -e "
const fs = require(\"fs\");
const dir = \"/app/save/gateway-logs\";
const files = fs.readdirSync(dir).filter(f => f.endsWith(\"_res.json\")).sort().reverse().slice(0,5);
for(const f of files){
    const d = JSON.parse(fs.readFileSync(dir+\"/\"+f,\"utf8\"));
    console.log(f.split(\"_\")[0], \"chatId=\"+d.chatId, \"len=\"+(d.responseText||\"\").length, \"ts=\"+d.timestamp);
}
"'
```
- gateway에 응답이 저장되어 있는지 확인
- 없으면 복구 불가

## Step 2: DB에서 해당 캐릭터/채팅 상태 확인
유저에게 **어떤 캐릭터의 어떤 채팅인지** 물어본 후:
```bash
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
        if (c.name && c.name.includes(\"캐릭터이름\")) {
            console.log(\"chaId:\", c.chaId);
            for(let ci=0; ci<(c.chats||[]).length; ci++){
                const msgs = c.chats[ci].message;
                if(!msgs || msgs.length === 0) continue;
                const last = msgs[msgs.length-1];
                console.log(\"chat\", ci, \"msgs:\", msgs.length, \"last:\", last.role, last.data.length+\"chars\", last.chatId||\"no-chatId\");
            }
        }
    }
    offset += dl;
}
"'
```

## Step 3: 문제 유형 판별

| DB 마지막 메시지 | 상태 | 조치 |
|---|---|---|
| user (char 응답 없음) | 응답 누락 | → Step 4A: 메시지 삽입 |
| char (길이 < gateway) | 응답 잘림 | → Step 4B: 메시지 교체 |
| char (길이 ≈ gateway) | 정상 | → 복구 불필요 |

## Step 4A: 누락된 응답 삽입
```bash
ssh rpi "docker stop risuai"
ssh rpi 'sudo node -e "
// ... DB 파싱 → 해당 캐릭터 찾기 (chaId 필터 필수!)
// → chat[N].message.push({role:\"char\", data: responseText, ...})
// → 백업 → 리빌드 → 저장
"'
ssh rpi "docker start risuai"
```

**필수 체크:**
- ⚠️ **chaId 필터 사용** — `c.chaId === "대상chaId"` 없으면 실행 금지
- ⚠️ **chatIndex 정확히 지정** — 잘못된 채팅에 삽입 방지
- ⚠️ **백업 먼저** — `fs.copyFileSync(dbPath, dbPath + ".backup-" + Date.now())`

## Step 4B: 잘린 응답 교체
Step 4A와 동일하되, `message.push` 대신 `message[msgIndex].data = responseText`

## Step 5: 검증
```bash
ssh rpi 'docker exec risuai node -e "
// DB 다시 읽어서 해당 메시지 길이 확인
// gateway 응답 길이와 일치하는지 비교
"'
```

## 주의사항
- gateway-logs의 chatId와 DB 메시지의 chatId는 **다를 수 있음** (generationId가 매번 새로 생성)
- 시간순으로 매칭하거나, 유저에게 "가장 최근 응답이 맞는지" 확인
- 하나의 gateway 응답을 여러 캐릭터에 적용하지 않도록 chaId 필터 필수
