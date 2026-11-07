/*
 * 后台 service worker：
 *  - 执行 chrome.downloads 下载（带子文件夹路径、自动重名去重）
 *  - 记录任务进度/日志/结果（持久化到 storage.local，SW 空闲休眠后可恢复）
 *  - 转发 popup 与内容脚本之间的启动/取消指令
 */
'use strict';

importScripts('/lib/core.js', '/lib/fsa.js');   // 纯逻辑 + 自选文件夹写入

const STATE_KEY = 'sw:state';
let state = null;

async function loadState() {
  if (state) return state;
  let saved = {};
  try { saved = (await chrome.storage.local.get(STATE_KEY))[STATE_KEY] || {}; } catch (e) { /* 忽略 */ }
  state = Object.assign({
    running: false, progress: null, log: [], summary: null, tabId: null,
    lastDownloadId: null, fallbackCount: 0,
    items: [], stats: { imaging: null, labs: null }, current: null, startedTs: null,
  }, saved);
  return state;
}

// 任务判活：progress.ts 心跳超过 90s 无更新 → 视为任务已死（SW 被杀/页面关闭），自动复位
const STALE_MS = 120 * 1000;
async function checkAlive(st) {
  if (!st.running) return;
  const ts = st.progress && st.progress.ts;
  if (!ts || Date.now() - ts > STALE_MS) {
    st.log.push({ ts: Date.now(), level: 'warn', msg: '检测到任务失去心跳（浏览器休眠了后台或页面已关闭），已复位状态' });
    if (st.log.length > 200) st.log.splice(0, st.log.length - 200);
    st.running = false;
    st.summary = st.summary || { fatal: '任务中断（心跳超时）。请刷新门户页面后重跑；已下载的文件不受影响。' };
    await saveNow();
  }
}

async function saveState() {
  try { await chrome.storage.local.set({ [STATE_KEY]: state }); } catch (e) { /* 忽略 */ }
}

// 进度类消息高频到达（每份报告 3 条以上），整份 state 落盘有写放大：
// 内存即时更新供 getState 读取，落盘按 500ms 合并；状态跃迁（begin/done/cancel…）用 saveNow 立即写。
let saveTimer = null;
function scheduleSave() {
  if (saveTimer != null) return;
  saveTimer = setTimeout(function () {
    saveTimer = null;
    saveState();
  }, 500);
}
async function saveNow() {
  if (saveTimer != null) { clearTimeout(saveTimer); saveTimer = null; }
  await saveState();
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  (async function () {
    const st = await loadState();
    await checkAlive(st);
    switch (msg && msg.type) {
      case 'download': {
        // 边界净化：下载 API / 文件写入都按相对路径处理
        const filename = CSHCore.safeRelativePath(msg.filename);
        if (!filename) {
          sendResponse({ ok: false, error: 'invalid filename: ' + msg.filename });
          return;
        }
        // 优先写入用户自选的文件夹（File System Access）
        try {
          const h = await CSHFsa.getHandle();
          if (h) {
            if (await CSHFsa.checkPermission(h)) {
              const parsed = CSHCore.parseDataUrl(msg.dataUrl);
              await CSHFsa.writeFile(h, filename, new Blob([parsed.bytes], { type: parsed.mime }));
              st.lastDownloadId = null;   // 所选文件夹模式下不再指向下载目录的旧文件
              await saveNow();
              sendResponse({ ok: true, fsa: true, filename: filename });
              return;
            }
            // 有所选文件夹但授权失效 → 明确计数提示（不再静默回退）
            st.fallbackCount++;
            st.log.push({
              ts: Date.now(), level: 'warn',
              msg: '所选文件夹未授权（到 ⚙ 设置重选一次，授权时选「允许每次访问」），文件改存浏览器下载目录：' + filename,
            });
          }
        } catch (e) {
          // 自选文件夹写入失败（被移走/拔盘等）→ 回退下载目录并记录
          st.fallbackCount++;
          st.log.push({
            ts: Date.now(), level: 'warn',
            msg: '写入所选文件夹失败，已改存浏览器下载目录：' + ((e && e.message) || e),
          });
        }
        if (st.log.length > 200) st.log.splice(0, st.log.length - 200);
        await saveNow();
        // 回退：chrome.downloads（保存到默认下载目录的子文件夹）
        try {
          const id = await chrome.downloads.download({
            url: msg.dataUrl,
            filename: filename,          // 相对路径 → 下载目录下的子文件夹
            conflictAction: 'uniquify',  // 重名自动加 (1)
            saveAs: false,
          });
          if (id == null) {
            // 用户在「保存位置」对话框点了取消（通常因浏览器开启了"下载前询问保存位置"）
            st.log.push({
              ts: Date.now(), level: 'warn',
              msg: '保存对话框被取消。若每份文件都弹出询问，请在浏览器设置中关闭「下载前询问每个文件的保存位置」后重跑。',
            });
            if (st.log.length > 200) st.log.splice(0, st.log.length - 200);
            await saveNow();
            sendResponse({ ok: false, error: '保存对话框被取消（若每份文件都弹窗，请关闭浏览器设置的「下载前询问每个文件的保存位置」）' });
            return;
          }
          st.lastDownloadId = id;
          await saveNow();
          sendResponse({ ok: true, id: id });
        } catch (e) {
          sendResponse({ ok: false, error: String((e && e.message) || e) });
        }
        return;
      }
      case 'fsaStatus': {
        const h = await CSHFsa.getHandle();
        if (!h) { sendResponse({ mode: 'downloads' }); return; }
        if (await CSHFsa.checkPermission(h)) sendResponse({ mode: 'fsa', name: h.name });
        else sendResponse({ mode: 'reauth', name: h.name });
        return;
      }
      case 'getLastDownloadId':
        sendResponse({ id: st.lastDownloadId });
        return;
      case 'progress':
        st.progress = Object.assign({ stage: msg.stage, ts: Date.now() }, msg.payload || {});
        if (msg.stage === 'item') {
          // 逐条事件历史（环形，最多 400 条）供状态面板渲染
          const p = msg.payload || {};
          st.items.push({
            ts: Date.now(),
            section: p.section,
            status: p.skip ? 'skip' : (p.fail ? 'fail' : 'ok'),
            name: p.file || '',
            error: p.error || '',
            n: p.n || 1,
          });
          if (st.items.length > 400) st.items.splice(0, st.items.length - 400);
        } else if (msg.stage === 'stats') {
          st.stats = st.stats || {};
          st.stats[msg.payload.section] = msg.payload;
        } else if (msg.stage === 'itemwait') {
          st.current = msg.payload;
        }
        scheduleSave();
        return;
      case 'log':
        st.log.push({ ts: Date.now(), level: msg.level, msg: msg.msg });
        if (st.log.length > 200) st.log.splice(0, st.log.length - 200);
        scheduleSave();
        return;
      case 'done':
        st.running = false;
        st.summary = msg.summary || {};
        await saveNow();
        return;
      case 'begin': {
        if (st.running) { sendResponse({ ok: false, error: 'busy' }); return; }
        st.running = true;
        st.summary = null;
        st.fallbackCount = 0;
        st.items = [];
        st.stats = { imaging: null, labs: null };
        st.current = null;
        st.startedTs = Date.now();
        st.progress = { stage: 'start', ts: Date.now() };
        st.tabId = msg.tabId;
        await saveNow();
        try {
          await chrome.tabs.sendMessage(msg.tabId, { type: 'runSweep', job: msg.job });
          sendResponse({ ok: true });
        } catch (e) {
          st.running = false;
          await saveNow();
          sendResponse({ ok: false, error: String((e && e.message) || e) });
        }
        return;
      }
      case 'cancel': {
        let delivered = false;
        if (st.tabId != null) {
          try {
            await chrome.tabs.sendMessage(st.tabId, { type: 'cancelSweep' });
            delivered = true;
          } catch (e) { /* 页面可能已关闭 */ }
        }
        // 页面不可达（或已无任务在跑）→ 视为要求强制复位，解除卡死的运行态
        if (!delivered || !st.running) {
          st.running = false;
          st.summary = st.summary || { fatal: '已强制复位。上次任务状态丢失；已下载的文件不受影响。' };
          await saveNow();
        }
        return;
      }
      case 'getState':
        sendResponse({
          running: st.running,
          progress: st.progress,
          summary: st.summary,
          fallbackCount: st.fallbackCount || 0,
          items: (st.items || []).slice(-100),
          stats: st.stats || { imaging: null, labs: null },
          current: st.current,
          startedTs: st.startedTs,
          tabId: st.tabId,   // 弹窗重开时恢复承载标签页
        });
        return;
      case 'reset':
        st.running = false;
        st.summary = null;
        st.progress = null;
        await saveNow();
        sendResponse({ ok: true });
        return;
    }
  })();
  return true; // 异步 sendResponse
});
