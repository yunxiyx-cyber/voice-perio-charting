// recognizer.js — 把 spike.html 驗證過的收音邏輯封裝成模組。
// 核心＝連續辨識（zh-TW）＋ onend 自動重啟 ＋ Screen Wake Lock（防熄屏）。
// 對外事件：
//   onTranscript(finalText)      — 一句 final 原文
//   onInterim(text)              — 即時（未定稿）原文，供底列顯示
//   onState('listening'|'paused'|'reconnecting'|'stopped'|'unsupported')
// 不支援的瀏覽器：supported=false，start() 只回報 unsupported，不丟例外。

export function createRecognizer({ lang = 'zh-TW', onTranscript, onInterim, onState } = {}) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const supported = !!SR;

  let rec = null;
  let running = false; // 使用者意圖（true＝該持續收音，onend 就自動重啟）
  let paused = false;
  let wakeLock = null;
  let fast = true; // 快速模式：interim 穩定前綴就提交，不等 final（iOS final 要等停頓、體感慢）

  const emitState = (s) => onState && onState(s);

  async function acquireWakeLock() {
    try {
      if ('wakeLock' in navigator) {
        wakeLock = await navigator.wakeLock.request('screen');
      }
    } catch { /* 熄屏防護失敗不致命，忽略 */ }
  }
  function releaseWakeLock() {
    try { wakeLock && wakeLock.release(); } catch { /* ignore */ }
    wakeLock = null;
  }
  // 切回前景時 Wake Lock 會失效，需重取
  document.addEventListener('visibilitychange', () => {
    if (running && !paused && document.visibilityState === 'visible') acquireWakeLock();
  });

  function makeRec() {
    const r = new SR();
    r.lang = lang;
    r.continuous = true;
    r.interimResults = true;

    // 快速模式的逐結果追蹤：{ last: 上次 interim 全文, committed: 已提交字元數, timer: 停頓沖洗 }
    const track = new Map();
    const IDLE_FLUSH_MS = 700; // 停頓多久就把保留尾端沖出去（口述點與點之間的自然停頓遠大於字內停頓）

    const commit = (st, text, upto) => {
      if (upto <= st.committed) return;
      const chunk = text.slice(st.committed, upto);
      st.committed = upto;
      if (chunk.trim() && onTranscript) onTranscript(chunk);
    };

    // 提交上限：整段扣掉尾端保留——至少 4 字（防指令詞被腰斬），數字結尾再加長（防「1」其實是「15」的前半）
    const stableEnd = (text) => {
      const tailDigits = (text.match(/[0-9零〇一二兩三四五六七八九十]+$/) || [''])[0].length;
      return Math.max(0, text.length - Math.max(4, tailDigits + 1));
    };

    const handleInterim = (i, text) => {
      let st = track.get(i);
      if (!st) { st = { last: '', committed: 0, timer: null }; track.set(i, st); }
      clearTimeout(st.timer);
      if (fast) {
        // 文字若不是延伸前文（辨識回頭改字），不追加提交，只重置基準；已提交的部分不回收
        if (!text.startsWith(st.last)) st.committed = Math.min(st.committed, text.length);
        commit(st, text, stableEnd(text));
        st.timer = setTimeout(() => commit(st, text, text.length), IDLE_FLUSH_MS); // 停頓＝安全邊界，全沖
      }
      st.last = text;
    };

    const handleFinal = (i, text) => {
      const st = track.get(i);
      if (st) {
        clearTimeout(st.timer);
        commit(st, text, text.length); // 已提交的前綴不重送，只補尾巴
        track.delete(i);
      } else if (text.trim() && onTranscript) {
        onTranscript(text); // 非快速模式（或沒收過 interim）：整句 final 照舊
      }
    };

    r.onresult = (ev) => {
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const res = ev.results[i];
        const text = res[0].transcript.trim();
        if (!text) continue;
        if (res.isFinal) handleFinal(i, text);
        else {
          if (onInterim) onInterim(text);
          handleInterim(i, text);
        }
      }
    };
    r.onerror = (ev) => {
      // no-speech / aborted 等非致命錯誤交給 onend 自動重啟；此處只在重連時提示
      if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') {
        running = false;
        emitState('unsupported');
      }
    };
    r.onend = () => {
      if (!running || paused) { emitState(paused ? 'paused' : 'stopped'); return; }
      emitState('reconnecting');
      try {
        rec = makeRec();
        rec.start();
        emitState('listening');
      } catch {
        setTimeout(() => { if (running && !paused) { rec = makeRec(); safeStart(); } }, 300);
      }
    };
    return r;
  }

  function safeStart() {
    try { rec.start(); emitState('listening'); }
    catch { /* InvalidStateError：已在跑，忽略 */ }
  }

  async function start() {
    if (!supported) { emitState('unsupported'); return false; }
    if (running) return true;
    running = true;
    paused = false;
    await acquireWakeLock();
    rec = makeRec();
    safeStart();
    return true;
  }

  function stop() {
    running = false;
    paused = false;
    if (rec) { try { rec.stop(); } catch { /* ignore */ } }
    releaseWakeLock();
    emitState('stopped');
  }

  // 暫停＝停收音但保留意圖（狀態顯示灰）；resume 重新開收音
  function pause() {
    if (!running || paused) return;
    paused = true;
    if (rec) { try { rec.stop(); } catch { /* ignore */ } }
    releaseWakeLock();
    emitState('paused');
  }
  async function resume() {
    if (!supported || !running || !paused) return;
    paused = false;
    await acquireWakeLock();
    rec = makeRec();
    safeStart();
  }

  return {
    supported,
    start,
    stop,
    pause,
    resume,
    get running() { return running; },
    get paused() { return paused; },
    get fast() { return fast; },
    setFast(v) { fast = !!v; },
  };
}
