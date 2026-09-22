"use strict";
function startPanel(document, host, bridge) {
  const $ = id => document.getElementById(id);
  let captured = null, proposal = null, busy = false, paired = false, applied = false;
  function status(text, error = false) { $("status").textContent = text; $("status").className = error ? "error" : ""; }
  function controls() {
    for (const id of ["pair", "connect-model", "disconnect-model", "capture", "generate", "manual"])
      $(id).disabled = busy || (id !== "pair" && !paired) || (["generate", "manual"].includes(id) && !captured);
    for (const el of document.querySelectorAll("#cuts input, #cuts button")) el.disabled = busy;
    $("style").disabled = busy;
    $("instruction").disabled = busy;
    $("apply").disabled = busy || applied || !proposal || !proposal.cuts.length || !$("acknowledge").checked;
  }
  async function task(work) {
    if (busy) return;
    busy = true; controls();
    try { await work(); } catch (error) { status(error.message, true); }
    finally { busy = false; controls(); }
  }
  function render() {
    $("cuts").textContent = "";
    $("summary").textContent = proposal ? proposal.summary : "제안을 받거나 직접 작성하세요.";
    $("notes").textContent = proposal ? proposal.notes.join(" · ") : "";
    for (const [index, cut] of (proposal ? proposal.cuts : []).entries()) {
      const clip = captured.snapshot.clips.find(c => c.id === cut.clip_id);
      const row = document.createElement("div"); row.className = "cut";
      const title = document.createElement("p"); title.className = "cut-name";
      title.textContent = `${index + 1}. ${clip.name} · ${clip.duration}f`; row.appendChild(title);
      const range = document.createElement("div"); range.className = "range";
      for (const [field, label] of [["start", "시작"], ["end", "끝"]]) {
        const wrapper = document.createElement("label"); wrapper.textContent = label;
        const input = document.createElement("input"); input.type = "number";
        input.setAttribute("aria-label", `${index + 1}번 컷 ${label} 프레임`);
        input.min = "0"; input.max = String(clip.duration); input.step = "1"; input.value = String(cut[field]);
        input.addEventListener("input", () => { cut[field] = input.value.trim() ? Number(input.value) : NaN; $("acknowledge").checked = false; updateDuration(); controls(); });
        wrapper.appendChild(input); range.appendChild(wrapper);
      }
      row.appendChild(range);
      const reason = document.createElement("p"); reason.className = "cut-reason"; reason.textContent = cut.reason; row.appendChild(reason);
      const remove = document.createElement("button"); remove.textContent = "이 컷 제외";
      remove.addEventListener("click", () => { proposal.cuts.splice(index, 1); $("acknowledge").checked = false; render(); });
      row.appendChild(remove); $("cuts").appendChild(row);
    }
    updateDuration(); controls();
  }
  function updateDuration() {
    const frames = proposal ? proposal.cuts.reduce((n, c) => n + c.end - c.start, 0) : 0;
    $("duration").textContent = captured && Number.isFinite(frames) ? `· ${frames}f / ${(frames / captured.snapshot.fps).toFixed(2)}초` : "";
  }
  function invalidate() { proposal = null; applied = false; $("acknowledge").checked = false; render(); }
  $("settings-toggle").addEventListener("click", () => {
    const hide = $("settings").style.display !== "none";
    $("settings").style.display = hide ? "none" : "block";
    $("api-key").value = ""; $("pair-code").value = "";
  });
  $("pair").addEventListener("click", () => task(async () => {
    paired = false; bridge.pair($("pair-code").value); $("pair-code").value = "";
    const result = await bridge.request("/status");
    if (result.protocol !== 1) throw new Error("엔진과 플러그인 버전이 맞지 않습니다.");
    const library = await bridge.request("/styles"); $("style").textContent = "";
    for (const style of library.styles) {
      const option = document.createElement("option"); option.value = style.id; option.textContent = style.name; $("style").appendChild(option);
    }
    paired = true; captured = null; invalidate(); status(result.connected ? `엔진 연결됨 · ${result.model}` : "엔진 연결됨 · 모델을 연결하거나 직접 컷을 작성하세요.");
  }));
  $("connect-model").addEventListener("click", () => task(async () => {
    const config = { base_url: $("base-url").value, model: $("model").value, api_key: $("api-key").value, vision: false };
    $("api-key").value = ""; status("모델 연결을 테스트하고 있습니다…");
    const result = await bridge.request("/model/connect", config);
    $("settings").style.display = "none"; status(`모델 연결됨 · ${result.model}`);
  }));
  $("disconnect-model").addEventListener("click", () => task(async () => {
    await bridge.request("/model/disconnect", {}); $("api-key").value = ""; status("모델 연결을 해제하고 메모리의 키를 지웠습니다.");
  }));
  $("capture").addEventListener("click", () => task(async () => {
    captured = null; invalidate(); status("현재 시퀀스를 읽고 있습니다…");
    captured = await bridge.request("/snapshots", await host.snapshot());
    const s = captured.snapshot; $("sequence").textContent = `${s.name} · ${s.clips.length}클립 · ${s.fps.toFixed(3)}fps`;
    status("타임라인을 읽었습니다. 원본은 변경하지 않았습니다.");
  }));
  $("manual").addEventListener("click", () => {
    invalidate(); proposal = { summary: "직접 작성한 러프컷", notes: ["모델을 사용하지 않았습니다."],
      cuts: captured.snapshot.clips.map(c => ({ clip_id: c.id, start: 0, end: c.duration, reason: "직접 검토" })) };
    render(); status("프레임 범위를 수정하고 제외할 컷을 고르세요.");
  });
  $("generate").addEventListener("click", () => task(async () => {
    invalidate(); status("AI가 컷 제안을 작성하고 있습니다…");
    const job = await bridge.request("/proposals", { snapshot_id: captured.id, style_id: $("style").value, instruction: $("instruction").value });
    const deadline = Date.now() + 150000;
    while (Date.now() < deadline) {
      const result = await bridge.request("/jobs/" + job.job_id);
      if (result.status === "error") throw new Error(result.detail);
      if (result.status === "done") { proposal = result.proposal; render(); status("AI 제안을 받았습니다. 아직 타임라인에는 적용하지 않았습니다."); return; }
      await new Promise(resolve => setTimeout(resolve, 750));
    }
    throw new Error("제안 대기 시간이 초과됐습니다. 엔진 상태를 확인하세요.");
  }));
  $("style").addEventListener("change", invalidate);
  $("acknowledge").addEventListener("change", controls);
  $("apply").addEventListener("click", () => task(async () => {
    if (!proposal || !$("acknowledge").checked) throw new Error("컷과 적용 범위를 먼저 검토하세요.");
    if (proposal.cuts.some(c => !Number.isInteger(c.start) || !Number.isInteger(c.end))) throw new Error("시작·끝에 정수 프레임을 입력하세요.");
    status("현재 타임라인과 검토안을 다시 확인하고 있습니다…");
    const current = await host.snapshot();
    const prepared = await bridge.request("/prepare", { snapshot_id: captured.id, current, proposal, acknowledge_basic_cuts: true });
    // Disable repeat writes even if the host reports an ambiguous import failure.
    applied = true;
    const name = await host.apply(prepared, current);
    status(`새 시퀀스를 만들었습니다: ${name}. 재생하며 확인하세요.`);
  }));
  controls();
}
module.exports = { startPanel };
