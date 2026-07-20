// zhnum.js — 中文/阿拉伯數字正規化與黏字消歧（純函式，無狀態）
// 值域驗證不在這裡做：PD/CAL 0–19、動搖/分叉 1–3 由 session 把關。

// 同音誤辨映射雛形：只收在此領域絕對安全的字（大寫數字、軍式唸法）。
// 「時→十」這類常見虛詞同音字風險太高，一律等 M3 診間實測收集後再加（spec §10）。
export const HOMOPHONES = {
  '幺': '一',
  '壹': '一', '貳': '二', '參': '三', '肆': '四', '伍': '五',
  '陸': '六', '柒': '七', '捌': '八', '玖': '九', '拾': '十',
};

const DIGITS = {
  '零': 0, '〇': 0, '一': 1, '二': 2, '兩': 2, '三': 3, '四': 4,
  '五': 5, '六': 6, '七': 7, '八': 8, '九': 9,
};

export function isChineseDigit(c) {
  return c === '十' || DIGITS[c] !== undefined;
}

export function applyHomophones(text) {
  let out = '';
  for (const c of text) out += HOMOPHONES[c] ?? c;
  return out;
}

// 連續中文數字字元 → 數值陣列。中文構式自帶邊界，不會歧義：
// 「三三」→[3,3]、「十」→[10]、「十一」→[11]、「一十」→[10]、「二十」→[20]（超值域由 session 報錯）
export function chineseRunToValues(run) {
  const vals = [];
  let i = 0;
  while (i < run.length) {
    const c = run[i];
    if (c === '十') {
      const next = DIGITS[run[i + 1]];
      if (next !== undefined) { vals.push(10 + next); i += 2; }
      else { vals.push(10); i += 1; }
    } else {
      const d = DIGITS[c];
      if (d === undefined) return null; // 呼叫端保證只送數字字元，不該發生
      if (run[i + 1] === '十') {
        const after = DIGITS[run[i + 2]];
        if (d === 1 && after === undefined) { vals.push(10); i += 2; }        // 一十
        else if (after !== undefined) { vals.push(d * 10 + after); i += 3; }  // 三十三
        else { vals.push(d * 10); i += 2; }                                   // 二十
      } else { vals.push(d); i += 1; }
    }
  }
  return vals;
}

// 阿拉伯黏字消歧（spec §7）：把純數字字串切成 0–19 的值序列。
// 合法 token：單位數 0–9，或「1」+一位數＝10–19。
// 回傳所有「相異」切法（長度 ≤ maxNeeded）；唯一解才可採用，多解由呼叫端報歧義。
export function segmentDigits(s, maxNeeded) {
  const results = new Set();
  const walk = (i, acc) => {
    if (acc.length > maxNeeded) return;
    if (i === s.length) {
      if (acc.length > 0) results.add(JSON.stringify(acc));
      return;
    }
    const d = s.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return;
    walk(i + 1, [...acc, d]);
    if (d === 1 && i + 1 < s.length) {
      const e = s.charCodeAt(i + 1) - 48;
      if (e >= 0 && e <= 9) walk(i + 2, [...acc, 10 + e]);
    }
  };
  walk(0, []);
  return [...results].map((j) => JSON.parse(j));
}
