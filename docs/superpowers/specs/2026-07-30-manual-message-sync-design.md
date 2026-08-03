# 수동 메시지 동기화 설계

작성일: 2026-07-30
대상: RisuAI 포크 (Bedrock 게이트웨이 모드)

## 배경

Bedrock 게이트웨이 모드에서 응답이 잘린 상태로 멈추는 사고가 반복된다.
구조는 이렇다.

```
브라우저 ──[완성된 프롬프트]──▶ RPi ──[ConverseStream]──▶ Bedrock
브라우저 ◀──────[SSE 중계]────── RPi ◀──[이벤트 스트림]──── Bedrock
         (여기가 끊긴다)             (여기는 안 끊긴다)
```

RPi↔Bedrock 스트림은 클라이언트와 무관하게 끝까지 진행되고, 서버는 응답을
`activeStreams` 메모리 버퍼(TTL 30분)와 `gateway-logs/*_res.json`(무기한)에
남긴다. 반면 브라우저↔RPi 구간은 새로고침, Safari 타임아웃, 네트워크 단절로
끊긴다.

### 자동 복구를 쌓아온 이력

끊김에 대응해 자동 복구를 4겹까지 쌓았다.

| 층 | 내용 |
|---|---|
| SSE resume | Last-Event-ID로 재접속, 서버 버퍼에서 replay (최대 12회) |
| 하트비트 | 10초 간격 `data:` 이벤트 (iOS WebKit 60초 타임아웃 회피) |
| idle 타임아웃 | 25초 무수신 시 연결 사망 판정 (Chrome 오프라인 대응) |
| 3중 폴링 복구 | 인라인 / visibilitychange / 부팅 스윕 |

그런데도 2026-07-29 사고가 발생했다. 생성 중 새로고침 두 번에 응답 12,393자
중 7,487자만 남았고, 자동 복구는 한 번도 시도되지 않았다.

### 근거 데이터

`gateway-logs` 전수 조사 (2026-07-30 기준):

```
고유 chatId          1,564건
├─ res.json 있음      1,540건 (98.5%)  ← 서버에 완성본이 남아 있다
└─ res.json 없음         24건 (1.5%)   ← 서버에도 기록이 없다
```

즉 **사고의 98.5%는 서버에 응답이 온전히 있는데 클라이언트가 못 받은 것**이다.
복구 수단이 없는 게 아니라, 복구를 *언제* 해야 하는지 코드가 잘못 추측한다.

## 문제 정의

자동 복구의 근본 한계는 판단 시점이다. 코드는 "스트림이 실패했는지"를
`streamError`, `expectedLength` 비교, `streamComplete` 플래그로 추측하지만,
페이지 리로드처럼 JS 컨텍스트가 소멸하는 경우엔 추측할 주체 자체가 사라진다.

사용자는 화면을 보고 즉시 안다 — 응답이 문장 중간에서 끊겼는지, 정상 종료했는지.
이 판단을 코드에서 사용자로 옮긴다.

## 설계

### 방향

**자동 복구를 제거하고, 사용자가 필요할 때 누르는 수동 동기화로 대체한다.**

- 전송 계층(SSE resume, 하트비트, idle 타임아웃)은 유지한다. 짧은 끊김을
  매번 수동 개입으로 처리하는 건 비현실적이다.
- 복구 계층(3중 폴링)은 제거한다.
- 스트림 실패 시 부분 텍스트를 남긴다. 지금은 삭제하는데, 그러면 `chatId`가
  사라져 수동 복구조차 불가능해진다.

### 1. 수동 동기화 버튼

`src/lib/ChatScreens/Chat.svelte`의 `minorIconButtonsBody` 스니펫에 버튼을
추가한다. 기존 북마크·분기·비활성화 버튼과 같은 줄이다.

```
[북마크] [분기점] [메시지 비활성화] [위쪽 비활성화] [서버에서 동기화]  ← 추가
```

노출 조건:
- `role === 'char'` 인 메시지에만 (user 메시지는 서버에 응답이 없다)
- `isNodeServer` 인 환경에서만 (게이트웨이가 노드 서버 전용이다)
- 메시지에 `chatId`가 있을 때만 (조회 키가 없으면 동작 불가)

### 2. 동작

```
1. 대상 메시지의 chatId를 읽는다 (idx로 특정된 그 메시지)
2. GET /gateway/recover?chatId=<chatId>
3. 응답에 따라 분기한다
```

| 서버 응답 | 처리 | 사용자에게 |
|---|---|---|
| `done:true`, 텍스트가 더 길다 | 교체 + 후처리 | "7,487자 → 12,393자로 복구했습니다" |
| `done:true`, 같거나 짧다 | 아무것도 안 함 | "이미 최신 상태입니다" |
| `done:false` | 부분 텍스트 반영 | "서버가 아직 생성 중입니다 (현재 N자). 잠시 후 다시 시도하세요" |
| 404 | 아무것도 안 함 | "서버에 이 응답 기록이 없습니다" |
| 그 외 오류 | 아무것도 안 함 | 오류 메시지 노출 |

**폴링하지 않는다.** 한 번 조회하고 결과를 보여준다. 생성 중이면 사용자가
다시 누른다. 자동 폴링은 이 설계가 없애려는 바로 그 추측이다.

### 3. 텍스트 교체 규칙

`gatewayRecovery.ts`에 인덱스 지정 함수를 추가한다. 기존
`applyRecoveredMessage()`는 chatId로 메시지를 탐색하지만, 수동 버튼은 사용자가
지목한 인덱스가 이미 확정이므로 그 메시지만 건드리는 게 안전하다.

```
syncMessageFromServer({ messages, index, chatId, responseText })
  → chatId 불일치면 거부 (인덱스가 흔들렸을 수 있다)
  → 기존 텍스트가 같거나 더 길면 거부 (후처리로 늘어났을 수 있다)
  → 그 외에는 교체
```

교체 후 `processScriptFull(..., 'editoutput', ...)`으로 후처리한다. 정상
스트리밍 경로와 같은 처리를 거쳐야 표시가 일관된다. (기존 자동 복구는 이걸
건너뛰어서 복구된 메시지에 정규식 스크립트가 적용되지 않았다.)

### 4. 자동 복구 제거

| 제거 대상 | 위치 |
|---|---|
| 인라인 폴링 (`needsRecovery` 블록) | `index.svelte.ts:1735~1783` |
| visibilitychange 세이프티넷 | `index.svelte.ts:2249~2367` |
| 부팅 스윕 (`runBootRecovery`) | `index.svelte.ts:2378`, `bootstrap.ts:262` |
| pending generation registry | `gatewayRecovery.ts` (localStorage persist 포함) |

`pollGatewayRecovery()`는 제거한다. 수동 버튼은 단발 조회이므로 폴링 로직이
필요 없다.

### 5. 스트림 실패 시 부분 텍스트 보존

현재 코드는 복구 실패 시 메시지를 지운다.

```js
if(!recovered){
    if(isNewMessage){
        message.splice(msgIndex, 1)   // ← 제거한다
    }
    throwError('Stream connection lost. Please try again.')
}
```

이걸 바꿔서 부분 텍스트를 남기고 에러만 알린다. 그래야 `chatId`가 살아남아
수동 동기화가 가능하다. 사용자가 보는 화면은 "응답이 문장 중간에서 끊긴 상태 +
에러 토스트"가 되고, 여기서 동기화 버튼을 누른다.

빈 텍스트(한 글자도 못 받은 경우)도 남긴다. 서버에는 응답이 있을 수 있고,
지우면 복구 경로가 사라진다.

## 데이터 흐름

```
정상:
  브라우저 → RPi → Bedrock → SSE → DBState → /api/write → database.bin

실패 후 수동 동기화:
  [부분 텍스트가 화면에 남는다 + 에러 토스트]
  사용자가 동기화 버튼을 누른다
  → GET /gateway/recover?chatId=...
  → 서버: activeStreams(30분) 조회 → 없으면 gateway-logs 파일 탐색
  → 전체 텍스트 반환
  → 후처리 → DBState 교체 → 자동 저장 → database.bin
```

### 6. 서버: `res.json` 저장 보장

현재 서버는 `metadata` 이벤트가 도착할 때만 `res.json`을 쓴다.

```js
} else if (event.metadata) {
    const usage = event.metadata.usage;
    if (gatewayLog && logId) {
        fs.writeFile(.../`${logId}_res.json`, JSON.stringify({usage, responseText, chatId, timestamp}))
    }
}
```

Bedrock 스트림이 `metadata` 없이 끝나면 영구 기록이 생기지 않는다. 메모리
버퍼는 30분 뒤 만료되므로 그 응답은 완전히 사라진다. 조사한 24건(1.5%)이
이 경우이고, 2026-07-29 14:44 사고가 실제 사례다.

수정: `for await` 루프가 끝난 뒤 — `metadata`가 왔든 안 왔든 — 텍스트가 있으면
`res.json`을 쓴다. `metadata`에서 이미 썼다면 같은 내용으로 덮어쓰는 것이므로
무해하다. `usage`는 없으면 `null`로 둔다.

에러 경로(catch 블록)에서도 같은 처리를 한다. 부분 텍스트라도 남기는 게
아무것도 없는 것보다 낫다.

이 수정으로 수동 동기화 버튼의 사정거리가 98.5% → 100%가 된다.

## 범위 밖

- **삭제된 메시지 복구**: 이미 사라진 메시지는 `chatId`가 없어 조회 불가.
  향후 서버 로그 역탐색 API가 필요하다.
- **채팅 전체 일괄 점검**: 메시지 단위 복구만 다룬다.
- **WebSocket 전환**: 전송 계층 개선은 별도 과제.
- **DB 저장 주체 변경**: 브라우저가 `database.bin`을 소유하는 구조는 그대로.

## 검증 기준

1. 잘린 char 메시지에서 버튼 → 전체 텍스트로 교체되고 후처리가 적용된다
2. 정상 char 메시지에서 버튼 → "이미 최신" 알림, 텍스트 무변경
3. 서버 기록 없는 메시지 → 404 안내, 텍스트 무변경
4. 생성 중인 메시지 → 부분 텍스트 반영 + 진행 중 안내
5. user 메시지 → 버튼이 노출되지 않는다
6. chatId 없는 옛 메시지 → 버튼이 노출되지 않는다
7. 스트림 실패 시 부분 텍스트가 남고 메시지가 삭제되지 않는다
8. 자동 복구가 더 이상 동작하지 않는다 (폴링 요청이 발생하지 않는다)
9. SSE resume은 여전히 동작한다 (짧은 끊김은 자동 복구된다)
10. `metadata` 없이 끝난 스트림도 `res.json`이 생성된다
11. 에러로 중단된 스트림도 부분 텍스트가 `res.json`에 남는다

## 참고

- 기존 계획: `risuai/improvements/SSE에서 WebSocket 전환 계획.md` (옵시디언)
- 사고 분석: 2026-07-29 웬디 대화 (chatId `a977e497-8768-4bf4-be21-38a7c4097cf2`)
- 서버 복구 API: `server/node/server.cjs` `/gateway/recover`
