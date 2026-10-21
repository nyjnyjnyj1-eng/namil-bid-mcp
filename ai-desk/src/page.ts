// 입력창 화면. 휴대폰 브라우저에서도 쓸 수 있게 한 장짜리로 만듭니다.
export const PAGE_HTML = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AI 작업 입력창</title>
<style>
  :root { --bg:#f7f7f5; --card:#fff; --text:#1f1f1f; --muted:#6b6b6b; --line:#e3e3e0; --accent:#2f6fde; --bad:#c0392b; }
  @media (prefers-color-scheme: dark) { :root { --bg:#191919; --card:#232323; --text:#ececec; --muted:#a0a0a0; --line:#353535; --accent:#6b9bff; --bad:#ff7b6b; } }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:16px/1.55 system-ui, -apple-system, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif; }
  main { max-width:760px; margin:0 auto; padding:20px 16px 48px; }
  h1 { font-size:22px; margin:4px 0 4px; }
  p.sub { color:var(--muted); margin:0 0 18px; font-size:14px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:16px; margin-bottom:14px; }
  label { display:block; font-size:14px; color:var(--muted); margin:10px 0 4px; }
  input[type=text], input[type=password], input[type=number], select, textarea {
    width:100%; padding:10px 12px; border:1px solid var(--line); border-radius:8px; background:var(--bg); color:var(--text); font:inherit; }
  textarea { min-height:220px; resize:vertical; }
  .row { display:flex; gap:12px; flex-wrap:wrap; }
  .row > div { flex:1 1 200px; }
  .check { display:flex; align-items:center; gap:8px; margin-top:12px; color:var(--text); font-size:15px; }
  .buttons { display:flex; gap:10px; flex-wrap:wrap; margin-top:16px; }
  button { padding:11px 18px; border-radius:8px; border:1px solid var(--accent); background:var(--accent); color:#fff; font:inherit; cursor:pointer; }
  button.secondary { background:transparent; color:var(--accent); }
  button:disabled { opacity:.5; cursor:wait; }
  #status { margin-top:12px; color:var(--muted); font-size:14px; min-height:1.2em; }
  #status.bad { color:var(--bad); }
  #result { white-space:pre-wrap; word-break:break-word; font-size:15px; }
  a { color:var(--accent); }
</style>
</head>
<body>
<main>
  <h1>AI 작업 입력창</h1>
  <p class="sub">지시서를 붙여넣고 실행하면 Coral·Hive가 처리합니다. 요청과 결과는 노션 요청함에도 남습니다.</p>

  <div class="card" id="lock">
    <label for="pass">입력창 암호 (이 기기에만 저장)</label>
    <input id="pass" type="password" autocomplete="current-password">
  </div>

  <div class="card">
    <label for="title">제목 (비우면 지시서 첫 줄)</label>
    <input id="title" type="text">
    <label for="instruction">지시서</label>
    <textarea id="instruction" placeholder="[목적] ...&#10;[참고] 노션 페이지 링크&#10;[할 일] ...&#10;[범위] ...&#10;[결과 형식] 새 결과 / 근거 / 한계 / 다음 할 일"></textarea>
    <div class="row">
      <div>
        <label for="worker">작업자</label>
        <select id="worker"><option>Coral</option><option>Hive LLM</option><option>Hive 검사</option></select>
      </div>
      <div>
        <label for="rounds">최대 조사 횟수</label>
        <input id="rounds" type="number" min="1" max="5" value="3">
      </div>
    </div>
    <label for="model">모델 (비우면 기본 모델)</label>
    <input id="model" type="text">
    <label class="check"><input id="self" type="checkbox"> 노션 안에서 스스로 찾아 읽기 (자체조사)</label>
    <label class="check"><input id="record" type="checkbox"> 결과를 노션 작업 기록에 남기기</label>
    <div class="buttons">
      <button id="run">지금 실행</button>
      <button id="queue" class="secondary">요청함에만 넣기</button>
      <button id="models" class="secondary">Coral 모델 목록 확인</button>
    </div>
    <div id="status" role="status"></div>
  </div>

  <div class="card" id="out" hidden>
    <div id="links"></div>
    <div id="result"></div>
  </div>
</main>
<script>
  const $ = (id) => document.getElementById(id);
  try { $("pass").value = localStorage.getItem("desk-pass") || ""; } catch (e) {}
  function setStatus(text, bad) { $("status").textContent = text; $("status").className = bad ? "bad" : ""; }
  function link(label, url) { const a = document.createElement("a"); a.href = url; a.target = "_blank"; a.rel = "noopener"; a.textContent = label; return a; }
  async function send(queueOnly) {
    const pass = $("pass").value.trim();
    if (!pass) { setStatus("입력창 암호를 넣어 주세요.", true); return; }
    try { localStorage.setItem("desk-pass", pass); } catch (e) {}
    const payload = {
      title: $("title").value, instruction: $("instruction").value, worker: $("worker").value,
      rounds: Number($("rounds").value), model: $("model").value,
      selfResearch: $("self").checked, record: $("record").checked, queueOnly,
    };
    $("run").disabled = $("queue").disabled = true;
    setStatus(queueOnly ? "요청함에 넣는 중…" : "실행 중… 자체조사를 켜면 몇 분 걸릴 수 있습니다. 창을 닫아도 노션에서 이어집니다.");
    try {
      const res = await fetch("/api/run", { method: "POST", headers: { "Content-Type": "application/json", "x-desk-passcode": pass }, body: JSON.stringify(payload) });
      const data = await res.json();
      $("out").hidden = false; $("links").replaceChildren(); $("result").textContent = "";
      if (data.rowUrl) $("links").append(link("요청 행 열기", data.rowUrl));
      if (data.recordUrl) { $("links").append(" · "); $("links").append(link("작업 기록 열기", data.recordUrl)); }
      if (!data.ok) { setStatus("실패: " + (data.error || res.status), true); return; }
      setStatus(data.message || ("상태: " + data.status + (data.error ? " — " + data.error : "")), Boolean(data.error));
      $("result").textContent = data.resultMarkdown || "";
    } catch (e) {
      setStatus("연결 오류: " + e.message + " (노션 요청함에서 상태를 확인하세요)", true);
    } finally {
      $("run").disabled = $("queue").disabled = false;
    }
  }
  $("models").addEventListener("click", async () => {
    const pass = $("pass").value.trim();
    if (!pass) { setStatus("입력창 암호를 넣어 주세요.", true); return; }
    setStatus("모델 목록을 불러오는 중…");
    try {
      const res = await fetch("/api/models", { headers: { "x-desk-passcode": pass } });
      const data = await res.json();
      $("out").hidden = false; $("links").replaceChildren();
      $("result").textContent = JSON.stringify(data.coral ?? data, null, 2);
      setStatus(data.ok ? "이 키로 쓸 수 있는 Coral 모델입니다. 모델 칸이나 CORAL_MODEL 설정에 id를 쓰세요." : "실패: " + data.error, !data.ok);
    } catch (e) { setStatus("연결 오류: " + e.message, true); }
  });
  $("run").addEventListener("click", () => send(false));
  $("queue").addEventListener("click", () => send(true));
</script>
</body>
</html>`;
