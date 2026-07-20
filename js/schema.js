// schema.js — chart 資料結構（spec §6.1，向下相容 perio_chart pilot）
// 慣例：FDI 牙位；facial/lingual 各存 3 元素陣列，順序＝紙面左→右；GM 不入檔，檢視/渲染時算。

// 紙面同一排的左→右牙位順序（病人右側在紙面左，牙科慣例）
export const UPPER_ROW = [18, 17, 16, 15, 14, 13, 12, 11, 21, 22, 23, 24, 25, 26, 27, 28];
export const LOWER_ROW = [48, 47, 46, 45, 44, 43, 42, 41, 31, 32, 33, 34, 35, 36, 37, 38];
export const ALL_TEETH = [...UPPER_ROW, ...LOWER_ROW];

export function isValidTooth(n) {
  return ALL_TEETH.includes(n);
}

export function quadrantOf(t) {
  return Math.floor(t / 10);
}

// 牙位在自己那一排的紙面位置（0=最左）；跨排比較無意義，僅供同一 pass 內判方向
export function rowIndexOf(t) {
  const row = t < 30 ? UPPER_ROW : LOWER_ROW;
  return row.indexOf(t);
}

// 紙面左→右的三點名稱：Q1/Q4（病人右側）＝遠、中、近；Q2/Q3＝近、中、遠
export function paperPointNames(t) {
  const q = quadrantOf(t);
  return q === 1 || q === 4 ? ['D', 'mid', 'M'] : ['M', 'mid', 'D'];
}

// 點名（'D'|'mid'|'M'）→ 該牙紙面陣列 index
export function paperIndexOfPoint(t, name) {
  return paperPointNames(t).indexOf(name);
}

function blankSide() {
  return { pd: [null, null, null], cal: [null, null, null], bop: [0, 0, 0], plaque: [0, 0, 0], furcation: null };
}

export function blankTooth() {
  return { status: 'present', mobility: null, facial: blankSide(), lingual: blankSide() };
}

export function createBlankChart(missing = []) {
  const teeth = {};
  for (const t of ALL_TEETH) {
    teeth[String(t)] = missing.includes(t) ? { status: 'missing' } : blankTooth();
  }
  return { teeth };
}

// GM = CAL − PD（spec §2；負值合法＝牙齦腫大）
export function computeGM(side) {
  return side.pd.map((pd, i) => (pd == null || side.cal[i] == null ? null : side.cal[i] - pd));
}

// 匯出用：組出與 pilot 同構的 chart.json 物件（含擴充欄位）
export function toChartJson(chart, header) {
  return {
    header: { ...header },
    point_order: '每側 3 元素，紙面左→右',
    teeth: JSON.parse(JSON.stringify(chart.teeth)),
  };
}
