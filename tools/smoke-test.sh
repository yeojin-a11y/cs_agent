#!/usr/bin/env bash
# Design Ref: §8.2 — L1 API 테스트. 인자로 Worker URL 을 받는다.
set -uo pipefail
URL="${1:?사용법: tools/smoke-test.sh https://pi-cs-agent.<계정>.workers.dev}"
ORIGIN="https://yeojin-a11y.github.io"
pass=0; fail=0

check() { # 설명 기대코드 실제코드 [추가검증결과]
  if [ "$2" = "$3" ] && [ "${4:-ok}" = "ok" ]; then
    printf '  ✓ %s\n' "$1"; pass=$((pass+1))
  else
    printf '  ✗ %s (기대 %s, 실제 %s%s)\n' "$1" "$2" "$3" "${4:+, $4}"; fail=$((fail+1))
  fi
}

# L1-1 health
c=$(curl -s -o /tmp/h.json -w '%{http_code}' "$URL/health")
leak=$(grep -qE 'AIza|AQ\.' /tmp/h.json && echo "키노출!" || echo ok)
check "L1-1 /health 200 + 키 미노출" 200 "$c" "$leak"

# L1-2 embed 정상
c=$(curl -s -o /tmp/e.json -w '%{http_code}' -H "Origin: $ORIGIN" -H 'Content-Type: application/json' \
  -X POST "$URL/embed" -d '{"text":"자녀 계좌 거래내역이 안 보여요"}')
dim=$(python3 -c "import json;d=json.load(open('/tmp/e.json'));v=d.get('vector',[]);n=sum(x*x for x in v)**.5;print('ok' if len(v)==768 and abs(n-1)<0.01 else f'dim={len(v)} norm={n:.3f}')" 2>/dev/null || echo "파싱실패")
check "L1-2 /embed 200 + 768차원 정규화" 200 "$c" "$dim"

# L1-3/4 입력 검증
c=$(curl -s -o /dev/null -w '%{http_code}' -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -X POST "$URL/embed" -d '{"text":""}')
check "L1-3 빈 문자열 거부" 400 "$c"
c=$(curl -s -o /dev/null -w '%{http_code}' -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -X POST "$URL/embed" -d "{\"text\":\"$(head -c 3100 < /dev/zero | tr '\0' 'a')\"}")
check "L1-4 3000자 초과 거부" 400 "$c"

# L1-7 contexts 초과
c=$(curl -s -o /dev/null -w '%{http_code}' -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -X POST "$URL/generate" \
  -d '{"question":"질문","confidence":"low","contexts":[{"id":1,"category":"a","score":0.5,"answer":"x"},{"id":2,"category":"a","score":0.5,"answer":"x"},{"id":3,"category":"a","score":0.5,"answer":"x"},{"id":4,"category":"a","score":0.5,"answer":"x"},{"id":5,"category":"a","score":0.5,"answer":"x"},{"id":6,"category":"a","score":0.5,"answer":"x"}]}')
check "L1-7 contexts 6개 거부" 400 "$c"

# L1-8 Origin 차단
c=$(curl -s -o /dev/null -w '%{http_code}' -H "Origin: https://evil.example.com" -H 'Content-Type: application/json' \
  -X POST "$URL/embed" -d '{"text":"테스트"}')
check "L1-8 허용되지 않은 Origin 차단" 403 "$c"

# L1-10 CORS preflight (와일드카드 금지)
acao=$(curl -s -D- -o /dev/null -X OPTIONS -H "Origin: $ORIGIN" "$URL/embed" | grep -i '^access-control-allow-origin:' | tr -d '\r' | awk '{print $2}')
check "L1-10 CORS 정확값 반환 (와일드카드 아님)" "$ORIGIN" "${acao:-없음}"

# L1-5 generate 정상 (일일 할당량 1건 소비)
if [ "${SKIP_GENERATE:-}" != "1" ]; then
  c=$(curl -s -o /tmp/g.json -w '%{http_code}' -H "Origin: $ORIGIN" -H 'Content-Type: application/json' -X POST "$URL/generate" \
    -d '{"question":"자녀 계좌 거래내역이 안 보여요","confidence":"low","contexts":[]}')
  fmt=$(python3 -c "
import json;d=json.load(open('/tmp/g.json'));a=d.get('answer','')
s=a.startswith('안녕하세요, 파이 고객센터입니다.'); e=a.rstrip().endswith('파이 고객센터 드림'); m='**' not in a
print('ok' if s and e and m else f'시작{s} 종료{e} 마크다운{m}')" 2>/dev/null || echo "파싱실패")
  check "L1-5 /generate 200 + R-01/R-02/R-05 준수" 200 "$c" "$fmt"
else
  echo "  – L1-5 /generate 건너뜀 (SKIP_GENERATE=1)"
fi

echo; echo "통과 $pass / 실패 $fail"
[ "$fail" -eq 0 ]
