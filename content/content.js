/*
 * 内容脚本：在门户页面上下文中
 *  - 从 sessionStorage 读取 OIDC Bearer 令牌（与门户自身的请求同源同权）
 *  - 以页面身份调用 /api/1 接口（行为与网站自身完全一致）
 *  - 把 PDF 交给后台 service worker 用 chrome.downloads 归档保存
 */
'use strict';
if (self.__CSH_CONTENT) {
  // 已注入（静态注册 + scripting 兜底双路径），避免重复注册监听器
} else {
  self.__CSH_CONTENT = true;
  const core = self.CSHCore;
  const pipeline = self.CSHPipeline;
  let currentCancel = null; // { value:boolean }

  function readToken() {
    try {
      for (let i = 0; i < sessionStorage.length; i++) {
        const k = sessionStorage.key(i);
        if (k && k.indexOf('oidc.user:') === 0) {
          try {
            const j = JSON.parse(sessionStorage.getItem(k));
            if (j && j.access_token) return j.access_token;
          } catch (e) { /* 非 JSON，继续 */ }
        }
      }
    } catch (e) { /* sessionStorage 不可用 */ }
    return null;
  }

  async function probe() {
    const token = readToken();
    if (!token) return { hasToken: false };
    try {
      const res = await fetch(pipeline.API.www + '/api/1/Citoyens', {
        headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
      });
      if (!res.ok) return { hasToken: true, profileError: 'HTTP ' + res.status };
      const j = await res.json();
      return {
        hasToken: true,
        profile: { name: ((j.Prenom || '') + ' ' + (j.Nom || '')).trim(), id: j.IdCitoyen },
      };
    } catch (e) {
      return { hasToken: true, profileError: String(e && e.message || e) };
    }
  }

  function post(msg) {
    try {
      const p = chrome.runtime.sendMessage(msg);
      if (p && typeof p.catch === 'function') p.catch(function () {});
    } catch (e) { /* SW 不可达，忽略 */ }
  }

  async function startSweep(job) {
    const cancelFlag = { value: false };
    currentCancel = cancelFlag;
    const env = {
      fetchImpl: function (url, init) { return fetch(url, init); },
      downloadFn: async function (item) {
        if (job.dryRun) return { ok: true, dryRun: true };
        return await chrome.runtime.sendMessage({
          type: 'download',
          dataUrl: core.bytesToDataUrl(item.bytes, item.mime),
          filename: item.filename,
        });
      },
      store: {
        async get(k) { const o = await chrome.storage.local.get(k); return o[k]; },
        async set(k, v) { await chrome.storage.local.set({ [k]: v }); },
      },
      sleep: function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); },
      log: function (level, msg) { post({ type: 'log', level: level, msg: msg }); },
      progress: function (stage, payload) { post({ type: 'progress', stage: stage, payload: payload }); },
      refresh: function () { return Promise.resolve(readToken()); },
      isCancelled: function () { return cancelFlag.value; },
    };
    try {
      const summary = await pipeline.runSweep(job, env);
      post({ type: 'done', summary: summary });
    } catch (e) {
      post({ type: 'done', summary: { fatal: String(e && e.message || e) } });
    } finally {
      currentCancel = null;
    }
  }

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || !msg.type) return;
    switch (msg.type) {
      case 'ping':
        sendResponse({ ok: true });
        return;
      case 'probe':
        probe().then(sendResponse);
        return true;
      case 'runSweep':
        startSweep(msg.job);
        sendResponse({ ok: true });
        return;
      case 'cancelSweep':
        if (currentCancel) currentCancel.value = true;
        sendResponse({ ok: true });
        return;
    }
  });
}
