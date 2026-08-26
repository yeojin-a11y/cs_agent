// Design Ref: §12.6 — Gemini API 는 일부 지역(홍콩 등)을 지원하지 않는다.
// Cloudflare 는 한국 접속자를 HKG 엣지에 배치하는 경우가 있어 400 FAILED_PRECONDITION 이 발생했다.
// Durable Object 는 locationHint 로 실행 지역을 지정할 수 있으므로, 상류 호출만 미국 DO 를 경유시킨다.
export class GeminiRelay {
  constructor(state, env) { this.env = env; }

  async fetch(request) {
    const { path, body } = await request.json();
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.env.GEMINI_API_KEY },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return new Response(
      JSON.stringify({ status: res.status, text }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  }
}
