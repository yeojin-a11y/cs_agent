// Design Ref: §2.1 — 키 보관 프록시. GitHub Pages 는 정적이고 키를 모른다.
// Design Ref: §7 — Origin 화이트리스트 + IP 호출제한 + 일일 예산 가드.
import { buildPrompt } from './prompt.js';
export { GeminiRelay } from './relay.js';

const API = 'https://generativelanguage.googleapis.com/v1beta/models';
const MAX_TEXT = 3000;
const MAX_CONTEXTS = 5;
const MAX_CONTEXT_CHARS = 4000;
const EMBED_DIM = 768;

const json = (obj, status, origin, extra = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors(origin), ...extra },
  });

const fail = (code, message, status, origin, extra = {}) =>
  json({ error: { code, message, ...extra } }, status, origin);

function cors(origin) {
  // §7 위협 8: 와일드카드 금지. 허용된 정확값만 반환한다.
  if (!origin) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Vary': 'Origin',
  };
}

function allowedOrigin(request, env) {
  const allow = (env.ALLOWED_ORIGIN ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const origin = request.headers.get('Origin');
  if (!origin) return null;                 // 브라우저 외 호출(curl 등)
  return allow.includes(origin) ? origin : false;
}

/** FR-14: 태평양시 기준 날짜 키. Gemini 무료 티어가 이 시각에 초기화된다. */
function pacificDateKey() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

async function readCounter(env, key) {
  if (!env.KV) return 0;
  return Number((await env.KV.get(key)) ?? 0);
}

async function bumpCounter(env, key, ttl) {
  if (!env.KV) return 0;
  const next = (await readCounter(env, key)) + 1;
  await env.KV.put(key, String(next), { expirationTtl: ttl });
  return next;
}

/** §7 위협 3: IP 단위 호출 제한 */
async function rateLimited(request, env) {
  if (!env.KV) return false;
  const limit = Number(env.RATE_LIMIT_PER_10MIN ?? 30);
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  const bucket = Math.floor(Date.now() / 600_000);
  const n = await bumpCounter(env, `rl:${ip}:${bucket}`, 900);
  return n > limit;
}

/** FR-14: 일일 생성 예산 */
async function dailyUsage(env) {
  const limit = Number(env.DAILY_GENERATE_LIMIT ?? 20);
  const used = await readCounter(env, `daily:${pacificDateKey()}`);
  return { used, limit, remaining: Math.max(0, limit - used) };
}

async function gemini(path, env, body) {
  // §12.6: 상류 호출은 미국 동부(enam) 에 고정된 Durable Object 를 경유한다.
  const stub = env.RELAY.get(env.RELAY.idFromName('gemini-us'), { locationHint: 'enam' });
  const relayed = await stub.fetch('https://relay/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, body }),
  });
  const { status, text } = await relayed.json();

  if (status >= 200 && status < 300) {
    try { return { ok: true, data: JSON.parse(text) }; }
    catch { return { ok: false, status: 502, text: '상류 응답 파싱 실패' }; }
  }
  const safe = String(text).replace(/AQ\.[\w.-]+|AIza[\w-]+/g, '***');
  console.error(`[gemini] ${path} ${status} ${safe.slice(0, 300)}`);
  return { ok: false, status, text: safe.slice(0, 400) };
}

async function handleEmbed(request, env, origin) {
  const { text } = await request.json().catch(() => ({}));
  if (typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT) {
    return fail('INVALID_INPUT', `문의 내용은 1자 이상 ${MAX_TEXT}자 이하여야 합니다.`, 400, origin);
  }

  const r = await gemini(`${env.EMBED_MODEL}:embedContent`, env, {
    content: { parts: [{ text }] },
    taskType: 'RETRIEVAL_QUERY',          // §4.2: 쿼리 측은 반드시 QUERY
    outputDimensionality: EMBED_DIM,
  });
  if (!r.ok) {
    if (r.status === 429) return fail('UPSTREAM_RATE_LIMITED', 'AI 서비스 사용량이 한도에 도달했습니다.', 429, origin);
    return fail('UPSTREAM_ERROR', 'AI 서비스 응답에 실패했습니다.', 502, origin, { upstreamStatus: r.status });
  }

  const values = r.data.embedding?.values;
  if (!Array.isArray(values) || values.length !== EMBED_DIM) {
    return fail('UPSTREAM_ERROR', '임베딩 응답 형식이 올바르지 않습니다.', 502, origin);
  }
  // L2 정규화하여 반환 — 클라이언트는 내적만으로 코사인을 얻는다 (§3.4)
  let sum = 0;
  for (const v of values) sum += v * v;
  const norm = Math.sqrt(sum) || 1;
  return json({ vector: values.map((v) => v / norm) }, 200, origin);
}

async function handleGenerate(request, env, origin) {
  const body = await request.json().catch(() => ({}));
  const { question, contexts = [], confidence = 'low' } = body;

  if (typeof question !== 'string' || !question.trim() || question.length > MAX_TEXT) {
    return fail('INVALID_INPUT', `문의 내용은 1자 이상 ${MAX_TEXT}자 이하여야 합니다.`, 400, origin);
  }
  if (!Array.isArray(contexts) || contexts.length > MAX_CONTEXTS) {
    return fail('INVALID_INPUT', `참고 사례는 ${MAX_CONTEXTS}건 이하여야 합니다.`, 400, origin);
  }
  for (const c of contexts) {
    if (typeof c?.answer !== 'string' || c.answer.length > MAX_CONTEXT_CHARS ||
        typeof c?.category !== 'string' || typeof c?.score !== 'number') {
      return fail('INVALID_INPUT', '참고 사례 형식이 올바르지 않습니다.', 400, origin);
    }
  }
  if (!['high', 'medium', 'low'].includes(confidence)) {
    return fail('INVALID_INPUT', '신뢰도 값이 올바르지 않습니다.', 400, origin);
  }

  // FR-16: 한도 소진 시 호출 자체를 하지 않는다
  const usage = await dailyUsage(env);
  if (usage.remaining <= 0) {
    return fail('DAILY_LIMIT_REACHED',
      '오늘의 답변 생성 한도를 모두 사용했습니다. 한국시간 기준 오후 4~5시경 초기화됩니다.',
      429, origin, { usage });
  }

  const r = await gemini(`${env.GEN_MODEL}:generateContent`, env, {
    contents: [{ parts: [{ text: buildPrompt({ question, contexts, confidence }) }] }],
    generationConfig: {
      temperature: 0.4,
      maxOutputTokens: 2048,
      // §12.12 실측: 기본값은 답변 294토큰을 뽑으려고 내부 추론에 1,537토큰을 쓴다.
      // 정형화된 CS 답변에는 불필요하며, 이 한 줄이 전체 39.4초 → 5.5초를 만든다.
      // budget=0 은 API 가 거부하므로 256 이 실질적 최솟값이다.
      thinkingConfig: { thinkingBudget: 256 },
    },
  });

  if (!r.ok) {
    if (r.status === 429) {
      // 자체 집계가 실제 할당량과 어긋난 경우 강제 동기화 (§12.3)
      if (env.KV) await env.KV.put(`daily:${pacificDateKey()}`, String(usage.limit), { expirationTtl: 172800 });
      return fail('UPSTREAM_RATE_LIMITED',
        'AI 서비스 사용량이 한도에 도달했습니다. 한국시간 기준 오후 4~5시경 초기화됩니다.',
        429, origin, { usage: { ...usage, used: usage.limit, remaining: 0 } });
    }
    return fail('UPSTREAM_ERROR', 'AI 서비스 응답에 실패했습니다. 다시 시도해 주세요.', 502, origin, { upstreamStatus: r.status });
  }

  const parts = r.data.candidates?.[0]?.content?.parts ?? [];
  const answer = parts.map((p) => p.text ?? '').join('').replace(/\*\*(.*?)\*\*/g, '$1').trim();
  if (!answer) return fail('EMPTY_COMPLETION', '답변이 생성되지 않았습니다. 문의 내용을 조금 바꿔 다시 시도해 주세요.', 502, origin);

  await bumpCounter(env, `daily:${pacificDateKey()}`, 172800);
  return json({ answer, usage: { ...usage, used: usage.used + 1, remaining: usage.remaining - 1 } }, 200, origin);
}

export default {
  async fetch(request, env) {
    const origin = allowedOrigin(request, env);
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors(origin || undefined) });
    }
    if (url.pathname === '/health') {
      // 키 존재 여부나 값은 응답하지 않는다 (§4.2)
      return json({ ok: true, version: '2.0.0', colo: request.cf?.colo ?? null,
                    country: request.cf?.country ?? null, usage: await dailyUsage(env) }, 200, origin || undefined);
    }
    if (origin === false) {
      return fail('FORBIDDEN_ORIGIN', '허용되지 않은 접근입니다. 정식 주소로 접속해 주세요.', 403, undefined);
    }
    if (request.method !== 'POST') {
      return fail('INVALID_INPUT', '지원하지 않는 요청입니다.', 405, origin || undefined);
    }
    if (await rateLimited(request, env)) {
      return fail('RATE_LIMITED', '요청이 몰리고 있습니다. 잠시 후 다시 시도해 주세요.', 429, origin || undefined, { retryAfter: 300 });
    }

    try {
      if (url.pathname === '/embed')    return await handleEmbed(request, env, origin || undefined);
      if (url.pathname === '/generate') return await handleGenerate(request, env, origin || undefined);
    } catch (e) {
      return fail('UPSTREAM_ERROR', '처리 중 오류가 발생했습니다.', 502, origin || undefined);
    }
    return fail('INVALID_INPUT', '존재하지 않는 경로입니다.', 404, origin || undefined);
  },
};
