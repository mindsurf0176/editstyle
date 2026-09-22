const $ = id => document.getElementById(id);
const state = {token: '', library: null, style: null, media: null, plan: null, export: null, busy: false, dirty: false, model: null};
const starter = '# 내 편집 스타일\n\n> Source: 직접 작성\n> EDITSTYLE v1\n\n## Rhythm\n- 설명을 끝까지 듣고 반복되는 부분만 줄입니다.\n\n## Subtitles\n- 완성된 문장 단위로 자막을 넣습니다.\n\n## Rules\n- 컷을 줄이면서 말의 의미를 바꾸지 않습니다.\n\n## Evidence\n- 사용자 취향으로 작성. 레퍼런스 분석 전입니다.\n';

function notice(text, error = false) {
  $('notice').textContent = text;
  $('notice').className = error ? 'error' : '';
  $('notice').hidden = !text;
}
function controls() {
  document.querySelectorAll('button, input, textarea, select').forEach(el => { el.disabled = state.busy; });
  if (state.busy) return;
  $('generate-plan').disabled = !state.media || !state.style;
  $('manual-plan').disabled = !state.media || !state.style;
  $('extract-style').disabled = !state.media;
  $('edit-style').disabled = !state.style;
  $('save-plan').disabled = !state.plan || !state.dirty;
  $('export-plan').disabled = !state.plan || state.dirty;
  $('disconnect-model').disabled = !state.model;
}
async function task(message, fn) {
  if (state.busy) return;
  state.busy = true; controls(); notice(message);
  try { await fn(); }
  catch (error) { notice(error.message || '작업을 완료하지 못했습니다.', true); }
  finally { state.busy = false; controls(); }
}
async function api(path, options = {}) {
  const headers = {'X-Editstyle-Token': state.token, ...options.headers};
  if (options.body && !(options.body instanceof FormData)) headers['Content-Type'] = 'application/json';
  const response = await fetch(path, {...options, headers});
  if (!response.ok) {
    let data; try { data = await response.json(); } catch { data = {}; }
    throw new Error(data.detail || `요청 실패 (${response.status}). 다시 시도하세요.`);
  }
  return response.json();
}
const post = (path, body) => api(path, {method: 'POST', body: JSON.stringify(body)});
const time = value => `${Math.floor(value / 60)}:${(value % 60).toFixed(1).padStart(4, '0')}`;
function element(tag, text, className) { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el; }
function cleanPlan() {
  state.plan = null; state.export = null; state.dirty = false;
  $('plan-content').hidden = true; $('plan-empty').hidden = false;
  $('export-result').hidden = true; $('plan-length').textContent = '';
  $('result-video').removeAttribute('src'); $('result-video').load();
  controls();
}
function canSwitch() { return !state.dirty || confirm('저장하지 않은 컷 변경을 버릴까요?'); }
async function loadLibrary() {
  state.library = await api('/api/library');
  const list = $('style-list'); list.replaceChildren();
  for (const item of state.library.styles) {
    const button = element('button'); button.append(element('span', item.name), element('small', item.builtin ? '프리셋' : '내 스타일'));
    button.dataset.id = item.id;
    button.classList.toggle('selected', state.style?.id === item.id);
    button.setAttribute('aria-pressed', String(state.style?.id === item.id));
    button.onclick = () => { if (canSwitch()) task('스타일을 불러오고 있어요.', async () => { await selectStyle(item.id); notice(''); }); };
    list.append(button);
  }
  $('recent-wrap').hidden = state.library.media.length === 0;
  $('recent-media').replaceChildren(...state.library.media.map(item => {
    const option = element('option', item.name); option.value = item.id; return option;
  }));
  if (state.media) $('recent-media').value = state.media.id;
  const history = $('history-list'); history.replaceChildren();
  if (!state.library.plans.length) history.append(element('p', '아직 저장한 제안이 없습니다.'));
  for (const item of state.library.plans) {
    const button = element('button', item.summary);
    button.onclick = () => { if (canSwitch()) task('제안을 불러오고 있어요.', async () => {
      const plan = await api(`/api/plans/${item.id}`);
      if (plan.style_id && state.library.styles.some(s => s.id === plan.style_id)) await selectStyle(plan.style_id);
      selectMedia(state.library.media.find(m => m.id === plan.media_id));
      showPlan(plan); notice('저장한 제안을 불러왔어요. 스타일 문서는 이 제안에 저장된 버전을 사용합니다.');
    }); };
    history.append(button);
  }
  controls();
}
async function selectStyle(id) {
  const style = await api(`/api/styles/${encodeURIComponent(id)}`);
  state.style = {...style, id}; cleanPlan();
  $('style-name').textContent = style.name;
  $('style-origin').textContent = id.startsWith('preset:') ? '작성된 시작점 · 레퍼런스 추출 결과가 아닙니다' : '내가 저장한 스타일';
  const sections = style.sections || [];
  $('style-preview').textContent = sections.length ? sections.filter(s => ['Rhythm', 'Subtitles', 'Rules'].includes(s.heading)).map(s => s.content).join('\n\n') : style.markdown;
  document.querySelectorAll('#style-list button').forEach(b => {
    b.classList.toggle('selected', b.dataset.id === id); b.setAttribute('aria-pressed', String(b.dataset.id === id));
  });
  localStorage.setItem('editstyle.selection', JSON.stringify({style: id, media: state.media?.id}));
}
function selectMedia(item) {
  if (!item) throw new Error('원본 영상을 찾을 수 없습니다. 다시 가져오세요.');
  state.media = item; cleanPlan();
  $('video-empty').hidden = true; $('source-video').hidden = false;
  $('source-video').src = `/media/${item.id}/source.mp4`;
  $('source-name').textContent = item.name;
  $('media-facts').textContent = `${item.width} × ${item.height} · 30fps · 컷 후보 ${Math.max(0, item.scenes.length - 1)}개`;
  $('media-time').textContent = time(item.duration); $('copy-note').hidden = false;
  $('frames').replaceChildren(...item.samples.map((timestamp, i) => {
    const button = element('button'); button.setAttribute('aria-label', `${time(timestamp)} 지점 보기`);
    const img = document.createElement('img'); img.src = `/media/${item.id}/frame/${i}`; img.alt = ''; img.width = 160; img.height = 100;
    button.append(img, element('span', time(timestamp))); button.onclick = () => { $('source-video').currentTime = timestamp; }; return button;
  }));
  $('recent-media').value = item.id;
  localStorage.setItem('editstyle.selection', JSON.stringify({style: state.style?.id, media: item.id}));
  controls();
}
function markDirty() {
  state.dirty = true; state.export = null; $('export-result').hidden = true;
  $('dirty-indicator').textContent = '저장하지 않은 변경사항'; controls();
}
function addRow(clip) {
  const row = document.createElement('tr');
  const seekCell = document.createElement('td'); const seek = element('button', String($('clip-rows').children.length + 1).padStart(2, '0'));
  seek.setAttribute('aria-label', '원본 구간 보기'); seek.onclick = () => { $('source-video').currentTime = Number(row.querySelector('[data-field=start]').value); };
  seekCell.append(seek); row.append(seekCell);
  for (const field of ['start', 'end', 'reason', 'caption']) {
    const cell = document.createElement('td'); const input = document.createElement(['start', 'end'].includes(field) ? 'input' : 'textarea');
    input.dataset.field = field; input.value = clip[field] ?? '';
    input.setAttribute('aria-label', `${$('clip-rows').children.length + 1}번 컷 ${ {start:'시작 시간',end:'끝 시간',reason:'선택 이유',caption:'자막'}[field]}`);
    if (input.tagName === 'INPUT') { input.type = 'number'; input.step = '0.033333'; input.min = '0'; input.max = String(state.media.duration); }
    else input.rows = 2;
    input.oninput = markDirty; cell.append(input); row.append(cell);
  }
  const removeCell = document.createElement('td'); const remove = element('button', '×', 'remove');
  remove.setAttribute('aria-label', '이 컷 삭제'); remove.onclick = () => { row.remove(); markDirty(); }; removeCell.append(remove); row.append(removeCell); $('clip-rows').append(row);
}
function showPlan(plan) {
  state.plan = plan; state.dirty = false; state.export = null;
  $('plan-empty').hidden = true; $('plan-content').hidden = false; $('export-result').hidden = true;
  $('plan-summary').textContent = plan.summary;
  $('proposal-title').textContent = plan.provenance?.mode === 'manual' ? '직접 작성한 컷' : '편집 제안';
  $('plan-length').textContent = `${plan.clips.length}컷 · ${time(plan.duration)}`;
  $('clip-rows').replaceChildren(); plan.clips.forEach(addRow);
  $('dirty-indicator').textContent = '저장됨';
  const notes = $('plan-notes').querySelector('ul'); notes.replaceChildren(...plan.notes.map(n => element('li', n)));
  if (plan.style_name) notes.append(element('li', `이 제안에 저장된 스타일: ${plan.style_name}`));
  if (plan.provenance?.model) notes.append(element('li', `모델: ${plan.provenance.model} · 전송한 프레임 ${plan.provenance.frames_sent}장`));
  if (Number.isFinite(plan.provenance?.usage?.total_tokens)) notes.append(element('li', `공급자가 보고한 사용량: ${plan.provenance.usage.total_tokens.toLocaleString()} 토큰`));
  notes.append(element('li', '내보내기는 컷·원본 오디오·SRT를 전달합니다. 색보정·전환·음악 선택·자막 서체는 별도 작업입니다.'));
  controls();
}
function proposalFromRows() {
  return {summary: state.plan.summary, notes: state.plan.notes, clips: [...$('clip-rows').children].map(row => {
    const result = {}; row.querySelectorAll('[data-field]').forEach(input => { result[input.dataset.field] = ['start', 'end'].includes(input.dataset.field) ? Number(input.value) : input.value; }); return result;
  })};
}
function modelLabel(model) { state.model = model; $('model-label').textContent = model || '모델 연결'; $('model-dot').classList.toggle('connected', !!model); controls(); }
function download(blob, filename) { const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = filename; a.click(); setTimeout(() => URL.revokeObjectURL(url), 30000); }
function openStyle(markdown) { $('style-document').value = markdown; $('style-error').hidden = true; $('style-dialog').showModal(); }
document.querySelectorAll('.close-dialog').forEach(b => b.onclick = () => b.closest('dialog').close());
$('model-open').onclick = () => { $('model-error').hidden = true; $('model-dialog').showModal(); };
$('model-dialog').addEventListener('close', () => { $('api-key').value = ''; });
$('model-form').onsubmit = event => {
  event.preventDefault();
  task('모델 연결을 확인하고 있어요.', async () => {
    $('model-error').hidden = true;
    try {
      const config = {base_url: $('base-url').value, model: $('model-name').value, api_key: $('api-key').value, vision: $('vision-model').checked};
      const result = await post('/api/model/connect', config); $('api-key').value = '';
      modelLabel(result.model); $('model-dialog').close(); notice('모델이 응답했어요. 편집 제안을 요청할 수 있습니다.');
    } catch (error) { $('model-error').textContent = error.message; $('model-error').hidden = false; throw error; }
  });
};
$('disconnect-model').onclick = () => task('모델 연결을 해제하고 있어요.', async () => { await post('/api/model/disconnect', {}); modelLabel(null); $('api-key').value = ''; $('model-dialog').close(); notice('모델 연결과 메모리에 있던 키를 지웠어요.'); });
$('new-style').onclick = () => openStyle(starter);
$('edit-style').onclick = () => openStyle(state.style.markdown);
$('download-style').onclick = () => download(new Blob([$ ('style-document').value], {type: 'text/markdown;charset=utf-8'}), 'EDITSTYLE.md');
$('style-form').onsubmit = event => {
  event.preventDefault();
  if (!canSwitch()) return;
  task('스타일을 저장하고 있어요.', async () => {
    try {
      const result = await post('/api/styles', {markdown: $('style-document').value});
      await loadLibrary(); await selectStyle(result.id); $('style-dialog').close(); notice('내 스타일로 저장했어요.');
    } catch (error) { $('style-error').textContent = error.message; $('style-error').hidden = false; throw error; }
  });
};
$('import-style').onclick = () => $('style-file').click();
$('style-file').onchange = async event => { const file = event.target.files[0]; if (file) { if (file.size > 100000) notice('100KB 이하의 스타일 문서를 선택하세요.', true); else openStyle(await file.text()); } event.target.value = ''; };
for (const id of ['upload-button', 'empty-upload']) $(id).onclick = () => { if (canSwitch()) $('video-file').click(); };
$('video-file').onchange = event => {
  const file = event.target.files[0]; if (!file) return;
  task('작업용 영상을 준비하고 컷 후보를 찾고 있어요. 잠시 기다려주세요.', async () => {
    if (file.size > 512 * 1024 * 1024) throw new Error('512MB 이하의 영상을 선택하세요.');
    const form = new FormData(); form.append('file', file);
    const item = await api('/api/media', {method: 'POST', body: form});
    await loadLibrary(); selectMedia(item); notice('영상 준비가 끝났어요. 스타일을 선택하고 제안을 요청하세요.');
  }); event.target.value = '';
};
$('recent-media').onchange = event => { if (canSwitch()) selectMedia(state.library.media.find(m => m.id === event.target.value)); else event.target.value = state.media.id; };
const generationBody = () => ({media_id: state.media.id, style_id: state.style?.id || '', instruction: $('instruction').value, send_frames: $('send-frames').checked});
$('generate-plan').onclick = () => {
  if (!state.model) { $('model-dialog').showModal(); return; }
  if (!canSwitch()) return;
  task('연결한 모델이 편집 제안을 만들고 있어요.', async () => {
    const plan = await post('/api/plans/generate', generationBody()); showPlan(plan); await loadLibrary(); notice('제안이 준비됐어요. 컷과 자막을 검토한 뒤 가져오기 묶음을 만드세요.');
  });
};
$('extract-style').onclick = () => {
  if (!state.model) { $('model-dialog').showModal(); return; }
  task('레퍼런스의 스타일 초안을 읽고 있어요.', async () => {
    const result = await post('/api/styles/extract', generationBody()); openStyle(result.markdown); notice('스타일 초안입니다. 관찰 근거와 미확인 항목을 검토하고 저장하세요.');
  });
};
$('manual-plan').onclick = () => {
  if (!canSwitch()) return;
  task('직접 편집할 컷 목록을 만들고 있어요.', async () => {
    const scenes = state.media.scenes.length <= 80 ? state.media.scenes : [{start: 0, end: state.media.duration}];
    const plan = await post('/api/plans', {media_id: state.media.id, style_id: state.style.id, proposal: {
      summary: '원본 순서로 시작하는 직접 편집 초안', clips: scenes.map(s => ({...s, reason: '자동 감지한 컷 후보입니다. 원본을 보고 범위를 조정하세요.', caption: ''})),
      notes: ['모델을 호출하지 않았으며 선택한 스타일을 자동 적용하지 않았습니다.', '오디오와 대사 의미는 직접 확인하세요.'],
    }}); showPlan(plan); await loadLibrary(); notice('원본 순서로 컷을 나눴어요. 시작·끝 시간과 자막을 직접 수정할 수 있습니다.');
  });
};
$('add-cut').onclick = () => { addRow({start: 0, end: Math.min(1, state.media.duration), reason: '', caption: ''}); markDirty(); };
$('save-plan').onclick = () => task('컷 변경사항을 검증하고 저장하고 있어요.', async () => {
  const result = await api(`/api/plans/${state.plan.id}`, {method: 'PUT', body: JSON.stringify(proposalFromRows())}); showPlan(result); await loadLibrary(); notice('새 버전으로 저장했어요. 이전 제안도 기록에 남아 있습니다.');
});
$('export-plan').onclick = () => task('검토한 컷으로 클립·타임라인·자막 묶음을 만들고 있어요.', async () => {
  state.export = await post(`/api/plans/${state.plan.id}/export`, {});
  $('result-video').src = state.export.preview; $('export-result').hidden = false;
  notice('가져오기 묶음이 준비됐어요. ZIP 안의 IMPORT.md에서 편집기별 방법을 확인하세요.');
});
$('download-bundle').onclick = () => task('파일을 내려받고 있어요.', async () => {
  const response = await fetch(state.export.download, {headers: {'X-Editstyle-Token': state.token}});
  if (!response.ok) throw new Error('묶음을 받지 못했습니다. 다시 만들어주세요.');
  download(await response.blob(), 'editstyle.zip'); notice('다운로드를 시작했어요.');
});
window.addEventListener('beforeunload', event => { if (state.dirty) { event.preventDefault(); event.returnValue = ''; } });

task('작업실을 열고 있어요.', async () => {
  const bootstrap = await api('/api/bootstrap'); state.token = bootstrap.token; modelLabel(bootstrap.model);
  if (bootstrap.connected) { $('base-url').value = bootstrap.base_url; $('model-name').value = bootstrap.model; $('vision-model').checked = bootstrap.vision; }
  let saved = {}; try { saved = JSON.parse(localStorage.getItem('editstyle.selection') || '{}'); } catch { /* no saved selection */ }
  await loadLibrary(); await selectStyle(state.library.styles.find(s => s.id === saved.style)?.id || state.library.styles[0].id);
  const previous = state.library.media.find(m => m.id === saved.media) || state.library.media[0]; if (previous) selectMedia(previous);
  notice(bootstrap.ffmpeg ? '' : 'FFmpeg가 필요합니다. 설치 후 영상을 가져오세요. macOS: brew install ffmpeg', !bootstrap.ffmpeg);
});
