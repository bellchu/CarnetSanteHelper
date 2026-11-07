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

    // API 基址：优先页面自身 origin（同源、无跨域预检），失败再试 www 域
    const wwwCandidates = [];
    if (job.apiBase && job.apiBase !== API.www) wwwCandidates.push(job.apiBase);
    if (wwwCandidates.indexOf(API.www) === -1) wwwCandidates.push(API.www);
    let wwwBase = wwwCandidates[0];

    async function api(url, opts) {
      opts = opts || {};
      // 请求级超时 + 取消中止（env.signal 由内容脚本的取消动作触发）
      const timeoutMs = opts.binary ? 180000 : 90000;
      let signal = null;
      if (typeof AbortSignal !== 'undefined') {
        const t = AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : null;
        if (env.signal && AbortSignal.any && t) signal = AbortSignal.any([env.signal, t]);
        else signal = env.signal || t;
      }
      const call = function (tok) {
        return env.fetchImpl(url, {
          headers: {
            Authorization: 'Bearer ' + tok,
            Accept: opts.binary ? 'application/pdf' : 'application/json',
          },
          credentials: 'include',
          signal: signal,
        });
      };
      let res;
      try {
        res = await call(job.token);
        if ((res.status === 401 || res.status === 403) && env.refresh) {
          const fresh = await env.refresh();
          if (fresh && fresh !== job.token) {
            job.token = fresh;
            res = await call(job.token);
          }
        }
      } catch (e) {
        if (isCancelled()) throw new CancelledError();   // 取消引发的中止
        const err = new Error('network/timeout ' + url);
        err.status = 0;                                  // 网络错误/超时，不做范围二分重试
        throw err;
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

    /* 自适应列表查询：服务端 400/500 时先换日期补零格式重试，
       仍失败则按年份二分缩小范围；单年仍失败才抛给调用方记录。 */
    const isRetryableStatus = function (s) { return s === 400 || s === 500 || s === 502 || s === 504; };
    function rangeDates(ys, ye, padded) {
      const today = new Date();
      return {
        from: core.fmtApiDate(new Date(ys, 0, 1), padded),
        to: ye === today.getFullYear()
          ? core.fmtApiDate(new Date(today.getFullYear(), today.getMonth(), today.getDate()), padded)
          : core.fmtApiDate(new Date(ye, 11, 31), padded),
      };
    }
    async function queryListAdaptive(fn, ys, ye, padded) {
      if (isCancelled()) throw new CancelledError();
      const d = rangeDates(ys, ye, padded);
      try {
        const arr = await fn(d.from, d.to);
        return Array.isArray(arr) ? arr : [];
      } catch (e1) {
        if (!isRetryableStatus(e1 && e1.status)) throw e1;
        log('warn', '区间 ' + ys + '-' + ye + ' HTTP ' + e1.status + '，换日期格式重试');
        try {
          const d2 = rangeDates(ys, ye, !padded);
          const arr2 = await fn(d2.from, d2.to);
          return Array.isArray(arr2) ? arr2 : [];
        } catch (e2) {
          if (!isRetryableStatus(e2 && e2.status)) throw e2;
          if (ye > ys) {
            log('warn', '区间 ' + ys + '-' + ye + ' 二分重试');
            const mid = Math.floor((ys + ye) / 2);
            const a = await queryListAdaptive(fn, ys, mid, padded);
            const b = await queryListAdaptive(fn, mid + 1, ye, padded);
            return a.concat(b);
          }
          throw e2;
        }
      }
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
    let lastErr = null;
    try {
      for (const b of wwwCandidates) {
        try {
          state.citizen = await api(b + '/api/1/Citoyens');
          wwwBase = b;
          break;
        } catch (e) {
          if (e instanceof CancelledError) throw e;
          lastErr = e;
        }
      }
    } catch (e) {
      if (e instanceof CancelledError) {
        const early = {
          stats: state.stats, files: [], rows: [], errors: [],
          citizen: { name: '', id: '' }, cancelled: true,
        };
        env.progress('done', { summary: early });
        return early;
      }
      throw e;
    }
    if (!state.citizen) throw (lastErr || new Error('cannot reach portal API'));
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
      const lastYear = Math.min(job.endYear, new Date().getFullYear());
      let exams = [];
      for (let chunkStart = job.startYear; chunkStart <= lastYear; chunkStart += 5) {
        const chunkEnd = Math.min(chunkStart + 4, lastYear);
        env.progress('listwait', { section: 'imaging', from: chunkStart, to: chunkEnd });   // 心跳
        try {
          const arr = await queryListAdaptive(function (from, to) {
            return api(wwwBase + '/api/1/Citoyens/' + cid + '/ExamensImagerie?DateDebut=' + from + '&DateFin=' + to);
          }, chunkStart, chunkEnd, false);
          exams = exams.concat(arr);
        } catch (e) {
          if (e instanceof CancelledError) throw e;
          state.errors.push({ section: 'imaging', id: 'range ' + chunkStart + '-' + chunkEnd, error: e.message });
        }
      }
      const seen = new Set();
      exams = exams.filter(function (e) {
        return e && e.NumeroExamen && !seen.has(e.NumeroExamen) && (seen.add(e.NumeroExamen), true);
      });
      env.progress('list', { section: 'imaging', total: exams.length });
      log('info', 'imaging exams: ' + exams.length);

      for (let ei = 0; ei < exams.length; ei++) {
        const exam = exams[ei];
        if (isCancelled()) throw new CancelledError();
        env.progress('itemwait', { section: 'imaging', i: ei + 1, n: exams.length, label: exam.DescriptionExamen || '' });
        let reports;
        try {
          reports = await api(wwwBase + '/api/1/Citoyens/' + cid + '/ExamenImagerie/' +
            encodeURIComponent(exam.NumeroExamen) + '/DetailRapport') || [];
        } catch (e) {
          if (e instanceof CancelledError) throw e;
          state.errors.push({ section: 'imaging', id: exam.NumeroExamen, error: e.message });
          continue;
        }
        if (!Array.isArray(reports)) reports = [];
        for (const rep of reports) {
          if (!rep || !rep.IdRapport) continue;
          st.found++;
          const key = 'imaging:' + exam.NumeroExamen + ':' + rep.IdRapport;
          const date = core.fmtDate(rep.DateRapport || exam.DateExamen);
          const prescriber = [exam.PrenomPrescripteur, exam.NomPrescripteur].filter(Boolean).join(' ');
          const filename = core.folderPath(opt.rootFolder, opt.imagingFolder) + '/' +
            core.buildFilename(opt.template, {
              date: date, label: exam.DescriptionExamen, prescriber: prescriber,
              section: opt.imagingFolder, id: rep.IdRapport, year: date.slice(0, 4),
            }, 'examen-' + date);
          try {
            if (await already(key)) {
              st.skipped++;
              env.progress('item', { section: 'imaging', file: filename, skip: true });
              env.progress('stats', {
                section: 'imaging', found: st.found, downloaded: st.downloaded,
                skipped: st.skipped, failed: st.failed,
              });
              continue;
            }
            // 仅扫描模式不拉取 PDF 本体
            const bytes = job.dryRun ? new Uint8Array() : await api(wwwBase + '/api/1/Citoyens/' + cid + '/ExamenImagerie/' +
              encodeURIComponent(exam.NumeroExamen) + '/DetailRapport/' +
              encodeURIComponent(rep.IdRapport) + '/Rapport', { binary: true });
            const row = {
              section: 'imagerie', date: date, label: exam.DescriptionExamen || '', prescriber: prescriber,
              status: rep.Statut || '', dateRapport: core.fmtDate(rep.DateRapport),
              sourceId: exam.NumeroExamen + '/' + rep.IdRapport, filename: '', downloadedAt: '',
            };
            await saveFile(bytes, 'application/pdf', filename, row);
            st.downloaded++;
            env.progress('item', { section: 'imaging', file: filename });
            if (!job.dryRun) await mark(key);   // 仅扫描不写去重记录
          } catch (e) {
            if (e instanceof CancelledError) throw e;
            st.failed++;
            env.progress('item', { section: 'imaging', file: filename, fail: true, error: e.message });
            state.errors.push({ section: 'imaging', id: key, error: e.message });
          }
          env.progress('stats', {
            section: 'imaging', found: st.found, downloaded: st.downloaded,
            skipped: st.skipped, failed: st.failed,
          });
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
      const lastYear = Math.min(job.endYear, new Date().getFullYear());
      let items = [];
      for (let ys = job.startYear; ys <= lastYear; ys++) {
        env.progress('listwait', { section: 'labs', from: ys, to: ys });   // 心跳
        try {
          const arr = await queryListAdaptive(function (from, to) {
            return api(API.labs + '/api/1/Prelevement/Citoyens/' + cid +
              '/Prelevements?DateDebut=' + from + '&DateFin=' + to);
          }, ys, ys, true);
          items = items.concat(arr);
        } catch (e) {
          if (e instanceof CancelledError) throw e;
          state.errors.push({ section: 'labs', id: 'range ' + ys, error: e.message });
        }
      }
      const seen = new Set();
      items = items.filter(function (it) {
        return it && it.id && !seen.has(it.id) && (seen.add(it.id), true);
      });
      env.progress('list', { section: 'labs', total: items.length });
      log('info', 'labs samples: ' + items.length);

      for (let idx = 0; idx < items.length; idx++) {
        const item = items[idx];
        // 整条已完成过（全部 PDF 已下载）→ 零网络快速跳过
        const itemKey = 'labsItem:' + item.id;
        if (opt.dedupe) {
          if (isCancelled()) throw new CancelledError();
          const nDone = await env.store.get(storeKey(itemKey));
          if (nDone) {
            const n = parseInt(nDone, 10) || 1;
            st.found += n;
            st.skipped += n;
            env.progress('item', {
              section: 'labs', file: core.fmtDate(item.datePrelevement) || item.id,
              skip: true, n: n,
            });
            env.progress('stats', {
              section: 'labs', found: st.found, downloaded: st.downloaded,
              skipped: st.skipped, failed: st.failed,
            });
            continue;
          }
        }
        env.progress('itemwait', {
          section: 'labs', i: idx + 1, n: items.length,
          label: core.fmtDate(item.datePrelevement) || item.id,
        });
        let payload = null;
        try {
          payload = await api(API.labs + '/api/1/Prelevement/Citoyens/' + cid +
            '/Prelevements/' + encodeURIComponent(item.id) + '/Rapports');
        } catch (e) {
          if (e instanceof CancelledError) throw e;
          st.found++; st.failed++;
          env.progress('item', { section: 'labs', file: item.id, fail: true, error: e.message });
          state.errors.push({ section: 'labs', id: item.id, error: e.message });
          env.progress('stats', {
            section: 'labs', found: st.found, downloaded: st.downloaded,
            skipped: st.skipped, failed: st.failed,
          });
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
          env.progress('item', { section: 'labs', file: item.id, fail: true, error: 'no embedded PDF' });
          state.errors.push({ section: 'labs', id: item.id, error: 'no embedded PDF' });
          env.progress('stats', {
            section: 'labs', found: st.found, downloaded: st.downloaded,
            skipped: st.skipped, failed: st.failed,
          });
          await sleep(opt.delayMs);
          continue;
        }
        let itemFailures = 0;
        for (let i = 0; i < pdfs.length; i++) {
          const key = 'labs:' + item.id + ':' + i;
          const lbl = pdfs.length > 1 ? label + ' (' + (i + 1) + ')' : label;
          const filename = core.folderPath(opt.rootFolder, opt.labsFolder) + '/' +
            core.buildFilename(opt.template, {
              date: date, label: lbl, prescriber: prescriber,
              section: opt.labsFolder, id: item.id, year: date.slice(0, 4),
            }, 'prelevement-' + date);
          try {
            if (await already(key)) {
              st.skipped++;
              env.progress('item', { section: 'labs', file: filename, skip: true });
              env.progress('stats', {
                section: 'labs', found: st.found, downloaded: st.downloaded,
                skipped: st.skipped, failed: st.failed,
              });
              continue;
            }
            const row = {
              section: 'prélèvements', date: date, label: lbl, prescriber: prescriber,
              status: item.statutRapport || '', dateRapport: core.fmtDate(item.dateDisponibiliteResultatAnalyse),
              sourceId: item.id + '#' + i, filename: '', downloadedAt: '',
            };
            await saveFile(pdfs[i], 'application/pdf', filename, row);
            st.downloaded++;
            env.progress('item', { section: 'labs', file: filename });
            if (!job.dryRun) await mark(key);   // 仅扫描不写去重记录
          } catch (e) {
            if (e instanceof CancelledError) throw e;
            st.failed++;
            itemFailures++;
            env.progress('item', { section: 'labs', file: filename, fail: true, error: e.message });
            state.errors.push({ section: 'labs', id: key, error: e.message });
          }
          env.progress('stats', {
            section: 'labs', found: st.found, downloaded: st.downloaded,
            skipped: st.skipped, failed: st.failed,
          });
          await sleep(opt.delayMs);
        }
        // 本条全部 PDF 成功 → 写整条标记，下次运行零网络跳过
        if (!job.dryRun && itemFailures === 0) {
          await env.store.set(storeKey(itemKey), String(pdfs.length));
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
