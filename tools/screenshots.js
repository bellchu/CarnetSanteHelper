#!/usr/bin/env node
/*
 * 用界面真实 HTML/CSS 生成 README 用的演示截图。
 * 数据是虚构的；只渲染真实标记，不加载扩展脚本（无 chrome.* API）。
 * 用法：node tools/screenshots.js   （需要本机 Chrome；可用 CHROME 指定路径）
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const core = require('../lib/core.js');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'screenshots');
const BUILD = fs.mkdtempSync(path.join(os.tmpdir(), 'csh-shots-'));
const CHROME = process.env.CHROME || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => { try { fs.accessSync(p); return true; } catch (e) { return false; } });

if (!CHROME) {
  console.error('Chrome not found — set CHROME=/path/to/chrome');
  process.exit(1);
}

// 真实页面 → 静态演示页：CSS 改为绝对路径，脚本全部去掉后注入填数据脚本
function demoPage(srcHtml, cssFile, fillScript) {
  return srcHtml
    .replace(/<link rel="stylesheet" href="[^"]+">/, '<link rel="stylesheet" href="' + pathToUrl(path.join(path.dirname(cssFile), path.basename(cssFile))) + '">')
    .replace(/<script[\s\S]*?<\/script>/g, '')
    .replace('</body>', '<script>' + fillScript + '</script></body>');
}

function pathToUrl(p) { return 'file://' + p.split(path.sep).join('/'); }

const HELPERS = `
  const $ = (id) => document.getElementById(id);
  const set = (id, text) => { const el = $(id); if (el) el.textContent = text; };
  const show = (id) => { const el = $(id); if (el) el.hidden = false; };
  const hide = (id) => { const el = $(id); if (el) el.hidden = true; };
  const check = (id, on) => { const el = $(id); if (el) el.checked = on; };
  const options = (id, list) => {
    const sel = $(id);
    sel.innerHTML = list.map(([v, label]) => '<option value="' + v + '">' + label + '</option>').join('');
    sel.value = String(list[0][0]);
  };
`;

const FILES = [
  ['ok', 'Hémogramme'],
  ['skip', 'Créatinine'],
  ['ok', 'Radiographie thorax'],
  ['ok', 'Échographie abdominale'],
  ['skip', 'TSH'],
  ['ok', 'Bilan lipidique'],
  ['fail', 'Résonance magnétique — genou'],
];

function popupFill(lang, state) {
  const T = (k, v) => core.t(lang, k, v);
  const lines = [];
  if (state === 'running') {
    lines.push(`set('statusLine', ${JSON.stringify(T('loggedInAs', { name: 'Marie Tremblay' }))});`);
    lines.push(`$('statusDot').className = 'dot ok';`);
    lines.push(`hide('controls'); show('progressBox'); hide('summaryBox');`);
    lines.push(`set('progressLine', ${JSON.stringify(T('labs') + ' — ' + T('found', { n: 34 }))});`);
    lines.push(`$('barFill').style.width = '74%'; set('pct', '74% · 37/50');`);
    lines.push(`$('secStats').innerHTML = ` + JSON.stringify(
      `<div class="stat"><b>${T('imaging')}</b> — ${T('downloaded', { n: 12 })} · ${T('skipped', { n: 2 })} · ${T('failed', { n: 1 })} / ${T('found', { n: 15 })}</div>` +
      `<div class="stat"><b>${T('labs')}</b> — ${T('downloaded', { n: 19 })} · ${T('skipped', { n: 2 })} · ${T('failed', { n: 0 })} / ${T('found', { n: 34 })}</div>` +
      `<div class="stat"><b>${T('meds')}</b> — ${T('downloaded', { n: 1 })} · ${T('skipped', { n: 0 })} · ${T('failed', { n: 0 })} / ${T('found', { n: 1 })}</div>`) + ';');
    lines.push(`set('curLine', ${JSON.stringify(T('current') + ': ' + T('labs') + ' — ' + T('processing', { i: 22, n: 34 }) + ' · Hémogramme')});`);
    lines.push(`set('metaLine', ${JSON.stringify(T('elapsed') + ' 1:42 · ' + T('eta') + ' 0:48')});`);
    lines.push(`$('fileList').innerHTML = ` + JSON.stringify(FILES.map(([kind, name]) => {
      const icon = kind === 'ok' ? '✓' : (kind === 'skip' ? '↷' : '✗');
      return `<li class="${kind}">${icon} ${name}.pdf${kind === 'skip' ? ' ×2' : ''}</li>`;
    }).join('')) + ';');
    lines.push(`show('cancel'); set('cancel', ${JSON.stringify(T('cancel'))});`);
  } else if (state === 'summary') {
    // 任务结束后重新打开弹窗：控件 + 汇总、无进度区
    lines.push(`set('statusLine', ${JSON.stringify(T('loggedInAs', { name: 'Marie Tremblay' }))});`);
    lines.push(`$('statusDot').className = 'dot ok';`);
    lines.push(`show('summaryBox'); hide('progressBox');`);
    const row = (name, st) => `<div class="stat">${name}: ${T('downloaded', { n: st[0] })} / ${T('found', { n: st[1] })} · ${T('skipped', { n: st[2] })} · ${T('failed', { n: st[3] })}</div>`;
    lines.push(`$('summaryBox').innerHTML = ` + JSON.stringify(
      `<div><b>${T('done')}</b></div>` +
      row(T('imaging'), [14, 15, 1, 0]) + row(T('labs'), [32, 34, 2, 0]) + row(T('meds'), [1, 1, 0, 0])) + ';');
  } else {
    lines.push(`set('statusLine', ${JSON.stringify(T('loggedInAs', { name: 'Marie Tremblay' }))});`);
    lines.push(`$('statusDot').className = 'dot ok';`);
    lines.push(`show('controls'); hide('progressBox'); hide('summaryBox');`);
  }
  const years = core.buildPeriodOptions(2023, 2026);
  const periodList = years.map((y, i) => [y, i === 0 ? T('periodAll', { y }) : (y === 2026 ? T('periodThisYear') : T('periodFrom', { y }))]);
  lines.push(`options('period', ${JSON.stringify(periodList)});`);
  lines.push(`set('targetLine', ${JSON.stringify(T('targetFolder') + ': ' + T('dlDir') + '/Carnet santé')});`);
  return `(() => {${HELPERS}
    set('t-appTitle', ${JSON.stringify(T('appTitle'))});
    set('t-sections', ${JSON.stringify(T('sections'))});
    set('t-labs', ${JSON.stringify(T('labs'))});
    set('t-imaging', ${JSON.stringify(T('imaging'))});
    set('t-meds', ${JSON.stringify(T('meds'))});
    set('t-period', ${JSON.stringify(T('period'))});
    set('t-onlyNew', ${JSON.stringify(T('onlyNew'))});
    set('t-dryRun', ${JSON.stringify(T('dryRun'))});
    set('start', ${JSON.stringify(T('start'))});
    $('openSettings').title = ${JSON.stringify(T('settings'))};
    $('openFolder').title = ${JSON.stringify(T('openFolder'))};
    set('privacyLine', ${JSON.stringify(T('privacy'))});
    check('labs', true); check('imaging', true); check('meds', true);
    check('onlyNew', true); check('dryRun', false);
    ${lines.join('\n    ')}
    document.title = 'H=' + document.body.scrollHeight;
  })();`;
}

function optionsFill(lang) {
  const T = (k, v) => core.t(lang, k, v);
  const base = T('dlDir') + '/';
  const f = { rootFolder: 'Carnet santé', labsFolder: 'Prélèvements', imagingFolder: 'Imagerie médicale', medsFolder: 'Médications' };
  const sample = (section, label) => core.buildFilename('{date} - {label}', { date: '2024-05-15', label, section, id: 'R1', year: '2024' }, 'rapport');
  const paths = {
    labs: base + core.folderPath(f.rootFolder, f.labsFolder) + '/' + sample(f.labsFolder, 'Hémogramme'),
    img: base + core.folderPath(f.rootFolder, f.imagingFolder) + '/' + sample(f.imagingFolder, 'Radiographie thorax'),
    meds: base + core.folderPath(f.rootFolder, f.medsFolder) + '/ordonnances-20260101-1200.csv',
    tpl: core.folderPath(f.rootFolder, f.imagingFolder) + '/' + sample(f.imagingFolder, 'Radiographie thorax'),
  };
  return `(() => {${HELPERS}
    set('t-appTitle', ${JSON.stringify(T('appTitle'))});
    set('t-lang', ${JSON.stringify(T('lang'))});
    set('t-grpLocation', ${JSON.stringify(T('grpLocation'))});
    set('t-saveDir', ${JSON.stringify(T('saveDir'))});
    $('lang').value = ${JSON.stringify(lang)};
    set('pickFolder', ${JSON.stringify(T('pickFolder'))});
    set('clearFolder', ${JSON.stringify(T('clearFolder'))});
    set('curFolder', ${JSON.stringify(T('fsaNone'))});
    set('t-grpNaming', ${JSON.stringify(T('grpNaming'))});
    set('t-root', ${JSON.stringify(T('root'))});
    set('t-labsDir', ${JSON.stringify(T('labsDir'))});
    set('t-imagingDir', ${JSON.stringify(T('imagingDir'))});
    set('t-medsDir', ${JSON.stringify(T('medsDir'))});
    $('rootFolder').value = ${JSON.stringify(f.rootFolder)};
    $('labsFolder').value = ${JSON.stringify(f.labsFolder)};
    $('imagingFolder').value = ${JSON.stringify(f.imagingFolder)};
    $('medsFolder').value = ${JSON.stringify(f.medsFolder)};
    set('t-saveLocation', ${JSON.stringify(T('saveLocation'))});
    set('locPreviewLabs', ${JSON.stringify(paths.labs)});
    set('locPreviewImg', ${JSON.stringify(paths.img)});
    set('locPreviewMeds', ${JSON.stringify(paths.meds)});
    set('t-tpl', ${JSON.stringify(T('tpl'))});
    $('template').value = '{date} - {label}';
    set('tplHelp', ${JSON.stringify(T('tplHelp'))});
    set('tplPreview', ${JSON.stringify(paths.tpl)});
    set('t-grpBehavior', ${JSON.stringify(T('grpBehavior'))});
    set('t-delay', ${JSON.stringify(T('delay'))});
    $('delayMs').value = 400;
    set('t-yearsBackLbl', ${JSON.stringify(T('yearsBack'))});
    $('yearsBack').value = 6;
    set('t-onlyNew', ${JSON.stringify(T('onlyNew'))});
    set('t-writeIndex', ${JSON.stringify(T('writeIndex'))});
    check('dedupe', true); check('writeIndex', true);
    set('save', ${JSON.stringify(T('save'))});
    set('reset', ${JSON.stringify(T('reset'))});
    set('clearDedup', ${JSON.stringify(T('clearDedup'))});
    set('privacyLine', ${JSON.stringify(T('privacy'))});
    set('savedFlag', '');
    document.title = 'H=' + document.body.scrollHeight;
  })();`;
}

function render(htmlFile, width, pngFile, dpr = 2) {
  const dom = execFileSync(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars',
    '--blink-settings=preferredColorScheme=1', '--window-size=' + width + ',400', '--dump-dom', pathToUrl(htmlFile)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const m = dom.match(/H=(\d+)/);
  const height = m ? Number(m[1]) : 600;
  execFileSync(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--allow-file-access-from-files',
    '--force-device-scale-factor=' + dpr, '--blink-settings=preferredColorScheme=1',
    '--window-size=' + width + ',' + height, '--screenshot=' + pngFile, pathToUrl(htmlFile)],
    { stdio: 'ignore' });
  console.log(path.relative(ROOT, pngFile) + '  ' + width + '×' + height + ' @' + dpr + 'x');
}

// 三张弹窗状态并排成一张图：统一高度、加标注和圆角阴影，README 里更整齐
const LABELS = {
  en: ['Ready', 'Downloading', 'Done'],
  fr: ['Prêt', 'Téléchargement', 'Terminé'],
};

function composite(states, lang, pngFile) {
  const labels = LABELS[lang];
  const html = '<!DOCTYPE html><html><head><meta charset="utf-8"><style>' +
    'body{margin:0;padding:24px;background:#eef2f5;font:600 13px system-ui,-apple-system,"Segoe UI",sans-serif;color:#374151}' +
    '.row{display:flex;gap:24px;align-items:flex-start}' +
    '.panel{width:360px}' +
    '.label{margin:0 0 8px 2px}' +
    'img{display:block;width:360px;border-radius:10px;box-shadow:0 6px 18px rgba(15,23,42,.14)}' +
    '</style></head><body><div class="row">' +
    states.map((p, i) => '<div class="panel"><div class="label">' + labels[i] +
      '</div><img src="' + pathToUrl(p) + '" alt=""></div>').join('') +
    '</div></body></html>';
  const file = path.join(BUILD, 'composite-' + lang + '.html');
  fs.writeFileSync(file, html);
  // 高度固定：标注行 + 最高一张（running 568px）+ 上下留白
  execFileSync(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--allow-file-access-from-files',
    '--blink-settings=preferredColorScheme=1', '--virtual-time-budget=2000',
    '--window-size=1152,640', '--screenshot=' + pngFile, pathToUrl(file)], { stdio: 'ignore' });
  console.log(path.relative(ROOT, pngFile) + '  1152×640 @1x');
}

function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const popupHtml = fs.readFileSync(path.join(ROOT, 'popup', 'popup.html'), 'utf8');
  const optionsHtml = fs.readFileSync(path.join(ROOT, 'options', 'options.html'), 'utf8');

  for (const lang of ['en', 'fr']) {
    const states = [];
    for (const state of ['idle', 'running', 'summary']) {
      const html = demoPage(popupHtml, path.join(ROOT, 'popup', 'popup.css'), popupFill(lang, state));
      const file = path.join(BUILD, 'popup-' + lang + '-' + state + '.html');
      fs.writeFileSync(file, html);
      const png = path.join(BUILD, 'popup-' + lang + '-' + state + '.png');
      render(file, 360, png, 2);
      states.push(png);
    }
    composite(states, lang, path.join(OUT, 'popup-states.' + lang + '.png'));

    const optHtml = demoPage(optionsHtml, path.join(ROOT, 'options', 'options.css'), optionsFill(lang));
    const optFile = path.join(BUILD, 'options-' + lang + '.html');
    fs.writeFileSync(optFile, optHtml);
    render(optFile, 720, path.join(OUT, 'options.' + lang + '.png'));
  }
  fs.rmSync(BUILD, { recursive: true, force: true });
}

main();
