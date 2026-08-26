// Design Ref: §9.1 Presentation — DOM 바인딩 + 오케스트레이션
import { parseVectors, search, BadVectorFormat } from './retrieval.js';
import { embed, generate, loadData, health, ApiError } from './api.js';

const $ = (id) => document.getElementById(id);
let INDEX = null, STORE = null, LAST_QUESTION = '';

const CONFIDENCE_LABEL = { high: '높음', medium: '보통', low: '낮음' };

function showError(message) {
  const el = $('errorMsg');
  el.textContent = message;
  el.style.display = 'block';
}
const clearError = () => { $('errorMsg').style.display = 'none'; };

// 응답이 20초대까지 걸리므로 단계를 보여준다. 스피너만 도는 화면은 고장처럼 보인다.
function setBusy(busy, stage) {
  const btn = $('generateBtn');
  btn.disabled = busy || !INDEX;
  btn.innerHTML = busy
    ? `<span class="spinner"></span>${stage ?? '처리 중...'}`
    : '답변 초안 생성';
}

/** FR-15/FR-16: 남은 할당량 표시. 3건 이하면 경고, 0이면 생성 차단. */
function renderUsage(usage) {
  const el = $('usageInfo');
  if (!usage) { el.style.display = 'none'; return; }
  const { used, limit, remaining } = usage;
  el.style.display = 'block';
  el.textContent = `오늘 ${used}/${limit}건 사용 · ${remaining}건 남음`;
  el.className = remaining <= 0 ? 'usage danger' : remaining <= 3 ? 'usage warn' : 'usage';
  if (remaining <= 0) {
    $('generateBtn').disabled = true;
    $('generateBtn').textContent = '오늘 한도 소진';
  }
}

function renderResult(answer, results, confidence) {
  $('answerBox').textContent = answer;

  const badge = $('confidenceBadge');
  badge.textContent = `신뢰도 ${CONFIDENCE_LABEL[confidence]}`;
  badge.className = `badge conf-${confidence}`;
  badge.style.display = 'inline-block';

  const list = $('refList');
  list.innerHTML = '';
  for (const r of results) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="ref-cat"></span><span class="ref-score">${Math.round(r.score * 100)}%</span>`;
    li.querySelector('.ref-cat').textContent = r.category;   // textContent 로 XSS 차단
    list.appendChild(li);
  }
  $('refSummary').textContent = `참고한 사례 ${results.length}건`;
  $('refCases').style.display = results.length ? 'block' : 'none';

  const card = $('resultCard');
  card.style.display = 'block';
  card.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function run(question) {
  clearError();
  setBusy(true, '유사 사례 검색 중...');
  try {
    // §6.3: /embed 가 실패해도 가이드 기반 답변은 나와야 한다 (우아한 저하)
    let results = [], confidence = 'low';
    try {
      const qVec = await embed(question);
      ({ results, confidence } = search(qVec, INDEX, STORE));
    } catch (e) {
      if (e instanceof BadVectorFormat) throw e;
      console.warn('[app] 검색 생략, 가이드 기반으로 진행', e);
    }

    const payload = {
      question,
      confidence,
      contexts: results.map(({ id, category, answer, score }) => ({ id, category, answer, score })),
    };
    setBusy(true, '답변 작성 중... (20초 정도 걸려요)');
    const { answer, usage } = await generate(payload);
    renderResult(answer, results, confidence);
    renderUsage(usage);
  } catch (e) {
    if (e instanceof BadVectorFormat) showError('사례 데이터 형식이 올바르지 않습니다. 관리자에게 문의해 주세요.');
    else if (e instanceof ApiError) { showError(e.message); renderUsage(e.usage); }
    else { console.error('[app]', e); showError('처리 중 오류가 발생했습니다.'); }
  } finally {
    setBusy(false);
  }
}

function onGenerate() {
  const question = $('question').value.trim();
  if (!question) return showError('문의 내용을 입력해주세요.');
  LAST_QUESTION = question;
  run(question);
}

async function init() {
  $('question').addEventListener('input', function () { $('charCount').textContent = this.value.length; });
  $('generateBtn').addEventListener('click', onGenerate);
  $('regenBtn').addEventListener('click', () => LAST_QUESTION && run(LAST_QUESTION));
  $('copyBtn').addEventListener('click', async () => {
    await navigator.clipboard.writeText($('answerBox').textContent);
    const t = $('toast');
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 2200);
  });

  try {
    const { index, buffer } = await loadData();
    INDEX = index;
    STORE = parseVectors(buffer);
    $('dataStatus').style.display = 'none';
    setBusy(false);
  } catch (e) {
    console.error('[app] 데이터 로드 실패', e);
    $('dataStatus').textContent = e instanceof BadVectorFormat
      ? '사례 데이터 형식이 올바르지 않습니다. 관리자에게 문의해 주세요.'
      : '사례 데이터를 불러오지 못했습니다. 새로고침해 주세요.';
    $('dataStatus').className = 'data-status error';
  }

  health().then((h) => h?.usage && renderUsage(h.usage));
}

init();
