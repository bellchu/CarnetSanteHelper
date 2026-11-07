'use strict';
/* 文件夹视图：列出用户自选报告文件夹的内容（File System Access 只读遍历） */
(function () {
  const core = window.CSHCore;
  const $ = function (id) { return document.getElementById(id); };
  let lang = 'zh';
  const T = function (k, v) { return core.t(lang, k, v); };

  function setStatus(text, busy) {
    $('status').textContent = text;
    $('status').className = busy ? 'busy' : '';
  }

  async function render() {
    const tree = $('tree');
    const h = await CSHFsa.getHandle();
    if (!h) {
      setStatus(T('fsaNoHandle'));
      $('reauth').hidden = true;
      return;
    }
    if (!(await CSHFsa.checkPermission(h))) {
      setStatus(T('fsaSet', { name: h.name }) + ' — ' + T('fsaNeedAuth'));
      $('reauth').hidden = false;
      return;
    }
    $('reauth').hidden = true;
    tree.innerHTML = '';
    setStatus(T('fsaSet', { name: h.name }) + ' — ' + T('loading'), true);
    const count = await walk(h, tree, 0);
    if (count === 0) {
      const li = document.createElement('li');
      li.textContent = T('fsaEmpty');
      tree.appendChild(li);
    }
    setStatus(T('fsaSet', { name: h.name }) + ' · ' + T('filesCounted', { n: count }));
  }

  // 三层足够：根 / 板块 / 文件。文件元数据按批并行读取，目录递归保持展示顺序（目录在前）。
  async function walk(dir, ul, depth) {
    if (depth > 2) return 0;
    const entries = [];
    for await (const entry of dir.values()) entries.push(entry);
    entries.sort(function (a, b) {
      if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    const files = entries.filter(function (e) { return e.kind === 'file'; });
    const meta = new Map();
    for (let i = 0; i < files.length; i += 8) {
      await Promise.all(files.slice(i, i + 8).map(async function (f) {
        try { meta.set(f.name, await f.getFile()); } catch (e) { /* 读取失败只影响大小/日期展示 */ }
      }));
    }
    let count = 0;
    for (const entry of entries) {
      const li = document.createElement('li');
      if (entry.kind === 'directory') {
        li.textContent = '📁 ' + entry.name;
        const sub = document.createElement('ul');
        li.appendChild(sub);
        ul.appendChild(li);
        count += await walk(entry, sub, depth + 1);
      } else {
        const f = meta.get(entry.name);
        li.textContent = '📄 ' + entry.name + (f
          ? ' · ' + Math.max(1, Math.round(f.size / 1024)) + ' KB · ' + new Date(f.lastModified).toISOString().slice(0, 10)
          : '');
        ul.appendChild(li);
        count++;
      }
    }
    return count;
  }

  document.addEventListener('DOMContentLoaded', async function () {
    const opts = Object.assign({}, core.DEFAULTS, (await chrome.storage.sync.get('options')).options || {});
    lang = opts.lang || 'zh';
    document.documentElement.dir = core.isRtl(lang) ? 'rtl' : 'ltr';   // 阿拉伯语等 RTL 语言
    $('t-title').textContent = T('folderViewTitle');
    $('reauth').textContent = T('fsaReauthBtn');
    $('finderHint').textContent = T('fsaFinderHint');
    $('reauth').addEventListener('click', async function () {
      const h = await CSHFsa.getHandle();
      if (h) await CSHFsa.requestPermission(h);   // 本页内的点击即手势
      await render();
    });
    await render();
  });
})();
