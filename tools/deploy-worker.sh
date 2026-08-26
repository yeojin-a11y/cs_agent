#!/usr/bin/env bash
# Design Ref: §11.2 step 6 — Worker 배포. wrangler login 이후 실행한다.
set -euo pipefail
cd "$(dirname "$0")/.."

export npm_config_cache=/tmp/npm-cache
WRANGLER="npx --yes wrangler@latest"

echo "▸ 인증 확인"
$WRANGLER whoami 2>&1 | grep -q "not authenticated" && {
  echo "  로그인이 필요합니다: npx wrangler@latest login"; exit 1; }

echo "▸ KV 네임스페이스"
if grep -q 'REPLACE_WITH_KV_NAMESPACE_ID' worker/wrangler.toml; then
  OUT=$($WRANGLER kv namespace create KV 2>&1)
  ID=$(echo "$OUT" | grep -oE '[0-9a-f]{32}' | head -1)
  [ -z "$ID" ] && { echo "  ID 추출 실패:"; echo "$OUT"; exit 1; }
  sed -i '' "s/REPLACE_WITH_KV_NAMESPACE_ID/$ID/" worker/wrangler.toml
  echo "  생성됨: $ID"
else
  echo "  이미 설정됨: $(grep -oE '[0-9a-f]{32}' worker/wrangler.toml | head -1)"
fi

echo "▸ API 키 주입 (.env 에서 읽음, 화면에 표시하지 않음)"
KEY=$(grep '^GEMINI_API_KEY=' .env | cut -d= -f2- | tr -d '\042\047')
[ -z "$KEY" ] && { echo "  .env 에 GEMINI_API_KEY 가 없습니다"; exit 1; }
if OUT=$(printf '%s' "$KEY" | (cd worker && $WRANGLER secret put GEMINI_API_KEY) 2>&1); then
  echo "  주입 완료"
else
  # 키 값이 섞여 들어갈 수 있으므로 마스킹한 뒤 출력한다
  echo "  주입 실패:"
  echo "$OUT" | grep -vE 'Unsupported macOS|^⚠️' | sed -E 's/(AQ\.[A-Za-z0-9_.-]{6})[A-Za-z0-9_.-]+/\1***/g; s/(AIza)[A-Za-z0-9_-]+/\1***/g' | sed 's/^/    /' | tail -8
  exit 1
fi

echo "▸ 배포"
(cd worker && $WRANGLER deploy) 2>&1 | grep -vE '^⚠️|Unsupported macOS' | tail -12
