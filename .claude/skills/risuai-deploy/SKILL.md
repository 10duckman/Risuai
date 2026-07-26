---
name: risuai-deploy
description: RisuAI 빌드 → 검증 → RPi 배포 → smoke test 전체 파이프라인. 빌드 캐시 문제, 코드 누락, 이미지 누적 방지를 자동으로 처리.
trigger: RisuAI 배포/디플로이 요청 시, 또는 RisuAI 코드 변경 후 배포가 필요할 때
---

# /risuai-deploy — RisuAI 배포 파이프라인

아래 단계를 **순서대로** 실행합니다. 각 단계 실패 시 중단하고 원인을 보고합니다.

## Step 1: 변경 사항 확인
```bash
cd /Users/sanghyun/Workspace/RisuAI
git diff --stat HEAD
```
- 변경된 파일 목록을 유저에게 보여주고 확인

## Step 2: 핵심 코드 키워드 정의
- 이번 변경에서 **반드시 빌드 결과물에 포함되어야 하는 키워드**를 정의
- 예: `stream_complete`, `risu-pending-stream`, `__streamComplete`
- 키워드가 없으면 빌드 의미 없음

## Step 3: --no-cache 빌드
```bash
cd /Users/sanghyun/Workspace/RisuAI
docker buildx build --no-cache --platform linux/arm64 -t risuai:arm64-dev -f Dockerfile .
```
- **항상 --no-cache 사용** (프론트엔드 코드 캐시 문제 방지)

## Step 4: 빌드 결과물 검증
```bash
# 서버 코드 확인
docker run --rm risuai:arm64-dev grep -c "핵심키워드" /app/server/node/server.cjs

# 클라이언트 코드 확인 — index-*.js 파일들에서 키워드 검색
docker run --rm risuai:arm64-dev sh -c 'for f in /app/dist/assets/index-*.js; do count=$(grep -c "핵심키워드" "$f" 2>/dev/null); if [ "$count" -gt 0 ]; then echo "$f: $count"; fi; done'
```
- **0건이면 여기서 중단**. 빌드 실패로 판정.
- 유저에게 "코드가 빌드에 포함되지 않았습니다" 보고

## Step 5: RPi 이전 이미지 정리 후 전송
```bash
# 이전 이미지 정리 (dangling + 이전 risuai 태그)
ssh rpi 'docker image prune -f && docker images --filter "dangling=true" -q | xargs -r docker rmi 2>/dev/null; echo "Cleaned"'

# 새 이미지 전송
docker save risuai:arm64-dev | gzip | ssh rpi "gunzip | docker load"

# 전송 후 다시 정리 (old unnamed images)
ssh rpi 'docker images | grep "<none>" | awk "{print \$3}" | xargs -r docker rmi 2>/dev/null; echo "Post-clean done"'

# 디스크 확인
ssh rpi 'df -h / | tail -1'
```

## Step 6: 컨테이너 교체
```bash
ssh rpi "docker stop risuai && docker rm risuai && docker run -d \
  --name risuai --restart always -p 6001:6001 \
  -e GATEWAY_LOG=true \
  -v /home/katoro/risuai-save:/app/save \
  -v /home/katoro/risuai-ssl:/app/server/node/ssl/certificate \
  risuai:arm64-dev"
```

## Step 7: Smoke Test
```bash
# 1. 서버 시작 확인
sleep 3
ssh rpi "docker logs risuai --tail 5 2>&1"
# "HTTPS server is running" 확인

# 2. 서버 코드 키워드 확인
ssh rpi 'docker exec risuai grep -c "핵심키워드" /app/server/node/server.cjs'

# 3. 클라이언트 코드 키워드 확인
ssh rpi 'docker exec risuai sh -c "grep -cl \"핵심키워드\" /app/dist/assets/index-*.js"'

# 4. 디스크 사용량 확인
ssh rpi 'df -h / | tail -1'
```
- 서버 미시작 → 롤백 필요
- 키워드 0건 → 빌드 문제, Step 3부터 재시도

## Step 8: 결과 보고
```
배포 완료:
- 이미지: risuai:arm64-dev
- 변경 파일: [목록]
- 키워드 검증: ✅ 서버 N건, 클라이언트 N건
- 서버 상태: 정상
- 디스크: XX% 사용
```

## 롤백
문제 발생 시:
```bash
ssh rpi "docker stop risuai && docker rm risuai && docker run -d \
  --name risuai --restart always -p 6001:6001 \
  -e GATEWAY_LOG=true \
  -v /home/katoro/risuai-save:/app/save \
  -v /home/katoro/risuai-ssl:/app/server/node/ssl/certificate \
  risuai:arm64"
```
(`risuai:arm64`는 안정 이미지)
