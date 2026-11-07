/*
 * Carnet santé Helper — File System Access API 封装
 * 让用户自选报告保存文件夹（showDirectoryPicker），句柄存 IndexedDB，
 * 供 service worker 直接写文件；与浏览器下载目录模式并存（此处失败即回退）。
 * 仅在扩展页面（options/popup）与 SW 中加载；浏览器不支持时静默降级。
 */
'use strict';
(function (global) {

  const DB_NAME = 'csh-fs';
  const STORE = 'handles';
  const KEY = 'reports';

  function openDb() {
    return new Promise(function (resolve, reject) {
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = function () { r.result.createObjectStore(STORE); };
      r.onsuccess = function () { resolve(r.result); };
      r.onerror = function () { reject(r.error); };
    });
  }

  async function tx(mode, fn) {
    const db = await openDb();
    return new Promise(function (resolve, reject) {
      const t = db.transaction(STORE, mode);
      const req = fn(t.objectStore(STORE));
      t.oncomplete = function () { resolve(req && req.result); };
      t.onerror = function () { reject(t.error); };
    });
  }

  async function getHandle() {
    try { return await tx('readonly', function (s) { return s.get(KEY); }); }
    catch (e) { return null; }
  }
  async function storeHandle(h) { await tx('readwrite', function (s) { return s.put(h, KEY); }); }
  async function clearHandle() {
    try { await tx('readwrite', function (s) { return s.delete(KEY); }); } catch (e) { /* 忽略 */ }
  }

  async function checkPermission(h) {
    try { return !!(h && (await h.queryPermission({ mode: 'readwrite' })) === 'granted'); }
    catch (e) { return false; }
  }
  async function requestPermission(h) {
    try { return !!(h && (await h.requestPermission({ mode: 'readwrite' })) === 'granted'); }
    catch (e) { return false; }
  }

  async function pickDirectory() {
    const h = await window.showDirectoryPicker({ mode: 'readwrite', id: 'csh-reports' });
    await storeHandle(h);
    return h;
  }

  // 在所选文件夹下按相对路径写入（自动创建子目录；重名加 " (n)"，行为对齐 downloads.uniquify）
  async function writeFile(root, relPath, bytes) {
    const parts = String(relPath).split('/').filter(Boolean);
    const name = parts.pop();
    if (!name) throw new Error('empty filename');
    let dir = root;
    for (const seg of parts) dir = await dir.getDirectoryHandle(seg, { create: true });

    let finalName = name;
    for (let i = 2; i < 1000; i++) {
      try {
        await dir.getFileHandle(finalName);
        finalName = name.replace(/(\.[^./]+)?$/, function (m) { return ' (' + i + ')' + m; });
      } catch (e) {
        if (e && e.name === 'NotFoundError') break;   // 不存在 → 可用
        throw e;
      }
    }
    const fh = await dir.getFileHandle(finalName, { create: true });
    const w = await fh.createWritable();
    await w.write(bytes);
    await w.close();
    return finalName;
  }

  const api = {
    supported: function () { return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function'; },
    getHandle: getHandle,
    storeHandle: storeHandle,
    clearHandle: clearHandle,
    checkPermission: checkPermission,
    requestPermission: requestPermission,
    pickDirectory: pickDirectory,
    writeFile: writeFile,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.CSHFsa = api;
})(typeof self !== 'undefined' ? self : globalThis);
