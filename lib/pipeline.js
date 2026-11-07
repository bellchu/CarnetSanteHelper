/*
 * Carnet santé Helper — 扫描/下载编排流水线
 * 依赖注入（fetchImpl / downloadFn / store / sleep / progress…），
 * 同一份代码在内容脚本（真实浏览器）与 Node 测试（模拟 API）中运行。
 *
 * 端点结构来自对门户私有 /api/1 的逆向观察（见 README「工作原理」）：
 *  - 影像：ExamensImagerie 列表 → DetailRapport 元数据 → .../Rapport PDF 二进制
 *  - 化验：Prelevements 按年列出 → /Rapports 的 JSON 内嵌 base64 PDF
 */
'use strict';
(function (global) {
  const core = (typeof require === 'function' && typeof module !== 'undefined' && module.exports)
    ? require('./core.js')
    : global.CSHCore;

  const API = {
    www: 'https://www.carnetsante.gouv.qc.ca',
    labs: 'https://ais-passerelle-autorisation-api.ramq.gouv.qc.ca',
  };

  class ApiError extends Error {
    constructor(url, status) {
      super('HTTP ' + status + ' ' + url);
      this.status = status;
    }
  }
  class CancelledError extends Error {
    constructor() { super('cancelled'); }
  }

  /**
   * job:   { sections:{labs,imaging}, startYear, endYear, dryRun, token, options }
   * env:   { fetchImpl(url,init), downloadFn({bytes,mime,filename})->{ok,error},
   *          store:{get(k),set(k,v)}, sleep(ms), log(level,msg),
   *          progress(stage,payload), refresh()->token, isCancelled() }
   * 返回 summary { imaging, labs, files, rows, errors, cancelled }
   */
  async function runSweep(job, env) {
    const opt = Object.assign({}, core.DEFAULTS, job.options || {});
    if (!job.sections) job.sections = { labs: true, imaging: true };
    job.sections = Object.assign({ labs: false, imaging: false }, job.sections);

    const state = {
      startedAt: new Date().toISOString(),
      rows: [], files: [], errors: [], citizen: null,
      stats: { imaging: mkStats(), labs: mkStats() },
    };
    function mkStats() { return { found: 0, downloaded: 0, skipped: 0, failed: 0 }; }

    const isCancelled = env.isCancelled || function () { return false; };
    const sleep = env.sleep || function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
    const log = env.log || function () {};

    async function api(url, opts) {
      opts = opts || {};
      const call = function (tok) {
        return env.fetchImpl(url, {
          headers: {
            Authorization: 'Bearer ' + tok,
            Accept: opts.binary ? 'application/pdf' : 'application/json',
          },
          credentials: 'include',
        });
      };
      let res = await call(job.token);
      if ((res.status === 401 || res.status === 403) && env.refresh) {
        const fresh = await env.refresh();
        if (fresh && fresh !== job.token) {
          job.token = fresh;
          res = await call(job.token);
        }
      }
      if (!res.ok) throw new ApiError(url, res.status);
      if (opts.binary) return new Uint8Array(await res.arrayBuffer());
      if (res.status === 204) return null;
      const text = await res.text();
      return text ? JSON.parse(text) : null;
    }

    const storeKey = function (k) {
      return 'dedup:' + ((state.citizen && state.citizen.IdCitoyen) || 'anon') + ':' + k;
    };
    async function already(key) {
      return !!(opt.dedupe && (await env.store.get(storeKey(key))));
    }
    async function mark(key) {
      await env.store.set(storeKey(key), new Date().toISOString());
    }

    async function saveFile(bytes, mime, filename, row) {
      if (isCancelled()) throw new CancelledError();
      const r = await env.downloadFn({ bytes: bytes, mime: mime, filename: filename });
      if (!r || r.ok === false) throw new Error((r && r.error) || 'download failed');
      state.files.push(filename);
      if (row) {
        row.filename = filename;
        row.downloadedAt = new Date().toISOString();
        state.rows.push(row);
      }
    }

    env.progress('start', {});
    state.citizen = await api(API.www + '/api/1/Citoyens');
    const cid = state.citizen.IdCitoyen;
    env.progress('citizen', {
      name: ((state.citizen.Prenom || '') + ' ' + (state.citizen.Nom || '')).trim(),
      id: cid,
    });
    log('info', 'citizen ' + cid);

    let cancelled = false;
    try {
      if (job.sections.imaging) await sweepImaging();
    } catch (e) {
      if (e instanceof CancelledError) cancelled = true; else throw e;
    }
    if (!cancelled) {
      try {
        if (job.sections.labs) await sweepLabs();
      } catch (e) {
        if (e instanceof CancelledError) cancelled = true; else throw e;
      }
    }
    if (!cancelled && opt.writeIndex && !job.dryRun && state.files.length) {
      try { await writeIndex(); } catch (e) { state.errors.push({ section: 'index', error: e.message }); }
    }

    const summary = {
      stats: state.stats,
      files: state.files,
      rows: state.rows,
      errors: state.errors,
      citizen: { name: ((state.citizen.Prenom || '') + ' ' + (state.citizen.Nom || '')).trim(), id: cid },
      cancelled: cancelled,
    };
    env.progress('done', { summary: summary });
    return summary;

    /* ---------- 影像 ---------- */
    async function sweepImaging() {
      const st = state.stats.imaging;
      env.progress('section', { section: 'imaging' });
      const ranges = core.buildRanges(job.startYear, job.endYear, 5, false); // 单段 ≤5 年（API 上限约 6 年）
      let exams = [];
      for (const r of ranges) {
        const arr = await api(API.www + '/api/1/Citoyens/' + cid + '/ExamensImagerie?DateDebut=' + r.from + '&DateFin=' + r.to) || [];
        exams = exams.concat(arr);
      }
      const seen = new Set();
      exams = exams.filter(function (e) {
        return e && e.NumeroExamen && !seen.has(e.NumeroExamen) && (seen.add(e.NumeroExamen), true);
      });
      env.progress('list', { section: 'imaging', total: exams.length });
      log('info', 'imaging exams: ' + exams.length);

      for (const exam of exams) {
        let reports;
        try {
          reports = await api(API.www + '/api/1/Citoyens/' + cid + '/ExamenImagerie/' +
            encodeURIComponent(exam.NumeroExamen) + '/DetailRapport') || [];
        } catch (e) {
          state.errors.push({ section: 'imaging', id: exam.NumeroExamen, error: e.message });
          continue;
        }
        if (!Array.isArray(reports)) reports = [];
        for (const rep of reports) {
          if (!rep || !rep.IdRapport) continue;
          st.found++;
          const key = 'imaging:' + exam.NumeroExamen + ':' + rep.IdRapport;
          try {
            if (await already(key)) { st.skipped++; continue; }
            const bytes = await api(API.www + '/api/1/Citoyens/' + cid + '/ExamenImagerie/' +
              encodeURIComponent(exam.NumeroExamen) + '/DetailRapport/' +
              encodeURIComponent(rep.IdRapport) + '/Rapport', { binary: true });
            const date = core.fmtDate(rep.DateRapport || exam.DateExamen);
            const prescriber = [exam.PrenomPrescripteur, exam.NomPrescripteur].filter(Boolean).join(' ');
            const filename = core.folderPath(opt.rootFolder, opt.imagingFolder) + '/' +
              core.buildFilename(opt.template, {
                date: date, label: exam.DescriptionExamen, prescriber: prescriber,
                section: opt.imagingFolder, id: rep.IdRapport, year: date.slice(0, 4),
              }, 'examen-' + date);
            const row = {
              section: 'imagerie', date: date, label: exam.DescriptionExamen || '', prescriber: prescriber,
              status: rep.Statut || '', dateRapport: core.fmtDate(rep.DateRapport),
              sourceId: exam.NumeroExamen + '/' + rep.IdRapport, filename: '', downloadedAt: '',
            };
            await saveFile(bytes, 'application/pdf', filename, row);
            st.downloaded++;
            env.progress('item', { section: 'imaging', file: filename, done: st.downloaded, total: st.found });
            if (!job.dryRun) await mark(key);   // 仅扫描不写去重记录
          } catch (e) {
            if (e instanceof CancelledError) throw e;
            st.failed++;
            state.errors.push({ section: 'imaging', id: key, error: e.message });
          }
          await sleep(opt.delayMs);
        }
      }
    }

    /* ---------- 化验（Prélèvements） ---------- */
    async function sweepLabs() {
      const st = state.stats.labs;
      env.progress('section', { section: 'labs' });
      try {
        await api(API.labs + '/api/1/Prelevement/Citoyens/' + cid + '/PrelevementsAccessibles');
      } catch (e) {
        // 功能开关未开放不算致命：记录后跳过该板块
        state.errors.push({ section: 'labs', id: 'gate', error: e.message });
        log('warn', 'PrelevementsAccessibles failed: ' + e.message);
        env.progress('labsGateOff', {});
        return;
      }
      const ranges = core.buildRanges(job.startYear, job.endYear, 1, true); // 逐年（YYYY-MM-DD）
      let items = [];
      for (const r of ranges) {
        try {
          const arr = await api(API.labs + '/api/1/Prelevement/Citoyens/' + cid +
            '/Prelevements?DateDebut=' + r.from + '&DateFin=' + r.to) || [];
          items = items.concat(arr);
        } catch (e) {
          state.errors.push({ section: 'labs', id: 'range ' + r.from, error: e.message });
        }
      }
      const seen = new Set();
      items = items.filter(function (it) {
        return it && it.id && !seen.has(it.id) && (seen.add(it.id), true);
      });
      env.progress('list', { section: 'labs', total: items.length });
      log('info', 'labs samples: ' + items.length);

      for (const item of items) {
        let payload = null;
        try {
          payload = await api(API.labs + '/api/1/Prelevement/Citoyens/' + cid +
            '/Prelevements/' + encodeURIComponent(item.id) + '/Rapports');
        } catch (e) {
          st.found++; st.failed++;
          state.errors.push({ section: 'labs', id: item.id, error: e.message });
          await sleep(opt.delayMs);
          continue;
        }
        const pdfs = core.findEmbeddedPdfs(payload);
        const label = core.findLabel(payload) || 'Prélèvement';
        const date = core.fmtDate(item.datePrelevement);
        const prescriber = [item.prenomPrescripteur, item.nomPrescripteur].filter(Boolean).join(' ');
        st.found += Math.max(pdfs.length, 1);
        if (!pdfs.length) {
          st.failed++;
          state.errors.push({ section: 'labs', id: item.id, error: 'no embedded PDF' });
          await sleep(opt.delayMs);
          continue;
        }
        for (let i = 0; i < pdfs.length; i++) {
          const key = 'labs:' + item.id + ':' + i;
          try {
            if (await already(key)) { st.skipped++; continue; }
            const lbl = pdfs.length > 1 ? label + ' (' + (i + 1) + ')' : label;
            const filename = core.folderPath(opt.rootFolder, opt.labsFolder) + '/' +
              core.buildFilename(opt.template, {
                date: date, label: lbl, prescriber: prescriber,
                section: opt.labsFolder, id: item.id, year: date.slice(0, 4),
              }, 'prelevement-' + date);
            const row = {
              section: 'prélèvements', date: date, label: lbl, prescriber: prescriber,
              status: item.statutRapport || '', dateRapport: core.fmtDate(item.dateDisponibiliteResultatAnalyse),
              sourceId: item.id + '#' + i, filename: '', downloadedAt: '',
            };
            await saveFile(pdfs[i], 'application/pdf', filename, row);
            st.downloaded++;
            env.progress('item', { section: 'labs', file: filename, done: st.downloaded, total: st.found });
            if (!job.dryRun) await mark(key);   // 仅扫描不写去重记录
          } catch (e) {
            if (e instanceof CancelledError) throw e;
            st.failed++;
            state.errors.push({ section: 'labs', id: key, error: e.message });
          }
          await sleep(opt.delayMs);
        }
      }
    }

    /* ---------- 汇总清单 ---------- */
    async function writeIndex() {
      const headers = ['section', 'date', 'label', 'prescriber', 'status', 'dateRapport', 'sourceId', 'filename', 'downloadedAt'];
      const csv = core.buildCsv(headers, state.rows.map(function (r) {
        const o = {};
        headers.forEach(function (h) { o[h] = r[h] || ''; });
        return o;
      }));
      const stamp = fmtStamp(new Date());
      await env.downloadFn({
        bytes: core.strToBytes('\uFEFF' + csv),
        mime: 'text/csv;charset=utf-8',
        filename: core.folderPath(opt.rootFolder) + '/index-' + stamp + '.csv',
      });
      const json = JSON.stringify({
        generatedAt: new Date().toISOString(),
        citizen: summaryCitizen(),
        options: { rootFolder: opt.rootFolder, labsFolder: opt.labsFolder, imagingFolder: opt.imagingFolder, template: opt.template },
        stats: state.stats,
        rows: state.rows,
        errors: state.errors,
      }, null, 2);
      await env.downloadFn({
        bytes: core.strToBytes(json),
        mime: 'application/json',
        filename: core.folderPath(opt.rootFolder) + '/donnees-' + stamp + '.json',
      });
    }
    function summaryCitizen() {
      return {
        name: ((state.citizen.Prenom || '') + ' ' + (state.citizen.Nom || '')).trim(),
        id: cid,
      };
    }
  }

  function fmtStamp(d) {
    function p(n) { return n < 10 ? '0' + n : String(n); }
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
  }

  const exports_ = { runSweep: runSweep, API: API, ApiError: ApiError, CancelledError: CancelledError };
  if (typeof module !== 'undefined' && module.exports) module.exports = exports_;
  global.CSHPipeline = exports_;
})(typeof self !== 'undefined' ? self : globalThis);
