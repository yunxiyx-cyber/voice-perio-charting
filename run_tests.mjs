// run_tests.mjs — Node 測試執行器：合成案例全跑＋本機王麗容 pilot 重播比對
// pilot json 在 ../perio_chart/（本機專案，不在本 repo；含病人資料，永不入 git）
// 用法：node run_tests.mjs

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { runAll, pilotReplayCase } from './js/tests.js';

const here = dirname(fileURLToPath(import.meta.url));
const PILOT = resolve(here, '..', 'perio_chart', 'charts', 'wang_initial_pilot.json');

const extra = [];
try {
  const pilot = JSON.parse(await readFile(PILOT, 'utf8'));
  extra.push(pilotReplayCase(pilot));
} catch {
  console.log(`（找不到本機 pilot 檔，略過重播比對：${PILOT}）`);
}

const results = runAll(extra);
let failed = 0;
for (const r of results) {
  if (r.pass) console.log(`  ✓ ${r.name}`);
  else { failed++; console.log(`  ✗ ${r.name}\n    ${r.detail}`); }
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
