// Design Ref: §9.1 Infrastructure — 프록시 호출 + 오류 코드 → 한국어 메시지 매핑 (§6.1)

// 배포 후 Worker 주소로 교체할 것 (§10.3). 공개돼도 무방한 값이다.
export const WORKER_URL = 'https://pi-cs-agent.yeojin.workers.dev';

// §6.3: 무한 로딩 금지. 실측(2026-08-24, DO 릴레이 경유) 기준으로 여유를 둔다.
//   /embed 2.2~2.9초 · /generate 12.4초(사례 0건) → 사례 5건이면 20초대까지 늘어난다.
const TIMEOUT = { embed: 15000, generate: 45000, health: 8000 };

const MESSAGES = {
  INVALID_INPUT:         '문의 내용이 너무 길거나 비어 있습니다. (최대 3000자)',
  FORBIDDEN_ORIGIN:      '허용되지 않은 접근입니다. 정식 주소로 접속해 주세요.',
  RATE_LIMITED:          '요청이 몰리고 있습니다. 잠시 후 다시 시도해 주세요.',
  UPSTREAM_RATE_LIMITED: 'AI 서비스 사용량이 한도에 도달했습니다. 한국시간 기준 오후 4~5시경 초기화됩니다.',
  DAILY_LIMIT_REACHED:   '오늘의 답변 생성 한도를 모두 사용했습니다. 한국시간 기준 오후 4~5시경 초기화됩니다.',
  UPSTREAM_ERROR:        'AI 서비스 응답에 실패했습니다. 다시 시도해 주세요.',
  EMPTY_COMPLETION:      '답변이 생성되지 않았습니다. 문의 내용을 조금 바꿔 다시 시도해 주세요.',
  DATA_LOAD_FAILED:      '사례 데이터를 불러오지 못했습니다. 새로고침해 주세요.',
  BAD_VECTOR_FORMAT:     '사례 데이터 형식이 올바르지 않습니다. 관리자에게 문의해 주세요.',
  NETWORK_ERROR:         '네트워크 연결을 확인해 주세요.',
};

export class ApiError extends Error {
  constructor(code, usage) {
    super(MESSAGES[code] ?? MESSAGES.UPSTREAM_ERROR);
    this.name = 'ApiError';
    this.code = code;
    this.usage = usage;
  }
}

async function post(path, body, timeoutMs) {
  let res;
  try {
    res = await fetch(`${WORKER_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    console.error(`[api] ${path}`, e);          // 원문은 콘솔에만 (§6.1 원칙)
    throw new ApiError('NETWORK_ERROR');
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`[api] ${path} ${res.status}`, data);
    throw new ApiError(data?.error?.code ?? 'UPSTREAM_ERROR', data?.error?.usage);
  }
  return data;
}

export const embed    = (text) => post('/embed', { text }, TIMEOUT.embed).then((d) => d.vector);
export const generate = (payload) => post('/generate', payload, TIMEOUT.generate);

export async function health() {
  try {
    const res = await fetch(`${WORKER_URL}/health`, { signal: AbortSignal.timeout(TIMEOUT.health) });
    return res.ok ? res.json() : null;
  } catch { return null; }
}

/** Design Ref: §2.2 — 인덱스와 벡터를 병렬로 받는다. */
export async function loadData() {
  const [indexRes, vecRes] = await Promise.all([
    fetch('data/index.json'),
    fetch('data/vectors.bin'),
  ]).catch(() => []);
  if (!indexRes?.ok || !vecRes?.ok) throw new ApiError('DATA_LOAD_FAILED');
  return { index: await indexRes.json(), buffer: await vecRes.arrayBuffer() };
}
