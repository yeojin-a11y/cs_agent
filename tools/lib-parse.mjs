// Design Ref: §11.2 step 2 — txt 파싱 + Slack 마크업 정제 + PII 스캔
// 순수 모듈: 파일 I/O·API 호출 없음. 문자열 in → 구조체 out.

/**
 * Slack 마크업 잔존물 제거.
 *   <tel:080-851-8282|080-851-8282> → 080-851-8282
 *   <https://www.bokjiro.go.kr/>    → https://www.bokjiro.go.kr/
 *   <https://x.com|여기>            → 여기
 */
export function cleanSlackMarkup(text) {
  return text
    .replace(/<tel:([^|>]+)\|([^>]*)>/g, (_, num, label) => label || num)
    .replace(/<tel:([^>]+)>/g, '$1')
    .replace(/<(https?:\/\/[^|>]+)\|([^>]*)>/g, (_, url, label) => label || url)
    .replace(/<(https?:\/\/[^>]+)>/g, '$1')
    .replace(/<mailto:([^|>]+)\|([^>]*)>/g, (_, addr, label) => label || addr)
    .replace(/```/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 정제본 txt를 Item 배열로 파싱.
 * 블록 형식:
 *   [문의 182] 카테고리: 계좌 · 투자
 *   문의 내용 힌트: ...        (선택 — 답변 파생 텍스트이므로 버린다)
 *   답변:
 *   ...
 */
export function parseSource(raw) {
  const blocks = raw.split(/\n-{20,}\n/);
  const items = [];
  const skipped = [];

  for (const block of blocks) {
    const header = block.match(/\[문의\s+(\d+)\]\s*카테고리:\s*(.+)/);
    if (!header) continue;

    const idx = block.indexOf('\n답변:');
    if (idx === -1) { skipped.push({ id: Number(header[1]), reason: '답변 섹션 없음' }); continue; }

    const answer = cleanSlackMarkup(block.slice(idx + '\n답변:'.length));
    if (!answer) { skipped.push({ id: Number(header[1]), reason: '답변 본문 비어있음' }); continue; }

    items.push({ id: Number(header[1]), category: header[2].trim(), answer });
  }
  return { items, skipped };
}

// Plan SC: 리스크 "답변 원문에 특정 고객의 개인정보 포함" — 전수 스캔 후 육안 확인
// 파이/한화의 공개 대표번호는 개인정보가 아니므로 제외한다.
const PUBLIC_NUMBERS = ['080-851-8282', '0808518282'];

const PII_PATTERNS = [
  { kind: '주민등록번호', re: /\b\d{6}\s*[-–]\s*[1-4]\d{6}\b/g },
  { kind: '휴대폰번호',   re: /\b01[016-9]\s*[-–\s]?\s*\d{3,4}\s*[-–\s]?\s*\d{4}\b/g },
  { kind: '유선번호',     re: /\b0(?:2|[3-6][0-9]|70|80)\s*[-–]\s*\d{3,4}\s*[-–]\s*\d{4}\b/g },
  { kind: '카드번호',     re: /\b\d{4}\s*[-–]\s*\d{4}\s*[-–]\s*\d{4}\s*[-–]\s*\d{4}\b/g },
  { kind: '계좌번호추정', re: /\b\d{3,6}\s*[-–]\s*\d{2,6}\s*[-–]\s*\d{2,7}\b/g },
  { kind: '이메일',       re: /\b[\w.+-]+@[\w-]+\.[\w.]+\b/g },
];

export function scanPII(items) {
  const hits = [];
  for (const item of items) {
    for (const { kind, re } of PII_PATTERNS) {
      for (const m of item.answer.matchAll(new RegExp(re))) {
        const value = m[0];
        if (PUBLIC_NUMBERS.includes(value.replace(/[\s–]/g, '-'))) continue;
        if (PUBLIC_NUMBERS.includes(value.replace(/\D/g, ''))) continue;
        const at = m.index ?? 0;
        hits.push({
          id: item.id,
          kind,
          value,
          context: item.answer.slice(Math.max(0, at - 35), at + value.length + 35).replace(/\n/g, ' '),
        });
      }
    }
  }
  return hits;
}
