/*
 * Carnet santé Helper — 共享纯逻辑
 * 无浏览器/扩展 API 依赖，可在 Node 中直接测试。
 * 同时以全局 CSHCore（内容脚本/页面）与 module.exports（Node require）两种方式导出。
 */
'use strict';
(function (global) {

  const DEFAULTS = {
    rootFolder: 'Carnet santé',
    labsFolder: 'Prélèvements',
    imagingFolder: 'Imagerie médicale',
    template: '{date} - {label}',
    delayMs: 400,          // 每份报告之间的间隔（毫秒），对站点友好
    dedupe: true,          // 跳过已下载过的报告
    writeIndex: true,      // 生成 index.csv 与 donnees.json
    lang: 'zh',
    yearsBack: 6,          // 默认回溯年数（影像 API 单次跨度上限约 6 年）
  };

  /* ---------- 文件名 ---------- */

  function sanitizeSegment(name, maxLen) {
    if (maxLen == null) maxLen = 100;
    let s = String(name == null ? '' : name)
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[. ]+$/, '')
      .trim();
    if (s.length > maxLen) s = s.slice(0, maxLen).replace(/[. ]+$/, '').trim();
    return s;
  }

  function folderPath() {
    const parts = Array.prototype.slice.call(arguments);
    return parts.map(function (p) { return sanitizeSegment(p, 80); }).filter(Boolean).join('/');
  }

  // 浏览器下载 API 只接受相对默认下载目录的路径：
  // 统一分隔符、剥掉盘符/前导斜杠、丢弃越界段（..），返回安全的相对路径
  function safeRelativePath(p) {
    if (p == null) return '';
    const s = String(p).replace(/\\/g, '/').replace(/^[A-Za-z]:/, '');
    const segs = [];
    for (const seg of s.split('/')) {
      const t = seg.trim();
      if (!t || t === '.') continue;
      if (t === '..') { segs.pop(); continue; }
      segs.push(t);
    }
    return segs.join('/');
  }

  function renderTemplate(tpl, vars) {
    const out = String(tpl || '').replace(/\{(\w+)\}/g, function (m, k) {
      const v = vars[k];
      return v == null || v === '' ? '' : String(v);
    });
    return out
      .replace(/\s*-\s*-\s*/g, ' - ')   // 变量为空时避免 "2024 - - "
      .replace(/\s+/g, ' ')
      .replace(/(^[\s-]+|[\s-]+$)/g, '')
      .trim();
  }

  function buildFilename(tpl, vars, fallback) {
    let name = sanitizeSegment(renderTemplate(tpl, vars), 120);
    if (!name) name = sanitizeSegment(fallback || 'rapport', 120) || 'rapport';
    if (!/\.pdf$/i.test(name)) name += '.pdf';
    return name;
  }

  /* ---------- 日期 ---------- */

  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  function parseDate(v) {
    if (v instanceof Date) return v;
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return new Date(v.slice(0, 10) + 'T00:00:00');
    return null;
  }

  function fmtDate(v) {
    const d = parseDate(v);
    return d ? d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) : '';
  }

  // 实验室端点要求 YYYY-MM-DD（补零），其余端点要求 YYYY-M-D（不补零）
  function fmtApiDate(d, padded) {
    return d.getFullYear() + '-' + (padded ? pad2(d.getMonth() + 1) : String(d.getMonth() + 1)) +
      '-' + (padded ? pad2(d.getDate()) : String(d.getDate()));
  }

  // 把 [startYear, endYear] 切成不超过 maxSpan 年的段；最后一段截止到今天。
  function buildRanges(startYear, endYear, maxSpan, padded, today) {
    if (!today) today = new Date();
    const lastYear = Math.min(endYear, today.getFullYear());
    const ranges = [];
    for (let ys = startYear; ys <= lastYear; ys += maxSpan) {
      const ye = Math.min(ys + maxSpan - 1, lastYear);
      const from = new Date(ys, 0, 1);
      const to = ye === today.getFullYear()
        ? new Date(today.getFullYear(), today.getMonth(), today.getDate())
        : new Date(ye, 11, 31);
      ranges.push({ from: fmtApiDate(from, padded), to: fmtApiDate(to, padded), years: [ys, ye] });
    }
    return ranges;
  }

  /* ---------- base64 / 字节 ---------- */

  const B64A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const B64M = (function () {
    const m = {};
    for (let i = 0; i < B64A.length; i++) m[B64A[i]] = i;
    return m;
  })();

  function bytesToBase64(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
      const b0 = bytes[i], b1 = bytes[i + 1], b2 = bytes[i + 2];
      out += B64A[b0 >> 2];
      out += B64A[((b0 & 3) << 4) | (b1 === undefined ? 0 : b1 >> 4)];
      out += b1 === undefined ? '=' : B64A[((b1 & 15) << 2) | (b2 === undefined ? 0 : b2 >> 6)];
      out += b2 === undefined ? '=' : B64A[b2 & 63];
    }
    return out;
  }

  function base64ToBytes(b64) {
    const s = String(b64).replace(/[^A-Za-z0-9+/=]/g, '');
    let len = s.length;
    if (len % 4 === 0 && s.endsWith('==')) len -= 2;
    else if (len % 4 === 0 && s.endsWith('=')) len -= 1;
    const out = new Uint8Array(Math.floor(len * 3 / 4));
    let o = 0, buf = 0, bits = 0;
    for (let i = 0; i < len; i++) {
      const v = B64M[s[i]];
      if (v == null) throw new Error('bad base64');
      buf = (buf << 6) | v;
      bits += 6;
      if (bits >= 8) { bits -= 8; out[o++] = (buf >> bits) & 0xff; }
    }
    return out.subarray(0, o);
  }

  function bytesToDataUrl(bytes, mime) {
    return 'data:' + mime + ';base64,' + bytesToBase64(bytes);
  }

  function parseDataUrl(s) {
    const m = /^data:([^;,]*);base64,(.*)$/.exec(String(s));
    if (!m) return null;
    return { mime: m[1] || 'application/octet-stream', bytes: base64ToBytes(m[2]) };
  }

  function strToBytes(str) {
    return new TextEncoder().encode(str);
  }

  /* ---------- 实验室 /Rapports 响应解析 ---------- */

  // %PDF 的 base64 以 "JVBERi" 开头。递归扫描 JSON 中的内嵌 PDF。
  function findEmbeddedPdfs(value, out, seen) {
    if (out == null) out = [];
    if (seen == null) seen = new Set();
    if (value == null) return out;
    if (typeof value === 'string') { maybePdf(value, out); return out; }
    if (typeof value !== 'object') return out;
    if (seen.has(value)) return out;
    seen.add(value);
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) findEmbeddedPdfs(value[i], out, seen);
      return out;
    }
    const keys = Object.keys(value);
    for (let i = 0; i < keys.length; i++) findEmbeddedPdfs(value[keys[i]], out, seen);
    return out;
  }

  function maybePdf(s, out) {
    let t = s.trim();
    const m = /^data:application\/pdf;base64,(.*)$/is.exec(t);
    if (m) t = m[1];
    if (t.length < 8) return;
    const compact = t.replace(/\s+/g, '');
    if (!compact.startsWith('JVBERi')) return;
    try {
      const bytes = base64ToBytes(compact);
      if (bytes.length > 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) {
        out.push(bytes);
      }
    } catch (e) { /* 非法 base64，忽略 */ }
  }

  // 从 Rapports JSON 里启发式找报告名称（description / libellé / titre…）
  function findLabel(value) {
    let best = null, bestRank = 99;
    const visit = function (v) {
      if (v == null || bestRank === 0) return;
      if (Array.isArray(v)) { v.forEach(visit); return; }
      if (typeof v !== 'object') return;
      const keys = Object.keys(v);
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i], val = v[k];
        if (typeof val === 'string') {
          const r = labelRank(k, val);
          if (r != null && r < bestRank) { bestRank = r; best = val.trim(); }
        } else if (val && typeof val === 'object') {
          visit(val);
        }
      }
    };
    visit(value);
    return best;
  }

  function labelRank(key, val) {
    const s = String(val).trim();
    if (s.length < 2 || s.length > 90) return null;
    if (!/\p{L}/u.test(s)) return null;                                  // 必须含字母
    if (s.length > 30 && /^[A-Za-z0-9+/=\s]+$/.test(s)) return null;     // 疑似 base64
    const k = key.toLowerCase();
    if (/prescripteur|medecin|pharmac|etabliss|statut|tracking|date|id/.test(k)) return null;
    if (/descript|libell|titre|title|examen|analy/.test(k)) return 0;
    if (k === 'nom' || /nom$/.test(k)) return 1;
    return null;
  }

  /* ---------- CSV ---------- */

  function csvEscape(v) {
    const s = String(v == null ? '' : v);
    if (/[",;\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function buildCsv(headers, rows) {
    const lines = [headers.map(csvEscape).join(',')];
    for (const row of rows) lines.push(headers.map(function (h) { return csvEscape(row[h]); }).join(','));
    return lines.join('\r\n');
  }

  /* ---------- i18n ---------- */

  const I18N = {
    zh: {
      appTitle: 'Carnet santé 报告助手',
      status: '状态',
      loggedInAs: '已登录：{name}',
      notLoggedIn: '未检测到登录会话。请先登录 Carnet santé 并停留在其页面。',
      openPortal: '打开 Carnet santé',
      tabMissing: '请先在标签页中打开 carnetsante.gouv.qc.ca 并登录，再点击本扩展。',
      sections: '下载范围',
      labs: '化验 Prélèvements',
      imaging: '影像 Imagerie médicale',
      yearsBack: '回溯年数',
      onlyNew: '跳过已下载过的报告',
      dryRun: '仅扫描（不下载）',
      start: '开始下载',
      scan: '开始扫描',
      cancel: '取消',
      running: '进行中…',
      done: '完成',
      found: '发现 {n}',
      processing: '处理 {i}/{n} …',
      current: '当前',
      elapsed: '用时',
      eta: '预计剩余',
      downloaded: '已下载 {n}',
      skipped: '跳过 {n}',
      failed: '失败 {n}',
      files: '文件',
      errorsTitle: '错误',
      settings: '设置',
      root: '根文件夹',
      labsDir: '化验子文件夹',
      imagingDir: '影像子文件夹',
      tpl: '文件名模板',
      tplHelp: '可用变量：{date} {label} {prescriber} {section} {id} {year}',
      delay: '每份报告间隔（毫秒）',
      writeIndex: '生成 index.csv 与 donnees.json',
      lang: '语言',
      save: '保存',
      saved: '已保存',
      reset: '恢复默认',
      clearDedup: '清除已下载记录',
      cleared: '已清除',
      openFolder: '打开文件夹',
      saveLocation: '保存位置预览（始终在浏览器下载目录内）',
      dlDir: '下载目录',
      absNote: '输入已转为下载目录内的相对路径（浏览器不允许扩展保存到下载目录以外）',
      targetFolder: '保存到',
      saveDir: '报告保存文件夹',
      pickFolder: '选择文件夹…',
      clearFolder: '清除',
      fsaNone: '未选择——将保存到浏览器下载目录',
      fsaSet: '已选择：{name}',
      fsaUnavailable: '当前浏览器不支持选择文件夹，将使用浏览器下载目录',
      fsaReauthHint: '文件夹需重新授权：到 ⚙ 设置里重选一次（授权时选「允许每次访问」可免重复授权）',
      fsaOpenDisabled: '查看所选文件夹内容',
      folderViewTitle: '报告文件夹',
      fsaNoHandle: '尚未选择文件夹——到 ⚙ 设置里点「选择文件夹…」',
      fsaNeedAuth: '需要重新授权',
      fsaReauthBtn: '重新授权',
      fsaEmpty: '（文件夹为空）',
      fallbackNotice: '⚠ 有 {n} 个文件未能写入所选文件夹，已改存浏览器下载目录（原因见错误/日志，常见：文件夹未授权）',
      fsaFinderHint: '浏览器不向扩展提供所选文件夹的绝对路径，因此无法直接在访达/Finder 中打开；本页是该文件夹的内容列表。',
      fetchFailHint: '请求被网络/跨域拦截：请停留在已登录的 carnetsante.gouv.qc.ca 标签页并刷新一次再试',
      busy: '已有任务在进行中',
      cancelled: '已取消',
      labsGateOff: '化验报告功能未对你开放，已跳过',
      privacy: '所有数据仅在本机浏览器与政府网站之间传输，扩展不连接任何第三方服务。',
    },
    fr: {
      appTitle: 'Assistant Carnet santé',
      status: 'État',
      loggedInAs: 'Connecté : {name}',
      notLoggedIn: 'Aucune session détectée. Connectez-vous au Carnet santé et restez sur sa page.',
      openPortal: 'Ouvrir le Carnet santé',
      tabMissing: "Ouvrez d'abord carnetsante.gouv.qc.ca dans un onglet et connectez-vous.",
      sections: 'Sections',
      labs: 'Prélèvements',
      imaging: 'Imagerie médicale',
      yearsBack: 'Années en arrière',
      onlyNew: 'Ignorer les rapports déjà téléchargés',
      dryRun: 'Simulation (sans téléchargement)',
      start: 'Télécharger',
      scan: 'Simuler',
      cancel: 'Annuler',
      running: 'En cours…',
      done: 'Terminé',
      found: 'Trouvés {n}',
      processing: 'Traitement {i}/{n} …',
      current: 'En cours',
      elapsed: 'Durée',
      eta: 'Reste',
      downloaded: 'Téléchargés {n}',
      skipped: 'Ignorés {n}',
      failed: 'Échecs {n}',
      files: 'Fichiers',
      errorsTitle: 'Erreurs',
      settings: 'Réglages',
      root: 'Dossier racine',
      labsDir: 'Sous-dossier prélèvements',
      imagingDir: 'Sous-dossier imagerie',
      tpl: 'Modèle de nom de fichier',
      tplHelp: 'Variables : {date} {label} {prescriber} {section} {id} {year}',
      delay: 'Délai entre rapports (ms)',
      writeIndex: 'Générer index.csv et donnees.json',
      lang: 'Langue',
      save: 'Enregistrer',
      saved: 'Enregistré',
      reset: 'Réinitialiser',
      clearDedup: 'Effacer le journal des téléchargements',
      cleared: 'Effacé',
      openFolder: 'Ouvrir le dossier',
      saveLocation: 'Aperçu de l’emplacement (toujours dans le dossier de téléchargements)',
      dlDir: 'Téléchargements',
      absNote: 'Converti en chemin relatif au dossier de téléchargements (le navigateur interdit d’écrire ailleurs)',
      targetFolder: 'Enregistrer dans',
      saveDir: 'Dossier des rapports',
      pickFolder: 'Choisir un dossier…',
      clearFolder: 'Effacer',
      fsaNone: 'Aucun — les rapports iront dans le dossier de téléchargements',
      fsaSet: 'Choisi : {name}',
      fsaUnavailable: 'Ce navigateur ne permet pas de choisir un dossier ; dossier de téléchargements utilisé',
      fsaReauthHint: 'Réautorisation requise : rechoisissez le dossier dans ⚙ Réglages (choisissez « Autoriser à chaque visite »)',
      fsaOpenDisabled: 'Voir le contenu du dossier choisi',
      folderViewTitle: 'Dossier des rapports',
      fsaNoHandle: 'Aucun dossier choisi — voir ⚙ Réglages',
      fsaNeedAuth: 'Réautorisation requise',
      fsaReauthBtn: 'Réautoriser',
      fsaEmpty: '(dossier vide)',
      fallbackNotice: '⚠ {n} fichier(s) non écrits dans le dossier choisi — enregistrés dans le dossier de téléchargements (voir journal)',
      fsaFinderHint: 'Le navigateur ne fournit pas le chemin absolu du dossier choisi ; cette page en liste le contenu.',
      fetchFailHint: 'Requête bloquée (réseau/CORS) : restez sur un onglet carnetsante.gouv.qc.ca connecté, actualisez puis réessayez',
      busy: 'Une tâche est déjà en cours',
      cancelled: 'Annulé',
      labsGateOff: 'Prélèvements non disponibles pour vous — section ignorée',
      privacy: 'Les données transitent uniquement entre votre navigateur et le site gouvernemental.',
    },
    en: {
      appTitle: 'Carnet santé Helper',
      status: 'Status',
      loggedInAs: 'Signed in: {name}',
      notLoggedIn: 'No session detected. Sign in to Carnet santé and stay on its page.',
      openPortal: 'Open Carnet santé',
      tabMissing: 'Open carnetsante.gouv.qc.ca in a tab and sign in first.',
      sections: 'Sections',
      labs: 'Labs (Prélèvements)',
      imaging: 'Medical imaging',
      yearsBack: 'Years back',
      onlyNew: 'Skip already-downloaded reports',
      dryRun: 'Dry run (no download)',
      start: 'Download',
      scan: 'Scan only',
      cancel: 'Cancel',
      running: 'Running…',
      done: 'Done',
      found: 'Found {n}',
      processing: 'Processing {i}/{n} …',
      current: 'Now',
      elapsed: 'Elapsed',
      eta: 'ETA',
      downloaded: 'Downloaded {n}',
      skipped: 'Skipped {n}',
      failed: 'Failed {n}',
      files: 'Files',
      errorsTitle: 'Errors',
      settings: 'Settings',
      root: 'Root folder',
      labsDir: 'Labs subfolder',
      imagingDir: 'Imaging subfolder',
      tpl: 'Filename template',
      tplHelp: 'Variables: {date} {label} {prescriber} {section} {id} {year}',
      delay: 'Delay between reports (ms)',
      writeIndex: 'Generate index.csv and donnees.json',
      lang: 'Language',
      save: 'Save',
      saved: 'Saved',
      reset: 'Reset to defaults',
      clearDedup: 'Clear download history',
      cleared: 'Cleared',
      openFolder: 'Open folder',
      saveLocation: 'Save location preview (always inside the browser downloads folder)',
      dlDir: 'Downloads',
      absNote: 'Converted to a path relative to the downloads folder (browsers forbid saving elsewhere)',
      targetFolder: 'Save to',
      saveDir: 'Reports folder',
      pickFolder: 'Choose folder…',
      clearFolder: 'Clear',
      fsaNone: 'None — reports go to the browser downloads folder',
      fsaSet: 'Selected: {name}',
      fsaUnavailable: 'This browser cannot pick a folder; the downloads folder will be used',
      fsaReauthHint: 'Folder needs reauthorization: re-pick it in ⚙ Settings (choose “Allow on every visit”)',
      fsaOpenDisabled: 'View chosen folder contents',
      folderViewTitle: 'Reports folder',
      fsaNoHandle: 'No folder chosen — pick one in ⚙ Settings',
      fsaNeedAuth: 'Reauthorization required',
      fsaReauthBtn: 'Reauthorize',
      fsaEmpty: '(folder is empty)',
      fallbackNotice: '⚠ {n} file(s) not written to the chosen folder — saved to the downloads folder instead (see log)',
      fsaFinderHint: 'The browser does not expose the chosen folder’s absolute path, so it cannot be opened in Finder directly; this page lists its contents.',
      fetchFailHint: 'Request blocked (network/CORS): stay on a signed-in carnetsante.gouv.qc.ca tab, refresh it and retry',
      busy: 'A task is already running',
      cancelled: 'Cancelled',
      labsGateOff: 'Labs section not available for you — skipped',
      privacy: 'Data travels only between your browser and the government site.',
    },
  };

  function t(lang, key, vars) {
    const L = I18N[lang] || I18N.zh;
    let s = L[key] != null ? L[key] : (I18N.en[key] != null ? I18N.en[key] : key);
    if (vars) {
      for (const k of Object.keys(vars)) s = s.split('{' + k + '}').join(vars[k]);
    }
    return s;
  }

  const api = {
    DEFAULTS: DEFAULTS,
    sanitizeSegment: sanitizeSegment,
    folderPath: folderPath,
    safeRelativePath: safeRelativePath,
    renderTemplate: renderTemplate,
    buildFilename: buildFilename,
    pad2: pad2,
    parseDate: parseDate,
    fmtDate: fmtDate,
    fmtApiDate: fmtApiDate,
    buildRanges: buildRanges,
    bytesToBase64: bytesToBase64,
    base64ToBytes: base64ToBytes,
    bytesToDataUrl: bytesToDataUrl,
    parseDataUrl: parseDataUrl,
    strToBytes: strToBytes,
    findEmbeddedPdfs: findEmbeddedPdfs,
    findLabel: findLabel,
    csvEscape: csvEscape,
    buildCsv: buildCsv,
    I18N: I18N,
    t: t,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.CSHCore = api;
})(typeof self !== 'undefined' ? self : globalThis);
