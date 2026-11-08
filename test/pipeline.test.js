'use strict';
/*
 * lib/pipeline.js 集成测试：
 * 用模拟的 /api/1（结构与逆向观察一致）跑完整流水线，
 * 覆盖：认证头、日期格式、文件命名与归档路径、base64 PDF 提取、
 * 去重、错误容忍、取消、索引清单生成、处方药（Médications）快照导出。
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

/* 处方药（OrdonnanceAvecService）模拟数据 */
const MED_1 = {
  Type: 'OrdonnanceAvecService',
  Id: 'ord-1', IdOrdonnance: 'ord-1',
  Date: `${Y}-03-10T00:00:00`, Duree: 30,
  NomPrescripteur: 'Dubois', PrenomPrescripteur: 'Jean', Pharmacie: 'Pharmaprix Centre',
  NombreDelivrancesAutorisees: 5, NombreDelivrancesRestantes: 2,
  MedicamentPrescrit: {
    DIN: '02239630', Nom: 'AMOXIL 250 mg gélule', LibelleClasse: 'Antibiotiques',
    Posologies: [{ Description: '1 comprimé 3 fois par jour' }, { Description: 'pendant 7 jours' }],
  },
  DernierService: { Id: 's1', Date: `${Y}-04-01T00:00:00`, NomPharmacie: 'Pharmaprix Centre' },
};
const MED_2 = {
  Id: 'ord-2', IdOrdonnance: 'ord-2',
  Date: `${Y - 1}-06-15T00:00:00`, Duree: 90,
  NomPrescripteur: 'Tremblay', PrenomPrescripteur: 'Marie', Pharmacie: 'Uniprix',
  NombreDelivrancesAutorisees: 3, NombreDelivrancesRestantes: null,   // 配制药剩余次数为 null
  MedicamentPrescrit: { DIN: '', Nom: 'Préparation magistrale', LibelleClasse: '', Posologies: [] },
  DernierService: null,
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

/* ---------- probeEarliest：最早数据探测（先判断最早数据，再给可选时间段） ---------- */

function earliestEnv(fetchImpl, storeMap, opts) {
  return makeEnv(fetchImpl, [], storeMap, opts || {});
}
function yearOf(u) {
  const m = /DateDebut=(\d{4})-/.exec(u);
  return m ? +m[1] : null;
}

test('probeEarliest：逐年后退找最早年，容忍单年空档；labs 补零 / imaging 不补零', async () => {
  const routes = [
    { match: (u) => u.endsWith('/api/1/Citoyens'), reply: () => resJson({ IdCitoyen: 'C123', Nom: 'Tremblay', Prenom: 'Jean' }) },
    { match: (u) => u.endsWith('/PrelevementsAccessibles'), reply: () => resJson({ accessible: true }) },
    {
      // 化验：仅 Y 与 Y-2 有数据（Y-1 空档）→ 最早 Y-2；数据后连续两空年（Y-3、Y-4）即停
      match: (u) => u.includes('/Prelevements?'),
      reply: (u) => {
        assert.match(u, /DateDebut=\d{4}-\d{2}-\d{2}&DateFin=\d{4}-\d{2}-\d{2}/);   // 补零
        const y = yearOf(u);
        return resJson(y === Y || y === Y - 2 ? [LAB_ITEM] : []);
      },
    },
    {
      // 影像：仅今年有数据 → 最早 Y；Y-1、Y-2 连续空年后停
      match: (u) => u.includes('/ExamensImagerie?'),
      reply: (u) => {
        assert.match(u, /DateDebut=\d{4}-\d{1,2}-\d{1,2}&DateFin=\d{4}-\d{1,2}-\d{1,2}/); // 不补零
        return resJson(yearOf(u) === Y ? [EXAM] : []);
      },
    },
  ];
  const srv = makeFetch(routes);
  const storeMap = new Map();
  const r = await pipeline.probeEarliest({ token: 'TOKEN-1' }, earliestEnv(srv.fetchImpl, storeMap));

  assert.strictEqual(r.citizen.id, 'C123');
  assert.strictEqual(r.labs, Y - 2);       // 跨过 Y-1 单年空档
  assert.strictEqual(r.imaging, Y);
  const labYears = srv.calls.filter((c) => c.url.includes('/Prelevements?')).map((c) => yearOf(c.url));
  const imgYears = srv.calls.filter((c) => c.url.includes('/ExamensImagerie?')).map((c) => yearOf(c.url));
  assert.strictEqual(Math.min(...labYears), Y - 4);   // 数据后两空年即停，不再探 Y-5
  assert.ok(!labYears.includes(Y - 5));
  assert.strictEqual(Math.min(...imgYears), Y - 2);
  assert.ok(!imgYears.includes(Y - 3));
  assert.ok(storeMap.has('probeEarliest:C123'));      // 结果已缓存
});

test('probeEarliest：labs 功能未开放 → labs 为 null 且不做年份查询', async () => {
  const routes = [
    { match: (u) => u.endsWith('/api/1/Citoyens'), reply: () => resJson({ IdCitoyen: 'C123' }) },
    { match: (u) => u.endsWith('/PrelevementsAccessibles'), reply: () => resJson({}, 403) },
    { match: (u) => u.includes('/ExamensImagerie?'), reply: (u) => resJson(yearOf(u) === Y ? [EXAM] : []) },
  ];
  const srv = makeFetch(routes);
  const r = await pipeline.probeEarliest({ token: 'T' }, earliestEnv(srv.fetchImpl, new Map()));
  assert.strictEqual(r.labs, null);
  assert.strictEqual(r.imaging, Y);
  assert.ok(!srv.calls.some((c) => c.url.includes('/Prelevements?')));
});

test('probeEarliest：早于数据起点的年份报 500 → 视为边界立即停止', async () => {
  const routes = [
    { match: (u) => u.endsWith('/api/1/Citoyens'), reply: () => resJson({ IdCitoyen: 'C123' }) },
    { match: (u) => u.endsWith('/PrelevementsAccessibles'), reply: () => resJson({ accessible: true }) },
    {
      // Y-1 起才有数据；更早区间一律 500（不存在数据的区间报错）
      match: (u) => u.includes('/Prelevements?'),
      reply: (u) => (yearOf(u) >= Y - 1 ? resJson([LAB_ITEM]) : resJson({}, 500)),
    },
    { match: (u) => u.includes('/ExamensImagerie?'), reply: () => resJson([]) },
  ];
  const srv = makeFetch(routes);
  const r = await pipeline.probeEarliest({ token: 'T' }, earliestEnv(srv.fetchImpl, new Map()));
  assert.strictEqual(r.labs, Y - 1);
  const labYears = srv.calls.filter((c) => c.url.includes('/Prelevements?')).map((c) => yearOf(c.url));
  // 遇 500 即停（该年按两种日期格式各试一次），不再探更早
  assert.deepStrictEqual(Array.from(new Set(labYears)).sort(), [Y - 2, Y - 1, Y]);
  assert.ok(!labYears.includes(Y - 3));
  assert.strictEqual(r.imaging, null);                    // 影像无任何数据 → null
});

test('probeEarliest：单年查询遇 500 换日期格式重试（与扫描侧一致）', async () => {
  const routes = [
    { match: (u) => u.endsWith('/api/1/Citoyens'), reply: () => resJson({ IdCitoyen: 'C123' }) },
    { match: (u) => u.endsWith('/PrelevementsAccessibles'), reply: () => resJson({}, 403) },
    { match: (u) => u.includes('/ExamensImagerie?'), reply: () => resJson([]) },
    {
      // Medications 只认补零日期：不补零 → 500；补零 → 仅 Y-1 有数据
      match: (u) => u.includes('/Medications?'),
      reply: (u) => {
        if (!/DateDebut=\d{4}-\d{2}-\d{2}&/.test(u)) return resJson({}, 500);
        return resJson(yearOf(u) === Y - 1 ? [MED_1] : []);
      },
    },
  ];
  const srv = makeFetch(routes);
  const r = await pipeline.probeEarliest({ token: 'T' }, earliestEnv(srv.fetchImpl, new Map()));
  assert.strictEqual(r.meds, Y - 1, '格式回退后应探测到数据，而不是判为无数据');
  const medCalls = srv.calls.filter((c) => c.url.includes('/Medications?'));
  assert.ok(medCalls.some((c) => /DateDebut=\d{4}-\d{2}-\d{2}&/.test(c.url)), '应回退到补零格式');
  assert.ok(medCalls.some((c) => !/DateDebut=\d{4}-\d{2}-\d{2}&/.test(c.url)), '先按板块惯用格式（不补零）尝试');
});

test('probeEarliest：旧版本缓存缺 meds 键 → 只补探 meds 并合并缓存', async () => {
  const routes = [
    { match: (u) => u.endsWith('/api/1/Citoyens'), reply: () => resJson({ IdCitoyen: 'C123' }) },
    { match: (u) => u.includes('/Prelevements?'), reply: () => resJson([LAB_ITEM]) },
    { match: (u) => u.includes('/ExamensImagerie?'), reply: () => resJson([EXAM]) },
    { match: (u) => u.includes('/Medications?'), reply: (u) => resJson(yearOf(u) === Y - 1 ? [MED_1] : []) },
  ];
  const storeMap = new Map();
  const ts = Date.now() - 60 * 1000;
  storeMap.set('probeEarliest:C123', { ts, labs: Y - 2, imaging: Y - 3 });   // 处方功能上线前的缓存
  const srv = makeFetch(routes);
  const r = await pipeline.probeEarliest({ token: 'T' }, earliestEnv(srv.fetchImpl, storeMap));

  assert.strictEqual(r.meds, Y - 1);
  assert.strictEqual(r.labs, Y - 2);      // 已有值沿用
  assert.strictEqual(r.imaging, Y - 3);
  assert.ok(!srv.calls.some((c) => c.url.includes('/Prelevements?')));      // 不重复探测已知板块
  assert.ok(!srv.calls.some((c) => c.url.includes('/ExamensImagerie?')));
  const cached = storeMap.get('probeEarliest:C123');
  assert.deepStrictEqual(cached, { ts, labs: Y - 2, imaging: Y - 3, meds: Y - 1 });   // 合并并保留原时间戳
});

test('probeEarliest：显式 null（探过无数据）命中缓存时不重复探测', async () => {
  const routes = [
    { match: (u) => u.endsWith('/api/1/Citoyens'), reply: () => resJson({ IdCitoyen: 'C123' }) },
    { match: (u) => u.includes('/Prelevements?'), reply: () => resJson([LAB_ITEM]) },
    { match: (u) => u.includes('/ExamensImagerie?'), reply: () => resJson([]) },
    { match: (u) => u.includes('/Medications?'), reply: () => resJson([]) },
  ];
  const storeMap = new Map();
  storeMap.set('probeEarliest:C123', { ts: Date.now(), labs: Y, imaging: null, meds: null });
  const srv = makeFetch(routes);
  const r = await pipeline.probeEarliest({ token: 'T' }, earliestEnv(srv.fetchImpl, storeMap));
  assert.strictEqual(r.labs, Y);
  assert.strictEqual(r.meds, null);
  assert.strictEqual(srv.calls.length, 1);   // 仅 Citoyens
});

test('probeEarliest：缓存命中时只请求 Citoyens，不再逐年探测', async () => {
  const routes = () => [
    { match: (u) => u.endsWith('/api/1/Citoyens'), reply: () => resJson({ IdCitoyen: 'C123', Nom: 'Tremblay', Prenom: 'Jean' }) },
    { match: (u) => u.endsWith('/PrelevementsAccessibles'), reply: () => resJson({ accessible: true }) },
    { match: (u) => u.includes('/Prelevements?'), reply: (u) => resJson(yearOf(u) === Y ? [LAB_ITEM] : []) },
    { match: (u) => u.includes('/ExamensImagerie?'), reply: (u) => resJson(yearOf(u) === Y ? [EXAM] : []) },
  ];
  const storeMap = new Map();
  const srv1 = makeFetch(routes());
  const r1 = await pipeline.probeEarliest({ token: 'T' }, earliestEnv(srv1.fetchImpl, storeMap));
  assert.strictEqual(r1.labs, Y);
  assert.strictEqual(r1.imaging, Y);

  const srv2 = makeFetch(routes());
  const r2 = await pipeline.probeEarliest({ token: 'T' }, earliestEnv(srv2.fetchImpl, storeMap));
  assert.deepStrictEqual(r2, r1);
  assert.strictEqual(srv2.calls.length, 1);                       // 仅 Citoyens
  assert.ok(srv2.calls[0].url.endsWith('/api/1/Citoyens'));      // 年份探测全部走缓存
});

test('earliest 收紧起始年：不查询无数据年份（避免报错）；未提供则照旧探测', async () => {
  const mkRoutes = () => [
    { match: (u) => u.endsWith('/api/1/Citoyens'), reply: () => resJson({ IdCitoyen: 'C123' }) },
    {
      // Y-1 之前的区间一律 500：模拟「查询不存在数据造成错误」
      match: (u) => u.includes('/ExamensImagerie?'),
      reply: (u) => (yearOf(u) >= Y - 1 ? resJson([EXAM]) : resJson({}, 500)),
    },
    { match: (u) => u.includes('/ExamenImagerie/') && u.endsWith('/DetailRapport'), reply: () => resJson([{ IdRapport: 'R1', DateRapport: `${Y}-05-15T00:00:00` }]) },
    { match: (u) => u.includes('/DetailRapport/') && u.endsWith('/Rapport'), reply: () => resBin(IMAGING_PDF) },
    { match: (u) => u.endsWith('/PrelevementsAccessibles'), reply: () => resJson({ accessible: true }) },
    {
      match: (u) => u.includes('/Prelevements?'),
      reply: (u) => (yearOf(u) >= Y - 1 ? resJson([LAB_ITEM]) : resJson({}, 500)),
    },
    { match: (u) => u.includes('/Prelevements/lab-001/Rapports'), reply: () => resJson(LAB_RAPPORTS) },
  ];

  // 带 earliest：起始年收紧到 Y-1，无数据区间零请求、零错误
  const srv = makeFetch(mkRoutes());
  const summary = await pipeline.runSweep(
    baseJob({ startYear: Y - 6, earliest: { labs: Y - 1, imaging: Y - 1 } }),
    makeEnv(srv.fetchImpl, [], new Map(), {})
  );
  assert.strictEqual(summary.errors.length, 0);
  assert.strictEqual(summary.stats.imaging.downloaded, 1);
  assert.strictEqual(summary.stats.labs.downloaded, 1);
  for (const c of srv.calls) {
    if (c.url.includes('/Prelevements?') || c.url.includes('/ExamensImagerie?')) {
      assert.ok(yearOf(c.url) >= Y - 1, '不应查询早于最早数据的年份: ' + c.url);
    }
  }

  // 对照：同样的任务不带 earliest → 查到无数据区间、记录区间错误（证明收紧是必要的）
  const srv2 = makeFetch(mkRoutes());
  const s2 = await pipeline.runSweep(
    baseJob({ startYear: Y - 6 }),
    makeEnv(srv2.fetchImpl, [], new Map(), {})
  );
  assert.ok(s2.errors.some((e) => /range/.test(e.id)));
  assert.ok(srv2.calls.some((c) =>
    (c.url.includes('/Prelevements?') || c.url.includes('/ExamensImagerie?')) && yearOf(c.url) < Y - 1));
});

/* ---------- Médications：处方药历史快照 ---------- */
function medRoutes(medsReply) {
  return [
    { match: (u) => u.endsWith('/api/1/Citoyens'), reply: () => resJson({ IdCitoyen: 'C123' }) },
    {
      match: (u) => u.includes('/Medications?'),
      reply: (u) => {
        assert.match(u, /DateDebut=\d{4}-\d{1,2}-\d{1,2}&DateFin=\d{4}-\d{1,2}-\d{1,2}/);   // 不补零
        const m = /DateDebut=(\d{4})-\d+-\d+&DateFin=(\d{4})-\d+-\d+/.exec(u);
        assert.ok(+m[2] - +m[1] <= 1, '区间不应超过 2 年（服务端跨度上限）: ' + u);
        return medsReply(+m[1], +m[2]);
      },
    },
  ];
}

test('Médications：快照 CSV+JSON 写出、≤2 年分段、跨段去重、并入统一索引', async () => {
  const routes = medRoutes((ys, ye) => {
    if (ye === Y) return resJson([MED_1]);
    if (ys === Y - 2) return resJson([MED_2, MED_1]);   // MED_1 跨段重复 → 按 IdOrdonnance 去重
    return resJson([]);
  });
  const srv = makeFetch(routes);
  const downloads = [];
  const summary = await pipeline.runSweep(
    baseJob({ sections: { labs: false, imaging: false, meds: true }, startYear: Y - 6 }),
    makeEnv(srv.fetchImpl, downloads, new Map(), {})
  );

  assert.deepStrictEqual(summary.stats.meds, { found: 2, downloaded: 2, skipped: 0, failed: 0 });

  // CSV 快照：BOM、表头、按日期升序、null 剩余次数留空
  const csv = downloads.find((d) => d.filename.startsWith('Carnet santé/Médications/ordonnances-') && d.filename.endsWith('.csv'));
  assert.ok(csv, downloads.map((d) => d.filename).join(', '));
  assert.strictEqual(csv.bytes[0], 0xef);   // Excel 兼容 BOM
  const csvText = new TextDecoder().decode(csv.bytes);
  assert.ok(csvText.startsWith('date,medicament,din,classe,posologie,prescripteur,pharmacie,duree,'));
  const i1 = csvText.indexOf('AMOXIL'), i2 = csvText.indexOf('Préparation magistrale');
  assert.ok(i1 > 0 && i2 > 0 && i2 < i1, '按日期升序：Y-1 的处方应在 Y 之前');
  assert.ok(csvText.includes('1 comprimé 3 fois par jour ; pendant 7 jours'));
  assert.ok(csvText.includes('delivrancesRestantes,dernierServiceDate'));   // 表头含剩余次数/末次配药
  assert.ok(csvText.includes(',Pharmaprix Centre'));

  // JSON 快照：分年份计数 + 完整字段
  const json = downloads.find((d) => d.filename.endsWith('.json') && d.filename.includes('ordonnances-'));
  assert.ok(json);
  const snap = JSON.parse(new TextDecoder().decode(json.bytes));
  assert.strictEqual(snap.total, 2);
  assert.deepStrictEqual(snap.parAnnee, { [Y - 1]: 1, [Y]: 1 });
  assert.strictEqual(snap.ordonnances[1].din, '02239630');
  assert.strictEqual(snap.ordonnances[1].dernierServiceDate, `${Y}-04-01`);
  assert.strictEqual(snap.ordonnances[0].delivrancesRestantes, '');

  // 处方行并入统一 index.csv
  const index = downloads.find((d) => /index-.*\.csv$/.test(d.filename));
  const indexText = new TextDecoder().decode(index.bytes);
  assert.ok(indexText.includes('médications'));
  assert.ok(indexText.includes('delivrances 2/5'));

  // 每段一次列表请求，无逐条详情请求
  const medCalls = srv.calls.filter((c) => c.url.includes('/Medications?'));
  assert.strictEqual(medCalls.length, 4);   // (Y-6,Y-5)(Y-4,Y-3)(Y-2,Y-1)(Y,Y)
});

test('Médications：仅扫描不写任何文件', async () => {
  const srv = makeFetch(medRoutes((ys, ye) => resJson(ye === Y ? [MED_1] : [])));
  const downloads = [];
  const summary = await pipeline.runSweep(
    baseJob({ sections: { labs: false, imaging: false, meds: true }, dryRun: true, startYear: Y - 1 }),
    Object.assign(makeEnv(srv.fetchImpl, downloads, new Map(), {}), {
      downloadFn: async () => ({ ok: true, dryRun: true }),
    })
  );
  assert.strictEqual(downloads.length, 0);
  assert.strictEqual(summary.stats.meds.found, 1);
  assert.strictEqual(summary.stats.meds.downloaded, 1);
  assert.ok(!summary.files.some((f) => f.includes('ordonnances-')));
});

test('Médications：earliest 收紧起始年，不查询更早区间', async () => {
  const srv = makeFetch(medRoutes((ys) => (ys >= Y - 1 ? resJson([MED_1]) : resJson({}, 500))));
  const summary = await pipeline.runSweep(
    baseJob({ sections: { labs: false, imaging: false, meds: true }, startYear: Y - 6, earliest: { meds: Y - 1 } }),
    makeEnv(srv.fetchImpl, [], new Map(), {})
  );
  assert.strictEqual(summary.stats.meds.downloaded, 1);
  assert.strictEqual(summary.errors.length, 0);
  for (const c of srv.calls) {
    if (c.url.includes('/Medications?')) assert.ok(yearOf(c.url) >= Y - 1, '不应查询早于最早数据的年份: ' + c.url);
  }
});

test('Médications：列表整体失败 → 记错误、不写快照、found=0', async () => {  const srv = makeFetch(medRoutes(() => resJson({}, 500)));
  const downloads = [];
  const summary = await pipeline.runSweep(
    baseJob({ sections: { labs: false, imaging: false, meds: true }, startYear: Y - 1 }),
    makeEnv(srv.fetchImpl, downloads, new Map(), {})
  );
  assert.deepStrictEqual(summary.stats.meds, { found: 0, downloaded: 0, skipped: 0, failed: 0 });
  assert.ok(summary.errors.some((e) => e.section === 'meds' && /range/.test(e.id)));
  assert.ok(!downloads.some((d) => d.filename.includes('ordonnances-')));
});

test('probeEarliest：meds 逐年后退探测（数据后连续两空年即停）', async () => {
  const routes = medRoutes((ys) => resJson(ys === Y || ys === Y - 1 ? [MED_1] : [])).concat([
    { match: (u) => u.endsWith('/PrelevementsAccessibles'), reply: () => resJson({}, 403) },   // labs 未开放
    { match: (u) => u.includes('/ExamensImagerie?'), reply: () => resJson([]) },               // imaging 无数据
  ]);
  const srv = makeFetch(routes);
  const r = await pipeline.probeEarliest({ token: 'T' }, earliestEnv(srv.fetchImpl, new Map()));
  assert.strictEqual(r.meds, Y - 1);
  assert.strictEqual(r.labs, null);
  assert.strictEqual(r.imaging, null);
  const medYears = srv.calls.filter((c) => c.url.includes('/Medications?')).map((c) => yearOf(c.url));
  assert.strictEqual(Math.min(...medYears), Y - 3);   // Y-2、Y-3 两空年后停
  assert.ok(!medYears.includes(Y - 4));
});

/* ---------- 写盘边界：内容脚本用 data URL 传给 SW，SW 再解码 ---------- */

test('每个写盘项都能通过 data URL 边界（含 CSV 的 charset 参数）', async () => {
  // 回归：text/csv;charset=utf-8 曾被 parseDataUrl 判为无效 → SW 写入所选文件夹失败并静默回退下载目录
  const srv = makeFetch(defaultRoutes.concat(medRoutes(() => resJson([MED_1]))));
  const downloads = [];
  const summary = await pipeline.runSweep(
    baseJob({ sections: { labs: true, imaging: true, meds: true } }),
    makeEnv(srv.fetchImpl, downloads, new Map(), {})
  );
  assert.ok(summary.stats.meds.downloaded > 0);
  assert.ok(downloads.length >= 4, '应有 PDF、CSV、JSON 三类写盘项');
  for (const d of downloads) {
    const parsed = core.parseDataUrl(core.bytesToDataUrl(d.bytes, d.mime));
    assert.ok(parsed, 'data URL 无法解析（mime=' + d.mime + ', file=' + d.filename + '）');
    assert.deepStrictEqual(Array.from(parsed.bytes), Array.from(d.bytes), '字节在边界处不一致: ' + d.filename);
  }
  assert.ok(downloads.some((d) => /\.csv$/.test(d.filename) && /charset=utf-8/.test(d.mime)));
});

test('Médications：写盘返回失败时计为失败并记错误（不静默成功）', async () => {
  const srv = makeFetch(medRoutes(() => resJson([MED_1])));
  const summary = await pipeline.runSweep(
    baseJob({ sections: { labs: false, imaging: false, meds: true }, startYear: Y - 1 }),
    Object.assign(makeEnv(srv.fetchImpl, [], new Map(), {}), {
      downloadFn: async () => ({ ok: false, error: 'FSA denied' }),
    })
  );
  assert.strictEqual(summary.stats.meds.downloaded, 0);
  assert.ok(summary.stats.meds.failed > 0);
  assert.ok(summary.errors.some((e) => e.section === 'meds' && e.error.includes('FSA denied')));
  assert.deepStrictEqual(summary.files, []);
});
