// Design Ref: §10.3 — 키는 .env 에서만 읽는다. 값을 로그에 남기지 않는다.
import { readFileSync, existsSync } from 'node:fs';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

export function loadKey(envPath) {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY.trim();
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^\s*GEMINI_API_KEY\s*=\s*(.+?)\s*$/);
      if (m) return m[1].replace(/^["']|["']$/g, '');
    }
  }
  throw new Error(
    `Gemini API 키를 찾지 못했습니다.\n` +
    `  ${envPath} 파일에 아래 한 줄을 넣어주세요:\n` +
    `  GEMINI_API_KEY=발급받은키`
  );
}

/** 키가 섞여 들어간 오류 문자열을 마스킹한다. */
function redact(text) {
  return String(text).replace(/AIza[0-9A-Za-z_-]{10,}/g, 'AIza***REDACTED***');
}

async function call(path, key, body, { retries = 3 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let res;
    try {
      res = await fetch(`${API_BASE}${path}`, {
        method: body ? 'POST' : 'GET',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      lastErr = new Error(`네트워크 오류: ${redact(e.message)}`);
      await sleep(1500 * 2 ** attempt);
      continue;
    }

    if (res.ok) return res.json();

    const text = redact(await res.text());
    // 429(할당량) / 5xx(일시 장애)는 백오프 후 재시도, 그 외는 즉시 실패
    if (res.status === 429 || res.status >= 500) {
      lastErr = new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
      await sleep(res.status === 429 ? 8000 * 2 ** attempt : 1500 * 2 ** attempt);
      continue;
    }
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
  throw lastErr;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function listModels(key) {
  const out = [];
  let pageToken = '';
  do {
    const q = pageToken ? `?pageSize=200&pageToken=${pageToken}` : '?pageSize=200';
    const data = await call(`/models${q}`, key);
    out.push(...(data.models ?? []));
    pageToken = data.nextPageToken ?? '';
  } while (pageToken);
  return out;
}

export async function generateText(key, model, prompt, config = {}) {
  const data = await call(`/models/${model}:generateContent`, key, {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.3, maxOutputTokens: 1024, ...config },
  });
  const parts = data.candidates?.[0]?.content?.parts ?? [];
  const text = parts.map((p) => p.text ?? '').join('').trim();
  if (!text) throw new Error(`빈 응답 (finishReason=${data.candidates?.[0]?.finishReason ?? '?'})`);
  return text;
}

/**
 * Design §4.2: 문서 측은 RETRIEVAL_DOCUMENT, 쿼리 측은 RETRIEVAL_QUERY.
 * 양쪽을 같은 taskType 으로 넣으면 비대칭 검색 성능이 무너진다.
 */
export async function embedText(key, model, text, taskType, outputDimensionality) {
  const body = { content: { parts: [{ text }] }, taskType };
  if (outputDimensionality) body.outputDimensionality = outputDimensionality;
  const data = await call(`/models/${model}:embedContent`, key, body);
  const values = data.embedding?.values;
  if (!Array.isArray(values) || values.length === 0) throw new Error('임베딩 응답에 values 없음');
  return values;
}
