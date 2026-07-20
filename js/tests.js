// tests.js — Phase 1 純邏輯層測試（瀏覽器 test.html 與 Node run_tests.mjs 共用）
// 此檔只用合成資料，可進公開 repo；真實 pilot 重播比對只在本機 Node 跑（run_tests.mjs）。

import { HOMOPHONES, applyHomophones, chineseRunToValues, segmentDigits } from './zhnum.js';
import { createBlankChart, computeGM, paperIndexOfPoint, rowIndexOf } from './schema.js';
import { parse } from './parser.js';
import { Session, DEFAULT_PASSES } from './session.js';
import { createStore, memoryStorage } from './store.js';

// ---------- 迷你測試框架 ----------

const eq = (actual, expected, msg = '') => {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg} got=${a} want=${b}`);
};
const ok = (cond, msg = 'assertion failed') => { if (!cond) throw new Error(msg); };

// ---------- 輔助 ----------

const TENS = ['十', '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九'];
const spoken = (v) => (v <= 9 ? String(v) : TENS[v - 10]);

const mkSession = ({ missing = [], passes = DEFAULT_PASSES } = {}) =>
  new Session({ chart: createBlankChart(missing), passes });

// 口述一點（PD、CAL 兩個值）
const say = (sess, text) => sess.handleTranscript(text);
const sayPoint = (sess, pd, cal) => say(sess, `${spoken(pd)} ${spoken(cal)}`);
const sayTooth = (sess, points) => points.forEach(([pd, cal]) => sayPoint(sess, pd, cal));

// ---------- 測試案例 ----------

export const CASES = [

  // zhnum
  ['中文數字：三三→[3,3]', () => eq(chineseRunToValues('三三'), [3, 3])],
  ['中文數字：十/十一/一十/二十', () => {
    eq(chineseRunToValues('十'), [10]);
    eq(chineseRunToValues('十一'), [11]);
    eq(chineseRunToValues('一十'), [10]);
    eq(chineseRunToValues('二十'), [20]); // 超值域由 session 擋
  }],
  ['同音映射：幺/壹/拾', () => {
    eq(applyHomophones('幺'), '一');
    eq(applyHomophones('壹拾'), '一十');
    ok(HOMOPHONES['時'] === undefined, '常見虛詞同音字不得進雛形映射表');
  }],
  ['黏字消歧：33 唯一解', () => eq(segmentDigits('33', 6), [[3, 3]])],
  ['黏字消歧：105 缺口2→唯一、缺口6→多解', () => {
    eq(segmentDigits('105', 2), [[10, 5]]);
    ok(segmentDigits('105', 6).length > 1);
  }],
  ['黏字消歧：113 恆為多解', () => ok(segmentDigits('113', 2).length > 1)],

  // parser
  ['parser：數對＋中文十位', () => {
    const { events } = parse('十 十', { mode: 'pdcal', needed: 6 });
    eq(events, [{ type: 'values', values: [10, 10] }]);
  }],
  ['parser：指令與數值保持順序', () => {
    const { events } = parse('改 5 5', { mode: 'pdcal', needed: 6 });
    eq(events[0], { type: 'command', name: 'redoTooth' });
    eq(events[1], { type: 'values', values: [5, 5] });
  }],
  ['parser：動搖二／分叉1／跳到一六', () => {
    eq(parse('動搖二', { mode: 'pdcal' }).events, [{ type: 'mobility', grade: 2 }]);
    eq(parse('分叉1', { mode: 'pdcal' }).events, [{ type: 'furcation', grade: 1 }]);
    eq(parse('跳到一六', { mode: 'pdcal' }).events, [{ type: 'goto', tooth: 16 }]);
  }],
  ['parser：黏字多解→ambiguous', () => {
    const { events } = parse('113', { mode: 'pdcal', needed: 6 });
    eq(events[0].type, 'error');
    eq(events[0].code, 'ambiguous');
  }],
  ['parser：純雜訊無事件', () => {
    const { events, noise } = parse('呃嗯那個', { mode: 'pdcal', needed: 6 });
    eq(events, []);
    ok(noise.length > 0);
  }],
  ['parser bop：17 遠 中', () => {
    const { events } = parse('17 遠 中', { mode: 'bop' });
    eq(events, [{ type: 'bopReport', tooth: 17, side: null, points: ['D', 'mid'] }]);
  }],
  ['parser bop：一四全（黏在一起）', () => {
    const { events } = parse('一四全', { mode: 'bop' });
    eq(events, [{ type: 'bopReport', tooth: 14, side: null, points: ['all'] }]);
  }],
  ['parser pi：一七 頰 遠', () => {
    const { events } = parse('一七 頰 遠', { mode: 'pi' });
    eq(events, [{ type: 'piReport', tooth: 17, side: 'facial', points: ['D'] }]);
  }],

  // schema
  ['紙面點序：Q1/Q4=遠中近、Q2/Q3=近中遠', () => {
    eq(paperIndexOfPoint(17, 'D'), 0);
    eq(paperIndexOfPoint(17, 'M'), 2);
    eq(paperIndexOfPoint(23, 'M'), 0);
    eq(paperIndexOfPoint(36, 'D'), 2);
    eq(paperIndexOfPoint(43, 'D'), 0);
  }],
  ['GM=CAL−PD，負值合法', () => eq(computeGM({ pd: [3, 3, null], cal: [4, 2, null] }), [1, -1, null])],

  // session：方向錨點（獨立手算，不依賴 reversed 規則）
  ['錨點 17（Q1頰）：口述遠中近＝紙面直填', () => {
    const s = mkSession({ missing: [18] });
    eq(s.tooth, 17, '18 缺牙預標後起點應為 17');
    sayTooth(s, [[10, 10], [10, 10], [9, 9]]);
    eq(s.chart.teeth['17'].facial.pd, [10, 10, 9]);
    eq(s.chart.teeth['17'].facial.cal, [10, 10, 9]);
  }],
  ['錨點 23（Q2頰）：口述近中遠＝紙面直填', () => {
    const s = mkSession({ passes: [{ id: 'Q2頰', side: 'facial', teeth: [21, 22, 23] }] });
    sayTooth(s, [[3, 3], [3, 3], [3, 3]]); // 21
    sayTooth(s, [[3, 3], [2, 2], [3, 3]]); // 22
    sayTooth(s, [[3, 3], [2, 4], [3, 3]]); // 23：近3/3、中2/4、遠3/3
    eq(s.chart.teeth['23'].facial.pd, [3, 2, 3]);
    eq(s.chart.teeth['23'].facial.cal, [3, 4, 3]);
  }],
  ['錨點 37（Q3頰）：口述遠中近＝紙面鏡射', () => {
    const s = mkSession({ passes: [{ id: 'Q3頰', side: 'facial', teeth: [38, 37] }] });
    sayTooth(s, [[3, 3], [3, 3], [3, 3]]); // 38
    sayTooth(s, [[7, 8], [5, 5], [3, 4]]); // 37：遠7/8、中5/5、近3/4
    eq(s.chart.teeth['37'].facial.pd, [3, 5, 7], '紙面左→右＝近中遠');
    eq(s.chart.teeth['37'].facial.cal, [4, 5, 8]);
  }],
  ['錨點 43（Q4頰）：口述近中遠＝紙面鏡射', () => {
    const s = mkSession({ passes: [{ id: 'Q4頰', side: 'facial', teeth: [41, 42, 43] }] });
    sayTooth(s, [[2, 2], [2, 2], [2, 2]]); // 41
    sayTooth(s, [[2, 2], [2, 2], [2, 2]]); // 42
    sayTooth(s, [[2, 3], [4, 4], [6, 7]]); // 43：近2/3、中4/4、遠6/7
    eq(s.chart.teeth['43'].facial.pd, [6, 4, 2], '紙面左→右＝遠中近');
    eq(s.chart.teeth['43'].facial.cal, [7, 4, 3]);
  }],
  ['錨點 47（Q4舌）：口述遠中近＝紙面直填', () => {
    const s = mkSession({ passes: [{ id: 'Q4舌', side: 'lingual', teeth: [48, 47] }] });
    sayTooth(s, [[3, 3], [3, 3], [3, 3]]); // 48
    sayTooth(s, [[5, 6], [4, 5], [3, 3]]); // 47：遠5/6、中4/5、近3/3
    eq(s.chart.teeth['47'].lingual.pd, [5, 4, 3]);
    eq(s.chart.teeth['47'].lingual.cal, [6, 5, 3]);
  }],

  // session：黏字、錯誤、修正
  ['黏字 33 當一點收', () => {
    const s = mkSession({ missing: [18] });
    say(s, '33');
    eq(s.chart.teeth['17'].facial.pd[0], 3);
    eq(s.chart.teeth['17'].facial.cal[0], 3);
  }],
  ['黏字 105 在缺口=2 時唯一解', () => {
    const s = mkSession({ missing: [18] });
    sayPoint(s, 3, 3);
    sayPoint(s, 4, 4);
    say(s, '105'); // 第三點：PD10 CAL5
    eq(s.chart.teeth['17'].facial.pd, [3, 4, 10]);
    eq(s.chart.teeth['17'].facial.cal, [3, 4, 5]);
  }],
  ['黏字多解→停格等重唸', () => {
    const s = mkSession({ missing: [18] });
    const fb = say(s, '113');
    eq(fb[0].kind, 'error');
    eq(s.pointIdx, 0);
    eq(s.chart.teeth['17'].facial.pd, [null, null, null]);
  }],
  ['超值域（二十）→錯誤且不寫入', () => {
    const s = mkSession({ missing: [18] });
    const fb = say(s, '二十 3');
    ok(fb.some((f) => f.kind === 'error' && f.code === 'range'));
    eq(s.chart.teeth['17'].facial.pd, [null, null, null]);
  }],
  ['CAL<PD 標黃不擋', () => {
    const s = mkSession({ missing: [18] });
    const fb = sayPoint(s, 3, 2);
    const p = fb.find((f) => f.kind === 'point');
    eq(p.warn, 'CAL<PD');
    eq(s.chart.teeth['17'].facial.cal[0], 2);
  }],
  ['復原：先清 pending PD，再退最後一點', () => {
    const s = mkSession({ missing: [18] });
    say(s, '5');
    say(s, '復原');
    eq(s.pendingPd, null);
    sayPoint(s, 3, 3);
    say(s, '復原');
    eq(s.chart.teeth['17'].facial.pd, [null, null, null]);
    eq(s.pointIdx, 0);
    sayPoint(s, 4, 4);
    eq(s.chart.teeth['17'].facial.pd[0], 4);
  }],
  ['改：清當前牙重唸', () => {
    const s = mkSession({ missing: [18] });
    sayPoint(s, 3, 3);
    sayPoint(s, 4, 4);
    say(s, '改');
    eq(s.chart.teeth['17'].facial.pd, [null, null, null]);
    sayTooth(s, [[5, 5], [6, 6], [7, 7]]);
    eq(s.chart.teeth['17'].facial.pd, [5, 6, 7]);
    eq(s.tooth, 16, '收滿三點應自動跳下一顆');
  }],
  ['缺牙：動態標記＋跳下一顆＋可復原', () => {
    const s = mkSession({ missing: [18] });
    say(s, '缺牙'); // 17
    eq(s.chart.teeth['17'].status, 'missing');
    eq(s.tooth, 16);
    say(s, '復原');
    eq(s.chart.teeth['17'].status, 'present');
    eq(s.tooth, 17);
  }],
  ['跳到／上一顆／不在本段報錯', () => {
    const s = mkSession({ missing: [18] });
    say(s, '跳到一五');
    eq(s.tooth, 15);
    say(s, '上一顆');
    eq(s.tooth, 16);
    const fb = say(s, '跳到三六');
    eq(fb[0].code, 'toothNotInPass');
  }],
  ['動搖／分叉掛當前牙', () => {
    const s = mkSession({ missing: [18] });
    say(s, '動搖二');
    say(s, '分叉一');
    eq(s.chart.teeth['17'].mobility, 2);
    eq(s.chart.teeth['17'].facial.furcation, 1);
  }],
  ['暫停期間忽略數值', () => {
    const s = mkSession({ missing: [18] });
    say(s, '暫停');
    sayPoint(s, 3, 3);
    eq(s.chart.teeth['17'].facial.pd, [null, null, null]);
    say(s, '繼續');
    sayPoint(s, 3, 3);
    eq(s.chart.teeth['17'].facial.pd[0], 3);
  }],

  // session：段落流轉、BOP、PI
  ['段落完成→BOP 輪→完成→下一段', () => {
    const s = mkSession({ passes: [
      { id: 'A', side: 'facial', teeth: [17, 16] },
      { id: 'B', side: 'facial', teeth: [21, 22] },
    ] });
    sayTooth(s, [[3, 3], [3, 3], [3, 3]]);
    const fb = sayTooth(s, [[3, 3], [3, 3], [3, 3]]);
    eq(s.phase, 'await');
    say(s, 'bop');
    say(s, '17 遠');
    say(s, '中'); // 跨句延續同一顆
    eq(s.chart.teeth['17'].facial.bop, [1, 1, 0]);
    say(s, '完成');
    eq(s.phase, 'pdcal');
    eq(s.tooth, 21);
  }],
  ['段落完成後直接唸數字＝略過 BOP 自動進下一段', () => {
    const s = mkSession({ passes: [
      { id: 'A', side: 'facial', teeth: [17] },
      { id: 'B', side: 'facial', teeth: [21] },
    ] });
    sayTooth(s, [[3, 3], [3, 3], [3, 3]]);
    eq(s.phase, 'await');
    sayPoint(s, 4, 4);
    eq(s.tooth, 21);
    eq(s.chart.teeth['21'].facial.pd[0], 4);
  }],
  ['BOP：缺牙與不在本段的牙報錯', () => {
    const s = mkSession({ missing: [18], passes: [{ id: 'Q1頰', side: 'facial', teeth: [18, 17] }] });
    sayTooth(s, [[3, 3], [3, 3], [3, 3]]);
    say(s, 'bop');
    eq(say(s, '一八 遠')[0].code, 'toothMissing');
    eq(say(s, '三六 遠')[0].code, 'toothNotInPass');
  }],
  ['PI 模式：全口報牙＋側，側跨牙延續，完成後回原游標', () => {
    const s = mkSession({ missing: [18] });
    sayPoint(s, 3, 3);
    say(s, '牙菌斑模式');
    say(s, '一七 頰 全');
    say(s, '一六 近');
    say(s, '三六 舌 遠');
    eq(s.chart.teeth['17'].facial.plaque, [1, 1, 1]);
    eq(s.chart.teeth['16'].facial.plaque, [0, 0, 1], 'Q1 近中在紙面最右');
    eq(s.chart.teeth['36'].lingual.plaque, [0, 0, 1], 'Q3 遠中在紙面最右');
    say(s, '完成');
    eq(s.phase, 'pdcal');
    eq(s.tooth, 17);
    eq(s.pointIdx, 1);
  }],
  ['PI 模式：沒報側位就報點→needSide', () => {
    const s = mkSession({ missing: [18] });
    say(s, '牙菌斑模式');
    eq(say(s, '一七 遠')[0].code, 'needSide');
  }],

  // 全口合成重播（不含真實病人資料）
  ['全口合成重播：8 段全跑、口述↔紙面一致、進度 100%', () => {
    const missing = [18, 28, 46];
    const s = mkSession({ missing });
    const expected = createBlankChart(missing);

    for (const pass of s.passes) {
      const teeth = pass.teeth.filter((t) => !missing.includes(t));
      for (const t of teeth) {
        for (let sp = 0; sp < 3; sp++) {
          let pd = ((t + sp * 3) % 8) + 2;
          if (t % 10 >= 6) pd += 5; // 臼齒混入 10+ 值，練中文十位
          const cal = pd + ((t + sp) % 3);
          const paperIdx = pass.reversed ? 2 - sp : sp;
          expected.teeth[String(t)][pass.side].pd[paperIdx] = pd;
          expected.teeth[String(t)][pass.side].cal[paperIdx] = cal;
          sayPoint(s, pd, cal);
        }
      }
      if (s.phase === 'await' && s.passIdx < s.passes.length - 1) say(s, '完成');
    }
    say(s, '完成');
    eq(s.phase, 'done');
    for (const t of Object.keys(expected.teeth)) {
      eq(s.chart.teeth[t].facial?.pd ?? null, expected.teeth[t].facial?.pd ?? null, `牙 ${t} facial pd`);
      eq(s.chart.teeth[t].facial?.cal ?? null, expected.teeth[t].facial?.cal ?? null, `牙 ${t} facial cal`);
      eq(s.chart.teeth[t].lingual?.pd ?? null, expected.teeth[t].lingual?.pd ?? null, `牙 ${t} lingual pd`);
      eq(s.chart.teeth[t].lingual?.cal ?? null, expected.teeth[t].lingual?.cal ?? null, `牙 ${t} lingual cal`);
    }
    const pr = s.progress();
    eq(pr.filled, pr.total);
  }],

  // store
  ['store：CRUD＋索引同步', () => {
    const st = createStore(memoryStorage());
    const c = st.createCase({ header: { patient_name: '測試', stage: 'pre' }, missing: [18] });
    eq(st.listCases().length, 1);
    const loaded = st.getCase(c.id);
    eq(loaded.chart.teeth['18'].status, 'missing');
    loaded.confirmed = true;
    st.saveCase(loaded);
    eq(st.listCases()[0].confirmed, true);
    st.deleteCase(c.id);
    eq(st.listCases(), []);
    eq(st.getCase(c.id), null);
  }],
];

// pilot 重播（由 run_tests.mjs 傳入本機 pilot json；瀏覽器版不跑）
export function pilotReplayCase(pilot) {
  return ['王麗容 pilot 重播：上顎頰側口述→與判讀資料完全一致', () => {
    const missing = Object.keys(pilot.teeth)
      .filter((t) => pilot.teeth[t].status === 'missing')
      .map(Number);
    const passes = DEFAULT_PASSES.slice(0, 2); // Q1頰、Q2頰
    const s = mkSession({ missing, passes });
    for (const pass of s.passes) {
      ok(!pass.reversed, '上顎頰側行進方向應與紙面同向');
      for (const t of pass.teeth.filter((x) => !missing.includes(x))) {
        const { pd, cal } = pilot.teeth[String(t)].facial;
        for (let i = 0; i < 3; i++) sayPoint(s, pd[i], cal[i]);
      }
      if (s.phase === 'await') say(s, '完成');
    }
    for (const t of Object.keys(pilot.teeth)) {
      if (pilot.teeth[t].status === 'missing') {
        eq(s.chart.teeth[t].status, 'missing', `牙 ${t}`);
      } else {
        eq(s.chart.teeth[t].facial.pd, pilot.teeth[t].facial.pd, `牙 ${t} pd`);
        eq(s.chart.teeth[t].facial.cal, pilot.teeth[t].facial.cal, `牙 ${t} cal`);
      }
    }
  }];
}

export function runAll(extraCases = []) {
  const results = [];
  for (const [name, fn] of [...CASES, ...extraCases]) {
    try {
      fn();
      results.push({ name, pass: true });
    } catch (e) {
      results.push({ name, pass: false, detail: String(e && e.message ? e.message : e) });
    }
  }
  return results;
}
