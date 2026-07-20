// chart-view.js — 仿紙本 PERIODONTAL SPECIAL CHARTING 渲染（行序忠實照 perio_chart layout.json）
// 上顎：頰側 CAL/PD/GM（上→下）→ 牙位 → 顎側 GM/PD/CAL（鏡像）；下顎同構（頰在上、舌在下）。
// GM=CAL−PD 即時算、唯讀藍字、可為負；缺牙整欄斜線；當前格高亮；一次一區段可左右滑。
// BOP/plaque/mobility/furcation 的「顯示」屬 Phase 3，本檔只預留 BOP 細列位置，暫不填。

import { UPPER_ROW, LOWER_ROW, computeGM } from './schema.js';

// 四個 grid 的行序（top→bottom）。facial 在牙位列上方、lingual 在下方＝紙本鏡像。
const ARCHES = [
  { id: 'upper', title: '上顎', teeth: UPPER_ROW, lingualLabel: '顎' },
  { id: 'lower', title: '下顎', teeth: LOWER_ROW, lingualLabel: '舌' },
];

const ROW_LABEL = { cal: 'CAL', pd: 'PD', gm: 'GM' };

// 從 session 讀當前游標（哪一格正在等填）
function cursorOf(session) {
  if (!session || session.tooth == null) return null;
  const pass = session.currentPass();
  if (!pass) return null;
  const paperIdx = pass.reversed ? 2 - session.pointIdx : session.pointIdx;
  return {
    tooth: session.tooth,
    side: pass.side,
    paperIdx,
    meaning: session.pendingPd == null ? 'pd' : 'cal',
    pdcal: session.phase === 'pdcal',
  };
}

function esc(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

// 一列數值列（cal/pd/gm 之一）
function dataRow(teeth, chart, side, meaning, label, cur) {
  let cells = '';
  for (const t of teeth) {
    const tooth = chart.teeth[String(t)];
    const missing = !tooth || tooth.status === 'missing';
    if (missing) {
      cells += `<div class="tcol missing" data-tooth="${t}"><div class="cell"></div><div class="cell"></div><div class="cell"></div></div>`;
      continue;
    }
    const sideObj = tooth[side];
    const vals = meaning === 'gm' ? computeGM(sideObj) : sideObj[meaning];
    let inner = '';
    for (let p = 0; p < 3; p++) {
      const isCurCol = cur && cur.tooth === t && cur.side === side && cur.paperIdx === p;
      const isCurCell = isCurCol && cur.pdcal && cur.meaning === meaning;
      const cls = ['cell', meaning === 'gm' ? 'gm' : '', isCurCol ? 'curcol' : '', isCurCell ? 'curcell' : '']
        .filter(Boolean).join(' ');
      const v = vals[p];
      const txt = v == null ? '' : String(v);
      const bad = meaning === 'gm' && v != null && v < 0 ? ' neg' : '';
      inner += `<div class="${cls}${bad}">${txt}</div>`;
    }
    cells += `<div class="tcol" data-tooth="${t}">${inner}</div>`;
  }
  return `<div class="row"><div class="lbl">${label}</div>${cells}</div>`;
}

// BOP 預留細列（Phase 3 才填紅點）
function bopRow(teeth, chart, side) {
  let cells = '';
  for (const t of teeth) {
    const tooth = chart.teeth[String(t)];
    const missing = !tooth || tooth.status === 'missing';
    cells += `<div class="tcol bopcol${missing ? ' missing' : ''}"><div class="cell"></div><div class="cell"></div><div class="cell"></div></div>`;
  }
  return `<div class="row bop"><div class="lbl bop">BOP</div>${cells}</div>`;
}

// 牙位列（號碼；缺牙整欄斜線＋號碼加刪除線）
function numberRow(teeth, chart, cur) {
  let cells = '';
  for (const t of teeth) {
    const tooth = chart.teeth[String(t)];
    const missing = !tooth || tooth.status === 'missing';
    const isCur = cur && cur.tooth === t;
    const cls = ['numcol', missing ? 'missing' : '', isCur ? 'curtooth' : ''].filter(Boolean).join(' ');
    const mob = !missing && tooth.mobility ? `<span class="mob">M${tooth.mobility}</span>` : '';
    cells += `<div class="${cls}" data-tooth="${t}"><span class="tnum">${t}</span>${mob}</div>`;
  }
  return `<div class="row numrow"><div class="lbl num">牙位</div>${cells}</div>`;
}

function archBlock(arch, chart, cur) {
  const t = arch.teeth;
  const rows = [];
  // 頰側（上→下）：BOP 預留 / CAL / PD / GM
  rows.push(bopRow(t, chart, 'facial'));
  rows.push(dataRow(t, chart, 'facial', 'cal', '頰 CAL', cur));
  rows.push(dataRow(t, chart, 'facial', 'pd', '頰 PD', cur));
  rows.push(dataRow(t, chart, 'facial', 'gm', '頰 GM', cur));
  // 牙位列
  rows.push(numberRow(t, chart, cur));
  // 顎/舌側（鏡像，上→下）：GM / PD / CAL / BOP 預留
  rows.push(dataRow(t, chart, 'lingual', 'gm', `${arch.lingualLabel} GM`, cur));
  rows.push(dataRow(t, chart, 'lingual', 'pd', `${arch.lingualLabel} PD`, cur));
  rows.push(dataRow(t, chart, 'lingual', 'cal', `${arch.lingualLabel} CAL`, cur));
  rows.push(bopRow(t, chart, 'lingual'));
  return `<div class="arch" data-arch="${arch.id}">
    <div class="archttl">${esc(arch.title)}</div>
    <div class="scroller"><div class="grid">${rows.join('')}</div></div>
  </div>`;
}

// 對外：重建整張表；保留各弓橫向捲動位置，並把當前格捲進視野置中
export function renderChart(container, session) {
  const chart = session.chart;
  const cur = cursorOf(session);
  // 保留捲動
  const prevScroll = {};
  container.querySelectorAll('.arch').forEach((a) => {
    const s = a.querySelector('.scroller');
    if (s) prevScroll[a.dataset.arch] = s.scrollLeft;
  });

  container.innerHTML = ARCHES.map((a) => archBlock(a, chart, cur)).join('');

  container.querySelectorAll('.arch').forEach((a) => {
    const s = a.querySelector('.scroller');
    if (s && prevScroll[a.dataset.arch] != null) s.scrollLeft = prevScroll[a.dataset.arch];
  });

  // 當前牙捲進視野置中（只捲游標所在弓，避免亂跳）
  if (cur) {
    const curArch = cur.tooth < 30 ? 'upper' : 'lower';
    const archEl = container.querySelector(`.arch[data-arch="${curArch}"]`);
    const scroller = archEl && archEl.querySelector('.scroller');
    const col = archEl && archEl.querySelector(`.numcol[data-tooth="${cur.tooth}"]`);
    if (scroller && col) {
      const target = col.offsetLeft - scroller.clientWidth / 2 + col.offsetWidth / 2;
      scroller.scrollLeft = Math.max(0, target);
    }
  }
}
