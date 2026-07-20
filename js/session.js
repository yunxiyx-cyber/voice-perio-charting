// session.js — 帶路狀態機：吃 parser 事件、推進游標、寫 chart、產 UI/聲音回饋
// 回饋 kind 對照：point/toothDone → 填格＋叮；error → 噠噠停格；passStart/passDone → 轉場提示

import { parse } from './parser.js';
import { createBlankChart, paperIndexOfPoint, rowIndexOf } from './schema.js';

// 預設帶路順序（spec §4.1，使用者已確認；順序可調，方向規則自動適應）：
// 上顎 Q1頰→Q2頰→顎側同拆兩象限；下顎馬蹄形 Q3頰→Q4頰→Q4舌→Q3舌
export const DEFAULT_PASSES = [
  { id: 'Q1頰', side: 'facial', teeth: [18, 17, 16, 15, 14, 13, 12, 11] },
  { id: 'Q2頰', side: 'facial', teeth: [21, 22, 23, 24, 25, 26, 27, 28] },
  { id: 'Q1顎', side: 'lingual', teeth: [18, 17, 16, 15, 14, 13, 12, 11] },
  { id: 'Q2顎', side: 'lingual', teeth: [21, 22, 23, 24, 25, 26, 27, 28] },
  { id: 'Q3頰', side: 'facial', teeth: [38, 37, 36, 35, 34, 33, 32, 31] },
  { id: 'Q4頰', side: 'facial', teeth: [41, 42, 43, 44, 45, 46, 47, 48] },
  { id: 'Q4舌', side: 'lingual', teeth: [48, 47, 46, 45, 44, 43, 42, 41] },
  { id: 'Q3舌', side: 'lingual', teeth: [31, 32, 33, 34, 35, 36, 37, 38] },
];

const VMAX = 19; // PD/CAL 值域上限（spec §4.2）

export class Session {
  constructor({ chart, passes = DEFAULT_PASSES, onChange = null } = {}) {
    this.chart = chart ?? createBlankChart();
    // 方向通用規則：pass 行進方向與紙面左→右同向＝口述序直填，反向＝鏡射（2-i）
    this.passes = passes.map((p) => ({
      ...p,
      reversed: p.teeth.length >= 2 && rowIndexOf(p.teeth[0]) > rowIndexOf(p.teeth[1]),
    }));
    this.onChange = onChange;

    this.phase = 'pdcal'; // pdcal | await(段落完成，等 BOP 或下一段) | bop | pi | done
    this.passIdx = 0;
    this.tooth = null;
    this.pointIdx = 0;
    this.pendingPd = null;
    this.paused = false;
    this.undoStack = [];
    this.bopPassIdx = 0;
    this.bopReturn = null; // 從 pdcal 中途進 BOP 時的回復點
    this.piReturn = null;
    this.lastReportTooth = null; // BOP/PI 報告跨句延續（「17 遠」＋下一句「中」）
    this.lastPiSide = null;

    this.#seekFirstPass();
  }

  // ---------- 對外 ----------

  handleTranscript(text) {
    const ctx = {
      mode: this.phase === 'bop' ? 'bop' : this.phase === 'pi' ? 'pi' : 'pdcal',
      needed: this.neededValues(),
    };
    const { events, noise } = parse(text, ctx);
    const fb = this.applyEvents(events);
    if (noise && events.length === 0) fb.push({ kind: 'noise', raw: noise });
    if (this.onChange) this.onChange(this);
    return fb;
  }

  // 當前牙還缺幾個值（黏字消歧的約束；非 pdcal 給寬鬆上限）
  neededValues() {
    if (this.phase !== 'pdcal') return 6;
    return (this.pendingPd == null ? 2 : 1) + (2 - this.pointIdx) * 2;
  }

  presentTeeth(passIdx = this.passIdx) {
    return this.passes[passIdx].teeth.filter((t) => this.chart.teeth[String(t)].status === 'present');
  }

  currentPass() {
    return this.passes[this.passIdx];
  }

  progress() {
    let filled = 0;
    let total = 0;
    for (const p of this.passes) {
      for (const t of p.teeth) {
        const tooth = this.chart.teeth[String(t)];
        if (tooth.status !== 'present') continue;
        total += 3;
        filled += tooth[p.side].pd.filter((v) => v != null).length;
      }
    }
    return { filled, total };
  }

  getState() {
    return {
      phase: this.phase, passIdx: this.passIdx, tooth: this.tooth, pointIdx: this.pointIdx,
      pendingPd: this.pendingPd, paused: this.paused, bopPassIdx: this.bopPassIdx,
      bopReturn: this.bopReturn, piReturn: this.piReturn,
    };
  }

  resume(state) {
    Object.assign(this, state);
  }

  // ---------- 事件套用 ----------

  applyEvents(events) {
    const fb = [];
    for (const ev of events) {
      if (this.paused && !(ev.type === 'command' && ev.name === 'resume')) {
        fb.push({ kind: 'ignoredPaused' });
        continue;
      }
      switch (ev.type) {
        case 'values': this.#onValues(ev.values, fb); break;
        case 'command': this.#onCommand(ev.name, fb); break;
        case 'goto': this.#onGoto(ev.tooth, fb); break;
        case 'mobility': this.#onGrade('mobility', ev.grade, fb); break;
        case 'furcation': this.#onGrade('furcation', ev.grade, fb); break;
        case 'bopReport': this.#onReport('bop', ev, fb); break;
        case 'piReport': this.#onReport('pi', ev, fb); break;
        case 'error': fb.push({ kind: 'error', code: ev.code, raw: ev.raw }); break;
        default: fb.push({ kind: 'error', code: 'unknownEvent' });
      }
    }
    return fb;
  }

  #onValues(values, fb) {
    if (this.phase === 'await') this.#advancePass(fb); // 略過 BOP 直接唸下一段
    if (this.phase !== 'pdcal') { fb.push({ kind: 'error', code: 'wrongMode' }); return; }
    for (const v of values) {
      if (this.phase === 'await') this.#advancePass(fb); // 值串跨段邊界
      if (this.phase !== 'pdcal') { fb.push({ kind: 'error', code: 'extraValues' }); return; }
      if (!Number.isInteger(v) || v < 0 || v > VMAX) {
        fb.push({ kind: 'error', code: 'range', raw: String(v) });
        return; // 丟棄本串剩餘值，避免 PD/CAL 錯位
      }
      this.#applyValue(v, fb);
    }
  }

  #applyValue(v, fb) {
    if (this.pendingPd == null) {
      this.pendingPd = v;
      fb.push({ kind: 'pd', tooth: this.tooth, point: this.pointIdx, value: v });
      return;
    }
    const pd = this.pendingPd;
    const cal = v;
    this.pendingPd = null;
    const pass = this.currentPass();
    const paperIdx = pass.reversed ? 2 - this.pointIdx : this.pointIdx;
    const sideObj = this.chart.teeth[String(this.tooth)][pass.side];
    this.undoStack.push({
      t: 'point', tooth: this.tooth, side: pass.side, paperIdx,
      prevPd: sideObj.pd[paperIdx], prevCal: sideObj.cal[paperIdx], cursor: this.#cursor(),
    });
    sideObj.pd[paperIdx] = pd;
    sideObj.cal[paperIdx] = cal;
    fb.push({ kind: 'point', tooth: this.tooth, side: pass.side, paperIdx, pd, cal, warn: cal < pd ? 'CAL<PD' : null });
    this.pointIdx++;
    if (this.pointIdx >= 3) {
      fb.push({ kind: 'toothDone', tooth: this.tooth });
      this.#advanceTooth(fb);
    }
  }

  #onCommand(name, fb) {
    switch (name) {
      case 'pause': this.paused = true; fb.push({ kind: 'paused' }); break;
      case 'resume': this.paused = false; fb.push({ kind: 'resumed' }); break;
      case 'undo': this.#undo(fb); break;
      case 'redoTooth': this.#redoTooth(fb); break;
      case 'missing': this.#markMissing(fb); break;
      case 'prevTooth': this.#prevTooth(fb); break;
      case 'bop': this.#enterBop(fb); break;
      case 'pi': this.#enterPi(fb); break;
      case 'finish': this.#finish(fb); break;
      default: fb.push({ kind: 'error', code: 'unknownCommand', raw: name });
    }
  }

  // ---------- 游標與段落 ----------

  #cursor() {
    return { passIdx: this.passIdx, tooth: this.tooth, pointIdx: this.pointIdx };
  }

  #restoreCursor(c) {
    this.passIdx = c.passIdx;
    this.tooth = c.tooth;
    this.pointIdx = c.pointIdx;
    this.pendingPd = null;
    this.phase = 'pdcal';
  }

  #seekFirstPass() {
    while (this.passIdx < this.passes.length && this.presentTeeth().length === 0) this.passIdx++;
    if (this.passIdx >= this.passes.length) { this.phase = 'done'; return; }
    this.tooth = this.presentTeeth()[0];
    this.pointIdx = 0;
  }

  #advanceTooth(fb) {
    const list = this.presentTeeth();
    const i = list.indexOf(this.tooth);
    if (i >= 0 && i + 1 < list.length) {
      this.tooth = list[i + 1];
      this.pointIdx = 0;
      fb.push({ kind: 'nextTooth', tooth: this.tooth });
    } else {
      this.phase = 'await';
      fb.push({ kind: 'passDone', passId: this.currentPass().id });
    }
  }

  #advancePass(fb) {
    this.passIdx++;
    while (this.passIdx < this.passes.length && this.presentTeeth().length === 0) this.passIdx++;
    if (this.passIdx >= this.passes.length) {
      this.phase = 'done';
      fb.push({ kind: 'allDone' });
      return;
    }
    this.phase = 'pdcal';
    this.tooth = this.presentTeeth()[0];
    this.pointIdx = 0;
    this.pendingPd = null;
    fb.push({ kind: 'passStart', passId: this.currentPass().id, tooth: this.tooth });
  }

  // ---------- 指令實作 ----------

  #undo(fb) {
    if (this.pendingPd != null) {
      this.pendingPd = null;
      fb.push({ kind: 'undoPd', tooth: this.tooth, point: this.pointIdx });
      return;
    }
    const e = this.undoStack.pop();
    if (!e) { fb.push({ kind: 'error', code: 'nothingToUndo' }); return; }
    const tooth = this.chart.teeth[String(e.tooth)];
    switch (e.t) {
      case 'point':
        tooth[e.side].pd[e.paperIdx] = e.prevPd;
        tooth[e.side].cal[e.paperIdx] = e.prevCal;
        this.#restoreCursor(e.cursor);
        break;
      case 'toothClear':
        tooth[e.side].pd = e.prevPd;
        tooth[e.side].cal = e.prevCal;
        this.#restoreCursor(e.cursor);
        break;
      case 'missing':
        this.chart.teeth[String(e.tooth)] = e.prevTooth;
        this.#restoreCursor(e.cursor);
        break;
      case 'mark':
        tooth[e.side][e.field] = e.prev;
        break;
      case 'mobility':
        tooth.mobility = e.prev;
        break;
      case 'furcation':
        tooth[e.side].furcation = e.prev;
        break;
    }
    fb.push({ kind: 'undo', what: e.t, tooth: e.tooth });
  }

  #redoTooth(fb) {
    if (this.phase !== 'pdcal') { fb.push({ kind: 'error', code: 'wrongMode' }); return; }
    const side = this.currentPass().side;
    const sideObj = this.chart.teeth[String(this.tooth)][side];
    this.undoStack.push({
      t: 'toothClear', tooth: this.tooth, side,
      prevPd: [...sideObj.pd], prevCal: [...sideObj.cal],
      cursor: { ...this.#cursor(), pointIdx: 0 },
    });
    sideObj.pd = [null, null, null];
    sideObj.cal = [null, null, null];
    this.pointIdx = 0;
    this.pendingPd = null;
    fb.push({ kind: 'redoTooth', tooth: this.tooth });
  }

  #markMissing(fb) {
    if (this.phase !== 'pdcal') { fb.push({ kind: 'error', code: 'wrongMode' }); return; }
    const t = this.tooth;
    const list = this.presentTeeth();
    const i = list.indexOf(t);
    this.undoStack.push({
      t: 'missing', tooth: t,
      prevTooth: JSON.parse(JSON.stringify(this.chart.teeth[String(t)])),
      cursor: this.#cursor(),
    });
    this.chart.teeth[String(t)] = { status: 'missing' };
    fb.push({ kind: 'missing', tooth: t });
    this.pendingPd = null;
    this.pointIdx = 0;
    const rest = this.presentTeeth();
    if (i < rest.length) {
      this.tooth = rest[i]; // 原位置的下一顆（清單已少一顆）
      fb.push({ kind: 'nextTooth', tooth: this.tooth });
    } else {
      this.phase = 'await';
      fb.push({ kind: 'passDone', passId: this.currentPass().id });
    }
  }

  #prevTooth(fb) {
    if (this.phase !== 'pdcal') { fb.push({ kind: 'error', code: 'wrongMode' }); return; }
    const list = this.presentTeeth();
    const i = list.indexOf(this.tooth);
    if (i <= 0) { fb.push({ kind: 'error', code: 'atFirstTooth' }); return; }
    this.tooth = list[i - 1];
    this.pointIdx = 0;
    this.pendingPd = null;
    fb.push({ kind: 'goto', tooth: this.tooth });
  }

  #onGoto(t, fb) {
    if (this.phase === 'await') this.phase = 'pdcal'; // 段落完成後仍可跳回本段補漏
    if (this.phase !== 'pdcal') { fb.push({ kind: 'error', code: 'wrongMode' }); return; }
    const list = this.presentTeeth();
    if (!list.includes(t)) { fb.push({ kind: 'error', code: 'toothNotInPass', raw: String(t) }); return; }
    this.tooth = t;
    this.pointIdx = 0;
    this.pendingPd = null;
    fb.push({ kind: 'goto', tooth: t });
  }

  #onGrade(which, grade, fb) {
    if (this.phase !== 'pdcal' && this.phase !== 'await') { fb.push({ kind: 'error', code: 'wrongMode' }); return; }
    if (!Number.isInteger(grade) || grade < 1 || grade > 3) {
      fb.push({ kind: 'error', code: 'badGrade', raw: String(grade) });
      return;
    }
    const tooth = this.chart.teeth[String(this.tooth)];
    if (which === 'mobility') {
      this.undoStack.push({ t: 'mobility', tooth: this.tooth, prev: tooth.mobility });
      tooth.mobility = grade;
    } else {
      const side = this.currentPass().side;
      this.undoStack.push({ t: 'furcation', tooth: this.tooth, side, prev: tooth[side].furcation });
      tooth[side].furcation = grade;
    }
    fb.push({ kind: which, tooth: this.tooth, grade });
  }

  // ---------- BOP / PI ----------

  #enterBop(fb) {
    if (this.phase !== 'pdcal' && this.phase !== 'await') { fb.push({ kind: 'error', code: 'wrongMode' }); return; }
    this.bopReturn = this.phase === 'pdcal' ? this.#cursor() : null;
    this.bopPassIdx = this.passIdx;
    this.phase = 'bop';
    this.lastReportTooth = null;
    fb.push({ kind: 'enterBop', passId: this.passes[this.bopPassIdx].id });
  }

  #enterPi(fb) {
    if (this.phase === 'pi' || this.phase === 'done') { fb.push({ kind: 'error', code: 'wrongMode' }); return; }
    this.piReturn = { phase: this.phase, cursor: this.#cursor(), bopPassIdx: this.bopPassIdx, bopReturn: this.bopReturn };
    this.phase = 'pi';
    this.lastReportTooth = null;
    this.lastPiSide = null;
    fb.push({ kind: 'enterPi' });
  }

  #finish(fb) {
    switch (this.phase) {
      case 'bop':
        fb.push({ kind: 'finishBop', passId: this.passes[this.bopPassIdx].id });
        if (this.bopReturn) this.#restoreCursor(this.bopReturn);
        else { this.passIdx = this.bopPassIdx; this.#advancePass(fb); }
        this.bopReturn = null;
        break;
      case 'pi': {
        const r = this.piReturn;
        this.phase = r.phase;
        if (r.phase === 'pdcal') this.#restoreCursor(r.cursor);
        else { this.passIdx = r.cursor.passIdx; this.tooth = r.cursor.tooth; this.pointIdx = r.cursor.pointIdx; }
        this.bopPassIdx = r.bopPassIdx;
        this.bopReturn = r.bopReturn;
        this.piReturn = null;
        fb.push({ kind: 'finishPi' });
        break;
      }
      case 'await':
        this.#advancePass(fb);
        break;
      case 'done':
        fb.push({ kind: 'allDone' });
        break;
      default:
        fb.push({ kind: 'error', code: 'passNotDone' }); // pdcal 唸到一半的「完成」不作數
    }
  }

  #onReport(which, ev, fb) {
    if (this.phase !== (which === 'bop' ? 'bop' : 'pi')) { fb.push({ kind: 'error', code: 'wrongMode' }); return; }
    const tooth = ev.tooth ?? this.lastReportTooth;
    if (tooth == null) { fb.push({ kind: 'error', code: 'noTooth' }); return; }

    let side;
    if (which === 'bop') {
      const pass = this.passes[this.bopPassIdx];
      if (!pass.teeth.includes(tooth)) { fb.push({ kind: 'error', code: 'toothNotInPass', raw: String(tooth) }); return; }
      side = pass.side;
    } else {
      side = ev.side ?? this.lastPiSide; // 側位跨牙延續，換側才需要重報
      if (!side) { fb.push({ kind: 'error', code: 'needSide', raw: String(tooth) }); return; } // PI 全口模式開頭必須指定頰/舌
    }

    const toothObj = this.chart.teeth[String(tooth)];
    if (toothObj.status !== 'present') { fb.push({ kind: 'error', code: 'toothMissing', raw: String(tooth) }); return; }
    if (!ev.points.length) { fb.push({ kind: 'error', code: 'noPoints', raw: String(tooth) }); return; }

    const field = which === 'bop' ? 'bop' : 'plaque';
    const idxs = ev.points[0] === 'all' ? [0, 1, 2] : ev.points.map((p) => paperIndexOfPoint(tooth, p));
    this.undoStack.push({ t: 'mark', tooth, side, field, prev: [...toothObj[side][field]] });
    for (const idx of idxs) toothObj[side][field][idx] = 1;
    this.lastReportTooth = tooth;
    if (which === 'pi') this.lastPiSide = side;
    fb.push({ kind: which === 'bop' ? 'bopMark' : 'piMark', tooth, side, idxs });
  }
}
