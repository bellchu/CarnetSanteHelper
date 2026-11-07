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

  // 进度流完整（含每个报告后的实时统计）
  const stages = meta.progresses.map(p => p.stage);
  assert.ok(stages.includes('start') && stages.includes('item') && stages.includes('done'));
  const statEvents = meta.progresses.filter(p => p.stage === 'stats');
  assert.ok(statEvents.length >= 2);
  const labStats = statEvents.filter(p => p.payload.section === 'labs').pop().payload;
  assert.strictEqual(labStats.failed, 1);   // lab-broken 计入实时失败数

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

test('apiBase：优先页面 origin，同源成功后锁定基址', async () => {
  const routes = [
    {
      match: (u) => u.endsWith('/api/1/Citoyens'),
      reply: (u) => (u.startsWith('https://carnetsante.gouv.qc.ca')
        ? resJson({ IdCitoyen: 'C123' })
        : resJson({}, 403)),
    },
    { match: (u) => u.includes('/ExamensImagerie?'), reply: () => resJson([]) },
  ];
  const srv = makeFetch(routes);
  const summary = await pipeline.runSweep(
    baseJob({ apiBase: 'https://carnetsante.gouv.qc.ca', sections: { labs: false, imaging: true } }),
    makeEnv(srv.fetchImpl, [], new Map(), {})
  );
  assert.strictEqual(summary.citizen.id, 'C123');
  assert.ok(srv.calls.every((c) => c.url.startsWith('https://carnetsante.gouv.qc.ca')), '后续请求应锁定同源基址');
});

test('apiBase：同源 403 时自动回退 www 域', async () => {
  const routes = [
    {
      match: (u) => u.endsWith('/api/1/Citoyens'),
      reply: (u) => (u.startsWith('https://www.carnetsante.gouv.qc.ca')
        ? resJson({ IdCitoyen: 'C123' })
        : resJson({}, 403)),
    },
    { match: (u) => u.includes('/ExamensImagerie?'), reply: () => resJson([]) },
  ];
  const srv = makeFetch(routes);
  const summary = await pipeline.runSweep(
    baseJob({ apiBase: 'https://carnetsante.gouv.qc.ca', sections: { labs: false, imaging: true } }),
    makeEnv(srv.fetchImpl, [], new Map(), {})
  );
  assert.strictEqual(summary.citizen.id, 'C123');
  assert.ok(srv.calls.some((c) => c.url.startsWith('https://carnetsante.gouv.qc.ca/api/1/Citoyens')), '先尝试同源基址');
  const postBootstrap = srv.calls.filter((c) => !c.url.endsWith('/api/1/Citoyens'));
  assert.ok(postBootstrap.every((c) => c.url.startsWith('https://www.carnetsante.gouv.qc.ca')), '回退后其余请求全部走 www 基址');
});

test('dry-run 不拉取影像 PDF 本体', async () => {
  // 移除会返回 PDF 的路由，换成抛错版本：dry run 若请求 PDF 即失败
  const isPdfRoute = function (r) {
    return r.match('https://x/a/DetailRapport/1/Rapport');
  };
  const routes = defaultRoutes.filter(function (r) { return !isPdfRoute(r); }).concat([{
    match: (u) => u.includes('/DetailRapport/') && u.endsWith('/Rapport'),
    reply: () => { throw new Error('dry run 不应请求 PDF'); },
  }]);
  const srv = makeFetch(routes);
  const summary = await pipeline.runSweep(
    baseJob({ dryRun: true }),
    Object.assign(makeEnv(srv.fetchImpl, [], new Map(), {}), {
      downloadFn: async () => ({ ok: true, dryRun: true }),
    })
  );
  assert.strictEqual(summary.stats.imaging.downloaded, 1);   // 扫描仍完整计数
  assert.strictEqual(summary.stats.labs.downloaded, 1);      // 化验 PDF 内嵌于 Rapports JSON，必须获取
});

test('ExamensImagerie 500：换格式仍失败则二分到单年后成功', async () => {
  const routes = [
    { match: (u) => u.endsWith('/api/1/Citoyens'), reply: () => resJson({ IdCitoyen: 'C123' }) },
    {
      // 跨年区间一律 500（模拟服务端跨度上限），单年正常返回
      match: (u) => u.includes('/ExamensImagerie?'),
      reply: (u) => {
        const m = /DateDebut=(\d{4})-\d+-\d+&DateFin=(\d{4})-\d+-\d+/.exec(u);
        if (!m) return resJson({}, 400);
        return (+m[1] === +m[2]) ? resJson([EXAM]) : resJson({}, 500);
      },
    },
    {
      match: (u) => u.includes('/ExamenImagerie/') && u.endsWith('/DetailRapport'),
      reply: () => resJson([{ IdRapport: 'R1', DateRapport: `${Y}-05-15T00:00:00`, Statut: 'Disponible' }]),
    },
    {
      match: (u) => u.includes('/DetailRapport/') && u.endsWith('/Rapport'),
      reply: () => resBin(IMAGING_PDF),
    },
  ];
  const downloads = [];
  const summary = await pipeline.runSweep(
    baseJob({ sections: { labs: false, imaging: true }, startYear: Y - 2 }),
    makeEnv(makeFetch(routes).fetchImpl, downloads, new Map(), {})
  );
  assert.strictEqual(summary.stats.imaging.downloaded, 1);
  assert.strictEqual(summary.errors.length, 0);
});

test('日期格式回退：非补零 500 时改补零即成功（无需二分）', async () => {
  const routes = [
    { match: (u) => u.endsWith('/api/1/Citoyens'), reply: () => resJson({ IdCitoyen: 'C123' }) },
    {
      // 非补零（月/日为一位数，如 2024-1-1）→ 500；补零 → 正常
      match: (u) => u.includes('/ExamensImagerie?'),
      reply: (u) => (/DateDebut=\d{4}-\d{1}-\d{1}&/.test(u) ? resJson({}, 500) : resJson([EXAM])),
    },
    {
      match: (u) => u.includes('/ExamenImagerie/') && u.endsWith('/DetailRapport'),
      reply: () => resJson([{ IdRapport: 'R1', DateRapport: `${Y}-05-15T00:00:00` }]),
    },
    {
      match: (u) => u.includes('/DetailRapport/') && u.endsWith('/Rapport'),
      reply: () => resBin(IMAGING_PDF),
    },
  ];
  const srv = makeFetch(routes);
  const downloads = [];
  const summary = await pipeline.runSweep(
    baseJob({ sections: { labs: false, imaging: true }, startYear: Y - 1 }),
    makeEnv(srv.fetchImpl, downloads, new Map(), {})
  );
  assert.strictEqual(summary.stats.imaging.downloaded, 1);
  const listCalls = srv.calls.filter((c) => c.url.includes('/ExamensImagerie?'));
  assert.strictEqual(listCalls.length, 2);   // 一次非补零失败 + 一次补零成功
});

test('单年仍 500：记录错误并继续其余板块', async () => {
  const routes = [
    { match: (u) => u.endsWith('/api/1/Citoyens'), reply: () => resJson({ IdCitoyen: 'C123' }) },
    { match: (u) => u.includes('/ExamensImagerie?'), reply: () => resJson({}, 500) },
  ].concat(defaultRoutes.filter(function (r) {
    return !r.match('https://x/ExamensImagerie?DateDebut=1&DateFin=2');
  }));
  const downloads = [];
  const summary = await pipeline.runSweep(
    baseJob(),
    makeEnv(makeFetch(routes).fetchImpl, downloads, new Map(), {})
  );
  assert.strictEqual(summary.stats.imaging.downloaded, 0);
  assert.ok(summary.errors.some(function (e) { return e.section === 'imaging'; }));
  assert.strictEqual(summary.stats.labs.downloaded, 1);   // 化验不受影响
});

test('labs 整条快速跳过：已完成条目不再请求 Rapports（零网络）', async () => {
  const storeMap = new Map();
  storeMap.set('dedup:C123:labsItem:lab-001', '1');   // 预置：lab-001 上次已完整下载
  const srv = makeFetch(defaultRoutes);
  const summary = await pipeline.runSweep(
    baseJob({ sections: { labs: true, imaging: false } }),
    makeEnv(srv.fetchImpl, [], storeMap, {})
  );
  assert.ok(!srv.calls.some((c) => c.url.includes('/Prelevements/lab-001/Rapports')), '已完成条目不应再拉取');
  assert.strictEqual(summary.stats.labs.skipped, 1);
  assert.ok(srv.calls.some((c) => c.url.includes('/Prelevements/lab-broken/Rapports')), '失败条目仍会重试');
  assert.strictEqual(summary.stats.labs.failed, 1);
});

test('labs 全部成功后写整条标记，二次运行该条零请求', async () => {
  const storeMap = new Map();
  const srv1 = makeFetch(defaultRoutes);
  await pipeline.runSweep(
    baseJob({ sections: { labs: true, imaging: false } }),
    makeEnv(srv1.fetchImpl, [], storeMap, {})
  );
  assert.ok(storeMap.has('dedup:C123:labsItem:lab-001'), '成功后写入整条标记');
  assert.ok(!storeMap.has('dedup:C123:labsItem:lab-broken'), '失败条目不写标记');

  const srv2 = makeFetch(defaultRoutes);
  const s2 = await pipeline.runSweep(
    baseJob({ sections: { labs: true, imaging: false } }),
    makeEnv(srv2.fetchImpl, [], storeMap, {})
  );
  assert.ok(!srv2.calls.some((c) => c.url.includes('/Prelevements/lab-001/Rapports')));
  assert.strictEqual(s2.stats.labs.skipped, 1);
  assert.strictEqual(s2.stats.labs.failed, 1);
});

test('取消立即中止挂起的 Rapports 请求（AbortError → cancelled，不计失败）', async () => {
  let cancelled = false;
  const abortErr = new Error('The user aborted a request.');
  abortErr.name = 'AbortError';
  const routes = [
    { match: (u) => u.endsWith('/api/1/Citoyens'), reply: () => resJson({ IdCitoyen: 'C123' }) },
    { match: (u) => u.endsWith('/PrelevementsAccessibles'), reply: () => resJson({ accessible: true }) },
    { match: (u) => u.includes('/Prelevements?'), reply: () => resJson([LAB_ITEM]) },
    {
      // Rapports 挂起时用户点取消 → fetch 被 abort
      match: (u) => u.includes('/Prelevements/lab-001/Rapports'),
      reply: () => { cancelled = true; throw abortErr; },
    },
  ];
  const summary = await pipeline.runSweep(
    baseJob({ sections: { labs: true, imaging: false } }),
    makeEnv(makeFetch(routes).fetchImpl, [], new Map(), { isCancelled: () => cancelled })
  );
  assert.strictEqual(summary.cancelled, true);
  assert.strictEqual(summary.stats.labs.failed, 0);   // 取消不计为失败
  assert.ok(!summary.errors.some((e) => e.id === 'lab-001'));
});

test('跳过/失败/成功都产生带状态的 item 事件', async () => {
  const storeMap = new Map();
  storeMap.set('dedup:C123:labsItem:lab-001', '1');   // 预置跳过
  const meta = {};
  await pipeline.runSweep(
    baseJob({ sections: { labs: true, imaging: false } }),
    makeEnv(makeFetch(defaultRoutes).fetchImpl, [], storeMap, meta)
  );
  const items = meta.progresses.filter((p) => p.stage === 'item').map((p) => p.payload);
  assert.ok(items.some((p) => p.skip === true), '跳过事件');
  assert.ok(items.some((p) => p.fail === true && p.error), '失败事件带原因');
  // 影像正常成功事件
  const meta2 = {};
  await pipeline.runSweep(baseJob({ sections: { labs: false, imaging: true } }),
    makeEnv(makeFetch(defaultRoutes).fetchImpl, [], new Map(), meta2));
  const items2 = meta2.progresses.filter((p) => p.stage === 'item').map((p) => p.payload);
  assert.ok(items2.some((p) => !p.skip && !p.fail && p.file.endsWith('.pdf')), '成功事件带文件名');
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
