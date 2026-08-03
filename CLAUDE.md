# RisuAI 포크

## 소스
- 포크: `github.com/10duckman/RisuAI`
- 업스트림: `github.com/kwaroran/RisuAI`
- 업스트림 동기화: `0afbcabf` (2026-03-23)

## 포크 변경사항 (업스트림 대비)

### Bedrock 게이트웨이 (`server/node/server.cjs`)
- `/gateway/bedrock-stream` — Bedrock ConverseStream SSE 프록시
- `/gateway/recover?chatId=&time=` — 응답 복구 API (chatId 매칭 + 타임스탬프 fallback)
- 요청/응답 로깅 (`GATEWAY_LOG=true`, `save/gateway-logs/`)
- `responseLength`를 `message_delta` SSE 이벤트에 포함

### 스트리밍 에러 복구 — 수동 동기화 (`index.svelte.ts`, `Chat.svelte`)
- 스트리밍 루프 try-catch + isStreaming 상태 보장 (finally)
- 빈 응답 / 잘린 응답 감지 (`expectedLength` 비교)
- **자동 복구는 없다.** 실패 시 부분 메시지(빈 것이라도)를 남기고 에러만 표시한다 —
  메시지를 지우면 `chatId`가 사라지고, `chatId`는 `/gateway/recover`의 유일한 조회 키다
- 복구는 사용자가 메시지 메뉴의 "서버에서 동기화"를 눌러서 한다 (단발 조회, 폴링 없음).
  이유: 자동 복구를 4겹까지 쌓아도 리로드로 JS 컨텍스트가 죽으면 전부 함께 사라졌다.
  로그 조사 결과 1,564건 중 1,540건(98.5%)이 서버에 온전히 남아 있었다 — 응답이 없는 게
  아니라 복구 시점을 코드가 잘못 추측하는 것이 문제였다
- 전송 계층 재시도는 유지: SSE resume(12회), 10초 하트비트, 25초 idle 타임아웃
- 설계/계획: `docs/superpowers/specs/2026-07-30-manual-message-sync-design.md`

### Bedrock gateway 모드 (`anthropic.ts`)
- 게이트웨이 경유 Bedrock 요청 지원
- `x-chat-id` 헤더 전송
- SSE에서 `responseLength` 파싱 → `__expectedLength`로 전달

### 기타
- `Dockerfile` 빌드 설정 수정
- `@aws-sdk/client-bedrock-runtime` 의존성 추가
- Bedrock 모델 목록 추가 (`modellist.ts`)

## 빌드 (맥북)
- Docker buildx (OrbStack), ARM64 네이티브 (M칩)
- `docker buildx build --platform linux/arm64 -t risuai:arm64-dev -f Dockerfile .`

## 배포 (라즈베리파이)
- 접속: `ssh rpi`
- 컨테이너: `risuai` / 이미지: `risuai:arm64-dev` / 포트: `6001`
- 볼륨: `/home/katoro/risuai-save:/app/save`, `/home/katoro/risuai-ssl:/app/server/node/ssl/certificate`
- 환경변수: `-e GATEWAY_LOG=true` (게이트웨이 로그 활성화 필수)

## 배포 명령
새 빌드 push → 컨테이너 교체 → 직전 이미지(이제 `<none>` 태그가 된 dangling) 자동 정리.
RPi 루트가 29GB 짜리 SD라 매 배포마다 이미지 1.2GB가 쌓이면 금방 100% 차서 다음 `docker load`가 실패함.

```bash
docker save risuai:arm64-dev | gzip | ssh rpi "gunzip | docker load" && \
ssh rpi "docker stop risuai && docker rm risuai && docker run -d \
  --name risuai --restart always -p 6001:6001 \
  -e GATEWAY_LOG=true \
  -v /home/katoro/risuai-save:/app/save \
  -v /home/katoro/risuai-ssl:/app/server/node/ssl/certificate \
  risuai:arm64-dev && \
docker image prune -f"
```

`docker image prune -f` 는 dangling(태그 없는) 이미지만 지움 — 같은 태그로 push했을 때 옛 이미지가
`<none>:<none>`이 되는 그것. 다른 컨테이너(stash, metatube 등)는 안 건드림.

디스크가 이미 가득 찼다면 `ssh rpi 'docker image prune -a -f'`로 사용 안 하는 모든 이미지까지
회수 (이건 잠자는 다른 이미지도 날림 — 신중히).

## 롤백
기존 이미지 `risuai:arm64`로 동일 명령. 데이터는 볼륨이라 유지됨.

## 스크립트

### 요청 분석 (`scripts/analyze-request.cjs`)
게이트웨이 요청의 토큰 구성을 분석. system prompt / 메시지 / 로어북 비중 확인.
```bash
# RPi에서 최신 요청 분석
ssh rpi 'docker exec risuai node /app/scripts/analyze-request.cjs latest'

# 특정 타임스탬프로 분석
ssh rpi 'docker exec risuai node /app/scripts/analyze-request.cjs 1775733374599'
```

### 응답 복구 (`scripts/recover-by-index.cjs`)
SSE 끊김으로 잘린/누락된 응답을 gateway-logs에서 수동 복구.
```bash
# RPi에서 실행 (chaId 필터 필수!)
scp scripts/recover-by-index.cjs rpi:/tmp/
ssh rpi 'sudo node /tmp/recover-by-index.cjs \
  "/home/katoro/risuai-save/64617461626173652f64617461626173652e62696e" \
  "<chaId>" <chatIndex> \
  '"'"'[{"msgIndex":<N>,"logFile":"/home/katoro/risuai-save/gateway-logs/<timestamp>_<model>_res.json"}]'"'"''
```

### 대화 내보내기
특정 캐릭터의 채팅을 JSONL로 추출.
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
            const msgs = c.chats[0].message;
            msgs.forEach(m => console.log(JSON.stringify({r:m.role===\"user\"?\"u\":\"c\",d:m.data})));
        }
    }
    offset += dl;
}
"' > output.jsonl
```
