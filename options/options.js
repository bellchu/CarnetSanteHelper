'use strict';
/* 选项页：设置持久化到 chrome.storage.sync；语言即时切换；报告保存文件夹（File System Access） */
(function () {
  const core = window.CSHCore;
  const $ = function (id) { return document.getElementById(id); };

  const FIELDS = ['rootFolder', 'labsFolder', 'imagingFolder', 'medsFolder', 'template', 'delayMs', 'dedupe', 'writeIndex', 'lang', 'yearsBack'];
  let lang = 'zh';
  let fsaDir = null;   // 已选报告保存文件夹名（null = 浏览器下载目录模式）
  const T = function (key, vars) { return core.t(lang, key, vars); };

  function renderStatic() {
    const map = {
      't-appTitle': 'appTitle', 't-lang': 'lang', 't-root': 'root', 't-labsDir': 'labsDir',
      't-imagingDir': 'imagingDir', 't-medsDir': 'medsDir', 't-tpl': 'tpl', 't-delay': 'delay',
      't-onlyNew': 'onlyNew', 't-writeIndex': 'writeIndex', 't-yearsBackLbl': 'yearsBack',
      't-saveLocation': 'saveLocation', 't-saveDir': 'saveDir', 't-grpLocation': 'grpLocation',
      't-grpNaming': 'grpNaming', 't-grpBehavior': 'grpBehavior',
    };
    for (const id of Object.keys(map)) $(id).textContent = T(map[id]);
    document.documentElement.dir = core.isRtl(lang) ? 'rtl' : 'ltr';   // 阿拉伯语等 RTL 语言
    $('tplHelp').textContent = T('tplHelp');
    $('save').textContent = T('save');
    $('reset').textContent = T('reset');
    $('clearDedup').textContent = T('clearDedup');
    $('pickFolder').textContent = T('pickFolder');
    $('clearFolder').textContent = T('clearFolder');
    $('privacyLine').textContent = T('privacy');
    updatePreview();
    refreshFolderStatus();
  }

  /* ---- 报告保存文件夹 ---- */
  async function refreshFolderStatus() {
    const hint = $('fsaHint'), cur = $('curFolder');
    if (!CSHFsa.supported()) {
      cur.textContent = '';
      $('pickFolder').disabled = true;
      hint.textContent = T('fsaUnavailable');
      return;
    }
    const h = await CSHFsa.getHandle();
    if (!h) {
      cur.textContent = T('fsaNone');
      $('clearFolder').hidden = true;
      hint.textContent = '';
      fsaDir = null;
    } else {
      const granted = await CSHFsa.checkPermission(h);
      cur.textContent = T('fsaSet', { name: h.name }) + (granted ? '' : ' ⚠');
      $('clearFolder').hidden = false;
      hint.textContent = granted ? '' : T('fsaReauthHint');
      fsaDir = h.name;
    }
    updatePreview();
  }

  async function pickFolder() {
    try {
      const h = await CSHFsa.pickDirectory();
      $('curFolder').textContent = T('fsaSet', { name: h.name });
      $('clearFolder').hidden = false;
      $('fsaHint').textContent = '';
    } catch (e) {
      if (e && e.name === 'AbortError') return;   // 用户取消选择
      $('fsaHint').textContent = String((e && e.message) || e);
    }
  }

  async function unPickFolder() {
    await CSHFsa.clearHandle();
    await refreshFolderStatus();
  }

  // 文件夹输入净化：绝对路径/反斜杠/越界段 → 下载目录内的相对路径；空则回退默认值
  function normFolder(v, def) {
    const n = core.folderPath(core.safeRelativePath(v));
    return n || def;
  }
  function normalizedFolders() {
    return {
      rootFolder: normFolder($('rootFolder').value, core.DEFAULTS.rootFolder),
      labsFolder: normFolder($('labsFolder').value, core.DEFAULTS.labsFolder),
      imagingFolder: normFolder($('imagingFolder').value, core.DEFAULTS.imagingFolder),
      medsFolder: normFolder($('medsFolder').value, core.DEFAULTS.medsFolder),
    };
  }

  function getForm() {
    return Object.assign({
      lang: $('lang').value,
      template: $('template').value,
      delayMs: Math.max(0, parseInt($('delayMs').value, 10) || 0),
      dedupe: $('dedupe').checked,
      writeIndex: $('writeIndex').checked,
      yearsBack: Math.min(30, Math.max(1, parseInt($('yearsBack').value, 10) || 6)),
    }, normalizedFolders());
  }

  function updatePreview() {
    const tpl = $('template').value || core.DEFAULTS.template;
    const f = normalizedFolders();

    const sample = function (section, label) {
      return core.buildFilename(tpl, {
        date: '2024-05-15', label: label, prescriber: 'Jean Dubois',
        section: section, id: 'R1', year: '2024',
      }, 'rapport');
    };
    const base = (fsaDir || T('dlDir')) + '/';
    $('tplPreview').textContent = core.folderPath(f.rootFolder, f.imagingFolder) + '/' + sample(f.imagingFolder, 'Radiographie thorax');
    $('locPreviewLabs').textContent = base + core.folderPath(f.rootFolder, f.labsFolder) + '/' + sample(f.labsFolder, 'Hémogramme');
    $('locPreviewImg').textContent = base + core.folderPath(f.rootFolder, f.imagingFolder) + '/' + sample(f.imagingFolder, 'Radiographie thorax');
    $('locPreviewMeds').textContent = base + core.folderPath(f.rootFolder, f.medsFolder) + '/ordonnances-20260101-1200.csv';

    // 输入被净化时提示（如填了绝对路径）
    const changed = ['rootFolder', 'labsFolder', 'imagingFolder', 'medsFolder'].some(function (id) {
      return $('' + id).value.trim() !== f[id];
    });
    $('locHint').textContent = changed ? T('absNote') : '';
  }

  async function load() {
    const saved = (await chrome.storage.sync.get('options')).options || {};
    const opts = Object.assign({}, core.DEFAULTS, saved);
    lang = opts.lang || 'zh';
    renderStatic();
    $('lang').value = opts.lang;
    $('rootFolder').value = opts.rootFolder;
    $('labsFolder').value = opts.labsFolder;
    $('imagingFolder').value = opts.imagingFolder;
    $('medsFolder').value = opts.medsFolder;
    $('template').value = opts.template;
    $('delayMs').value = opts.delayMs;
    $('dedupe').checked = opts.dedupe;
    $('writeIndex').checked = opts.writeIndex;
    $('yearsBack').value = opts.yearsBack;
  }

  async function save() {
    const opts = getForm();
    lang = opts.lang;
    await chrome.storage.sync.set({ options: opts });
    renderStatic();
    $('savedFlag').textContent = T('saved');
    setTimeout(function () { $('savedFlag').textContent = ''; }, 1500);
  }

  async function resetDefaults() {
    await chrome.storage.sync.set({ options: core.DEFAULTS });
    await load();
  }

  async function clearDedup() {
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter(function (k) { return k.indexOf('dedup:') === 0; });
    if (keys.length) await chrome.storage.local.remove(keys);
    $('savedFlag').textContent = T('cleared') + ' (' + keys.length + ')';
    setTimeout(function () { $('savedFlag').textContent = ''; }, 2000);
  }

  document.addEventListener('DOMContentLoaded', function () {
    $('save').addEventListener('click', save);
    $('reset').addEventListener('click', resetDefaults);
    $('clearDedup').addEventListener('click', clearDedup);
    $('lang').addEventListener('change', function () { lang = $('lang').value; renderStatic(); });
    $('template').addEventListener('input', updatePreview);
    ['rootFolder', 'labsFolder', 'imagingFolder', 'medsFolder'].forEach(function (id) {
      $(id).addEventListener('input', updatePreview);
    });
    $('pickFolder').addEventListener('click', pickFolder);
    $('clearFolder').addEventListener('click', unPickFolder);
    load();
  });
})();
