# 파이 CS 답변 도우미 v2 기획 문서

> **Summary**: 배포된 CS 답변 생성 도우미에서 API 키 입력 단계를 제거하고, 미작동 상태인 사례 검색을 임베딩 기반 시맨틱 검색으로 교체한다.
>
> **Project**: cs_agent (파이 CS 답변 도우미)
> **Version**: v1 배포본 → v2
> **Author**: yoon-yeojin
> **Date**: 2026-08-21
> **Status**: Draft

---

## Executive Summary

| 관점 | 내용 |
|------|------|
| **Problem** | 배포본의 `getExamples()`가 입력된 문의를 **전혀 사용하지 않고** 카테고리 1~3번의 첫 답변만 고정 반환한다. 문의 내용과 무관하게 항상 같은 3건이 프롬프트에 들어가므로 "맥락에 맞는 답변"이 구조적으로 불가능하다. 더불어 담당자는 접속할 때마다 Gemini API 키를 재입력해야 한다(`sessionStorage`). |
| **Solution** | ① Cloudflare Worker를 키 보관 프록시로 두어 프런트에서 키 입력 UI를 완전히 제거한다. ② 원본 160건 전체를 대상으로 답변마다 합성 질문 3개를 역생성해 임베딩하고, 문의 입력 시 코사인 유사도 상위 5건을 근거로 주입하는 검색-생성(RAG) 구조로 교체한다. |
| **Function/UX Effect** | 접속 즉시 사용 가능(키 입력 0회). 참조 사례가 30건→160건, 고정 3건→문의별 동적 상위 5건. 화면에 참조된 사례와 유사도·신뢰도가 노출되어 담당자가 초안을 신뢰할지 판단할 수 있다. |
| **Core Value** | 담당자별로 흩어진 응대 품질을, 실제 축적된 160건의 검증된 답변에 근거해 상향 평준화한다. |

---

## Context Anchor

| Key | Value |
|-----|-------|
| **WHY** | 검색 로직이 사실상 부재하여 생성 답변이 문의 맥락과 무관함 + 매 접속 시 키 재입력 마찰 |
| **WHO** | 파이 고객센터 응대 담당자 다수 (사내, 동시 이용) |
| **RISK** | 공개 프록시 엔드포인트의 무단 호출로 인한 Gemini 할당량 소진 |
| **SUCCESS** | 평가셋 20건 기준 Top-5 검색 적중률 ≥ 80%, 키 입력 횟수 0회 |
| **SCOPE** | Phase 1 데이터 재구축 → Phase 2 프록시 → Phase 3 프런트 교체 → Phase 4 평가 |

---

## 1. Overview

### 1.1 Purpose

이미 GitHub Pages에 배포되어 운영 중인 `파이 CS 답변 도우미`의 두 가지 결함을 해소한다.

1. **진입 마찰 제거** — 최초 접속 시 Gemini API 키 입력 모달을 없앤다.
2. **답변 근거 확보** — 문의 내용에 실제로 대응하는 과거 사례를 검색해 답변 생성의 근거로 사용한다.

### 1.2 Background

현행 배포본(`index.html`, 301줄) 코드 분석 결과 확인된 사실:

| 구성 | 현재 구현 | 문제 |
|------|-----------|------|
| 키 저장 | `sessionStorage.setItem('gemini_key', ...)` | 탭 종료 시 소실. 담당자마다 매 세션 재입력 |
| 사례 검색 | `getExamples(question)` — 시그니처에 `question`이 있으나 **함수 본문에서 미사용**. `cats[0..2]`의 `[0]`번 답변만 반환 | 검색이 존재하지 않음. 모든 문의에 동일한 3건 주입 |
| 탑재 데이터 | `QA_DATA = {카테고리: [답변…]}` 6개 카테고리 × 5건 = **30건** | 원본 160건 중 19%만 사용 |
| 데이터 구조 | 답변 문자열 배열만 보유. 질문 필드 없음 | 유사도 매칭의 기준축이 없음 |
| 프롬프트 | 참고 사례를 `"말투·형식 참고용"`으로만 지시 | 사례의 **내용**이 근거로 쓰이지 않음 |

원본 데이터(`data/파이CS_QA_정제본.txt`, 160건) 분석 결과:

- 카테고리 분포: 계좌·투자 51 / 증여세 신고·조회 42 / 증여+투자 패키지 32 / 앱 이용 19 / 회원정보 8 / 기타 8
- **`문의 내용 힌트` 필드(109건)는 고객 질문이 아니다.** 46건은 답변 본문의 앞 500자와 문자열이 그대로 일치하고, 나머지 63건도 답변의 변형이다. 힌트 길이 분포(중앙값 498자, 최대 524자)가 500자 절단을 뒷받침한다.
- 따라서 **데이터셋에 실제 고객 질문은 0건이며, 검증된 답변 160건만 존재한다.**
- Slack 마크업 잔존: `<tel:…|…>` 7건, `<https://…>` 8건

이 마지막 사실이 설계를 결정한다. 검색 과제가 "질문↔질문"(대칭)이 아니라 **"질문↔답변"(비대칭)**이며, 이는 키워드 중첩 방식이 가장 취약한 유형이다. 고객은 "애 계좌에서 거래내역이 안 보여요"라고 쓰지만 답변은 "자녀 명의 계정으로 로그인하신 경우에만 조회가 가능합니다"라고 되어 있어 어휘가 거의 겹치지 않는다. 임베딩 기반 시맨틱 검색이 필요하며, 여기에 합성 질문 역생성을 더해 비대칭 문제를 대칭으로 되돌린다.

### 1.3 Related Documents

- 배포본: https://yeojin-a11y.github.io/cs_agent/
- 저장소: https://github.com/yeojin-a11y/cs_agent
- 원본 데이터: `data/파이CS_QA_정제본.txt` (160건)
- 서비스 가이드: `index.html` 내 `GUIDE_DATA` 상수 (5개 섹션)

---

## 2. Scope

### 2.1 In Scope

- [ ] 원본 txt → 구조화 인덱스 변환 스크립트 (`tools/build-index.mjs`)
- [ ] Slack 마크업 정제 (`<tel:…|…>`, `<https://…>` 총 15건)
- [ ] 답변 160건 각각에 대한 합성 질문 3개 역생성 (빌드 시 1회, 총 480개)
- [ ] 합성 질문 480개 임베딩 → 바이너리 벡터 파일 생성
- [ ] Cloudflare Worker 프록시 (`/embed`, `/generate` 2개 라우트, 키는 서버 시크릿)
- [ ] 프런트엔드에서 API 키 모달·`saveKey`·`resetKey` 전면 제거
- [ ] 클라이언트 코사인 유사도 검색 (상위 5건, 부모 답변 단위 max 집계)
- [ ] 프롬프트 v2 — 검색 사례를 "말투 참고"가 아닌 **내용 근거**로 사용하도록 재작성
- [ ] 참조 사례 표시 UI (카테고리 + 유사도 %) 및 신뢰도 배지
- [ ] 평가셋 20건 구축 및 Top-5 적중률 측정

### 2.2 Out of Scope

- 구글시트 실시간 연동 (→ txt 수동 재빌드로 결정)
- 담당자 로그인·권한 관리
- 답변 피드백 수집 및 재학습 루프
- 멀티턴 대화 (1문의 = 1답변 유지)
- 레거시 `파이CS_답변도우미.html` 개선 (보존만, 수정 없음)
- 신규 카테고리 추가 및 데이터 증강

---

## 3. Requirements

### 3.1 Functional Requirements

| ID | 요구사항 | 우선순위 | 상태 |
|----|----------|----------|------|
| FR-01 | 최초 접속 시 API 키 입력 없이 즉시 사용 가능 | High | Pending |
| FR-02 | Gemini API 키는 Worker 시크릿에만 존재하며 클라이언트 번들·네트워크 응답 어디에도 노출되지 않음 | High | Pending |
| FR-03 | 원본 160건 전체를 인덱스에 포함 (현행 30건 → 160건) | High | Pending |
| FR-04 | 답변별 합성 질문 3개를 역생성하여 검색 대상으로 사용 | High | Pending |
| FR-05 | 입력된 문의를 임베딩하여 코사인 유사도 상위 5건을 검색 | High | Pending |
| FR-06 | 검색된 사례를 근거로 답변 생성 (말투 참고가 아닌 사실 근거) | High | Pending |
| FR-07 | 기존 답변 규칙 유지 — 인사말/맺음말 고정, 마크다운 굵게 금지, 계좌·투자 문의 시 한화투자증권 고객센터 안내 삽입 | High | Pending |
| FR-08 | 참조된 사례 목록(카테고리·유사도 %)을 화면에 표시 | Medium | Pending |
| FR-09 | 최상위 유사도 기반 신뢰도 배지 표시 (높음 ≥0.75 / 보통 0.60~0.75 / 낮음 <0.60) | Medium | Pending |
| FR-10 | 신뢰도 '낮음'일 때 프롬프트에서 단정 표현을 억제하고 확인 안내를 유도 | Medium | Pending |
| FR-11 | Slack 마크업 정제 후 인덱싱 | Medium | Pending |
| FR-12 | Worker에 Origin 검증 및 IP 단위 호출 제한 적용 | Medium | Pending |
| FR-13 | txt 갱신 시 단일 명령으로 인덱스 재빌드 | Low | Pending |

### 3.2 Non-Functional Requirements

| 항목 | 기준 | 측정 방법 |
|------|------|-----------|
| 검색 지연 | 클라이언트 코사인 연산 < 50ms (480벡터) | `performance.now()` 계측 |
| 전체 응답 | 문의 입력 → 답변 출력 < 8초 (임베딩 1회 + 생성 1회) | 수동 계측 10회 평균 |
| 초기 로드 | 벡터 파일 ≤ 400KB, 최초 로드 < 3초 / 이후 CDN 캐시 | DevTools Network |
| 키 노출 | 배포된 정적 자산 전체 grep에서 키 문자열 0건 | `grep -r 'AIza' dist/` |
| 가용성 | Worker 무료 티어 한도 내 동작 (일 10만 요청) | Cloudflare 대시보드 |
| 브라우저 | Chrome / Edge / Safari 최신 2개 버전 | 수동 확인 |

---

## 4. Success Criteria

### 4.1 Definition of Done

- [ ] FR-01 ~ FR-07 (High) 전량 구현 완료
- [ ] 배포본 접속 시 키 모달이 나타나지 않음
- [ ] 배포 정적 자산에서 API 키 문자열 검출 0건
- [ ] 인덱스에 160건 전량 탑재 확인
- [ ] 평가셋 20건에 대한 검색 결과 육안 검수 완료
- [ ] GitHub Pages 재배포 및 Worker 배포 완료

### 4.2 Quality Criteria

- [ ] **Top-5 검색 적중률 ≥ 80%** — 담당자가 작성한 실제 문의 20건에 대해, 사람이 판단한 정답 사례가 검색 상위 5건에 포함되는 비율
- [ ] **Top-1 적중률 ≥ 55%**
- [ ] 서비스 범위 밖 문의(적금·연금 등) 5건 투입 시 5건 모두 "제공하지 않는 서비스"로 안내 (환각 방어)
- [ ] 합성 질문 480개 중 무작위 20개 육안 검수에서 부적절 생성 ≤ 2건
- [ ] 콘솔 에러 0건

---

## 5. Risks and Mitigation

| 리스크 | 영향 | 발생가능성 | 완화 방안 |
|--------|------|-----------|-----------|
| 공개 프록시 URL이 스크래핑되어 무단 호출 → Gemini 할당량 소진 | High | Medium | Origin 화이트리스트(`https://yeojin-a11y.github.io`) + IP당 호출 제한(10분 30회) + Worker 일일 상한. 사내 전용이 확실히 필요하면 Cloudflare Access(무료, 사내 이메일 인증) 추가 |
| 합성 질문이 답변 내용을 잘못 요약 → 검색 품질 저하 | High | Medium | 빌드 후 무작위 20건 육안 검수를 릴리스 게이트로 강제. 온도 0.3 고정, JSON 스키마 강제 |
| 임베딩 모델명·차원이 문서와 다름 | Medium | Medium | Phase 1 착수 시 `models.list` 호출로 실사용 가능 모델 확인 후 확정. 현행 코드의 `gemini-3.6-flash`도 함께 검증 |
| Gemini 무료 티어 rate limit(429) — 담당자 동시 사용 | Medium | Medium | Worker에서 429 감지 시 지수 백오프 재시도 1회 + 사용자에게 "잠시 후 재시도" 안내. 초과 반복 시 유료 전환 검토 |
| 160건에 없는 신규 유형 문의 | Medium | High | 신뢰도 '낮음' 배지 + 프롬프트에서 단정 억제(FR-10). 담당자가 초안을 신뢰하지 않아야 할 때를 명시적으로 알림 |
| 답변 원문에 특정 고객의 개인정보·상황이 포함 | High | Low | Phase 1에서 160건 전수 스캔 (이름·연락처·계좌번호·금액 패턴). 검출 시 마스킹 후 인덱싱 |
| 벡터 파일이 커져 초기 로드 지연 | Low | Low | int8 양자화(768차원 기준 약 370KB). 초과 시 차원 256으로 절단 |

---

## 6. Impact Analysis

### 6.1 Changed Resources

| 리소스 | 유형 | 변경 내용 |
|--------|------|-----------|
| `index.html` | 정적 페이지 | 키 모달 제거, `QA_DATA` 인라인 상수 제거, 검색·프록시 호출 로직 신규, 결과 UI 확장 |
| `data/index.json` | 신규 데이터 | 160건 메타데이터 + 정제된 답변 본문 |
| `data/vectors.bin` | 신규 데이터 | 합성 질문 480개의 임베딩 벡터 |
| `tools/build-index.mjs` | 신규 스크립트 | txt → 인덱스 + 벡터 변환 |
| `worker/index.js` | 신규 서비스 | Cloudflare Worker 프록시 |
| `파이CS_답변도우미.html` | 레거시 | 변경 없음 (보존) |
| Gemini API 키 | 시크릿 | 클라이언트 입력 → Worker 환경변수로 이관 |

### 6.2 Current Consumers

| 리소스 | 동작 | 코드 경로 | 영향 |
|--------|------|-----------|------|
| `QA_DATA` | READ | `index.html` → `getExamples()` | **Breaking** — 상수 삭제, `data/index.json` fetch로 대체 |
| `sessionStorage['gemini_key']` | READ/WRITE | `saveKey()`, `resetKey()`, `generate()` | **Breaking** — 3개 함수 전부 제거 |
| `GUIDE_DATA` | READ | `buildPrompt()` | None — 상수 그대로 유지 |
| Gemini `generateContent` | CALL | `generate()` 내 직접 fetch | **Breaking** — Worker `/generate` 경유로 변경 |
| 답변 규칙(인사말·맺음말·한화 안내) | READ | `buildPrompt()` 프롬프트 문자열 | Needs verification — 프롬프트 v2에 **전량 이관 확인 필요** |
| 마크다운 제거 후처리 | TRANSFORM | `answer.replace(/\*\*(.*?)\*\*/g,'$1')` | None — 유지 |
| GitHub Pages 배포 | DEPLOY | 저장소 루트 `index.html` | None — 경로 유지, 담당자 북마크 URL 불변 |

### 6.3 Verification

- [ ] 프롬프트 v1의 모든 규칙 조항이 v2에 누락 없이 이관되었는지 조항 단위 대조
- [ ] `index.html` 내 `sessionStorage` / `apiKey` 잔존 참조 0건 확인
- [ ] Worker 미배포 상태에서 프런트가 명확한 오류 메시지를 표시하는지 확인 (무한 로딩 금지)
- [ ] 배포 URL 불변 확인 — 담당자 기존 북마크가 그대로 동작해야 함

---

## 7. Architecture Considerations

### 7.1 Project Level Selection

| Level | 특성 | 적합 대상 | 선택 |
|-------|------|-----------|:----:|
| **Starter** | 단순 구조, 정적 호스팅 | 정적 사이트, 랜딩 | ☑ |
| **Dynamic** | 기능 모듈 분리, BaaS 연동 | 백엔드 있는 웹앱 | ☐ |
| **Enterprise** | 계층 분리, DI, MSA | 대규모 트래픽 | ☐ |

**Starter 선택 근거**: 단일 HTML + 얇은 Worker 프록시 2라우트. 빌드 도구·프레임워크·상태관리 라이브러리 도입은 이 규모에 과잉이며, 현재 담당자가 직접 파일을 수정·배포하는 운영 방식(GitHub 웹 업로드)을 유지하는 편이 낫다.

### 7.2 Key Architectural Decisions

| 결정 항목 | 선택지 | 선택 | 근거 |
|-----------|--------|------|------|
| 키 보관 | 하드코딩 / localStorage / 서버 프록시 | **Cloudflare Worker 프록시** | 키 입력 0회 + 키 완전 비노출을 동시에 만족하는 유일한 방식 |
| 검색 방식 | 키워드 / 임베딩 / 하이브리드 | **임베딩 시맨틱 검색** | 데이터에 질문이 0건 → 질문↔답변 비대칭 검색. 키워드 중첩이 가장 취약한 유형 |
| 비대칭 보정 | taskType 지정 / 합성 질문 역생성 | **합성 질문 역생성 + `RETRIEVAL_QUERY` 지정** | 답변당 질문 3개를 만들면 대칭 검색으로 환원. 빌드 시 160콜 1회로 끝나는 최고 레버리지 |
| 검색 실행 위치 | 클라이언트 / Worker | **클라이언트** | 벡터를 Pages CDN에서 정적 서빙 → Worker는 키 보관에만 집중, 스크립트 크기 제한 무관 |
| 벡터 저장 | JSON float / base64 / 바이너리 int8 | **바이너리 int8 (`.bin`)** | 480×768 기준 약 370KB. `fetch().arrayBuffer()`로 직접 로드, 파싱 비용 없음 |
| 프레임워크 | 없음 / React / Vue | **없음 (vanilla)** | 현행 구조 유지, 담당자 직접 수정 가능성 보존 |
| 데이터 갱신 | 시트 연동 / 수동 재빌드 | **수동 재빌드** | 갱신 빈도가 낮고 시트 스키마 고정 부담이 큼 |
| 배포 | GitHub Pages + Cloudflare Workers | **양쪽 병행** | 프런트는 기존 URL 유지, Worker만 신규 |

### 7.3 시스템 구성

```
[담당자 브라우저]
       │
       │ ① 정적 로드 (키 입력 없음)
       ▼
[GitHub Pages]  index.html · data/index.json · data/vectors.bin
       │
       │ ② POST /embed   { question }
       │ ③ POST /generate { question, contexts[5] }
       ▼
[Cloudflare Worker]   env.GEMINI_API_KEY  ← 시크릿, 외부 비노출
       │  · Origin 화이트리스트
       │  · IP당 호출 제한
       ▼
[Gemini API]

검색은 ② 응답 벡터로 브라우저에서 수행:
  cosine(query, 480 벡터) → 부모 답변 단위 max 집계 → 상위 5건 → ③
```

### 7.4 폴더 구조

```
cs_agent/
├── index.html                 # 프런트 (키 입력 제거, 검색 로직 신규)
├── data/
│   ├── 파이CS_QA_정제본.txt    # 원본 (수동 갱신 대상)
│   ├── index.json             # 160건 메타 + 정제 답변
│   └── vectors.bin            # 합성 질문 480개 임베딩 (int8)
├── tools/
│   └── build-index.mjs        # txt → index.json + vectors.bin
├── worker/
│   ├── index.js               # 프록시 2라우트
│   └── wrangler.toml
├── eval/
│   └── testset.json           # 평가셋 20건
└── docs/01-plan/features/cs-answer-agent-v2.plan.md
```

---

## 8. Convention Prerequisites

### 8.1 기존 프로젝트 컨벤션

- [ ] `CLAUDE.md` — 저장소에 없음 (홈 디렉터리 CLAUDE.md는 별개 디자인시스템 문서)
- [ ] `docs/01-plan/conventions.md` — 없음
- [ ] ESLint / Prettier / tsconfig — 없음 (빌드 도구 미사용)

현행 프로젝트는 컨벤션 문서가 전무하며, 단일 HTML 규모에서는 정식 도입이 과잉이다. 아래 최소 규칙만 문서화한다.

### 8.2 정의할 컨벤션

| 항목 | 현재 | 정의 내용 | 우선순위 |
|------|------|-----------|:--------:|
| **프롬프트 규칙 위치** | HTML 내 문자열 하드코딩 | `buildPrompt()` 단일 함수에 집중, 규칙 조항을 주석 번호로 관리 | High |
| **데이터 스키마** | 없음 | `index.json` = `{version, builtAt, items:[{id, category, answer, qCount}]}` 고정 | High |
| **벡터 파일 포맷** | 없음 | 헤더(itemCount, dim, scale offset) + int8 본문. 포맷 변경 시 `version` 증가 | High |
| **비밀값 취급** | 클라이언트 입력 | 키는 `wrangler secret`으로만 주입. 저장소 커밋 금지 | High |
| **오류 처리** | `showError()` 문자열 | 네트워크/429/500을 구분해 담당자가 이해할 한국어 메시지로 매핑 | Medium |

### 8.3 환경 변수

| 변수 | 용도 | 범위 | 생성 필요 |
|------|------|------|:---------:|
| `GEMINI_API_KEY` | Gemini 임베딩·생성 호출 | Worker 시크릿 | ☑ |
| `ALLOWED_ORIGIN` | Origin 화이트리스트 | Worker 환경변수 | ☑ |
| `RATE_LIMIT_PER_10MIN` | IP당 호출 상한 (기본 30) | Worker 환경변수 | ☑ |
| `WORKER_URL` | 프런트가 호출할 프록시 주소 | `index.html` 상수 (공개 무방) | ☑ |

---

## 9. 구현 단계

| Phase | 산출물 | 해소 요구사항 | 선행 조건 |
|:-----:|--------|---------------|-----------|
| **1. 데이터 재구축** | `tools/build-index.mjs`, `data/index.json`, `data/vectors.bin` | FR-03, FR-04, FR-11 | Gemini 키 확보, 임베딩 모델명 확정 |
| **2. 프록시** | `worker/index.js`, `wrangler.toml`, 배포된 Worker URL | FR-02, FR-12 | Cloudflare 계정 |
| **3. 프런트 교체** | `index.html` v2 | FR-01, FR-05 ~ FR-10 | Phase 1·2 완료 |
| **4. 평가** | `eval/testset.json`, 측정 결과 | 4.2 품질 기준 | Phase 3 배포 |

Phase 1에는 **개인정보 전수 스캔**과 **합성 질문 육안 검수 20건**이 릴리스 게이트로 포함된다.

---

## 10. Next Steps

1. [ ] Cloudflare 계정 보유 여부 및 Gemini 키 발급 주체 확인
2. [ ] 임베딩 모델명·차원 실측 확인 (`models.list`)
3. [ ] 설계 문서 작성 (`/pdca design cs-answer-agent-v2`)
4. [ ] Phase 1 착수

---

## Version History

| 버전 | 날짜 | 변경 | 작성자 |
|------|------|------|--------|
| 0.1 | 2026-08-21 | 최초 작성. 배포본 코드 분석 및 원본 데이터 실측 반영 | yoon-yeojin |
