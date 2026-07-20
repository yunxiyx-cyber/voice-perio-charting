// app.js — 主畫面組裝與流程控制：病例清單 → 表頭 → 缺牙預標 → 語音主畫面。
// 串接 recognizer → session → chart-view，onChange 自動存 store；聲音回饋走 feedback。
// ?demo=1：自動建合成病例（假名「測試病人」）＋顯示文字輸入框餵 handleTranscript（無麥克風乾跑）。

import { Session } from './session.js';
import { createStore } from './store.js';
import { renderChart } from './chart-view.js';
import { createRecognizer } from './recognizer.js';
import { createFeedback } from './feedback.js';
import { UPPER_ROW, LOWER_ROW } from './schema.js';

const STAGES = [
  { code: 'pre', label: '初診' },
  { code: 're', label: '再評估' },
  { code: 'spt', label: '支持性治療' },
];
const stageLabel = (c) => (STAGES.find((s) => s.code === c) || {}).label || c || '';

const $ = (id) => document.getElementById(id);
const store = createStore(window.localStorage);
const feedback = createFeedback();

let recognizer = null;
let current = null; // { case, session }
let pickMissing = new Set();
let bannerTimer = null;

// ---------- 畫面切換 ----------

function show(screen) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === screen));
}

// ---------- 病例清單 ----------

function renderCaseList() {
  const cases = store.listCases();
  const box = $('caseList');
  if (!cases.length) {
    box.innerHTML = '<p class="empty">尚無病例，點下方「新增病人」開始。</p>';
    return;
  }
  box.innerHTML = cases.map((c) => `
    <button class="caserow" data-id="${c.id}">
      <span class="cname">${escapeHtml(c.patient_name || '（未命名）')}</span>
      <span class="cmeta">${escapeHtml(stageLabel(c.stage))}　${escapeHtml(c.exam_date || '')}${c.confirmed ? '　✓已確認' : ''}</span>
    </button>`).join('');
  box.querySelectorAll('.caserow').forEach((b) => (b.onclick = () => openCase(b.dataset.id)));
}

// ---------- 表頭表單 ----------

function resetForm() {
  $('fName').value = '';
  $('fNumber').value = '';
  $('fAge').value = '';
  $('fSex').value = '';
  $('fStage').value = 'pre';
  $('fDate').value = new Date().toISOString().slice(0, 10);
}

function formHeader() {
  return {
    patient_name: $('fName').value.trim(),
    patient_number: $('fNumber').value.trim(),
    age: $('fAge').value.trim(),
    sex: $('fSex').value,
    stage: $('fStage').value,
    exam_date: $('fDate').value,
  };
}

// ---------- 缺牙預標 ----------

function renderMissingPicker() {
  const build = (teeth) => teeth.map((t) =>
    `<button class="mtooth${pickMissing.has(t) ? ' picked' : ''}" data-t="${t}">${t}</button>`).join('');
  $('missUpper').innerHTML = build(UPPER_ROW);
  $('missLower').innerHTML = build(LOWER_ROW);
  document.querySelectorAll('.mtooth').forEach((b) => (b.onclick = () => {
    const t = Number(b.dataset.t);
    if (pickMissing.has(t)) pickMissing.delete(t);
    else pickMissing.add(t);
    b.classList.toggle('picked');
  }));
}

// ---------- 開病例 / 進主畫面 ----------

function openCase(id) {
  const caseObj = store.getCase(id);
  if (!caseObj) return;
  startMain(caseObj);
}

function startMain(caseObj) {
  const session = new Session({ chart: caseObj.chart });
  if (caseObj.sessionState) { try { session.resume(caseObj.sessionState); } catch { /* 舊資料容錯 */ } }
  current = { case: caseObj, session };

  $('mPatient').textContent = caseObj.header.patient_name || '（未命名）';
  $('mStage').textContent = stageLabel(caseObj.header.stage);
  renderChart($('chart'), session);
  updateProgress();
  $('heard').textContent = '—';
  show('screen-main');
}

// ---------- 口述處理主入口 ----------

function handleText(text) {
  if (!current || !text || !text.trim()) return;
  $('heard').textContent = text;
  const fb = current.session.handleTranscript(text);
  renderChart($('chart'), current.session);
  processFeedback(fb);
  persist();
  updateProgress();
}

function processFeedback(fb) {
  let lastPoint = null;
  let banner = null;
  let ding = false;
  let dada = false;
  for (const f of fb) {
    switch (f.kind) {
      case 'toothDone': ding = true; break;
      case 'point': lastPoint = f; if (f.warn) banner = `注意：CAL<PD（GM 為負，牙齦腫大）`; break;
      case 'error': dada = true; banner = errorText(f); break;
      case 'noise': dada = true; break;
      case 'passStart': banner = `新段落：${f.passId}（起於 ${f.tooth}）`; break;
      case 'passDone': banner = `${f.passId} 完成，可唸「出血」進 BOP 輪或直接唸下一段`; break;
      case 'allDone': banner = '全口 PD/CAL 已收完'; break;
      case 'enterBop': banner = `進入 BOP 出血輪（${f.passId}）`; break;
      case 'finishBop': banner = 'BOP 輪完成'; break;
      case 'enterPi': banner = '進入牙菌斑模式'; break;
      case 'finishPi': banner = '牙菌斑模式結束'; break;
      case 'missing': banner = `${f.tooth} 標記缺牙`; break;
      case 'paused': banner = '已暫停（語音）'; break;
      case 'resumed': banner = '已繼續'; break;
      default: break;
    }
  }
  if (ding) feedback.ding();
  if (dada) feedback.dada();
  if (lastPoint && feedback.ttsEnabled) feedback.speak(`${lastPoint.pd}，${lastPoint.cal}`);
  if (banner) showBanner(banner);
}

function errorText(f) {
  const map = {
    range: '數值超出 0–19',
    ambiguous: `聽成「${f.raw || ''}」無法判斷，請重唸`,
    badNumber: '數字無法解析，請重唸',
    toothNotInPass: `${f.raw || ''} 不在本段`,
    toothMissing: `${f.raw || ''} 是缺牙`,
    needSide: '請先報頰／舌側',
    atFirstTooth: '已是本段第一顆',
    nothingToUndo: '沒有可復原的動作',
  };
  return map[f.code] || `解析問題（${f.code || '未知'}）`;
}

function showBanner(text) {
  const b = $('banner');
  b.textContent = text;
  b.classList.add('show');
  feedback.blip();
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => b.classList.remove('show'), 3500);
}

function persist() {
  current.case.chart = current.session.chart;
  current.case.sessionState = current.session.getState();
  store.saveCase(current.case);
}

function updateProgress() {
  const pr = current.session.progress();
  const pct = pr.total ? Math.round((pr.filled / pr.total) * 100) : 0;
  $('progress').textContent = `${pr.filled}/${pr.total}（${pct}%）`;
}

// ---------- 麥克風狀態燈 ----------

function setMic(state) {
  const el = $('micLight');
  const map = {
    listening: ['🟢', '監聽中'],
    paused: ['⚪', '已暫停'],
    reconnecting: ['🔴', '重連中'],
    stopped: ['⚪', '未收音'],
    unsupported: ['🔴', '此瀏覽器不支援語音'],
  };
  const [dot, txt] = map[state] || ['⚪', ''];
  el.textContent = `${dot} ${txt}`;
  $('btnPause').textContent = state === 'paused' ? '繼續收音' : '暫停';
}

// ---------- 事件綁定 ----------

function bind() {
  $('btnNew').onclick = () => { resetForm(); show('screen-form'); };
  $('formBack').onclick = () => { renderCaseList(); show('screen-list'); };
  $('formNext').onclick = () => {
    if (!$('fName').value.trim()) { $('fName').focus(); return; }
    pickMissing = new Set();
    renderMissingPicker();
    show('screen-missing');
  };
  $('missBack').onclick = () => show('screen-form');
  $('missStart').onclick = () => {
    const caseObj = store.createCase({ header: formHeader(), missing: [...pickMissing] });
    feedback.unlock();
    startMain(caseObj);
    startMic();
  };

  $('btnBackList').onclick = () => {
    if (recognizer) recognizer.stop();
    current = null;
    renderCaseList();
    show('screen-list');
  };
  $('btnPause').onclick = () => {
    if (!recognizer) return;
    feedback.unlock();
    if (recognizer.paused) recognizer.resume();
    else if (recognizer.running) recognizer.pause();
    else startMic();
  };
  $('btnUndo').onclick = () => { feedback.unlock(); handleText('復原'); };
  $('ttsToggle').onchange = (e) => { feedback.ttsEnabled = e.target.checked; };
  $('fastToggle').onchange = (e) => { recognizer && recognizer.setFast(e.target.checked); };

  // demo 文字輸入（模擬語音）
  $('demoSend').onclick = sendDemo;
  $('demoInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendDemo(); });
}

function sendDemo() {
  const v = $('demoInput').value;
  if (!v.trim()) return;
  feedback.unlock();
  handleText(v);
  $('demoInput').value = '';
  $('demoInput').focus();
}

function startMic() {
  if (!recognizer) return;
  recognizer.start();
}

// ---------- 啟動 ----------

function init() {
  recognizer = createRecognizer({
    onTranscript: (t) => handleText(t),
    onInterim: (t) => { $('heard').textContent = t + '…'; },
    onState: setMic,
  });
  bind();
  setMic('stopped');

  const demo = new URLSearchParams(location.search).get('demo') === '1';
  if (demo) {
    document.body.classList.add('demo');
    const caseObj = store.createCase({
      header: { patient_name: '測試病人', patient_number: 'DEMO-001', age: '50', sex: 'F', stage: 'pre', exam_date: new Date().toISOString().slice(0, 10) },
      missing: [18, 28, 38, 48],
    });
    startMain(caseObj);
    // demo 不自動開麥克風（無麥克風乾跑），用文字框輸入
    setMic('stopped');
  } else {
    renderCaseList();
    show('screen-list');
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

init();
