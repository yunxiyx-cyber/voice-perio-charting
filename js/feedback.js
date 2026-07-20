// feedback.js — 聲音回饋（WebAudio「叮」「噠噠」）＋ 可選 TTS 回讀。
// spec §4.6：收滿一顆＝短「叮」；解析失敗／歧義＝「噠噠」停格。
// TTS 回讀預設關（會被麥克風收回造成回授），由 UI 開關切換。

export function createFeedback() {
  let ctx = null;
  const ac = () => (ctx ??= new (window.AudioContext || window.webkitAudioContext)());

  // 需在使用者手勢中先 resume 一次，iOS 才會出聲
  function unlock() {
    try { if (ac().state === 'suspended') ac().resume(); } catch { /* ignore */ }
  }

  function tone(freq, start, dur, { type = 'sine', gain = 0.18 } = {}) {
    const a = ac();
    const t0 = a.currentTime + start;
    const osc = a.createOscillator();
    const g = a.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(a.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  const api = {
    ttsEnabled: false,

    unlock,

    // 收滿一顆牙：清亮上行雙音
    ding() {
      try { tone(880, 0, 0.12); tone(1320, 0.09, 0.14); } catch { /* ignore */ }
    },

    // 解析失敗／歧義：兩記低沉「噠噠」
    dada() {
      try { tone(220, 0, 0.09, { type: 'square', gain: 0.14 }); tone(200, 0.12, 0.1, { type: 'square', gain: 0.14 }); }
      catch { /* ignore */ }
    },

    // 段落轉場：中性提示音
    blip() {
      try { tone(660, 0, 0.1); } catch { /* ignore */ }
    },

    // TTS 回讀剛填的兩個數字（開關開啟時）
    speak(text) {
      if (!api.ttsEnabled || !('speechSynthesis' in window)) return;
      try {
        const u = new SpeechSynthesisUtterance(String(text));
        u.lang = 'zh-TW';
        u.rate = 1.1;
        window.speechSynthesis.cancel();
        window.speechSynthesis.speak(u);
      } catch { /* ignore */ }
    },
  };
  return api;
}
