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

  // 时间段选项：最早数据年 earliest → 今年 thisYear 的可选起始年列表。
  // earliest 无效或晚于今年 → 空数组（调用方回退到固定档位）。
  function buildPeriodOptions(earliest, thisYear) {
    if (!Number.isFinite(earliest) || !Number.isFinite(thisYear)) return [];
    const e = Math.floor(earliest), n = Math.floor(thisYear);
    if (e > n) return [];
    const out = [];
    for (let y = e; y <= n; y++) out.push(y);
    return out;
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
      checking: '正在检测登录状态…',
      loggedInAs: '已登录：{name}',
      notLoggedIn: '未检测到登录会话。请先登录 Carnet santé 并停留在其页面。',
      openPortal: '打开 Carnet santé',
      tabMissing: '请先在标签页中打开 carnetsante.gouv.qc.ca 并登录，再点击本扩展。',
      sections: '下载范围',
      labs: '化验 Prélèvements',
      imaging: '影像 Imagerie médicale',
      yearsBack: '回溯年数',
      period: '时间段',
      periodAll: '全部（{y} 年起）',
      periodFrom: '{y} 年起',
      periodThisYear: '仅今年',
      periodDetecting: '正在检测最早可用数据…',
      periodFallback: '近 {n} 年',
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
      cancelling: '正在取消…',
      labsGateOff: '化验报告功能未对你开放，已跳过',
      grpLocation: '保存位置',
      grpNaming: '文件夹与文件名',
      grpBehavior: '下载选项',
      loading: '读取中…',
      filesCounted: '{n} 个文件',
      privacy: '所有数据仅在本机浏览器与政府网站之间传输，扩展不连接任何第三方服务。',
    },
    fr: {
      appTitle: 'Assistant Carnet santé',
      status: 'État',
      checking: 'Vérification de la session…',
      loggedInAs: 'Connecté : {name}',
      notLoggedIn: 'Aucune session détectée. Connectez-vous au Carnet santé et restez sur sa page.',
      openPortal: 'Ouvrir le Carnet santé',
      tabMissing: "Ouvrez d'abord carnetsante.gouv.qc.ca dans un onglet et connectez-vous.",
      sections: 'Sections',
      labs: 'Prélèvements',
      imaging: 'Imagerie médicale',
      yearsBack: 'Années en arrière',
      period: 'Période',
      periodAll: 'Tout (dès {y})',
      periodFrom: 'Dès {y}',
      periodThisYear: 'Cette année seulement',
      periodDetecting: 'Détection des données les plus anciennes…',
      periodFallback: '{n} dernières années',
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
      cancelling: 'Annulation…',
      labsGateOff: 'Prélèvements non disponibles pour vous — section ignorée',
      grpLocation: 'Emplacement',
      grpNaming: 'Dossiers et noms de fichiers',
      grpBehavior: 'Options de téléchargement',
      loading: 'Chargement…',
      filesCounted: '{n} fichier(s)',
      privacy: 'Les données transitent uniquement entre votre navigateur et le site gouvernemental.',
    },
    en: {
      appTitle: 'Carnet santé Helper',
      status: 'Status',
      checking: 'Checking sign-in…',
      loggedInAs: 'Signed in: {name}',
      notLoggedIn: 'No session detected. Sign in to Carnet santé and stay on its page.',
      openPortal: 'Open Carnet santé',
      tabMissing: 'Open carnetsante.gouv.qc.ca in a tab and sign in first.',
      sections: 'Sections',
      labs: 'Labs (Prélèvements)',
      imaging: 'Medical imaging',
      yearsBack: 'Years back',
      period: 'Time period',
      periodAll: 'All (from {y})',
      periodFrom: 'From {y}',
      periodThisYear: 'This year only',
      periodDetecting: 'Detecting earliest available data…',
      periodFallback: 'Last {n} years',
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
      cancelling: 'Cancelling…',
      labsGateOff: 'Labs section not available for you — skipped',
      grpLocation: 'Save location',
      grpNaming: 'Folders and file names',
      grpBehavior: 'Download options',
      loading: 'Loading…',
      filesCounted: '{n} files',
      privacy: 'Data travels only between your browser and the government site.',
    },
    /* ---- 魁北克移民常用语言（翻译覆盖全部键，缺键由 t() 回退英文） ---- */
    ar: {
      appTitle: 'مساعد Carnet santé',
      status: 'الحالة',
      checking: 'جارٍ التحقق من تسجيل الدخول…',
      loggedInAs: 'تم تسجيل الدخول: {name}',
      notLoggedIn: 'لم يتم اكتشاف جلسة تسجيل دخول. يُرجى تسجيل الدخول إلى Carnet santé والبقاء في صفحته.',
      openPortal: 'فتح Carnet santé',
      tabMissing: 'افتح carnetsante.gouv.qc.ca في تبويب وسجّل الدخول أولاً.',
      sections: 'الأقسام',
      labs: 'التحاليل (Prélèvements)',
      imaging: 'التصوير الطبي (Imagerie médicale)',
      yearsBack: 'عدد سنوات البحث',
      period: 'الفترة الزمنية',
      periodAll: 'الكل (من {y})',
      periodFrom: 'من {y}',
      periodThisYear: 'هذه السنة فقط',
      periodDetecting: 'جارٍ اكتشاف أقدم البيانات المتاحة…',
      periodFallback: 'آخر {n} سنوات',
      onlyNew: 'تخطَّ التقارير التي نُزِّلت سابقًا',
      dryRun: 'مسح فقط (بدون تنزيل)',
      start: 'بدء التنزيل',
      scan: 'بدء المسح',
      cancel: 'إلغاء',
      running: 'جارٍ العمل…',
      done: 'اكتمل',
      found: 'تم العثور على {n}',
      processing: 'معالجة {i}/{n} …',
      current: 'الحالي',
      elapsed: 'الوقت المنقضي',
      eta: 'الوقت المتبقي',
      downloaded: 'تم تنزيل {n}',
      skipped: 'تم تخطي {n}',
      failed: 'فشل {n}',
      files: 'ملفات',
      errorsTitle: 'أخطاء',
      settings: 'الإعدادات',
      root: 'المجلد الجذر',
      labsDir: 'مجلد فرعي للتحاليل',
      imagingDir: 'مجلد فرعي للتصوير',
      tpl: 'قالب اسم الملف',
      tplHelp: 'المتغيرات: {date} {label} {prescriber} {section} {id} {year}',
      delay: 'الفاصل الزمني بين التقارير (ms)',
      writeIndex: 'توليد index.csv و donnees.json',
      lang: 'اللغة',
      save: 'حفظ',
      saved: 'تم الحفظ',
      reset: 'استعادة الافتراضيات',
      clearDedup: 'مسح سجل التنزيلات',
      cleared: 'تم المسح',
      openFolder: 'فتح المجلد',
      saveLocation: 'معاينة موقع الحفظ (دائمًا داخل مجلد التنزيلات)',
      dlDir: 'مجلد التنزيلات',
      absNote: 'تم التحويل إلى مسار نسبي داخل مجلد التنزيلات (المتصفح يمنع الكتابة خارجه)',
      targetFolder: 'الحفظ في',
      saveDir: 'مجلد التقارير',
      pickFolder: 'اختيار مجلد…',
      clearFolder: 'مسح',
      fsaNone: 'لا شيء — ستُحفظ التقارير في مجلد تنزيلات المتصفح',
      fsaSet: 'تم الاختيار: {name}',
      fsaUnavailable: 'هذا المتصفح لا يسمح باختيار مجلد؛ سيتم استخدام مجلد التنزيلات',
      fsaReauthHint: 'المجلد يحتاج إلى إعادة تفويض: أعد اختياره في ⚙ الإعدادات (اختر «السماح في كل زيارة»)',
      fsaOpenDisabled: 'عرض محتويات المجلد المختار',
      folderViewTitle: 'مجلد التقارير',
      fsaNoHandle: 'لم يُختر مجلد — اختر واحدًا في ⚙ الإعدادات',
      fsaNeedAuth: 'مطلوب إعادة تفويض',
      fsaReauthBtn: 'إعادة التفويض',
      fsaEmpty: '(المجلد فارغ)',
      fallbackNotice: '⚠ تعذّرت كتابة {n} ملف في المجلد المختار — حُفظ في مجلد التنزيلات (انظر السجل)',
      fsaFinderHint: 'المتصفح لا يوفر المسار المطلق للمجلد المختار؛ هذه الصفحة تعرض محتواه.',
      fetchFailHint: 'الطلب محجوب (شبكة/CORS): ابقَ في تبويب carnetsante.gouv.qc.ca مسجّلًا، حدّثه ثم أعد المحاولة',
      busy: 'هناك مهمة قيد التنفيذ بالفعل',
      cancelled: 'تم الإلغاء',
      cancelling: 'جارٍ الإلغاء…',
      labsGateOff: 'قسم التحاليل غير متاح لك — تم تخطيه',
      grpLocation: 'موقع الحفظ',
      grpNaming: 'المجلدات وأسماء الملفات',
      grpBehavior: 'خيارات التنزيل',
      loading: 'جارٍ التحميل…',
      filesCounted: '{n} ملف',
      privacy: 'تنتقل البيانات فقط بين متصفحك والموقع الحكومي.',
    },
    es: {
      appTitle: 'Asistente de Carnet santé',
      status: 'Estado',
      checking: 'Verificando la sesión…',
      loggedInAs: 'Sesión iniciada: {name}',
      notLoggedIn: 'No se detectó ninguna sesión. Inicie sesión en Carnet santé y permanezca en su página.',
      openPortal: 'Abrir Carnet santé',
      tabMissing: 'Abra carnetsante.gouv.qc.ca en una pestaña e inicie sesión primero.',
      sections: 'Secciones',
      labs: 'Análisis (Prélèvements)',
      imaging: 'Imagen médica (Imagerie médicale)',
      yearsBack: 'Años hacia atrás',
      period: 'Período',
      periodAll: 'Todo (desde {y})',
      periodFrom: 'Desde {y}',
      periodThisYear: 'Solo este año',
      periodDetecting: 'Detectando los datos más antiguos…',
      periodFallback: 'Últimos {n} años',
      onlyNew: 'Omitir informes ya descargados',
      dryRun: 'Solo escanear (sin descarga)',
      start: 'Descargar',
      scan: 'Escanear',
      cancel: 'Cancelar',
      running: 'En curso…',
      done: 'Completado',
      found: 'Encontrados {n}',
      processing: 'Procesando {i}/{n} …',
      current: 'Actual',
      elapsed: 'Transcurrido',
      eta: 'Restante',
      downloaded: 'Descargados {n}',
      skipped: 'Omitidos {n}',
      failed: 'Fallidos {n}',
      files: 'Archivos',
      errorsTitle: 'Errores',
      settings: 'Ajustes',
      root: 'Carpeta raíz',
      labsDir: 'Subcarpeta de análisis',
      imagingDir: 'Subcarpeta de imagen',
      tpl: 'Plantilla de nombre de archivo',
      tplHelp: 'Variables: {date} {label} {prescriber} {section} {id} {year}',
      delay: 'Retardo entre informes (ms)',
      writeIndex: 'Generar index.csv y donnees.json',
      lang: 'Idioma',
      save: 'Guardar',
      saved: 'Guardado',
      reset: 'Restablecer',
      clearDedup: 'Borrar historial de descargas',
      cleared: 'Borrado',
      openFolder: 'Abrir carpeta',
      saveLocation: 'Vista previa de la ubicación (siempre en la carpeta de descargas)',
      dlDir: 'Descargas',
      absNote: 'Convertido en una ruta relativa a la carpeta de descargas (el navegador prohíbe escribir fuera de ella)',
      targetFolder: 'Guardar en',
      saveDir: 'Carpeta de informes',
      pickFolder: 'Elegir carpeta…',
      clearFolder: 'Borrar',
      fsaNone: 'Ninguna — los informes irán a la carpeta de descargas',
      fsaSet: 'Elegida: {name}',
      fsaUnavailable: 'Este navegador no permite elegir carpeta; se usará la de descargas',
      fsaReauthHint: 'La carpeta necesita reautorización: vuelva a elegirla en ⚙ Ajustes (elija «Permitir en cada visita»)',
      fsaOpenDisabled: 'Ver el contenido de la carpeta elegida',
      folderViewTitle: 'Carpeta de informes',
      fsaNoHandle: 'Ninguna carpeta elegida — elija una en ⚙ Ajustes',
      fsaNeedAuth: 'Se requiere reautorización',
      fsaReauthBtn: 'Reautorizar',
      fsaEmpty: '(carpeta vacía)',
      fallbackNotice: '⚠ {n} archivo(s) no escritos en la carpeta elegida — guardados en la de descargas (ver registro)',
      fsaFinderHint: 'El navegador no expone la ruta absoluta de la carpeta elegida; esta página lista su contenido.',
      fetchFailHint: 'Petición bloqueada (red/CORS): quédese en una pestaña conectada de carnetsante.gouv.qc.ca, actualice y reintente',
      busy: 'Ya hay una tarea en curso',
      cancelled: 'Cancelado',
      cancelling: 'Cancelando…',
      labsGateOff: 'Sección de análisis no disponible para usted — omitida',
      grpLocation: 'Ubicación',
      grpNaming: 'Carpetas y nombres de archivo',
      grpBehavior: 'Opciones de descarga',
      loading: 'Cargando…',
      filesCounted: '{n} archivo(s)',
      privacy: 'Los datos viajan únicamente entre su navegador y el sitio gubernamental.',
    },
    ht: {
      appTitle: 'Asistan Carnet santé',
      status: 'Estati',
      checking: 'N’ap verifye sesyon an…',
      loggedInAs: 'Konekte: {name}',
      notLoggedIn: 'Pa gen sesyon ki detekte. Konekte nan Carnet santé epi rete sou paj li.',
      openPortal: 'Ouvri Carnet santé',
      tabMissing: 'Ouvri carnetsante.gouv.qc.ca nan yon onglet epi konekte anvan.',
      sections: 'Seksyon',
      labs: 'Analiz (Prélèvements)',
      imaging: 'Imaj medikal (Imagerie médicale)',
      yearsBack: 'Kantite ane deyè',
      period: 'Peryòd',
      periodAll: 'Tout (depi {y})',
      periodFrom: 'Depi {y}',
      periodThisYear: 'Se sèlman ane sa a',
      periodDetecting: "N'ap detekte done ki pi ansyen yo…",
      periodFallback: '{n} dènye lane',
      onlyNew: 'Inyore rapò ki deja telechaje',
      dryRun: 'Sèlman eskane (san telechaje)',
      start: 'Telechaje',
      scan: 'Eskane',
      cancel: 'Anile',
      running: 'An kou…',
      done: 'Fini',
      found: 'Jwenn {n}',
      processing: 'N’ap trete {i}/{n} …',
      current: 'Kounye a',
      elapsed: 'Tan ki pase',
      eta: 'Tan ki rete',
      downloaded: 'Telechaje {n}',
      skipped: 'Inyore {n}',
      failed: 'Echwe {n}',
      files: 'Fichye',
      errorsTitle: 'Erè',
      settings: 'Paramèt',
      root: 'Dosiye rasin',
      labsDir: 'Sou-dosiye analiz',
      imagingDir: 'Sou-dosiye imaj',
      tpl: 'Modèl non fichye',
      tplHelp: 'Variable: {date} {label} {prescriber} {section} {id} {year}',
      delay: 'Intèval ant rapò yo (ms)',
      writeIndex: 'Jenere index.csv ak donnees.json',
      lang: 'Lang',
      save: 'Sove',
      saved: 'Sove',
      reset: 'Retabli valè inisyal yo',
      clearDedup: 'Efase istwa telechajman yo',
      cleared: 'Efase',
      openFolder: 'Ouvri dosiye a',
      saveLocation: 'Aperçu kote rapò yo ap save (toujou andedan dosiye telechajman an)',
      dlDir: 'Telechajman',
      absNote: 'Konvèti an chemen relatif andedan dosiye telechajman an (navigatè a pa pèmèt ekri deyò li)',
      targetFolder: 'Save nan',
      saveDir: 'Dosiye rapò yo',
      pickFolder: 'Chwazi yon dosiye…',
      clearFolder: 'Efase',
      fsaNone: 'Pa gen — rapò yo prale nan dosiye telechajman an',
      fsaSet: 'Chwazi: {name}',
      fsaUnavailable: 'Navigatè sa a pa pèmèt chwazi yon dosiye; yo ap itilize dosiye telechajman an',
      fsaReauthHint: 'Dosiye a bezwen otorizasyon ankò: rechwazi l nan ⚙ Paramèt (chwazi «Pèmèt chak vizit»)',
      fsaOpenDisabled: 'Gade kontni dosiye chwazi a',
      folderViewTitle: 'Dosiye rapò yo',
      fsaNoHandle: 'Pa gen dosiye ki chwazi — chwazi youn nan ⚙ Paramèt',
      fsaNeedAuth: 'Bezwen otorizasyon ankò',
      fsaReauthBtn: 'Otorize ankò',
      fsaEmpty: '(dosiye a vid)',
      fallbackNotice: '⚠ {n} fichye pa ekri nan dosiye chwazi a — yo save nan dosiye telechajman an (gade jounal la)',
      fsaFinderHint: 'Navigatè a pa bay chemen absoli dosiye chwazi a; paj sa a lis kontni li.',
      fetchFailHint: 'Demann nan bloke (rezo/CORS): rete sou yon onglet carnetsante.gouv.qc.ca ki konekte, aktyalize l epi eseye ankò',
      busy: 'Gen yon travay ki ap fèt deja',
      cancelled: 'Anile',
      cancelling: 'N’ap anile…',
      labsGateOff: 'Seksyon analiz pa disponib pou ou — inyore',
      grpLocation: 'Kote pou save',
      grpNaming: 'Dosiye ak non fichye',
      grpBehavior: 'Opsyon telechajman',
      loading: 'N’ap chaje…',
      filesCounted: '{n} fichye',
      privacy: 'Done yo sèlman vwayaje ant navigatè ou a ak sit gouvènman an.',
    },
    pt: {
      appTitle: 'Assistente do Carnet santé',
      status: 'Estado',
      checking: 'A verificar a sessão…',
      loggedInAs: 'Sessão iniciada: {name}',
      notLoggedIn: 'Nenhuma sessão detetada. Inicie sessão no Carnet santé e fique na sua página.',
      openPortal: 'Abrir o Carnet santé',
      tabMissing: 'Abra carnetsante.gouv.qc.ca num separador e inicie sessão primeiro.',
      sections: 'Secções',
      labs: 'Análises (Prélèvements)',
      imaging: 'Imagiologia (Imagerie médicale)',
      yearsBack: 'Anos para trás',
      period: 'Período',
      periodAll: 'Tudo (desde {y})',
      periodFrom: 'Desde {y}',
      periodThisYear: 'Só este ano',
      periodDetecting: 'A detetar os dados mais antigos…',
      periodFallback: 'Últimos {n} anos',
      onlyNew: 'Ignorar relatórios já transferidos',
      dryRun: 'Apenas simular (sem transferência)',
      start: 'Transferir',
      scan: 'Simular',
      cancel: 'Cancelar',
      running: 'Em curso…',
      done: 'Concluído',
      found: 'Encontrados {n}',
      processing: 'A processar {i}/{n} …',
      current: 'Atual',
      elapsed: 'Decorrido',
      eta: 'Restante',
      downloaded: 'Transferidos {n}',
      skipped: 'Ignorados {n}',
      failed: 'Falhados {n}',
      files: 'Ficheiros',
      errorsTitle: 'Erros',
      settings: 'Definições',
      root: 'Pasta raiz',
      labsDir: 'Subpasta de análises',
      imagingDir: 'Subpasta de imagiologia',
      tpl: 'Modelo de nome de ficheiro',
      tplHelp: 'Variáveis: {date} {label} {prescriber} {section} {id} {year}',
      delay: 'Intervalo entre relatórios (ms)',
      writeIndex: 'Gerar index.csv e donnees.json',
      lang: 'Idioma',
      save: 'Guardar',
      saved: 'Guardado',
      reset: 'Restaurar predefinições',
      clearDedup: 'Limpar histórico de transferências',
      cleared: 'Limpo',
      openFolder: 'Abrir pasta',
      saveLocation: 'Pré-visualização da localização (sempre na pasta de transferências)',
      dlDir: 'Transferências',
      absNote: 'Convertido num caminho relativo à pasta de transferências (o navegador proíbe escrever fora dela)',
      targetFolder: 'Guardar em',
      saveDir: 'Pasta de relatórios',
      pickFolder: 'Escolher pasta…',
      clearFolder: 'Limpar',
      fsaNone: 'Nenhuma — os relatórios vão para a pasta de transferências',
      fsaSet: 'Escolhida: {name}',
      fsaUnavailable: 'Este navegador não permite escolher pasta; será usada a pasta de transferências',
      fsaReauthHint: 'A pasta precisa de reautorização: reescolha-a em ⚙ Definições (escolha «Permitir em todas as visitas»)',
      fsaOpenDisabled: 'Ver o conteúdo da pasta escolhida',
      folderViewTitle: 'Pasta de relatórios',
      fsaNoHandle: 'Nenhuma pasta escolhida — escolha uma em ⚙ Definições',
      fsaNeedAuth: 'Reautorização necessária',
      fsaReauthBtn: 'Reautorizar',
      fsaEmpty: '(pasta vazia)',
      fallbackNotice: '⚠ {n} ficheiro(s) não escritos na pasta escolhida — guardados na pasta de transferências (ver registo)',
      fsaFinderHint: 'O navegador não expõe o caminho absoluto da pasta escolhida; esta página lista o seu conteúdo.',
      fetchFailHint: 'Pedido bloqueado (rede/CORS): fique num separador com sessão do carnetsante.gouv.qc.ca, atualize e tente de novo',
      busy: 'Já existe uma tarefa em curso',
      cancelled: 'Cancelado',
      cancelling: 'A cancelar…',
      labsGateOff: 'Secção de análises indisponível para si — ignorada',
      grpLocation: 'Localização',
      grpNaming: 'Pastas e nomes de ficheiros',
      grpBehavior: 'Opções de transferência',
      loading: 'A carregar…',
      filesCounted: '{n} ficheiro(s)',
      privacy: 'Os dados circulam apenas entre o seu navegador e o site do governo.',
    },
    it: {
      appTitle: 'Assistente Carnet santé',
      status: 'Stato',
      checking: 'Verifica della sessione…',
      loggedInAs: 'Connesso: {name}',
      notLoggedIn: 'Nessuna sessione rilevata. Accedi al Carnet santé e resta sulla sua pagina.',
      openPortal: 'Apri Carnet santé',
      tabMissing: 'Apri carnetsante.gouv.qc.ca in una scheda e accedi prima.',
      sections: 'Sezioni',
      labs: 'Analisi (Prélèvements)',
      imaging: 'Diagnostica per immagini (Imagerie médicale)',
      yearsBack: 'Anni indietro',
      period: 'Periodo',
      periodAll: 'Tutto (dal {y})',
      periodFrom: 'Dal {y}',
      periodThisYear: "Solo quest'anno",
      periodDetecting: 'Rilevamento dei dati più vecchi…',
      periodFallback: 'Ultimi {n} anni',
      onlyNew: 'Salta i referti già scaricati',
      dryRun: 'Solo scansione (senza download)',
      start: 'Scarica',
      scan: 'Scansiona',
      cancel: 'Annulla',
      running: 'In corso…',
      done: 'Completato',
      found: 'Trovati {n}',
      processing: 'Elaborazione {i}/{n} …',
      current: 'Corrente',
      elapsed: 'Trascorso',
      eta: 'Restante',
      downloaded: 'Scaricati {n}',
      skipped: 'Saltati {n}',
      failed: 'Non riusciti {n}',
      files: 'File',
      errorsTitle: 'Errori',
      settings: 'Impostazioni',
      root: 'Cartella principale',
      labsDir: 'Sottocartella analisi',
      imagingDir: 'Sottocartella diagnostica',
      tpl: 'Modello nome file',
      tplHelp: 'Variabili: {date} {label} {prescriber} {section} {id} {year}',
      delay: 'Ritardo tra referti (ms)',
      writeIndex: 'Genera index.csv e donnees.json',
      lang: 'Lingua',
      save: 'Salva',
      saved: 'Salvato',
      reset: 'Ripristina predefiniti',
      clearDedup: 'Cancella cronologia download',
      cleared: 'Cancellato',
      openFolder: 'Apri cartella',
      saveLocation: 'Anteprima posizione (sempre nella cartella download)',
      dlDir: 'Download',
      absNote: 'Convertito in un percorso relativo alla cartella download (il browser vieta di scrivere altrove)',
      targetFolder: 'Salva in',
      saveDir: 'Cartella referti',
      pickFolder: 'Scegli cartella…',
      clearFolder: 'Cancella',
      fsaNone: 'Nessuna — i referti vanno nella cartella download',
      fsaSet: 'Scelta: {name}',
      fsaUnavailable: 'Questo browser non permette di scegliere una cartella; verrà usata quella dei download',
      fsaReauthHint: 'La cartella richiede una nuova autorizzazione: riselezionala in ⚙ Impostazioni (scegli «Consenti a ogni visita»)',
      fsaOpenDisabled: 'Vedi il contenuto della cartella scelta',
      folderViewTitle: 'Cartella referti',
      fsaNoHandle: 'Nessuna cartella scelta — scegline una in ⚙ Impostazioni',
      fsaNeedAuth: 'Nuova autorizzazione richiesta',
      fsaReauthBtn: 'Riautorizza',
      fsaEmpty: '(cartella vuota)',
      fallbackNotice: '⚠ {n} file non scritti nella cartella scelta — salvati nella cartella download (vedi registro)',
      fsaFinderHint: 'Il browser non espone il percorso assoluto della cartella scelta; questa pagina ne elenca il contenuto.',
      fetchFailHint: 'Richiesta bloccata (rete/CORS): resta su una scheda carnetsante.gouv.qc.ca connessa, aggiorna e riprova',
      busy: 'Un’attività è già in corso',
      cancelled: 'Annullato',
      cancelling: 'Annullamento…',
      labsGateOff: 'Sezione analisi non disponibile per te — saltata',
      grpLocation: 'Posizione',
      grpNaming: 'Cartelle e nomi file',
      grpBehavior: 'Opzioni di download',
      loading: 'Caricamento…',
      filesCounted: '{n} file',
      privacy: 'I dati viaggiano solo tra il tuo browser e il sito governativo.',
    },
    tl: {
      appTitle: 'Katulong ng Carnet santé',
      status: 'Katayuan',
      checking: 'Sinusuri ang pag-sign in…',
      loggedInAs: 'Naka-sign in: {name}',
      notLoggedIn: 'Walang nakitang sesyon. Mag-sign in sa Carnet santé at manatili sa pahina nito.',
      openPortal: 'Buksan ang Carnet santé',
      tabMissing: 'Buksan muna ang carnetsante.gouv.qc.ca sa isang tab at mag-sign in.',
      sections: 'Mga seksyon',
      labs: 'Laboratoryo (Prélèvements)',
      imaging: 'Medikal na imaging (Imagerie médicale)',
      yearsBack: 'Taon pabalik',
      period: 'Panahon',
      periodAll: 'Lahat (mula {y})',
      periodFrom: 'Mula {y}',
      periodThisYear: 'Taong ito lang',
      periodDetecting: 'Sinusuri ang pinakalumang available na data…',
      periodFallback: 'Huling {n} taon',
      onlyNew: 'Laktawan ang nai-download nang ulat',
      dryRun: 'Scan lamang (walang download)',
      start: 'I-download',
      scan: 'i-scan',
      cancel: 'Kanselahin',
      running: 'Ginagawa…',
      done: 'Tapos na',
      found: 'Nahanap {n}',
      processing: 'Pinoproseso {i}/{n} …',
      current: 'Kasalukuyan',
      elapsed: 'Oras na lumipas',
      eta: 'Natitira',
      downloaded: 'Na-download {n}',
      skipped: 'Laktawan {n}',
      failed: 'Nabigo {n}',
      files: 'Mga file',
      errorsTitle: 'Mga error',
      settings: 'Mga setting',
      root: 'Pangunahing folder',
      labsDir: 'Subfolder ng laboratoryo',
      imagingDir: 'Subfolder ng imaging',
      tpl: 'Template ng pangalan ng file',
      tplHelp: 'Mga variable: {date} {label} {prescriber} {section} {id} {year}',
      delay: 'Pagitan ng mga ulat (ms)',
      writeIndex: 'Gumawa ng index.csv at donnees.json',
      lang: 'Wika',
      save: 'I-save',
      saved: 'Naka-save na',
      reset: 'I-reset',
      clearDedup: 'Burahin ang history ng download',
      cleared: 'Nabura',
      openFolder: 'Buksan ang folder',
      saveLocation: 'Preview ng lokasyon (palaging sa loob ng download folder)',
      dlDir: 'Mga download',
      absNote: 'Na-convert sa relative path sa loob ng download folder (ipinagbabawal ng browser ang pagsulat sa labas nito)',
      targetFolder: 'I-save sa',
      saveDir: 'Folder ng mga ulat',
      pickFolder: 'Pumili ng folder…',
      clearFolder: 'Burahin',
      fsaNone: 'Wala — pupunta ang mga ulat sa download folder',
      fsaSet: 'Pinili: {name}',
      fsaUnavailable: 'Hindi pinapayagan ng browser na ito ang pagpili ng folder; gagamitin ang download folder',
      fsaReauthHint: 'Kailangan ng folder ng muling awtorisasyon: piliin muli sa ⚙ Mga setting (piliin ang «Payagan sa bawat pagbisita»)',
      fsaOpenDisabled: 'Tingnan ang nilalaman ng piniling folder',
      folderViewTitle: 'Folder ng mga ulat',
      fsaNoHandle: 'Walang napiling folder — pumili sa ⚙ Mga setting',
      fsaNeedAuth: 'Kailangan ng muling awtorisasyon',
      fsaReauthBtn: 'Muling awtorisahin',
      fsaEmpty: '(walang laman ang folder)',
      fallbackNotice: '⚠ {n} file hindi naisulat sa piniling folder — naka-save sa download folder (tingnan ang log)',
      fsaFinderHint: 'Hindi ibinibigay ng browser ang absolute path ng piniling folder; nililista ng pahinang ito ang nilalaman nito.',
      fetchFailHint: 'Hinarang ang request (network/CORS): manatili sa naka-sign in na tab ng carnetsante.gouv.qc.ca, i-refresh at subukan muli',
      busy: 'May tumatakbong gawain na',
      cancelled: 'Kanselado',
      cancelling: 'Kinakansel…',
      labsGateOff: 'Hindi available ang seksyon ng laboratoryo para sa iyo — laktawan',
      grpLocation: 'Lokasyon ng pag-save',
      grpNaming: 'Mga folder at pangalan ng file',
      grpBehavior: 'Mga opsyon sa download',
      loading: 'Naglo-load…',
      filesCounted: '{n} file',
      privacy: 'Ang data ay dumadaan lamang sa pagitan ng iyong browser at ng site ng gobyerno.',
    },
    vi: {
      appTitle: 'Trợ lý Carnet santé',
      status: 'Trạng thái',
      checking: 'Đang kiểm tra đăng nhập…',
      loggedInAs: 'Đã đăng nhập: {name}',
      notLoggedIn: 'Không phát hiện phiên đăng nhập. Hãy đăng nhập Carnet santé và ở lại trang của nó.',
      openPortal: 'Mở Carnet santé',
      tabMissing: 'Hãy mở carnetsante.gouv.qc.ca trong một thẻ và đăng nhập trước.',
      sections: 'Khu vực',
      labs: 'Xét nghiệm (Prélèvements)',
      imaging: 'Chẩn đoán hình ảnh (Imagerie médicale)',
      yearsBack: 'Số năm trở lại',
      period: 'Khoảng thời gian',
      periodAll: 'Tất cả (từ {y})',
      periodFrom: 'Từ {y}',
      periodThisYear: 'Chỉ năm nay',
      periodDetecting: 'Đang dò dữ liệu cũ nhất có sẵn…',
      periodFallback: '{n} năm gần đây',
      onlyNew: 'Bỏ qua báo cáo đã tải trước đây',
      dryRun: 'Chỉ quét (không tải)',
      start: 'Tải xuống',
      scan: 'Quét',
      cancel: 'Hủy',
      running: 'Đang chạy…',
      done: 'Hoàn tất',
      found: 'Tìm thấy {n}',
      processing: 'Đang xử lý {i}/{n} …',
      current: 'Hiện tại',
      elapsed: 'Đã trôi qua',
      eta: 'Còn lại',
      downloaded: 'Đã tải {n}',
      skipped: 'Đã bỏ qua {n}',
      failed: 'Thất bại {n}',
      files: 'Tệp',
      errorsTitle: 'Lỗi',
      settings: 'Cài đặt',
      root: 'Thư mục gốc',
      labsDir: 'Thư mục con xét nghiệm',
      imagingDir: 'Thư mục con hình ảnh',
      tpl: 'Mẫu tên tệp',
      tplHelp: 'Biến: {date} {label} {prescriber} {section} {id} {year}',
      delay: 'Khoảng nghỉ giữa các báo cáo (ms)',
      writeIndex: 'Tạo index.csv và donnees.json',
      lang: 'Ngôn ngữ',
      save: 'Lưu',
      saved: 'Đã lưu',
      reset: 'Khôi phục mặc định',
      clearDedup: 'Xóa lịch sử tải xuống',
      cleared: 'Đã xóa',
      openFolder: 'Mở thư mục',
      saveLocation: 'Xem trước vị trí lưu (luôn trong thư mục tải xuống)',
      dlDir: 'Tải xuống',
      absNote: 'Đã chuyển thành đường dẫn tương đối trong thư mục tải xuống (trình duyệt không cho ghi ra ngoài)',
      targetFolder: 'Lưu vào',
      saveDir: 'Thư mục báo cáo',
      pickFolder: 'Chọn thư mục…',
      clearFolder: 'Xóa',
      fsaNone: 'Chưa chọn — báo cáo sẽ vào thư mục tải xuống',
      fsaSet: 'Đã chọn: {name}',
      fsaUnavailable: 'Trình duyệt này không cho chọn thư mục; sẽ dùng thư mục tải xuống',
      fsaReauthHint: 'Thư mục cần cấp quyền lại: chọn lại trong ⚙ Cài đặt (chọn «Cho phép mỗi lần truy cập»)',
      fsaOpenDisabled: 'Xem nội dung thư mục đã chọn',
      folderViewTitle: 'Thư mục báo cáo',
      fsaNoHandle: 'Chưa chọn thư mục — chọn trong ⚙ Cài đặt',
      fsaNeedAuth: 'Cần cấp quyền lại',
      fsaReauthBtn: 'Cấp quyền lại',
      fsaEmpty: '(thư mục trống)',
      fallbackNotice: '⚠ {n} tệp không ghi được vào thư mục đã chọn — đã lưu vào thư mục tải xuống (xem nhật ký)',
      fsaFinderHint: 'Trình duyệt không cung cấp đường dẫn tuyệt đối của thư mục đã chọn; trang này liệt kê nội dung của nó.',
      fetchFailHint: 'Yêu cầu bị chặn (mạng/CORS): hãy ở trên thẻ carnetsante.gouv.qc.ca đã đăng nhập, tải lại rồi thử lại',
      busy: 'Đã có tác vụ đang chạy',
      cancelled: 'Đã hủy',
      cancelling: 'Đang hủy…',
      labsGateOff: 'Khu vực xét nghiệm không khả dụng cho bạn — đã bỏ qua',
      grpLocation: 'Vị trí lưu',
      grpNaming: 'Thư mục và tên tệp',
      grpBehavior: 'Tùy chọn tải xuống',
      loading: 'Đang tải…',
      filesCounted: '{n} tệp',
      privacy: 'Dữ liệu chỉ truyền giữa trình duyệt của bạn và trang web chính phủ.',
    },
    ru: {
      appTitle: 'Помощник Carnet santé',
      status: 'Статус',
      checking: 'Проверка входа…',
      loggedInAs: 'Вы вошли: {name}',
      notLoggedIn: 'Сеанс не обнаружен. Войдите в Carnet santé и останьтесь на его странице.',
      openPortal: 'Открыть Carnet santé',
      tabMissing: 'Откройте carnetsante.gouv.qc.ca во вкладке и сначала войдите.',
      sections: 'Разделы',
      labs: 'Анализы (Prélèvements)',
      imaging: 'Медицинская визуализация (Imagerie médicale)',
      yearsBack: 'Лет назад',
      period: 'Период',
      periodAll: 'Все (с {y})',
      periodFrom: 'С {y}',
      periodThisYear: 'Только этот год',
      periodDetecting: 'Определение самых ранних данных…',
      periodFallback: 'Последние {n} лет',
      onlyNew: 'Пропускать уже скачанные отчёты',
      dryRun: 'Только сканировать (без загрузки)',
      start: 'Скачать',
      scan: 'Сканировать',
      cancel: 'Отмена',
      running: 'Выполняется…',
      done: 'Завершено',
      found: 'Найдено {n}',
      processing: 'Обработка {i}/{n} …',
      current: 'Текущий',
      elapsed: 'Прошло',
      eta: 'Осталось',
      downloaded: 'Скачано {n}',
      skipped: 'Пропущено {n}',
      failed: 'Ошибок {n}',
      files: 'Файлы',
      errorsTitle: 'Ошибки',
      settings: 'Настройки',
      root: 'Корневая папка',
      labsDir: 'Подпапка анализов',
      imagingDir: 'Подпапка визуализации',
      tpl: 'Шаблон имени файла',
      tplHelp: 'Переменные: {date} {label} {prescriber} {section} {id} {year}',
      delay: 'Пауза между отчётами (мс)',
      writeIndex: 'Создавать index.csv и donnees.json',
      lang: 'Язык',
      save: 'Сохранить',
      saved: 'Сохранено',
      reset: 'Сбросить настройки',
      clearDedup: 'Очистить журнал загрузок',
      cleared: 'Очищено',
      openFolder: 'Открыть папку',
      saveLocation: 'Предпросмотр расположения (всегда в папке загрузок)',
      dlDir: 'Загрузки',
      absNote: 'Преобразовано в относительный путь внутри папки загрузок (браузер запрещает писать вне её)',
      targetFolder: 'Сохранить в',
      saveDir: 'Папка отчётов',
      pickFolder: 'Выбрать папку…',
      clearFolder: 'Очистить',
      fsaNone: 'Не выбрана — отчёты попадут в папку загрузок',
      fsaSet: 'Выбрана: {name}',
      fsaUnavailable: 'Этот браузер не позволяет выбрать папку; будет использована папка загрузок',
      fsaReauthHint: 'Папке нужна повторная авторизация: выберите её заново в ⚙ Настройках (выберите «Разрешать при каждом посещении»)',
      fsaOpenDisabled: 'Просмотр содержимого выбранной папки',
      folderViewTitle: 'Папка отчётов',
      fsaNoHandle: 'Папка не выбрана — выберите в ⚙ Настройках',
      fsaNeedAuth: 'Требуется повторная авторизация',
      fsaReauthBtn: 'Повторно авторизовать',
      fsaEmpty: '(папка пуста)',
      fallbackNotice: '⚠ {n} файл(ов) не записаны в выбранную папку — сохранены в папку загрузок (см. журнал)',
      fsaFinderHint: 'Браузер не раскрывает абсолютный путь выбранной папки; эта страница показывает её содержимое.',
      fetchFailHint: 'Запрос заблокирован (сеть/CORS): оставайтесь на вкладке carnetsante.gouv.qc.ca с входом, обновите и повторите',
      busy: 'Задача уже выполняется',
      cancelled: 'Отменено',
      cancelling: 'Отмена…',
      labsGateOff: 'Раздел анализов вам недоступен — пропущен',
      grpLocation: 'Расположение',
      grpNaming: 'Папки и имена файлов',
      grpBehavior: 'Параметры загрузки',
      loading: 'Загрузка…',
      filesCounted: 'файлов: {n}',
      privacy: 'Данные передаются только между вашим браузером и правительственным сайтом.',
    },
    uk: {
      appTitle: 'Помічник Carnet santé',
      status: 'Статус',
      checking: 'Перевірка входу…',
      loggedInAs: 'Ви увійшли: {name}',
      notLoggedIn: 'Сеансу не виявлено. Увійдіть у Carnet santé і залишайтеся на його сторінці.',
      openPortal: 'Відкрити Carnet santé',
      tabMissing: 'Відкрийте carnetsante.gouv.qc.ca у вкладці та спочатку увійдіть.',
      sections: 'Розділи',
      labs: 'Аналізи (Prélèvements)',
      imaging: 'Медична візуалізація (Imagerie médicale)',
      yearsBack: 'Років тому',
      period: 'Період',
      periodAll: 'Усе (з {y})',
      periodFrom: 'З {y}',
      periodThisYear: 'Тільки цього року',
      periodDetecting: 'Визначення найраніших даних…',
      periodFallback: 'Останні {n} років',
      onlyNew: 'Пропускати вже завантажені звіти',
      dryRun: 'Лише сканування (без завантаження)',
      start: 'Завантажити',
      scan: 'Сканувати',
      cancel: 'Скасувати',
      running: 'Виконується…',
      done: 'Завершено',
      found: 'Знайдено {n}',
      processing: 'Обробка {i}/{n} …',
      current: 'Поточний',
      elapsed: 'Минуло',
      eta: 'Залишилось',
      downloaded: 'Завантажено {n}',
      skipped: 'Пропущено {n}',
      failed: 'Помилок {n}',
      files: 'Файли',
      errorsTitle: 'Помилки',
      settings: 'Налаштування',
      root: 'Коренева папка',
      labsDir: 'Підпапка аналізів',
      imagingDir: 'Підпапка візуалізації',
      tpl: 'Шаблон назви файлу',
      tplHelp: 'Змінні: {date} {label} {prescriber} {section} {id} {year}',
      delay: 'Пауза між звітами (мс)',
      writeIndex: 'Створювати index.csv і donnees.json',
      lang: 'Мова',
      save: 'Зберегти',
      saved: 'Збережено',
      reset: 'Відновити стандартні',
      clearDedup: 'Очистити журнал завантажень',
      cleared: 'Очищено',
      openFolder: 'Відкрити папку',
      saveLocation: 'Перегляд розташування (завжди в папці завантажень)',
      dlDir: 'Завантаження',
      absNote: 'Перетворено на відносний шлях у папці завантажень (браузер забороняє писати поза нею)',
      targetFolder: 'Зберегти до',
      saveDir: 'Папка звітів',
      pickFolder: 'Вибрати папку…',
      clearFolder: 'Очистити',
      fsaNone: 'Не вибрано — звіти підуть у папку завантажень',
      fsaSet: 'Вибрано: {name}',
      fsaUnavailable: 'Цей браузер не дозволяє вибрати папку; буде використано папку завантажень',
      fsaReauthHint: 'Папці потрібна повторна авторизація: виберіть її знову в ⚙ Налаштуваннях (оберіть «Дозволяти при кожному відвідуванні»)',
      fsaOpenDisabled: 'Перегляд вмісту вибраної папки',
      folderViewTitle: 'Папка звітів',
      fsaNoHandle: 'Папку не вибрано — виберіть у ⚙ Налаштуваннях',
      fsaNeedAuth: 'Потрібна повторна авторизація',
      fsaReauthBtn: 'Повторно авторизувати',
      fsaEmpty: '(папка порожня)',
      fallbackNotice: '⚠ {n} файл(ів) не записано у вибрану папку — збережено в папку завантажень (див. журнал)',
      fsaFinderHint: 'Браузер не розкриває абсолютний шлях вибраної папки; ця сторінка показує її вміст.',
      fetchFailHint: 'Запит заблоковано (мережа/CORS): залишайтеся на вкладці carnetsante.gouv.qc.ca з входом, оновіть і повторіть',
      busy: 'Задача вже виконується',
      cancelled: 'Скасовано',
      cancelling: 'Скасування…',
      labsGateOff: 'Розділ аналізів вам недоступний — пропущено',
      grpLocation: 'Розташування',
      grpNaming: 'Папки та назви файлів',
      grpBehavior: 'Параметри завантаження',
      loading: 'Завантаження…',
      filesCounted: 'файлів: {n}',
      privacy: 'Дані передаються лише між вашим браузером і урядовим сайтом.',
    },
    pa: {
      appTitle: 'Carnet santé ਸਹਾਇਕ',
      status: 'ਸਥਿਤੀ',
      checking: 'ਲਾਗਇਨ ਦੀ ਜਾਂਚ ਜਾਰੀ…',
      loggedInAs: 'ਲਾਗ ਇਨ: {name}',
      notLoggedIn: 'ਕੋਈ ਲਾਗਇਨ ਸੈਸ਼ਨ ਨਹੀਂ ਲੱਭਿਆ। Carnet santé ਵਿੱਚ ਲਾਗ ਇਨ ਕਰੋ ਅਤੇ ਉਸ ਪੰਨੇ ’ਤੇ ਰਹੋ।',
      openPortal: 'Carnet santé ਖੋਲ੍ਹੋ',
      tabMissing: 'ਪਹਿਲਾਂ ਇੱਕ ਟੈਬ ਵਿੱਚ carnetsante.gouv.qc.ca ਖੋਲ੍ਹੋ ਅਤੇ ਲਾਗ ਇਨ ਕਰੋ।',
      sections: 'ਭਾਗ',
      labs: 'ਲੈਬ ਟੈਸਟ (Prélèvements)',
      imaging: 'ਮੈਡੀਕਲ ਇਮੇਜਿੰਗ (Imagerie médicale)',
      yearsBack: 'ਕਿੰਨੇ ਸਾਲ ਪਿੱਛੇ',
      period: 'ਸਮਾਂ-ਮਿਆਦ',
      periodAll: 'ਸਭ ({y} ਤੋਂ)',
      periodFrom: '{y} ਤੋਂ',
      periodThisYear: 'ਸਿਰਫ਼ ਇਹ ਸਾਲ',
      periodDetecting: 'ਸਭ ਤੋਂ ਪੁਰਾਣਾ ਮੌਜੂਦ ਡਾਟਾ ਲੱਭਿਆ ਜਾ ਰਿਹਾ ਹੈ…',
      periodFallback: 'ਪਿਛਲੇ {n} ਸਾਲ',
      onlyNew: 'ਪਹਿਲਾਂ ਡਾਊਨਲੋਡ ਕੀਤੀਆਂ ਰਿਪੋਰਟਾਂ ਛੱਡੋ',
      dryRun: 'ਸਿਰਫ਼ ਸਕੈਨ (ਡਾਊਨਲੋਡ ਨਹੀਂ)',
      start: 'ਡਾਊਨਲੋਡ ਸ਼ੁਰੂ',
      scan: 'ਸਕੈਨ ਕਰੋ',
      cancel: 'ਰੱਦ ਕਰੋ',
      running: 'ਜਾਰੀ…',
      done: 'ਪੂਰਾ ਹੋਇਆ',
      found: '{n} ਮਿਲੇ',
      processing: 'ਪ੍ਰੋਸੈਸਿੰਗ {i}/{n} …',
      current: 'ਮੌਜੂਦਾ',
      elapsed: 'ਬੀਤਿਆ ਸਮਾਂ',
      eta: 'ਬਾਕੀ ਸਮਾਂ',
      downloaded: '{n} ਡਾਊਨਲੋਡ',
      skipped: '{n} ਛੱਡੇ',
      failed: '{n} ਅਸਫ਼ਲ',
      files: 'ਫ਼ਾਈਲਾਂ',
      errorsTitle: 'ਗਲਤੀਆਂ',
      settings: 'ਸੈਟਿੰਗਾਂ',
      root: 'ਮੁੱਖ ਫ਼ੋਲਡਰ',
      labsDir: 'ਲੈਬ ਸਬ-ਫ਼ੋਲਡਰ',
      imagingDir: 'ਇਮੇਜਿੰਗ ਸਬ-ਫ਼ੋਲਡਰ',
      tpl: 'ਫ਼ਾਈਲ ਨਾਮ ਟੈਂਪਲੇਟ',
      tplHelp: 'ਵੇਰੀਏਬਲ: {date} {label} {prescriber} {section} {id} {year}',
      delay: 'ਰਿਪੋਰਟਾਂ ਵਿਚਕਾਰ ਅੰਤਰਾਲ (ms)',
      writeIndex: 'index.csv ਅਤੇ donnees.json ਬਣਾਓ',
      lang: 'ਭਾਸ਼ਾ',
      save: 'ਸੰਭਾਲੋ',
      saved: 'ਸੰਭਾਲਿਆ',
      reset: 'ਮੁੜ ਸੈੱਟ ਕਰੋ',
      clearDedup: 'ਡਾਊਨਲੋਡ ਇਤਿਹਾਸ ਮਿਟਾਓ',
      cleared: 'ਮਿਟਾਇਆ',
      openFolder: 'ਫ਼ੋਲਡਰ ਖੋਲ੍ਹੋ',
      saveLocation: 'ਸੰਭਾਲਣ ਦੀ ਥਾਂ ਝਲਕ (ਹਮੇਸ਼ਾ ਡਾਊਨਲੋਡ ਫ਼ੋਲਡਰ ਵਿੱਚ)',
      dlDir: 'ਡਾਊਨਲੋਡ',
      absNote: 'ਡਾਊਨਲੋਡ ਫ਼ੋਲਡਰ ਦੇ ਅੰਦਰ ਸਾਪੇਖਿਕ ਮਾਰਗ ਵਿੱਚ ਬਦਲਿਆ (ਬਰਾਊਜ਼ਰ ਬਾਹਰ ਲਿਖਣ ਦੀ ਇਜਾਜ਼ਤ ਨਹੀਂ ਦਿੰਦਾ)',
      targetFolder: 'ਇੱਥੇ ਸੰਭਾਲੋ',
      saveDir: 'ਰਿਪੋਰਟ ਫ਼ੋਲਡਰ',
      pickFolder: 'ਫ਼ੋਲਡਰ ਚੁਣੋ…',
      clearFolder: 'ਮਿਟਾਓ',
      fsaNone: 'ਕੋਈ ਨਹੀਂ — ਰਿਪੋਰਟਾਂ ਡਾਊਨਲੋਡ ਫ਼ੋਲਡਰ ਵਿੱਚ ਜਾਣਗੀਆਂ',
      fsaSet: 'ਚੁਣਿਆ: {name}',
      fsaUnavailable: 'ਇਹ ਬਰਾਊਜ਼ਰ ਫ਼ੋਲਡਰ ਚੁਣਨ ਦੀ ਇਜਾਜ਼ਤ ਨਹੀਂ ਦਿੰਦਾ; ਡਾਊਨਲੋਡ ਫ਼ੋਲਡਰ ਵਰਤਿਆ ਜਾਵੇਗਾ',
      fsaReauthHint: 'ਫ਼ੋਲਡਰ ਨੂੰ ਦੁਬਾਰਾ ਅਧਿਕਾਰ ਚਾਹੀਦਾ ਹੈ: ⚙ ਸੈਟਿੰਗਾਂ ਵਿੱਚ ਮੁੜ ਚੁਣੋ («ਹਰ ਵਿਜ਼ਿਟ ’ਤੇ ਆਗਿਆ» ਚੁਣੋ)',
      fsaOpenDisabled: 'ਚੁਣੇ ਫ਼ੋਲਡਰ ਦੀ ਸਮੱਗਰੀ ਵੇਖੋ',
      folderViewTitle: 'ਰਿਪੋਰਟ ਫ਼ੋਲਡਰ',
      fsaNoHandle: 'ਕੋਈ ਫ਼ੋਲਡਰ ਨਹੀਂ ਚੁਣਿਆ — ⚙ ਸੈਟਿੰਗਾਂ ਵਿੱਚ ਚੁਣੋ',
      fsaNeedAuth: 'ਦੁਬਾਰਾ ਅਧਿਕਾਰ ਲੋੜੀਂਦਾ',
      fsaReauthBtn: 'ਦੁਬਾਰਾ ਅਧਿਕਾਰ ਦਿਓ',
      fsaEmpty: '(ਫ਼ੋਲਡਰ ਖਾਲੀ ਹੈ)',
      fallbackNotice: '⚠ {n} ਫ਼ਾਈਲਾਂ ਚੁਣੇ ਫ਼ੋਲਡਰ ਵਿੱਚ ਨਹੀਂ ਲਿਖੀਆਂ ਜਾ ਸਕੀਆਂ — ਡਾਊਨਲੋਡ ਫ਼ੋਲਡਰ ਵਿੱਚ ਸੰਭਾਲੀਆਂ (ਲੌਗ ਵੇਖੋ)',
      fsaFinderHint: 'ਬਰਾਊਜ਼ਰ ਚੁਣੇ ਫ਼ੋਲਡਰ ਦਾ ਪੂਰਾ ਮਾਰਗ ਨਹੀਂ ਦੱਸਦਾ; ਇਹ ਪੰਨਾ ਉਸ ਦੀ ਸਮੱਗਰੀ ਵਿਖਾਉਂਦਾ ਹੈ।',
      fetchFailHint: 'ਬੇਨਤੀ ਰੋਕੀ ਗਈ (ਨੈੱਟਵਰਕ/CORS): ਲਾਗਇਨ ਕੀਤੀ carnetsante.gouv.qc.ca ਟੈਬ ’ਤੇ ਰਹੋ, ਰਿਫਰੈਸ਼ ਕਰੋ ਤੇ ਦੁਬਾਰਾ ਕੋਸ਼ਿਸ਼ ਕਰੋ',
      busy: 'ਇੱਕ ਕੰਮ ਪਹਿਲਾਂ ਹੀ ਜਾਰੀ ਹੈ',
      cancelled: 'ਰੱਦ ਕੀਤਾ',
      cancelling: 'ਰੱਦ ਕੀਤਾ ਜਾ ਰਿਹਾ ਹੈ…',
      labsGateOff: 'ਲੈਬ ਭਾਗ ਤੁਹਾਡੇ ਲਈ ਉਪਲਬਧ ਨਹੀਂ — ਛੱਡਿਆ',
      grpLocation: 'ਸੰਭਾਲਣ ਦੀ ਥਾਂ',
      grpNaming: 'ਫ਼ੋਲਡਰ ਅਤੇ ਫ਼ਾਈਲ ਨਾਮ',
      grpBehavior: 'ਡਾਊਨਲੋਡ ਵਿਕਲਪ',
      loading: 'ਲੋਡ ਹੋ ਰਿਹਾ ਹੈ…',
      filesCounted: '{n} ਫ਼ਾਈਲਾਂ',
      privacy: 'ਡਾਟਾ ਸਿਰਫ਼ ਤੁਹਾਡੇ ਬਰਾਊਜ਼ਰ ਅਤੇ ਸਰਕਾਰੀ ਸਾਈਟ ਵਿਚਕਾਰ ਜਾਂਦਾ ਹੈ।',
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

  // 文字走向：阿拉伯语界面需 dir="rtl"，其余语言 LTR
  const RTL_LANGS = ['ar'];
  function isRtl(lang) { return RTL_LANGS.indexOf(lang) !== -1; }

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
    buildPeriodOptions: buildPeriodOptions,
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
    isRtl: isRtl,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.CSHCore = api;
})(typeof self !== 'undefined' ? self : globalThis);
