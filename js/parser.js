// parser.js — 辨識原文 → 事件流（純函式：同樣輸入＋同樣 ctx 必得同樣輸出）
// ctx = { mode: 'pdcal'|'bop'|'pi', needed: 黏字消歧用的當前缺口值數（pdcal 模式） }
// 回傳 { events, noise }；session 負責值域驗證、狀態推進與錯誤音。

import { applyHomophones, chineseRunToValues, isChineseDigit, segmentDigits } from './zhnum.js';
import { isValidTooth } from './schema.js';

// 指令詞（長詞優先比對，避免「上一顆」被「一」搶走）
const KEYWORDS = [
  { w: '牙菌斑模式', t: 'pi' },
  { w: '菌斑模式', t: 'pi' },
  { w: '上一顆', t: 'prevTooth' },
  { w: '跳到', t: 'goto' },
  { w: '動搖', t: 'mobility' },
  { w: '分叉', t: 'furcation' },
  { w: '分岔', t: 'furcation' },
  { w: '缺牙', t: 'missing' },
  { w: '復原', t: 'undo' },
  { w: '暫停', t: 'pause' },
  { w: '繼續', t: 'resume' },
  { w: '完成', t: 'finish' },
  { w: 'bop', t: 'bop' },
  { w: '改', t: 'redoTooth' },
].sort((a, b) => b.w.length - a.w.length);

const POINT_WORDS = { '近': 'M', '遠': 'D', '中': 'mid', '全': 'all' }; // 僅 bop/pi 模式有意義
const SIDE_WORDS = { '頰': 'facial', '舌': 'lingual', '顎': 'lingual' }; // 僅 pi 模式有意義
const FILLERS = new Set([...' \t\n\r，。、,.？?！!；;：:～~的了呃嗯啊喔哦欸唉']);

const isArabic = (c) => c >= '0' && c <= '9';

// 從 i 之後讀下一個數字 run（略過填充字），回傳 { values, nextI }；讀不到 → values:null
function readNextValues(s, i) {
  while (i < s.length && FILLERS.has(s[i])) i++;
  if (i >= s.length) return { values: null, nextI: i };
  if (isChineseDigit(s[i])) {
    let j = i;
    while (j < s.length && isChineseDigit(s[j])) j++;
    return { values: chineseRunToValues(s.slice(i, j)), nextI: j };
  }
  if (isArabic(s[i])) {
    let j = i;
    while (j < s.length && isArabic(s[j])) j++;
    return { values: [...s.slice(i, j)].map(Number), nextI: j }; // 指令參數逐字讀，不做黏字切分
  }
  return { values: null, nextI: i };
}

// 值序列 → 牙位：單值本身是合法 FDI（11–48），或兩個單位數組成象限+牙
function valuesToTooth(values) {
  if (!values || values.length === 0) return null;
  if (values.length === 1 && isValidTooth(values[0])) return values[0];
  if (values.length === 2 && values[0] >= 1 && values[0] <= 4 && values[1] >= 1 && values[1] <= 8) {
    const t = values[0] * 10 + values[1];
    return isValidTooth(t) ? t : null;
  }
  return null;
}

export function parse(text, ctx = {}) {
  const mode = ctx.mode ?? 'pdcal';
  const needed = ctx.needed ?? 6;
  const s = applyHomophones(String(text).toLowerCase());

  const events = [];
  let noise = '';

  // pdcal 模式：數值累積後合併成一個 values 事件（保持與指令的先後順序）
  let vals = [];
  const flushVals = () => {
    if (vals.length) { events.push({ type: 'values', values: vals }); vals = []; }
  };

  // bop/pi 模式：組報告（牙位＋側＋點），tooth/side 可為 null（session 用上一筆延續）
  let report = null;
  let pendingQuadrant = null; // 「一」「七」分兩個值進來時暫存象限
  const flushReport = () => {
    if (report) { events.push(report); report = null; }
    pendingQuadrant = null;
  };
  const reportType = mode === 'pi' ? 'piReport' : 'bopReport';
  const newReport = (tooth) => {
    flushReport();
    report = { type: reportType, tooth, side: null, points: [] };
  };
  const ensureReport = () => {
    if (!report) report = { type: reportType, tooth: null, side: null, points: [] };
  };
  const feedToothValue = (v) => {
    if (isValidTooth(v)) { newReport(v); return; }
    if (pendingQuadrant != null) {
      const t = pendingQuadrant * 10 + v;
      pendingQuadrant = null;
      if (isValidTooth(t)) { newReport(t); return; }
      events.push({ type: 'error', code: 'badTooth', raw: String(t) });
      return;
    }
    if (v >= 1 && v <= 4) { pendingQuadrant = v; return; }
    events.push({ type: 'error', code: 'badTooth', raw: String(v) });
  };

  const flushAll = () => { flushVals(); flushReport(); };

  let i = 0;
  outer: while (i < s.length) {
    if (FILLERS.has(s[i])) { i++; continue; }

    // 1. 指令詞
    for (const { w, t } of KEYWORDS) {
      if (s.startsWith(w, i)) {
        flushAll();
        i += w.length;
        if (t === 'goto') {
          const r = readNextValues(s, i);
          i = r.nextI;
          const tooth = valuesToTooth(r.values);
          events.push(tooth ? { type: 'goto', tooth } : { type: 'error', code: 'badTooth', raw: w });
        } else if (t === 'mobility' || t === 'furcation') {
          const r = readNextValues(s, i);
          i = r.nextI;
          const grade = r.values && r.values.length === 1 ? r.values[0] : null;
          events.push(grade != null ? { type: t, grade } : { type: 'error', code: 'badGrade', raw: w });
        } else {
          events.push({ type: 'command', name: t });
        }
        continue outer;
      }
    }

    // 2. 數字 run（中文構式先解、阿拉伯黏字走消歧）
    if (isChineseDigit(s[i]) || isArabic(s[i])) {
      let run = '';
      const arabic = isArabic(s[i]);
      while (i < s.length && (arabic ? isArabic(s[i]) : isChineseDigit(s[i]))) { run += s[i]; i++; }

      let values;
      if (arabic) {
        if (mode === 'pdcal') {
          const remaining = Math.max(1, needed - vals.length);
          const segs = segmentDigits(run, remaining);
          if (segs.length === 1) values = segs[0];
          else {
            flushVals();
            events.push({ type: 'error', code: segs.length ? 'ambiguous' : 'badNumber', raw: run });
            continue;
          }
        } else {
          // bop/pi：兩位數整串是合法牙位就當牙位，否則逐字餵
          const asInt = parseInt(run, 10);
          values = run.length === 2 && isValidTooth(asInt) ? [asInt] : [...run].map(Number);
        }
      } else {
        values = chineseRunToValues(run);
        if (!values) { noise += run; continue; }
      }

      if (mode === 'pdcal') vals.push(...values);
      else for (const v of values) feedToothValue(v);
      continue;
    }

    // 3. 點／側詞（僅 bop/pi 模式；pdcal 下視為雜訊）
    if (mode !== 'pdcal') {
      if (POINT_WORDS[s[i]]) {
        ensureReport();
        const p = POINT_WORDS[s[i]];
        if (p === 'all') report.points = ['all'];
        else if (report.points[0] !== 'all' && !report.points.includes(p)) report.points.push(p);
        i++;
        continue;
      }
      if (SIDE_WORDS[s[i]]) {
        ensureReport();
        report.side = SIDE_WORDS[s[i]];
        i++;
        continue;
      }
    }

    // 4. 其餘 → 雜訊
    noise += s[i];
    i++;
  }

  flushAll();
  return { events, noise };
}
