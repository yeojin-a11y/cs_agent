#!/usr/bin/env node
// Design Ref: §11.2 — 데이터 파이프라인. 각 단계는 개별 실행·재개 가능.
//
//   node tools/build-index.mjs models      모델 ID 실측 (§10.3 미확정 항목 해소)
//   node tools/build-index.mjs parse       txt → items.json + PII 리포트 (키 불필요)
//   node tools/build-index.mjs questions   합성 질문 역생성 (재개 가능)
//   node tools/build-index.mjs review      합성 질문 무작위 20건 육안 검수 출력
//   node tools/build-index.mjs embed       임베딩 + 양자화 → index.json + vectors.bin
//
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSource, scanPII } from './lib-parse.mjs';
import { packVectors, normalize, roundTripFidelity } from './lib-vec.mjs';
import { loadKey, listModels, generateText, embedText, sleep } from './lib-gemini.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const P = {
  source:    join(ROOT, 'data', '파이CS_QA_정제본.txt'),
  items:     join(ROOT, 'data', 'items.json'),
  questions: join(ROOT, 'data', 'questions.json'),
  index:     join(ROOT, 'data', 'index.json'),
  vectors:   join(ROOT, 'data', 'vectors.bin'),
  pii:       join(ROOT, 'data', 'pii-report.json'),
  env:       join(ROOT, '.env'),
};

const QUESTIONS_PER_ITEM = 3;
const DIM = 768;

const readJSON  = (p) => JSON.parse(readFileSync(p, 'utf8'));
const writeJSON = (p, o) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(o, null, 2)); };

// ── models ────────────────────────────────────────────────────────────────
async function cmdModels() {
  const key = loadKey(P.env);
  const models = await listModels(key);
  const show = (label, filter) => {
    const list = models.filter(filter);
    console.log(`\n${label} (${list.length}개)`);
    for (const m of list) {
      const id = m.name.replace(/^models\//, '');
      const dims = m.outputDimensionality ? ` dim=${m.outputDimensionality}` : '';
      console.log(`  ${id}${dims}`);
    }
  };
  show('임베딩 가능 모델', (m) => (m.supportedGenerationMethods ?? []).includes('embedContent'));
  show('생성 가능 모델',   (m) => (m.supportedGenerationMethods ?? []).includes('generateContent'));
  console.log(`\n총 ${models.length}개 모델 조회됨`);
  console.log('→ 확정한 모델 ID를 .env 의 EMBED_MODEL / GEN_MODEL 에 기입하세요.');
}

// ── parse ─────────────────────────────────────────────────────────────────
function cmdParse() {
  const { items, skipped } = parseSource(readFileSync(P.source, 'utf8'));
  writeJSON(P.items, items);

  const byCategory = {};
  for (const it of items) byCategory[it.category] = (byCategory[it.category] ?? 0) + 1;

  console.log(`파싱 완료: ${items.length}건 → ${P.items}`);
  for (const [cat, n] of Object.entries(byCategory).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${cat}: ${n}건`);
  }
  if (skipped.length) {
    console.log(`\n건너뜀 ${skipped.length}건:`);
    for (const s of skipped) console.log(`  [문의 ${s.id}] ${s.reason}`);
  }

  const hits = scanPII(items);
  writeJSON(P.pii, hits);
  console.log(`\n개인정보 스캔: ${hits.length}건 검출 → ${P.pii}`);
  if (hits.length) {
    const byKind = {};
    for (const h of hits) byKind[h.kind] = (byKind[h.kind] ?? 0) + 1;
    for (const [kind, n] of Object.entries(byKind)) console.log(`  ${kind}: ${n}건`);
    console.log('\n⚠️  검출 항목은 육안 확인이 필요합니다 (Design §7 위협 6).');
    console.log(`   확인: node tools/build-index.mjs pii`);
  }
}

function cmdPII() {
  const hits = readJSON(P.pii);
  if (!hits.length) return console.log('검출된 항목이 없습니다.');
  for (const h of hits) {
    console.log(`\n[문의 ${h.id}] ${h.kind}: ${h.value}`);
    console.log(`  …${h.context}…`);
  }
  console.log(`\n총 ${hits.length}건`);
}

// ── questions ─────────────────────────────────────────────────────────────
// Design Ref: §11.2 step 3 — 무료 티어 일일 생성 한도(20~) 때문에 4건씩 묶어 호출한다.
const BATCH_SIZE = 4;

const QUESTION_PROMPT = (batch) => `아래는 금융 앱 "파이"의 고객센터가 실제로 발송한 답변 ${batch.length}건입니다.
각 답변에 대해, 그 답변을 받았을 고객이 **처음에 무엇을 물어봤을지** 있음직한 문의 ${QUESTIONS_PER_ITEM}개씩 복원하세요.

규칙:
- 고객이 직접 쓴 말투로 작성하세요. 상담원 말투가 아닙니다.
- ${QUESTIONS_PER_ITEM}개는 서로 다른 표현이어야 합니다. 같은 상황을 다른 단어로 묻는 방식으로 다양화하세요.
  (예: 공식 용어를 쓴 문의 / 일상어로 쓴 문의 / 증상만 짧게 말한 문의)
- 답변에 등장하지 않는 새로운 상황을 지어내지 마세요.
- 각 문의는 한 문장에서 세 문장 사이로 쓰세요.
- 인사말이나 맺음말은 넣지 마세요.
- 답변마다 반드시 정확히 ${QUESTIONS_PER_ITEM}개씩 만드세요.

출력 형식: 아래 JSON 객체 하나만. 설명·코드펜스 없이 객체만 출력하세요.
키는 각 답변의 ID 문자열입니다.
{${batch.map((b) => `"${b.id}": ["문의1", "문의2", "문의3"]`).join(', ')}}

${batch.map((b) => `=== ID ${b.id} (카테고리: ${b.category}) ===\n${b.answer}`).join('\n\n')}`;

function parseQuestionObject(raw, batch) {
  const text = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error(`JSON 객체 없음: ${text.slice(0, 120)}`);
  const obj = JSON.parse(text.slice(start, end + 1));

  const out = {};
  for (const item of batch) {
    const arr = obj[String(item.id)];
    if (!Array.isArray(arr)) continue;                       // 누락분은 다음 실행에서 재시도
    const clean = arr.filter((q) => typeof q === 'string' && q.trim().length >= 5).map((q) => q.trim());
    if (clean.length < QUESTIONS_PER_ITEM) continue;
    out[item.id] = clean.slice(0, QUESTIONS_PER_ITEM);
  }
  return out;
}

async function cmdQuestions() {
  const key = loadKey(P.env);
  const model = process.env.GEN_MODEL ?? readEnvVar('GEN_MODEL');
  if (!model) throw new Error('.env 에 GEN_MODEL 을 지정하세요. (먼저 `models` 로 실측)');

  const items = readJSON(P.items);
  const done = existsSync(P.questions) ? readJSON(P.questions) : {};
  const todo = items.filter((it) => !done[it.id]);

  const batches = [];
  for (let i = 0; i < todo.length; i += BATCH_SIZE) batches.push(todo.slice(i, i + BATCH_SIZE));

  console.log(`합성 질문 생성 (${model})`);
  console.log(`  전체 ${items.length}건 / 완료 ${items.length - todo.length}건 / 남은 ${todo.length}건`);
  console.log(`  ${BATCH_SIZE}건씩 묶어 API ${batches.length}회 호출 예정`);
  if (!todo.length) return console.log('이미 전부 생성되어 있습니다.');

  let quotaHit = false;
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    try {
      const raw = await generateText(key, model, QUESTION_PROMPT(batch), { maxOutputTokens: 2048 });
      Object.assign(done, parseQuestionObject(raw, batch));
      writeJSON(P.questions, done);
      console.log(`  배치 ${i + 1}/${batches.length} → 누적 ${Object.keys(done).length}/${items.length}건`);
    } catch (e) {
      const msg = e.message ?? '';
      if (/PerDay|quota|429/i.test(msg)) {
        console.error(`\n  일일 할당량 소진으로 중단합니다. (배치 ${i + 1}/${batches.length})`);
        quotaHit = true;
        break;
      }
      console.error(`  배치 ${i + 1} 실패: ${msg.slice(0, 120)}`);
    }
    await sleep(500);
  }
  writeJSON(P.questions, done);

  const n = Object.keys(done).length;
  console.log(`\n누적 ${n}/${items.length}건 → ${P.questions}`);
  if (n < items.length) {
    console.log(quotaHit
      ? '할당량이 회복되면(보통 태평양시 자정) 같은 명령을 다시 실행하세요. 남은 분량만 처리합니다.'
      : '같은 명령을 다시 실행하면 남은 분량만 재시도합니다.');
  } else {
    console.log('→ 다음: node tools/build-index.mjs review  (육안 검수 게이트)');
  }
}

// ── review (Design §11.2 step 3 게이트) ───────────────────────────────────
function cmdReview() {
  const items = readJSON(P.items);
  const questions = readJSON(P.questions);
  const ids = Object.keys(questions);
  const sample = ids.sort(() => Math.random() - 0.5).slice(0, 20);

  for (const id of sample) {
    const item = items.find((it) => String(it.id) === id);
    console.log(`\n${'─'.repeat(70)}`);
    console.log(`[문의 ${id}] ${item.category}`);
    console.log(`답변 앞부분: ${item.answer.replace(/\n/g, ' ').slice(0, 110)}…`);
    questions[id].forEach((q, i) => console.log(`  Q${i + 1}. ${q}`));
  }
  console.log(`\n${'─'.repeat(70)}`);
  console.log(`무작위 20건 표시. 부적절 생성이 2건을 넘으면 프롬프트를 수정하고 재생성하세요.`);
  console.log(`(Plan §4.2 품질 기준: 20건 중 부적절 ≤ 2건)`);
}

// ── embed ─────────────────────────────────────────────────────────────────
async function cmdEmbed() {
  const key = loadKey(P.env);
  const model = process.env.EMBED_MODEL ?? readEnvVar('EMBED_MODEL');
  if (!model) throw new Error('.env 에 EMBED_MODEL 을 지정하세요. (먼저 `models` 로 실측)');

  const items = readJSON(P.items);
  const questions = readJSON(P.questions);
  const partial = process.argv.includes('--partial');
  const missing = items.filter((it) => !questions[it.id]);
  if (missing.length && !partial) {
    throw new Error(`합성 질문이 없는 항목 ${missing.length}건. 먼저 questions 를 완료하거나 --partial 로 부분 빌드하세요.`);
  }
  if (partial && missing.length) console.log(`부분 빌드: 질문 보유 ${items.length - missing.length}건만 인덱싱합니다.`);

  const cachePath = join(ROOT, 'data', '.embed-cache.json');
  const cache = existsSync(cachePath) ? readJSON(cachePath) : {};

  const indexItems = [];
  const vectors = [];
  let cursor = 0, apiCalls = 0;

  const target = items.filter((it) => questions[it.id]);
  for (let i = 0; i < target.length; i++) {
    const item = target[i];
    const qs = questions[item.id];
    for (const q of qs) {
      const cacheKey = `${model}|${DIM}|${q}`;
      let vec = cache[cacheKey];
      if (!vec) {
        vec = normalize(await embedText(key, model, q, 'RETRIEVAL_DOCUMENT', DIM));
        cache[cacheKey] = vec;
        apiCalls++;
        if (apiCalls % 20 === 0) writeJSON(cachePath, cache);
        await sleep(200);
      }
      if (vec.length !== DIM) throw new Error(`차원 불일치: ${DIM} 기대, ${vec.length} 수신`);
      vectors.push(vec);
    }
    indexItems.push({
      id: item.id, category: item.category, answer: item.answer,
      questions: qs, vecStart: cursor, vecCount: qs.length,
    });
    cursor += qs.length;
    process.stdout.write(`\r  ${i + 1}/${target.length} 항목 (API ${apiCalls}회)   `);
  }
  writeJSON(cachePath, cache);

  const fidelity = vectors.slice(0, 50).map(roundTripFidelity);
  const avgFid = fidelity.reduce((a, b) => a + b, 0) / fidelity.length;

  writeJSON(P.index, {
    version: 2,
    builtAt: new Date().toISOString(),
    embedModel: model,
    dim: DIM,
    itemCount: indexItems.length,
    vectorCount: vectors.length,
    items: indexItems,
  });
  const buf = packVectors(vectors);
  writeFileSync(P.vectors, buf);

  console.log(`\n\n완료`);
  console.log(`  index.json   ${indexItems.length}건  ${(readFileSync(P.index).length / 1024).toFixed(0)}KB`);
  console.log(`  vectors.bin  ${vectors.length}벡터 × ${DIM}차원  ${(buf.length / 1024).toFixed(0)}KB`);
  console.log(`  양자화 충실도 ${avgFid.toFixed(5)} (1.0에 가까울수록 손실 적음)`);
  console.log(`  신규 API 호출 ${apiCalls}회`);
  if (buf.length > 400 * 1024) console.log(`  ⚠️  Plan 비기능 요건(≤400KB) 초과`);
}

function readEnvVar(name) {
  if (!existsSync(P.env)) return null;
  for (const line of readFileSync(P.env, 'utf8').split('\n')) {
    const m = line.match(new RegExp(`^\\s*${name}\\s*=\\s*(.+?)\\s*$`));
    if (m) return m[1].replace(/^["']|["']$/g, '');
  }
  return null;
}

// ── main ──────────────────────────────────────────────────────────────────
const commands = { models: cmdModels, parse: cmdParse, pii: cmdPII, questions: cmdQuestions, review: cmdReview, embed: cmdEmbed };
const cmd = process.argv[2];
if (!commands[cmd]) {
  console.log(`사용법: node tools/build-index.mjs <명령>\n\n  ${Object.keys(commands).join('  ')}\n`);
  process.exit(1);
}
try { await commands[cmd](); }
catch (e) { console.error(`\n오류: ${e.message}`); process.exit(1); }
