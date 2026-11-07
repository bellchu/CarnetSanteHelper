'use strict';
/*
 * lib/pipeline.js 集成测试：
 * 用模拟的 /api/1（结构与逆向观察一致）跑完整流水线，
 * 覆盖：认证头、日期格式、文件命名与归档路径、base64 PDF 提取、
 * 去重、错误容忍、取消、索引清单生成。
 */
const test = require('node:test');
const assert = require('node:assert');
const core = require('../lib/core.js');
const pipeline = require('../lib/pipeline.js');

const ENC = new TextEncoder();
const Y = new Date().getFullYear();

function resJson(obj, status) {
  status = status || 200;
  const text = JSON.stringify(obj);
  return {
    ok: status >= 200 && status < 300,
    status: status,
    async json() { return obj; },
    async text() { return text; },
    async arrayBuffer() { return ENC.encode(text).buffer; },
  };
}
function resBin(str, status) {
  status = status || 200;
  const b = ENC.encode(str);
  return {
    ok: status >= 200 && status < 300,
    status: status,
    async json() { throw new Error('not json'); },
    async text() { return str; },
    async arrayBuffer() { return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); },
  };
}

/* 模拟数据 */
const EXAM = {
  NumeroExamen: '2.16.840.1.113883.3.234.1.3.101.1.2.999',
  DateExamen: `${Y}-05-13T00:00:00`,
  DescriptionExamen: 'Radiographie: thorax',
  NomPrescripteur: 'Dubois',
  PrenomPrescripteur: 'Jean',
};
const IMAGING_PDF = '%PDF-1.4 imaging report';
const LAB_ITEM = {
  id: 'lab-001',
  trackingId: 'uuid-1',
  datePrelevement: `${Y}-02-01T00:00:00`,
  statutRapport: 'Final',
  nomPrescripteur: 'Dubois',
  prenomPrescripteur: 'Jean',
};
const LAB_ITEM_BROKEN = {
  id: 'lab-broken',
  datePrelevement: `${Y}-03-01T00:00:00`,
  statutRapport: 'Final',
};
const LAB_PDF = '%PDF-1.4 labs report';
const LAB_RAPPORTS = {
  rapports: [{ description: 'Hémogramme', contenu: core.bytesToBase64(ENC.encode(LAB_PDF)) }],
};

/* 模拟服务器：记录 URL 与请求头，按路由返回 */
function makeFetch(routes) {
  const calls = [];
  const fetchImpl = async function (url, init) {
    init = init || {};
    calls.push({ url, headers: init.headers, credentials: init.credentials });
    for (const r of routes) {
      if (r.match(url)) return r.reply(url, init);
    }
    return resJson({ error: 'not found' }, 404);
  };
  return { fetchImpl, calls };
}

const defaultRoutes = [
  {
    match: (u) => u.endsWith('/api/1/Citoyens'),
    reply: () => resJson({ IdCitoyen: 'C123', Nom: 'Tremblay', Prenom: 'Jean' }),
  },
  {
    match: (u) => u.includes('/ExamensImagerie?'),
    reply: (u) => {
      assert.match(u, /DateDebut=\d{4}-\d{1,2}-\d{1,2}&DateFin=\d{4}-\d{1,2}-\d{1,2}/); // 不补零
      return resJson([EXAM]);
    },
  },
  {
    match: (u) => u.includes('/ExamenImagerie/') && u.endsWith('/DetailRapport'),
    reply: () => resJson([{ IdRapport: '1061642060216840113883323413103129990', DateRapport: `${Y}-05-15T00:00:00`, Statut: 'Disponible' }]),
  },
  {
    match: (u) => u.includes('/DetailRapport/') && u.endsWith('/Rapport'),
    reply: () => resBin(IMAGING_PDF),
  },
  {
    match: (u) => u.endsWith('/PrelevementsAccessibles'),
    reply: () => resJson({ accessible: true }),
  },
  {
    match: (u) => u.includes('/Prelevements?'),
    reply: (u) => {
      assert.match(u, /DateDebut=\d{4}-\d{2}-\d{2}&DateFin=\d{4}-\d{2}-\d{2}/);        // 补零格式
      return resJson(u.includes(`DateDebut=${Y}-01-01`) ? [LAB_ITEM, LAB_ITEM_BROKEN] : []);
    },
  },
  {
    match: (u) => u.includes('/Prelevements/lab-001/Rapports'),
    reply: () => resJson(LAB_RAPPORTS),
  },
  {
    match: (u) => u.includes('/Prelevements/lab-broken/Rapports'),
    reply: () => resJson({ error: 'boom' }, 500),
  },
];

function makeEnv(fetchImpl, downloads, storeMap, opts) {
  opts = opts || {};
  return {
    fetchImpl,
    downloadFn: async function (item) {
      downloads.push(item);
      return { ok: true };
    },
    store: {
      async get(k) { return storeMap.get(k); },
      async set(k, v) { storeMap.set(k, v); },
    },
    sleep: async function (ms) { (opts.delays = opts.delays || []).push(ms); },
    log: function () {},
    progress: function (stage, payload) { (opts.progresses = opts.progresses || []).push({ stage, payload }); },
    refresh: opts.refresh,
    isCancelled: opts.isCancelled || function () { return false; },
  };
}

function baseJob(over) {
  return Object.assign({
    sections: { labs: true, imaging: true },
    startYear: Y - 6,
    endYear: Y,
    token: 'TOKEN-1',
    options: {},
  }, over);
}

test('完整流水线：下载两类 PDF、命名归档正确、带 Bearer 头', async () => {
  const srv = makeFetch(defaultRoutes);
  const downloads = [];
  const storeMap = new Map();
  const meta = {};
  const summary = await pipeline.runSweep(baseJob(), makeEnv(srv.fetchImpl, downloads, storeMap, meta));

  // 认证头与凭据
  assert.ok(srv.calls.length > 0);
  for (const c of srv.calls) {
    assert.strictEqual(c.headers.Authorization, 'Bearer TOKEN-1');
    assert.strictEqual(c.credentials, 'include');
  }

  // PDF 内容
  const pdfs = downloads.filter(d => d.mime === 'application/pdf');
  assert.strictEqual(pdfs.length, 2);
  assert.strictEqual(new TextDecoder().decode(pdfs.find(d => d.filename.includes('Imagerie')).bytes), IMAGING_PDF);
  assert.strictEqual(new TextDecoder().decode(pdfs.find(d => d.filename.includes('Prélèvements')).bytes), LAB_PDF);

  // 归档路径与命名（报告日期优先，标签来自 DescriptionExamen / description）
  assert.ok(pdfs.some(d => d.filename === 'Carnet santé/Imagerie médicale/' + `${Y}-05-15 - Radiographie thorax.pdf`));
  assert.ok(pdfs.some(d => d.filename === 'Carnet santé/Prélèvements/' + `${Y}-02-01 - Hémogramme.pdf`));

  // lab-broken 的 /Rapports 500 → 计入失败但不中断
  assert.strictEqual(summary.stats.imaging.downloaded, 1);
  assert.strictEqual(summary.stats.labs.downloaded, 1);
  assert.strictEqual(summary.stats.labs.failed, 1);
  assert.ok(summary.errors.some(e => e.section === 'labs' && e.error.includes('500')));

  // 索引清单
  const csv = downloads.find(d => /\.csv$/.test(d.filename));
  const json = downloads.find(d => /\.json$/.test(d.filename));
  assert.ok(csv && csv.filename.startsWith('Carnet santé/index-'), csv && csv.filename);
  assert.ok(json && json.filename.startsWith('Carnet santé/donnees-'), json && json.filename);
  // Excel 兼容 BOM（TextDecoder 默认剥离 BOM，直接查原始字节）
  assert.strictEqual(csv.bytes[0], 0xef);
  assert.strictEqual(csv.bytes[1], 0xbb);
  assert.strictEqual(csv.bytes[2], 0xbf);
  const csvText = new TextDecoder().decode(csv.bytes);
  assert.ok(csvText.includes('imagerie') && csvText.includes('prélèvements'));

  // 去重记录已写入
  assert.ok(Array.from(storeMap.keys()).some(k => k.startsWith('dedup:C123:imaging:')));
  assert.ok(Array.from(storeMap.keys()).some(k => k.startsWith('dedup:C123:labs:')));

  // 进度流完整
  const stages = meta.progresses.map(p => p.stage);
  assert.ok(stages.includes('start') && stages.includes('item') && stages.includes('done'));

  // 限速生效
  assert.ok(meta.delays.length >= 2 && meta.delays.every(d => d === core.DEFAULTS.delayMs));
});

test('去重：第二次运行全部跳过，不再下载', async () => {
  const srv = makeFetch(defaultRoutes);
  const downloads = [];
  const storeMap = new Map();
  const env1 = makeEnv(srv.fetchImpl, downloads, storeMap, {});
  await pipeline.runSweep(baseJob(), env1);
  const count1 = downloads.length;

  const srv2 = makeFetch(defaultRoutes);
  const downloads2 = [];
  const summary2 = await pipeline.runSweep(baseJob(), makeEnv(srv2.fetchImpl, downloads2, storeMap, {}));
  assert.strictEqual(downloads2.filter(d => d.mime === 'application/pdf').length, 0);
  assert.strictEqual(summary2.stats.imaging.skipped, 1);
  assert.strictEqual(summary2.stats.labs.skipped, 1);
  assert.strictEqual(count1 >= 3, true);
});

test('取消：下载被中止并标记 cancelled', async () => {
  const srv = makeFetch(defaultRoutes);
  const downloads = [];
  const env = makeEnv(srv.fetchImpl, downloads, new Map(), { isCancelled: () => true });
  const summary = await pipeline.runSweep(baseJob(), env);
  assert.strictEqual(summary.cancelled, true);
  assert.strictEqual(downloads.filter(d => d.mime === 'application/pdf').length, 0);
});

test('401 后用新令牌重试成功', async () => {
  let first = true;
  const routes = [
    {
      match: (u) => u.endsWith('/api/1/Citoyens'),
      reply: (u, init) => {
        if (first && init.headers.Authorization === 'Bearer OLD') {
          first = false;
          return resJson({ error: 'expired' }, 401);
        }
        return resJson({ IdCitoyen: 'C123', Nom: 'Tremblay', Prenom: 'Jean' });
      },
    },
  ];
  const srv = makeFetch(routes);
  const job = baseJob({ sections: { labs: false, imaging: false }, token: 'OLD' });
  const summary = await pipeline.runSweep(job, makeEnv(srv.fetchImpl, [], new Map(), {
    refresh: async () => 'FRESH',
  }));
  assert.strictEqual(summary.citizen.id, 'C123');
  assert.strictEqual(job.token, 'FRESH');
});

test('仅扫描（dry-run）：预览文件列表，但不写索引、不污染去重记录', async () => {
  const storeMap = new Map();

  // 第一次：仅扫描。downloadFn 模拟内容脚本在 dryRun 下的行为（不真实下载）
  const realDownloads = [];
  const dryEnv = Object.assign(makeEnv(makeFetch(defaultRoutes).fetchImpl, realDownloads, storeMap, {}), {
    downloadFn: async function (item) { return { ok: true, dryRun: true }; },
  });
  const drySummary = await pipeline.runSweep(baseJob({ dryRun: true }), dryEnv);

  assert.strictEqual(drySummary.files.filter(f => f.endsWith('.pdf')).length, 2); // 两份 PDF 预览
  assert.ok(!drySummary.files.some(f => f.includes('index-') || f.includes('donnees-'))); // 无索引
  assert.strictEqual(storeMap.size, 0);                                            // 未写去重记录
  assert.strictEqual(realDownloads.length, 0);                                     // 未真实下载

  // 第二次：正式运行 → 全量下载成功（没有被扫描模式"吃掉"）
  const srv2 = makeFetch(defaultRoutes);
  const downloads = [];
  const summary = await pipeline.runSweep(baseJob(), makeEnv(srv2.fetchImpl, downloads, storeMap, {}));
  assert.strictEqual(summary.stats.imaging.downloaded, 1);
  assert.strictEqual(summary.stats.labs.downloaded, 1);
});

test('化验功能未开放（gate 403）：跳过板块但不报致命错误', async () => {
  const routes = [
    { match: (u) => u.endsWith('/api/1/Citoyens'), reply: () => resJson({ IdCitoyen: 'C123' }) },
    { match: (u) => u.endsWith('/PrelevementsAccessibles'), reply: () => resJson({}, 403) },
  ];
  const srv = makeFetch(routes);
  const summary = await pipeline.runSweep(
    baseJob({ sections: { labs: true, imaging: false } }),
    makeEnv(srv.fetchImpl, [], new Map(), {})
  );
  assert.strictEqual(summary.stats.labs.downloaded, 0);
  assert.ok(summary.errors.some(e => e.id === 'gate'));
});
