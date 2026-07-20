// store.js — 病例 CRUD＋自動儲存。storage 可注入：瀏覽器給 localStorage、測試給 memoryStorage()。
// 資料只存本機（spec §6）；量大再升 IndexedDB，介面不變。

import { createBlankChart } from './schema.js';

const INDEX_KEY = 'vpc:index';
const CASE_PREFIX = 'vpc:case:';

export function memoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

export function createStore(storage) {
  const readIndex = () => JSON.parse(storage.getItem(INDEX_KEY) ?? '[]');
  const writeIndex = (idx) => storage.setItem(INDEX_KEY, JSON.stringify(idx));
  const summarize = (c) => ({
    id: c.id,
    patient_name: c.header.patient_name ?? '',
    stage: c.header.stage ?? '',
    exam_date: c.header.exam_date ?? '',
    confirmed: c.confirmed,
    updatedAt: c.updatedAt,
  });

  return {
    listCases() {
      return readIndex();
    },

    createCase({ header = {}, missing = [] } = {}) {
      const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const now = new Date().toISOString();
      const caseObj = {
        id, header,
        chart: createBlankChart(missing),
        sessionState: null,
        confirmed: false,
        createdAt: now,
        updatedAt: now,
      };
      storage.setItem(CASE_PREFIX + id, JSON.stringify(caseObj));
      const idx = readIndex();
      idx.unshift(summarize(caseObj));
      writeIndex(idx);
      return caseObj;
    },

    getCase(id) {
      const raw = storage.getItem(CASE_PREFIX + id);
      return raw ? JSON.parse(raw) : null;
    },

    saveCase(caseObj) {
      caseObj.updatedAt = new Date().toISOString();
      storage.setItem(CASE_PREFIX + caseObj.id, JSON.stringify(caseObj));
      const idx = readIndex();
      const i = idx.findIndex((e) => e.id === caseObj.id);
      const summary = summarize(caseObj);
      if (i >= 0) idx[i] = summary;
      else idx.unshift(summary);
      writeIndex(idx);
      return caseObj;
    },

    deleteCase(id) {
      storage.removeItem(CASE_PREFIX + id);
      writeIndex(readIndex().filter((e) => e.id !== id));
    },
  };
}
