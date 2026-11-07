'use strict';
/* 文件夹视图：列出用户自选报告文件夹的内容（File System Access 只读遍历） */
(function () {
  const core = window.CSHCore;
  const $ = function (id) { return document.getElementById(id); };
  let lang = 'zh';
  const T = function (k, v) { return core.t(lang, k, v); };

  async function render() {
    const tree = $('tree');
    const h = await CSHFsa.getHandle();
    if (!h) {
      $('status').textContent = T('fsaNoHandle');
      $('reauth').hidden = true;
      return;
    }
    if (!(await CSHFsa.checkPermission(h))) {
      $('status').textContent = T('fsaSet', { name: h.name }) + ' — ' + T('fsaNeedAuth');
      $('reauth').hidden = false;
      return;
    }
    $('reauth').hidden = true;
    $('status').textContent = T('fsaSet', { name: h.name });
    tree.innerHTML = '';
    const count = await walk(h, tree, 0, 0);
    if (count === 0) {
      const li = document.createElement('li');
      li.textContent = T('fsaEmpty');
      tree.appendChild(li);
    }
  }

  // 三层足够：根 / 板块 / 文件
  async function walk(dir, ul, depth, count0) {
    let count = count0;
    if (depth > 2) return count;
    const entries = [];
    for await (const entry of dir.values()) entries.push(entry);
    entries.sort(function (a, b) { return a.name.localeCompare(b.name); });
    for (const entry of entries) {
      const li = document.createElement('li');
      if (entry.kind === 'directory') {
        li.textContent = '📁 ' + entry.name;
        const sub = document.createElement('ul');
        li.appendChild(sub);
        ul.appendChild(li);
        count = await walk(entry, sub, depth + 1, count);
      } else {
        const f = await entry.getFile();
        li.textContent = '📄 ' + entry.name + ' · ' + Math.max(1, Math.round(f.size / 1024)) + ' KB · ' +
          new Date(f.lastModified).toISOString().slice(0, 10);
        ul.appendChild(li);
        count++;
      }
    }
    return count;
  }

  document.addEventListener('DOMContentLoaded', async function () {
    const opts = Object.assign({}, core.DEFAULTS, (await chrome.storage.sync.get('options')).options || {});
    lang = opts.lang || 'zh';
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
