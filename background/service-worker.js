/*
 * 后台 service worker：
 *  - 执行 chrome.downloads 下载（带子文件夹路径、自动重名去重）
 *  - 记录任务进度/日志/结果（持久化到 storage.local，SW 空闲休眠后可恢复）
 *  - 转发 popup 与内容脚本之间的启动/取消指令
 */
'use strict';

const STATE_KEY = 'sw:state';
let state = null;

async function loadState() {
  if (state) return state;
  let saved = {};
  try { saved = (await chrome.storage.local.get(STATE_KEY))[STATE_KEY] || {}; } catch (e) { /* 忽略 */ }
  state = Object.assign({ running: false, progress: null, log: [], summary: null, tabId: null }, saved);
  return state;
}

async function saveState() {
  try { await chrome.storage.local.set({ [STATE_KEY]: state }); } catch (e) { /* 忽略 */ }
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  (async function () {
    const st = await loadState();
    switch (msg && msg.type) {
      case 'download': {
        try {
          const id = await chrome.downloads.download({
            url: msg.dataUrl,
            filename: msg.filename,       // 相对路径 → 下载目录下的子文件夹
            conflictAction: 'uniquify',   // 重名自动加 (1)
            saveAs: false,
          });
          sendResponse({ ok: true, id: id });
        } catch (e) {
          sendResponse({ ok: false, error: String((e && e.message) || e) });
        }
        return;
      }
      case 'progress':
        st.progress = Object.assign({ stage: msg.stage, ts: Date.now() }, msg.payload || {});
        await saveState();
        return;
      case 'log':
        st.log.push({ ts: Date.now(), level: msg.level, msg: msg.msg });
        if (st.log.length > 200) st.log.splice(0, st.log.length - 200);
        await saveState();
        return;
      case 'done':
        st.running = false;
        st.summary = msg.summary || {};
        await saveState();
        return;
      case 'begin': {
        if (st.running) { sendResponse({ ok: false, error: 'busy' }); return; }
        st.running = true;
        st.summary = null;
        st.progress = { stage: 'start', ts: Date.now() };
        st.tabId = msg.tabId;
        await saveState();
        try {
          await chrome.tabs.sendMessage(msg.tabId, { type: 'runSweep', job: msg.job });
          sendResponse({ ok: true });
        } catch (e) {
          st.running = false;
          await saveState();
          sendResponse({ ok: false, error: String((e && e.message) || e) });
        }
        return;
      }
      case 'cancel': {
        if (st.tabId != null) {
          try { await chrome.tabs.sendMessage(st.tabId, { type: 'cancelSweep' }); } catch (e) { /* 页面可能已关闭 */ }
        }
        return;
      }
      case 'getState':
        sendResponse({
          running: st.running,
          progress: st.progress,
          summary: st.summary,
          log: st.log.slice(-50),
        });
        return;
      case 'reset':
        st.running = false;
        st.summary = null;
        st.progress = null;
        await saveState();
        sendResponse({ ok: true });
        return;
    }
  })();
  return true; // 异步 sendResponse
});
