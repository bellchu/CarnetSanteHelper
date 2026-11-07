'use strict';
/* popup：登录探测、任务参数、启动/取消、进度与结果渲染 */
(function () {
  const core = window.CSHCore;
  const $ = function (id) { return document.getElementById(id); };

  let tab = null;
  let pollTimer = null;
  let lang = 'zh';
  let savedOptions = {};   // options 页保存的设置，启动任务时随 job 下发
  const T = function (key, vars) { return core.t(lang, key, vars); };

  function renderStatic() {
    const map = {
      't-appTitle': 'appTitle', 't-sections': 'sections', 't-labs': 'labs', 't-imaging': 'imaging',
      't-yearsBack': 'yearsBack', 't-onlyNew': 'onlyNew', 't-dryRun': 'dryRun',
    };
    for (const id of Object.keys(map)) $(id).textContent = T(map[id]);
    $('start').textContent = T('start');
    $('cancel').textContent = T('cancel');
    $('openFolder').textContent = '📁 ' + T('openFolder');
    $('privacyLine').textContent = T('privacy');
  }

  function setStatus(text, isErr) {
    $('statusLine').textContent = text;
    $('statusLine').style.color = isErr ? '#b91c1c' : '#1f2937';
  }

  async function ensureContent(tabId) {
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'ping' });
    } catch (e) {
      // 页面在扩展安装/刷新前已加载：手动注入内容脚本
      await chrome.scripting.executeScript({
        target: { tabId: tabId },
        files: ['lib/core.js', 'lib/pipeline.js', 'content/content.js'],
      });
    }
  }

  async function init() {
    const st = (await chrome.storage.sync.get('options')).options || {};
    savedOptions = Object.assign({}, core.DEFAULTS, st);
    const opts = savedOptions;
    lang = opts.lang || 'zh';
    renderStatic();

    const tabs = await chrome.tabs.query({
      url: ['https://www.carnetsante.gouv.qc.ca/*', 'https://carnetsante.gouv.qc.ca/*'],
    });
    if (!tabs.length) { setStatus(T('tabMissing'), true); return; }
    tab = tabs.find(function (t) { return t.active; }) || tabs[0];

    await ensureContent(tab.id);
    let probe = null;
    try {
      probe = await chrome.tabs.sendMessage(tab.id, { type: 'probe' });
    } catch (e) { /* ignore */ }

    if (!probe || !probe.hasToken) {
      setStatus(T('notLoggedIn'), true);
    } else if (probe.profile && probe.profile.name) {
      setStatus(T('loggedInAs', { name: probe.profile.name }));
    } else {
      setStatus(T('status') + ': OK');
    }

    $('controls').hidden = false;
    $('yearsBack').value = opts.yearsBack;
    $('onlyNew').checked = opts.dedupe;

    // 保存目标：自选文件夹（File System Access）或浏览器下载目录
    let fsa = null;
    try { fsa = await chrome.runtime.sendMessage({ type: 'fsaStatus' }); } catch (e) { /* 忽略 */ }
    if (fsa && fsa.mode === 'fsa') {
      $('targetLine').textContent = T('targetFolder') + ': ' + fsa.name;
      $('openFolder').title = T('fsaOpenDisabled');
    } else if (fsa && fsa.mode === 'reauth') {
      $('targetLine').textContent = T('targetFolder') + ': ' + fsa.name + ' ⚠';
      $('targetLine').title = T('fsaReauthHint');
      $('targetLine').style.cursor = 'pointer';
      $('targetLine').onclick = function () { chrome.runtime.openOptionsPage(); };
    } else {
      $('targetLine').textContent = T('targetFolder') + ': ' + T('dlDir') + '/' + opts.rootFolder;
    }

    const swState = await chrome.runtime.sendMessage({ type: 'getState' });
    if (swState && swState.running) { enterRunningUI(); startPolling(); }
  }

  function collectJob() {
    return {
      sections: { labs: $('labs').checked, imaging: $('imaging').checked },
      startYear: new Date().getFullYear() - (parseInt($('yearsBack').value, 10) || 6),
      endYear: new Date().getFullYear(),
      dryRun: $('dryRun').checked,
      // 已保存设置 + 弹窗里的即时覆盖
      options: Object.assign({}, savedOptions, { dedupe: $('onlyNew').checked }),
    };
  }

  async function start() {
    if (!tab) return;
    if (!$('labs').checked && !$('imaging').checked) return;
    $('start').disabled = true;
    const res = await chrome.runtime.sendMessage({ type: 'begin', tabId: tab.id, job: collectJob() });
    if (!res || res.ok === false) {
      $('start').disabled = false;
      setStatus(res && res.error === 'busy' ? T('busy') : String((res && res.error) || 'failed'), true);
      return;
    }
    enterRunningUI();
    startPolling();
  }

  function enterRunningUI() {
    $('start').disabled = true;
    $('cancel').hidden = false;
    $('progressBox').hidden = false;
    $('summaryBox').hidden = true;
    $('fileList').innerHTML = '';
  }

  function exitRunningUI() {
    $('start').disabled = false;
    $('cancel').hidden = true;
    stopPolling();
  }

  function startPolling() {
    stopPolling();
    pollTimer = setInterval(poll, 700);
    poll();
  }
  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  async function poll() {
    const s = await chrome.runtime.sendMessage({ type: 'getState' });
    if (!s) return;
    if (s.progress) renderProgress(s.progress);
    if (!$('progressBox').hidden) renderLive(s);
    if (s.running) {
      // 运行中但承载标签页已关闭 → 任务实际已死，复位状态
      if (tab) {
        try { await chrome.tabs.get(tab.id); } catch (e) { await chrome.runtime.sendMessage({ type: 'reset' }); }
      }
      return;
    }
    exitRunningUI();
    if (s.summary) renderSummary(s.summary, s.fallbackCount || 0);
  }

  function renderProgress(p) {
    // 只渲染阶段性标题；逐条进度/计数/日志由 renderLive 负责
    let line = '';
    if (p.stage === 'start') line = T('running');
    else if (p.stage === 'citizen') line = T('loggedInAs', { name: p.name || '' });
    else if (p.stage === 'section') line = (p.section === 'labs' ? T('labs') : T('imaging')) + '…';
    else if (p.stage === 'list') line = (p.section === 'labs' ? T('labs') : T('imaging')) + ' — ' + T('found', { n: p.total });
    else if (p.stage === 'labsGateOff') line = T('labsGateOff');
    if (line) $('progressLine').textContent = line;
  }

  function fmtDur(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    return Math.floor(s / 60) + ':' + (s % 60 < 10 ? '0' : '') + (s % 60);
  }

  // 详细状态面板：进度条 / 分板块计数 / 当前项 / 用时与预计 / 逐条活动日志
  function renderLive(s) {
    const img = s.stats && s.stats.imaging;
    const la = s.stats && s.stats.labs;
    const found = (img ? img.found : 0) + (la ? la.found : 0);
    const done = (img ? img.downloaded + img.skipped + img.failed : 0) +
      (la ? la.downloaded + la.skipped + la.failed : 0);
    const pct = found ? Math.min(100, Math.round(done * 100 / found)) : 0;
    $('barFill').style.width = pct + '%';
    $('pct').textContent = found ? (pct + '% · ' + done + '/' + found) : '';

    const row = function (st, name) {
      if (!st) return '';
      return '<div class="stat"><b>' + name + '</b> — ' + T('downloaded', { n: st.downloaded }) +
        ' · ' + T('skipped', { n: st.skipped }) + ' · ' + T('failed', { n: st.failed }) +
        ' / ' + T('found', { n: st.found }) + '</div>';
    };
    $('secStats').innerHTML = row(img, T('imaging')) + row(la, T('labs'));

    if (s.current) {
      $('curLine').textContent = T('current') + ': ' +
        (s.current.section === 'labs' ? T('labs') : T('imaging')) + ' — ' +
        T('processing', { i: s.current.i, n: s.current.n }) +
        (s.current.label ? ' · ' + s.current.label : '');
    }
    if (s.startedTs) {
      const el = Date.now() - s.startedTs;
      let meta = T('elapsed') + ' ' + fmtDur(el);
      if (found > done && done > 3) meta += ' · ' + T('eta') + ' ' + fmtDur(el * (found - done) / done);
      $('metaLine').textContent = meta;
    }

    $('fileList').innerHTML = (s.items || []).slice(-80).map(function (it) {
      const icon = it.status === 'ok' ? '✓' : (it.status === 'skip' ? '↷' : '✗');
      const name = it.name ? String(it.name).split('/').pop() : '';
      const ntag = (it.status === 'skip' && it.n > 1) ? ' ×' + it.n : '';
      const extra = (it.status === 'fail' && it.error) ? ' — ' + escapeHtml(it.error) : '';
      return '<li class="' + it.status + '">' + icon + ' ' + escapeHtml(name) + ntag + extra + '</li>';
    }).join('');
    $('fileList').scrollTop = $('fileList').scrollHeight;
  }

  function renderSummary(sum, fallbackCount) {
    const box = $('summaryBox');
    box.hidden = false;
    if (sum.fatal) {
      let msg = sum.fatal;
      if (/failed to fetch/i.test(msg)) msg += ' — ' + T('fetchFailHint');
      box.innerHTML = '<div class="err">' + escapeHtml(msg) + '</div>';
      return;
    }
    const im = sum.stats.imaging, la = sum.stats.labs;
    const html = [
      '<div><b>' + T('done') + (sum.cancelled ? ' (' + T('cancelled') + ')' : '') + '</b></div>',
      '<div class="stat">' + T('imaging') + ': ' + T('downloaded', { n: im.downloaded }) + ' / ' + T('found', { n: im.found }) +
      ' · ' + T('skipped', { n: im.skipped }) + ' · ' + T('failed', { n: im.failed }) + '</div>',
      '<div class="stat">' + T('labs') + ': ' + T('downloaded', { n: la.downloaded }) + ' / ' + T('found', { n: la.found }) +
      ' · ' + T('skipped', { n: la.skipped }) + ' · ' + T('failed', { n: la.failed }) + '</div>',
    ];
    if (fallbackCount > 0) html.push('<div class="err">' + escapeHtml(T('fallbackNotice', { n: fallbackCount })) + '</div>');
    if (sum.errors && sum.errors.length) {
      html.push('<div class="err"><b>' + T('errorsTitle') + ' (' + sum.errors.length + ')</b><br>' +
        sum.errors.slice(0, 8).map(function (e) { return escapeHtml(e.section + ' ' + e.id + ': ' + e.error); }).join('<br>') +
        (sum.errors.length > 8 ? '<br>…' : '') + '</div>');
    }
    box.innerHTML = html.join('');
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    $('start').addEventListener('click', start);
    $('cancel').addEventListener('click', function () { chrome.runtime.sendMessage({ type: 'cancel' }); });
    $('openSettings').addEventListener('click', function () { chrome.runtime.openOptionsPage(); });
    $('openFolder').addEventListener('click', async function () {
      // 按保存目标分流：所选文件夹 → 内容视图页；需授权 → 设置页；否则 → 下载目录
      let fsa = null;
      try { fsa = await chrome.runtime.sendMessage({ type: 'fsaStatus' }); } catch (e) { /* 忽略 */ }
      if (fsa && fsa.mode === 'fsa') {
        chrome.tabs.create({ url: chrome.runtime.getURL('folder/folder.html') });
        return;
      }
      if (fsa && fsa.mode === 'reauth') {
        chrome.runtime.openOptionsPage();
        return;
      }
      try {
        const r = await chrome.runtime.sendMessage({ type: 'getLastDownloadId' });
        if (r && r.id != null) {
          await chrome.downloads.show(r.id);
          return;
        }
      } catch (e) { /* 回退 */ }
      chrome.downloads.showDefaultFolder();
    });
    init();
  });
})();
