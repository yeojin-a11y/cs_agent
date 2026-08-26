// Design Ref: §3.4 — vectors.bin 바이너리 포맷 (쓰기 측)
// 읽기 측은 js/retrieval.js. 두 구현이 같은 포맷 상수를 공유해야 한다.
// 포맷 변경 시 FORMAT_VERSION 을 올리고 js/retrieval.js 도 함께 고칠 것.

export const MAGIC = 'PIVE';
export const FORMAT_VERSION = 1;
export const HEADER_BYTES = 12;

/** L2 정규화. 코사인 유사도를 내적으로 계산하기 위한 전제. */
export function normalize(vec) {
  let sum = 0;
  for (const v of vec) sum += v * v;
  const norm = Math.sqrt(sum);
  if (norm === 0) throw new Error('영벡터는 정규화할 수 없습니다');
  return vec.map((v) => v / norm);
}

/** 정규화된 float 벡터 → { q: Int8Array, scale: number } */
export function quantize(vec) {
  let scale = 0;
  for (const v of vec) scale = Math.max(scale, Math.abs(v));
  if (scale === 0) throw new Error('영벡터는 양자화할 수 없습니다');
  const q = new Int8Array(vec.length);
  for (let i = 0; i < vec.length; i++) {
    q[i] = Math.max(-127, Math.min(127, Math.round((vec[i] / scale) * 127)));
  }
  return { q, scale };
}

/**
 * 정규화된 벡터 배열 → vectors.bin 버퍼.
 * 레이아웃: magic(4) version(2) dim(2) count(4) scales(4*count) data(dim*count)
 */
export function packVectors(vectors) {
  const count = vectors.length;
  if (count === 0) throw new Error('벡터가 없습니다');
  const dim = vectors[0].length;
  for (const v of vectors) {
    if (v.length !== dim) throw new Error(`차원 불일치: ${dim} 기대, ${v.length} 발견`);
  }

  const buf = Buffer.alloc(HEADER_BYTES + count * 4 + count * dim);
  buf.write(MAGIC, 0, 'ascii');
  buf.writeUInt16LE(FORMAT_VERSION, 4);
  buf.writeUInt16LE(dim, 6);
  buf.writeUInt32LE(count, 8);

  const dataOffset = HEADER_BYTES + count * 4;
  vectors.forEach((vec, i) => {
    const { q, scale } = quantize(vec);
    buf.writeFloatLE(scale, HEADER_BYTES + i * 4);
    for (let d = 0; d < dim; d++) buf.writeInt8(q[d], dataOffset + i * dim + d);
  });
  return buf;
}

/** 양자화 충실도 검증용 (Design §8.6): 역양자화 후 원본과의 내적. 1.0에 가까울수록 손실이 적다. */
export function roundTripFidelity(vec) {
  const { q, scale } = quantize(vec);
  let dot = 0, normQ = 0;
  for (let i = 0; i < vec.length; i++) {
    const restored = (q[i] * scale) / 127;
    dot += vec[i] * restored;
    normQ += restored * restored;
  }
  return dot / Math.sqrt(normQ);
}
