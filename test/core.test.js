'use strict';
/* lib/core.js 单元测试（零依赖，node:test） */
const test = require('node:test');
const assert = require('node:assert');
const core = require('../lib/core.js');

test('sanitizeSegment 去除非法字符与首尾点空格', () => {
  assert.strictEqual(core.sanitizeSegment('a/b\\c:d*e?f"g<h>i|j'), 'a b c d e f g h i j');
  assert.strictEqual(core.sanitizeSegment('  rapport  .pdf. '), 'rapport .pdf');
  assert.strictEqual(core.sanitizeSegment(''), '');
  assert.strictEqual(core.sanitizeSegment(null), '');
  assert.strictEqual(core.sanitizeSegment('x'.repeat(300), 50).length, 50);
});

test('safeRelativePath：绝对路径/盘符/反斜杠/越界段 → 下载目录内相对路径', () => {
  assert.strictEqual(core.safeRelativePath('Carnet santé/Prélèvements'), 'Carnet santé/Prélèvements');
  assert.strictEqual(core.safeRelativePath('/Users/b/Downloads/A'), 'Users/b/Downloads/A');
  assert.strictEqual(core.safeRelativePath('C:\\Reports\\X'), 'Reports/X');
  assert.strictEqual(core.safeRelativePath('a/../b'), 'b');
  assert.strictEqual(core.safeRelativePath('../../x'), 'x');   // 不允许逃出下载目录
  assert.strictEqual(core.safeRelativePath('..'), '');
  assert.strictEqual(core.safeRelativePath('   '), '');
  assert.strictEqual(core.safeRelativePath(null), '');
});

test('renderTemplate 空变量不留残迹', () => {
  assert.strictEqual(core.renderTemplate('{date} - {label}', { date: '2024-05-15', label: 'Radio' }), '2024-05-15 - Radio');
  assert.strictEqual(core.renderTemplate('{date} - {label}', { date: '2024-05-15' }), '2024-05-15');
  assert.strictEqual(core.renderTemplate('{date} - {prescriber} - {label}', { date: '2024-05-15', label: 'X' }), '2024-05-15 - X');
});

test('buildFilename 回退与 .pdf 后缀', () => {
  assert.strictEqual(core.buildFilename('{date} - {label}', { date: '2024-05-15', label: 'Thorax' }), '2024-05-15 - Thorax.pdf');
  assert.strictEqual(core.buildFilename('', {}, 'fallback'), 'fallback.pdf');
  assert.ok(core.buildFilename('{label}', { label: 'a:b*?' }).endsWith('.pdf'));
  assert.ok(!/[:*?]/.test(core.buildFilename('{label}', { label: 'a:b*?' })));
});

test('日期解析与格式化', () => {
  assert.strictEqual(core.fmtDate('2024-03-05T10:00:00'), '2024-03-05');
  assert.strictEqual(core.fmtDate('2024-03-05'), '2024-03-05');
  assert.strictEqual(core.fmtDate(null), '');
  assert.strictEqual(core.fmtApiDate(new Date(2024, 0, 5), true), '2024-01-05');
  assert.strictEqual(core.fmtApiDate(new Date(2024, 10, 15), false), '2024-11-15');
});

test('buildRanges：补零/不补零、跨度上限、当年截至今日', () => {
  const today = new Date(2026, 10, 7); // 2026-11-07
  const labs = core.buildRanges(2024, 2026, 1, true, today);
  assert.deepStrictEqual(labs.map(r => r.from), ['2024-01-01', '2025-01-01', '2026-01-01']);
  assert.strictEqual(labs[labs.length - 1].to, '2026-11-07');      // 当年 → 今天
  assert.strictEqual(labs[labs.length - 2].to, '2025-12-31');

  const img = core.buildRanges(2020, 2026, 5, false, today);
  assert.strictEqual(img.length, 2);                                // [2020..2024] [2025..2026]
  assert.strictEqual(img[0].from, '2020-1-1');                      // 不补零
  assert.strictEqual(img[1].to, '2026-11-7');
});

test('buildPeriodOptions：最早数据年 → 今年的可选起始年列表', () => {
  assert.deepStrictEqual(core.buildPeriodOptions(2021, 2026), [2021, 2022, 2023, 2024, 2025, 2026]);
  assert.deepStrictEqual(core.buildPeriodOptions(2026, 2026), [2026]);   // 最早即今年
  assert.deepStrictEqual(core.buildPeriodOptions(2027, 2026), []);       // 最早晚于今年 → 无效
  assert.deepStrictEqual(core.buildPeriodOptions(null, 2026), []);       // 未知 → 调用方回退
  assert.deepStrictEqual(core.buildPeriodOptions('2021', 2026), []);
});

test('base64 编解码往返 + %PDF 魔数', () => {
  const bytes = new TextEncoder().encode('%PDF-1.4 hello é');
  const b64 = core.bytesToBase64(bytes);
  const back = core.base64ToBytes(b64);
  assert.deepStrictEqual(Array.from(back), Array.from(bytes));
  const pdfHeader = core.base64ToBytes('JVBERi0xLjQ=');
  assert.strictEqual(new TextDecoder().decode(pdfHeader), '%PDF-1.4');
  assert.strictEqual(core.bytesToDataUrl(new Uint8Array([1, 2, 3]), 'application/pdf'),
    'data:application/pdf;base64,AQID');
});

test('parseDataUrl 解析 data URL（mime + 字节往返）', () => {
  const bytes = new TextEncoder().encode('%PDF-1.4 x');
  const url = core.bytesToDataUrl(bytes, 'application/pdf');
  const parsed = core.parseDataUrl(url);
  assert.strictEqual(parsed.mime, 'application/pdf');
  assert.deepStrictEqual(Array.from(parsed.bytes), Array.from(bytes));
  assert.strictEqual(core.parseDataUrl('https://x/y'), null);
  assert.strictEqual(core.parseDataUrl('data:text/plain;base64,!!!').bytes.length, 0); // 非法字符被剥离
});

test('findEmbeddedPdfs 从任意嵌套 JSON 提取内嵌 PDF', () => {
  const pdfBytes = new TextEncoder().encode('%PDF-1.4 labs');
  const payload = {
    rapports: [
      { description: 'Hémogramme', contenu: core.bytesToBase64(pdfBytes) },
      { note: 'pas un pdf', contenu: 'SGVsbG8gd29ybGQ=' },
    ],
    meta: { dataUri: 'data:application/pdf;base64,' + core.bytesToBase64(pdfBytes) },
  };
  const out = core.findEmbeddedPdfs(payload);
  assert.strictEqual(out.length, 2);
  assert.deepStrictEqual(Array.from(out[0]), Array.from(pdfBytes));
  assert.strictEqual(core.findEmbeddedPdfs({ a: 'texte' }).length, 0);
});

test('findLabel 启发式挑出报告名称', () => {
  assert.strictEqual(core.findLabel({ rapports: [{ contenu: 'JVBERi', description: 'Glycémie à jeun' }] }), 'Glycémie à jeun');
  assert.strictEqual(core.findLabel({ libelle: 'Urinanalyse', nomPrescripteur: 'Dubois' }), 'Urinanalyse');
  assert.strictEqual(core.findLabel({ nom: 'Analyse urinaire' }), 'Analyse urinaire');
  // 处方者字段不作为标题
  assert.strictEqual(core.findLabel({ nomPrescripteur: 'Dubois', titre: 'Bilan sanguin' }), 'Bilan sanguin');
  assert.strictEqual(core.findLabel({ datePrelevement: '2024-01-01' }), null);
});

test('CSV 转义与表头', () => {
  assert.strictEqual(core.csvEscape('a,b'), '"a,b"');
  assert.strictEqual(core.csvEscape('say "hi"'), '"say ""hi"""');
  const csv = core.buildCsv(['date', 'label'], [{ date: '2024-01-01', label: 'A,B' }]);
  assert.strictEqual(csv, 'date,label\r\n2024-01-01,"A,B"');
});

test('i18n t() 三语与变量替换', () => {
  assert.ok(core.t('zh', 'appTitle').length > 0);
  assert.strictEqual(core.t('fr', 'downloaded', { n: 3 }), 'Téléchargés 3');
  assert.strictEqual(core.t('en', 'downloaded', { n: 3 }), 'Downloaded 3');
  assert.strictEqual(core.t('xx', 'appTitle'), core.t('zh', 'appTitle')); // 未知语言回退中文
});

test('i18n 全部语言键集合与 en 一致（新增语言不缺翻译）', () => {
  const base = Object.keys(core.I18N.en).sort();
  assert.ok(base.length >= 70);
  assert.strictEqual(Object.keys(core.I18N).length, 13);   // zh/fr/en + 10 移民语言
  for (const lang of Object.keys(core.I18N)) {
    assert.deepStrictEqual(
      Object.keys(core.I18N[lang]).sort(), base,
      '语言 ' + lang + ' 的键集合与 en 不一致（缺翻译或多出键）');
  }
});

test('i18n 新增语言样例与 RTL 判定', () => {
  assert.strictEqual(core.t('ar', 'downloaded', { n: 3 }), 'تم تنزيل 3');
  assert.strictEqual(core.t('tl', 'cancel'), 'Kanselahin');
  assert.strictEqual(core.t('pa', 'found', { n: 5 }), '5 ਮਿਲੇ');
  assert.strictEqual(core.t('ht', 'done'), 'Fini');
  assert.strictEqual(core.isRtl('ar'), true);
  assert.strictEqual(core.isRtl('fr'), false);
  assert.strictEqual(core.isRtl('pa'), false);
});
