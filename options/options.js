'use strict';
/* 选项页：设置持久化到 chrome.storage.sync；语言即时切换 */
(function () {
  const core = window.CSHCore;
  const $ = function (id) { return document.getElementById(id); };

  const FIELDS = ['rootFolder', 'labsFolder', 'imagingFolder', 'template', 'delayMs', 'dedupe', 'writeIndex', 'lang', 'yearsBack'];
  let lang = 'zh';
  const T = function (key, vars) { return core.t(lang, key, vars); };

  function renderStatic() {
    const map = {
      't-appTitle': 'appTitle', 't-lang': 'lang', 't-root': 'root', 't-labsDir': 'labsDir',
      't-imagingDir': 'imagingDir', 't-tpl': 'tpl', 't-delay': 'delay', 't-onlyNew': 'onlyNew',
      't-writeIndex': 'writeIndex', 't-yearsBackLbl': 'yearsBack',
    };
    for (const id of Object.keys(map)) $(id).textContent = T(map[id]);
    $('tplHelp').textContent = T('tplHelp');
    $('save').textContent = T('save');
    $('reset').textContent = T('reset');
    $('clearDedup').textContent = T('clearDedup');
    $('privacyLine').textContent = T('privacy');
    updatePreview();
  }

  function getForm() {
    return {
      lang: $('lang').value,
      rootFolder: $('rootFolder').value,
      labsFolder: $('labsFolder').value,
      imagingFolder: $('imagingFolder').value,
      template: $('template').value,
      delayMs: Math.max(0, parseInt($('delayMs').value, 10) || 0),
      dedupe: $('dedupe').checked,
      writeIndex: $('writeIndex').checked,
      yearsBack: Math.min(30, Math.max(1, parseInt($('yearsBack').value, 10) || 6)),
    };
  }

  function updatePreview() {
    const tpl = $('template').value || core.DEFAULTS.template;
    const name = core.buildFilename(tpl, {
      date: '2024-05-15', label: 'Radiographie thorax', prescriber: 'Jean Dubois',
      section: 'Imagerie médicale', id: 'R1', year: '2024',
    }, 'rapport');
    $('tplPreview').textContent = 'Imagerie médicale/' + name;
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
    load();
  });
})();
