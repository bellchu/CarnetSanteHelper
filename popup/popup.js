'use strict';
/* popup：登录探测、任务参数、启动/取消、进度与结果渲染 */
(function () {
  const core = window.CSHCore;
  const $ = function (id) { return document.getElementById(id); };

  let tab = null;
  let pollTimer = null;
  let lang = 'zh';
  let savedOptions = {};   // options 页保存的设置，启动任务时随 job 下发
  let liveSig = '';        // 上次渲染的统计/当前项签名：未变化则跳过 DOM 更新
  let itemsSig = '';       // 上次渲染的日志列表签名
  let earliestMap = null;  // probe 返回的各板块最早数据年 {labs,imaging}，null = 未知
  const T = function (key, vars) { return core.t(lang, key, vars); };

  function renderStatic() {
    const map = {
      't-appTitle': 'appTitle', 't-sections': 'sections', 't-labs': 'labs', 't-imaging': 'imaging',
      't-meds': 'meds', 't-period': 'period', 't-onlyNew': 'onlyNew', 't-dryRun': 'dryRun',
    };
    for (const id of Object.keys(map)) $(id).textContent = T(map[id]);
    document.documentElement.dir = core.isRtl(lang) ? 'rtl' : 'ltr';   // 阿拉伯语等 RTL 语言
    updateStartLabel();
    $('cancel').textContent = T('cancel');
    $('openSettings').title = T('settings');
    $('openFolder').title = T('openFolder');
    $('privacyLine').textContent = T('privacy');
  }

  // 勾选「仅扫描」时按钮文案随之切换
  function updateStartLabel() {
    $('start').textContent = T($('dryRun').checked ? 'scan' : 'start');
  }

  // kind: 'ok' | 'err' | 'busy'；busy 时状态点闪烁表示检测中
  function setStatus(text, kind) {
    $('statusLine').textContent = text;
    $('statusDot').className = 'dot' + (kind ? ' ' + kind : '');
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

  // 登录探测较慢（需请求 API）：控件先展示，探测结果异步更新状态行
  async function probeStatus() {
    setStatus(T('checking'), 'busy');
    await ensureContent(tab.id);
    let probe = null;
    try {
      probe = await chrome.tabs.sendMessage(tab.id, { type: 'probe' });
    } catch (e) { /* ignore */ }

    if (!probe || !probe.hasToken) {
      setStatus(T('notLoggedIn'), 'err');
    } else if (probe.profile && probe.profile.name) {
      setStatus(T('loggedInAs', { name: probe.profile.name }), 'ok');
    } else {
      setStatus(T('status') + ': OK', 'ok');
    }
    // 时间段选项随探测结果落地：已知最早数据 → 只列真实区间；失败 → 固定档位回退
    earliestMap = (probe && probe.earliest) || null;
    renderPeriods(false);
  }

  /* 时间段选项：探测到最早数据 → 只列出 [最早年..今年]（真实可下载的区间）；
     未知 → 回退固定档位（行为与旧版一致）。勾选板块变化时按其最早年重算。 */
  function renderPeriods(detecting) {
    const sel = $('period');
    const thisYear = new Date().getFullYear();
    if (detecting) {
      const y = thisYear - (parseInt(savedOptions.yearsBack, 10) || 6);
      sel.innerHTML = '<option value="' + y + '">' + escapeHtml(T('periodDetecting')) + '</option>';
      return;
    }
    const known = [
      $('labs').checked && earliestMap && earliestMap.labs,
      $('imaging').checked && earliestMap && earliestMap.imaging,
      $('meds').checked && earliestMap && earliestMap.meds,
    ].filter(function (y) { return typeof y === 'number'; });
    const years = known.length ? core.buildPeriodOptions(Math.min.apply(null, known), thisYear) : [];
    let html = '';
    if (!years.length) {
      [1, 3, 6, 10, 30].forEach(function (n) {
        html += '<option value="' + (thisYear - n) + '">' + escapeHtml(T('periodFallback', { n: n })) + '</option>';
      });
    } else {
      years.forEach(function (y) {
        const label = y === years[0] ? T('periodAll', { y: y })
          : (y === thisYear ? T('periodThisYear') : T('periodFrom', { y: y }));
        html += '<option value="' + y + '">' + escapeHtml(label) + '</option>';
      });
    }
    const prev = parseInt(sel.value, 10);
    sel.innerHTML = html;
    // 尽量保持已选起始年；首次渲染取最接近旧「回溯年数」偏好的档位
    const opts = Array.prototype.map.call(sel.options, function (o) { return parseInt(o.value, 10); });
    const want = Number.isInteger(prev) ? prev : thisYear - (parseInt(savedOptions.yearsBack, 10) || 6);
    let best = opts[0];
    for (const y of opts) if (Math.abs(y - want) < Math.abs(best - want)) best = y;
    sel.value = String(best);
  }

  // 目标文件夹行 + 打开按钮的行为均随保存模式而定
  async function renderTarget() {
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
      $('targetLine').textContent = T('targetFolder') + ': ' + T('dlDir') + '/' + savedOptions.rootFolder;
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
    tab = tabs.find(function (t) { return t.active; }) || tabs[0] || null;

    const swState = await chrome.runtime.sendMessage({ type: 'getState' });
    if (swState && swState.running) {
      // 弹窗在任务运行中重新打开：恢复承载标签页并直接进入运行界面
      if (!tab && swState.tabId != null) {
        try { tab = await chrome.tabs.get(swState.tabId); } catch (e) { /* 页面已关 */ }
      }
      enterRunningUI();
      startPolling();
      if (tab) probeStatus(); else setStatus(T('running'), 'busy');
      return;
    }

    if (!tab) {
      setStatus(T('tabMissing'), 'err');
      const btn = $('openPortal');
      btn.hidden = false;
      btn.textContent = T('openPortal');
      return;
    }

    $('controls').hidden = false;
    $('onlyNew').checked = opts.dedupe;
    renderPeriods(true);   // 先显示「检测中」，probe 返回后换成真实可下载区间
    renderTarget();

    probeStatus();
    // 上次运行的结果仍在：直接展示，弹窗重开后不丢汇总
    if (swState && swState.summary) renderSummary(swState.summary, swState.fallbackCount || 0);
  }

  function collectJob() {
    return {
      sections: { labs: $('labs').checked, imaging: $('imaging').checked, meds: $('meds').checked },
      // 选中的起始年（探测完成前启动则沿用旧「回溯年数」默认）
      startYear: parseInt($('period').value, 10) ||
        (new Date().getFullYear() - (parseInt(savedOptions.yearsBack, 10) || 6)),
      endYear: new Date().getFullYear(),
      dryRun: $('dryRun').checked,
      earliest: earliestMap || undefined,   // 流水线据此收紧起始年，跳过无数据区间
      // 已保存设置 + 弹窗里的即时覆盖
      options: Object.assign({}, savedOptions, { dedupe: $('onlyNew').checked }),
    };
  }

  async function start() {
    if (!tab) return;
    if (!$('labs').checked && !$('imaging').checked && !$('meds').checked) return;
    $('start').disabled = true;
    const res = await chrome.runtime.sendMessage({ type: 'begin', tabId: tab.id, job: collectJob() });
    if (!res || res.ok === false) {
      $('start').disabled = false;
      setStatus(res && res.error === 'busy' ? T('busy') : String((res && res.error) || 'failed'), 'err');
      return;
    }
    enterRunningUI();
    startPolling();
  }

  function enterRunningUI() {
    $('start').disabled = true;
    $('cancel').hidden = false;
    $('cancel').disabled = false;
    $('cancel').textContent = T('cancel');
    $('controls').hidden = true;   // 运行中收起参数区，聚焦进度
    $('progressBox').hidden = false;
    $('summaryBox').hidden = true;
    $('fileList').innerHTML = '';
    liveSig = '';
    itemsSig = '';
  }

  function exitRunningUI() {
    $('start').disabled = false;
    $('cancel').hidden = true;
    $('cancel').disabled = false;
    $('cancel').textContent = T('cancel');
    $('controls').hidden = false;
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

  // 板段名 → 本地化标签（进度/统计/汇总共用）
  function sectionName(s) {
    return s === 'labs' ? T('labs') : (s === 'meds' ? T('meds') : T('imaging'));
  }

  function renderProgress(p) {
    // 只渲染阶段性标题；逐条进度/计数/日志由 renderLive 负责
    let line = '';
    if (p.stage === 'start') line = T('running');
    else if (p.stage === 'citizen') line = T('loggedInAs', { name: p.name || '' });
    else if (p.stage === 'section') line = sectionName(p.section) + '…';
    else if (p.stage === 'list') line = sectionName(p.section) + ' — ' + T('found', { n: p.total });
    else if (p.stage === 'labsGateOff') line = T('labsGateOff');
    if (line) $('progressLine').textContent = line;
  }

  function fmtDur(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    return Math.floor(s / 60) + ':' + (s % 60 < 10 ? '0' : '') + (s % 60);
  }

  // 详细状态面板：进度条 / 分板块计数 / 当前项 / 用时与预计 / 逐条活动日志。
  // 统计与列表按签名去重，700ms 轮询中大部分周期只更新用时一行，避免整片 DOM 重建。
  function renderLive(s) {
    const img = s.stats && s.stats.imaging;
    const la = s.stats && s.stats.labs;
    const me = s.stats && s.stats.meds;
    const secSum = function (pick) {
      return [img, la, me].reduce(function (acc, st) { return acc + (st ? pick(st) : 0); }, 0);
    };
    const sig = JSON.stringify([img, la, me, s.current]);
    if (sig !== liveSig) {
      liveSig = sig;
      const found = secSum(function (st) { return st.found; });
      const done = secSum(function (st) { return st.downloaded + st.skipped + st.failed; });
      const pct = found ? Math.min(100, Math.round(done * 100 / found)) : 0;
      $('barFill').style.width = pct + '%';
      $('pct').textContent = found ? (pct + '% · ' + done + '/' + found) : '';

      const row = function (st, name) {
        if (!st) return '';
        return '<div class="stat"><b>' + name + '</b> — ' + T('downloaded', { n: st.downloaded }) +
          ' · ' + T('skipped', { n: st.skipped }) + ' · ' + T('failed', { n: st.failed }) +
          ' / ' + T('found', { n: st.found }) + '</div>';
      };
      $('secStats').innerHTML = row(img, T('imaging')) + row(la, T('labs')) + row(me, T('meds'));

      if (s.current) {
        $('curLine').textContent = T('current') + ': ' + sectionName(s.current.section) + ' — ' +
          T('processing', { i: s.current.i, n: s.current.n }) +
          (s.current.label ? ' · ' + s.current.label : '');
      }
    }

    const found = secSum(function (st) { return st.found; });
    const done = secSum(function (st) { return st.downloaded + st.skipped + st.failed; });
    if (s.startedTs) {
      const el = Date.now() - s.startedTs;
      let meta = T('elapsed') + ' ' + fmtDur(el);
      if (found > done && done > 3) meta += ' · ' + T('eta') + ' ' + fmtDur(el * (found - done) / done);
      $('metaLine').textContent = meta;
    }

    const items = s.items || [];
    const isig = items.length + ':' + (items.length ? items[items.length - 1].ts : 0);
    if (isig !== itemsSig) {
      const fl = $('fileList');
      // 用户正向上翻看时不抢滚动位置，仅在贴近底部时跟随新条目
      const nearBottom = fl.scrollHeight - fl.scrollTop - fl.clientHeight < 30;
      itemsSig = isig;
      fl.innerHTML = items.slice(-80).map(function (it) {
        const icon = it.status === 'ok' ? '✓' : (it.status === 'skip' ? '↷' : '✗');
        const name = it.name ? String(it.name).split('/').pop() : '';
        const ntag = (it.status === 'skip' && it.n > 1) ? ' ×' + it.n : '';
        const extra = (it.status === 'fail' && it.error) ? ' — ' + escapeHtml(it.error) : '';
        return '<li class="' + it.status + '">' + icon + ' ' + escapeHtml(name) + ntag + extra + '</li>';
      }).join('');
      if (nearBottom) fl.scrollTop = fl.scrollHeight;
    }
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
    const im = sum.stats.imaging, la = sum.stats.labs, me = sum.stats.meds;
    const html = [
      '<div><b>' + T('done') + (sum.cancelled ? ' (' + T('cancelled') + ')' : '') + '</b></div>',
      '<div class="stat">' + T('imaging') + ': ' + T('downloaded', { n: im.downloaded }) + ' / ' + T('found', { n: im.found }) +
      ' · ' + T('skipped', { n: im.skipped }) + ' · ' + T('failed', { n: im.failed }) + '</div>',
      '<div class="stat">' + T('labs') + ': ' + T('downloaded', { n: la.downloaded }) + ' / ' + T('found', { n: la.found }) +
      ' · ' + T('skipped', { n: la.skipped }) + ' · ' + T('failed', { n: la.failed }) + '</div>',
      '<div class="stat">' + T('meds') + ': ' + T('downloaded', { n: me.downloaded }) + ' / ' + T('found', { n: me.found }) +
      ' · ' + T('skipped', { n: me.skipped }) + ' · ' + T('failed', { n: me.failed }) + '</div>',
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
    $('dryRun').addEventListener('change', updateStartLabel);
    // 勾选板块变化 → 可选时间段随之按其最早数据年重算
    ['labs', 'imaging', 'meds'].forEach(function (id) {
      $(id).addEventListener('change', function () { renderPeriods(false); });
    });
    $('cancel').addEventListener('click', function () {
      // 立即反馈：按钮进入「取消中」禁用态，等 pipeline 实际停止后由 exitRunningUI 复原
      this.disabled = true;
      this.textContent = T('cancelling');
      chrome.runtime.sendMessage({ type: 'cancel' });
    });
    $('openSettings').addEventListener('click', function () { chrome.runtime.openOptionsPage(); });
    $('openPortal').addEventListener('click', function () {
      chrome.tabs.create({ url: 'https://www.carnetsante.gouv.qc.ca/' });
      window.close();
    });
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
