// Design Ref: §9.1 Domain — 순수 모듈.
// document·window·fetch 를 참조하지 않는다. Node 평가 스크립트가 그대로 import 한다 (§9.2 규칙 1).

// Design Ref: §3.4 — vectors.bin 포맷. 쓰기 측은 tools/lib-vec.mjs.
const MAGIC = 'PIVE';
const FORMAT_VERSION = 1;
const HEADER_BYTES = 12;

// Design Ref: §12.4 — 잠정값. module-4에서 160건 전체 분포로 확정한다.
//
// 근거 (13건 부분 인덱스 실측, gemini-embedding-2 + 합성 질문):
//   정답 1위      0.814, 0.859
//   정답 2위권    0.699, 0.776
//   인덱스에 없는 주제  0.654  ← 이 값이 'low'로 떨어져야 한다
//
// 주의: 항목이 13건뿐이라 무관 질의의 최고점이 낮게 나온다. 160건에서는
// 후보가 많아져 무관 질의의 최고점도 올라가므로, 최종값은 더 높아질 가능성이 크다.
export const CONFIDENCE_THRESHOLDS = { high: 0.78, medium: 0.68 };

export const TOP_K = 5;

export class BadVectorFormat extends Error {
  constructor(message) { super(message); this.name = 'BadVectorFormat'; }
}

/**
 * vectors.bin ArrayBuffer → { dim, count, scales, data }
 * data 는 Int8Array, i번째 벡터는 data.subarray(i*dim, (i+1)*dim).
 */
export function parseVectors(buffer) {
  const view = new DataView(buffer);
  if (buffer.byteLength < HEADER_BYTES) throw new BadVectorFormat('벡터 파일이 너무 짧습니다');

  const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (magic !== MAGIC) throw new BadVectorFormat(`매직 불일치: ${magic}`);

  const version = view.getUint16(4, true);
  if (version !== FORMAT_VERSION) throw new BadVectorFormat(`포맷 버전 불일치: ${version}`);

  const dim = view.getUint16(6, true);
  const count = view.getUint32(8, true);
  const expected = HEADER_BYTES + count * 4 + count * dim;
  if (buffer.byteLength !== expected) {
    throw new BadVectorFormat(`크기 불일치: ${expected} 기대, ${buffer.byteLength} 수신`);
  }

  const scales = new Float32Array(buffer.slice(HEADER_BYTES, HEADER_BYTES + count * 4));
  const data = new Int8Array(buffer, HEADER_BYTES + count * 4, count * dim);
  return { dim, count, scales, data };
}

/**
 * 쿼리 벡터와 i번째 저장 벡터의 코사인 유사도.
 * 양쪽 모두 L2 정규화되어 있으므로 내적과 같다 (§3.4).
 * 역양자화 v ≈ q * scale / 127 에서 scale/127 은 상수이므로 루프 밖으로 뺀다.
 */
function similarity(query, store, i) {
  const { dim, scales, data } = store;
  const base = i * dim;
  let dot = 0;
  for (let d = 0; d < dim; d++) dot += query[d] * data[base + d];
  return (dot * scales[i]) / 127;
}

export function classifyConfidence(topScore) {
  if (topScore >= CONFIDENCE_THRESHOLDS.high) return 'high';
  if (topScore >= CONFIDENCE_THRESHOLDS.medium) return 'medium';
  return 'low';
}

/**
 * Design Ref: §2.2 — 벡터 단위로 점수를 낸 뒤 부모 항목(답변) 단위로 max 집계한다.
 * 한 답변에 합성 질문 여러 개가 매달려 있으므로, 그중 가장 잘 맞는 하나의 점수를 그 답변의 점수로 삼는다.
 *
 * @param {number[]} queryVector  L2 정규화된 쿼리 벡터
 * @param {{items: Array}} index  index.json
 * @param {object} store          parseVectors() 결과
 * @returns {{results: Array, confidence: string}}
 */
export function search(queryVector, index, store, k = TOP_K) {
  if (queryVector.length !== store.dim) {
    throw new BadVectorFormat(`쿼리 차원 불일치: ${store.dim} 기대, ${queryVector.length} 수신`);
  }

  const scored = [];
  for (const item of index.items) {
    let best = -Infinity;
    for (let v = 0; v < item.vecCount; v++) {
      const s = similarity(queryVector, store, item.vecStart + v);
      if (s > best) best = s;
    }
    scored.push({ id: item.id, category: item.category, answer: item.answer, score: best });
  }

  scored.sort((a, b) => b.score - a.score);
  const results = scored.slice(0, k);
  return { results, confidence: classifyConfidence(results[0]?.score ?? -1) };
}
