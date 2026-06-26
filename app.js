/**
 * 運転日誌 PWA フロントエンド
 *
 * 設計メモ:
 *  - 単一ページ、ハッシュルーティング（#/list, #/new, ...）
 *  - 設定（URL・トークン・自分の社員ID）は localStorage
 *  - 車種マスタなどキャッシュは IndexedDB
 *  - 未送信の入力もIndexedDBに溜め、オンライン復帰時に自動送信
 *  - GAS への POST は Content-Type: text/plain で送り、CORS preflightを回避
 */

const APP_VERSION = '0.14.9-poc';
const LS_URL = 'unten.gas_url';
const LS_TOKEN = 'unten.token';
const LS_USER = 'unten.user_id';
const LS_USER_NAME = 'unten.user_name';

// v0.14.0: 管理者パスワード認証
// adminToken は sessionStorage に保持＝アプリを閉じるとクリア（門田さんの選択「毎回入力」）。
const SS_ADMIN_TOKEN = 'unten.admin_token';
function getAdminToken() { try { return sessionStorage.getItem(SS_ADMIN_TOKEN) || ''; } catch (_) { return ''; } }
function setAdminToken(v) { try { sessionStorage.setItem(SS_ADMIN_TOKEN, v); } catch (_) {} }
function clearAdminToken() { try { sessionStorage.removeItem(SS_ADMIN_TOKEN); } catch (_) {} }

// v0.14.0: 運転者ごとの「前回使った車両」を記憶（localStorage、運転者IDごと）
// v0.14.2: 車種IDだけでなく、その車種の最新到着後メータも合わせて {v, m} で保存。
//   旧形式（車種IDの文字列のみ）も読めるよう後方互換。返り値: {v, m} or null
const LS_LAST_VEHICLE_PREFIX = 'unten.last_vehicle.';
function getLastVehicleForDriver(driverId) {
  try {
    const raw = localStorage.getItem(LS_LAST_VEHICLE_PREFIX + driverId) || '';
    if (!raw) return null;
    if (raw.charAt(0) === '{') { const o = JSON.parse(raw); return { v: String(o.v || ''), m: o.m }; }
    return { v: raw, m: '' }; // 旧形式（車種IDのみ）
  } catch (_) { return null; }
}
function setLastVehicleForDriver(driverId, vehicleId, meter) {
  try {
    if (driverId && vehicleId) {
      localStorage.setItem(LS_LAST_VEHICLE_PREFIX + driverId, JSON.stringify({ v: String(vehicleId), m: (meter == null ? '' : meter) }));
    }
  } catch (_) {}
}

// ===== v0.10.5 アプリ本体(APK)更新通知 =====
const LS_APK_INSTALLED = 'unten.apk_installed';
const LS_APK_DISMISS = 'unten.apk_dismissed';
const APK_BASELINE = '0.10.1'; // 現在配布済みのAPK（?apk未付与の旧APK向けの初期値）
const APK_MANIFEST_URL = './apk-latest.json';
const APK_PKG = 'jp.co.nippatech.untennisshi';

function isRunningInApk() {
  try {
    if (String(document.referrer || '').indexOf('android-app://' + APK_PKG) === 0) return true;
  } catch (_) {}
  const standalone = window.matchMedia && window.matchMedia('(display-mode: standalone)').matches;
  const isAndroid = /Android/i.test(navigator.userAgent || '');
  return !!(standalone && isAndroid);
}
function parseApkParam() {
  try { const m = location.search.match(/[?&]apk=([^&]+)/); return m ? decodeURIComponent(m[1]) : ''; }
  catch (_) { return ''; }
}
function cmpVer(a, b) {
  const na = String(a || '0').replace(/[^0-9.].*$/, '').split('.').map(n => parseInt(n, 10) || 0);
  const nb = String(b || '0').replace(/[^0-9.].*$/, '').split('.').map(n => parseInt(n, 10) || 0);
  const len = Math.max(na.length, nb.length);
  for (let i = 0; i < len; i++) { const x = na[i] || 0, y = nb[i] || 0; if (x > y) return 1; if (x < y) return -1; }
  return 0;
}
function getInstalledApkVersion() {
  const baked = parseApkParam();
  if (baked) { try { localStorage.setItem(LS_APK_INSTALLED, baked); } catch (_) {} return baked; }
  let v = '';
  try { v = localStorage.getItem(LS_APK_INSTALLED) || ''; } catch (_) {}
  if (!v) { v = APK_BASELINE; try { localStorage.setItem(LS_APK_INSTALLED, v); } catch (_) {} }
  return v;
}
async function fetchApkManifest() {
  const url = APK_MANIFEST_URL + (APK_MANIFEST_URL.indexOf('?') >= 0 ? '&' : '?') + 't=' + Date.now();
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error('manifest HTTP ' + res.status);
  return res.json();
}
function showUpdateBanner(manifest) {
  const banner = document.getElementById('update-banner');
  if (!banner) return;
  const dl = document.getElementById('update-dl');
  const txt = document.getElementById('update-text');
  const dateStr = manifest.date ? `（${manifest.date}）` : '';
  txt.textContent = `新しいアプリ版 v${manifest.latestVersion}${dateStr} があります`;
  dl.href = manifest.url || '#';
  banner.hidden = false;
  document.getElementById('update-dismiss').onclick = () => {
    try { localStorage.setItem(LS_APK_DISMISS, manifest.latestVersion); } catch (_) {}
    banner.hidden = true;
  };
}
async function checkApkUpdate(opts) {
  opts = opts || {};
  const inApk = isRunningInApk();
  if (!inApk && !opts.force) return { skipped: true, reason: 'not_in_apk' };
  let manifest;
  try { manifest = await fetchApkManifest(); } catch (e) { return { error: String(e && e.message || e) }; }
  const installed = getInstalledApkVersion();
  const latest = manifest.latestVersion || '0';
  const hasUpdate = cmpVer(latest, installed) > 0;
  let dismissed = '';
  try { dismissed = localStorage.getItem(LS_APK_DISMISS) || ''; } catch (_) {}
  if (inApk && hasUpdate && dismissed !== latest) showUpdateBanner(manifest);
  return { inApk, installed, latest, hasUpdate, manifest };
}

// Phase B: 自分の権限情報（me APIの結果）をメモリにキャッシュ
// v0.14.0: serverEligible（userIdが管理者IDか）と adminPasswordSet（GASにパスワード設定済か）を分離。
//   実効的な管理者権限 me.isAdmin = serverEligible && (パスワード未設定 or adminToken保持)。
const me = {
  isAdmin: false,
  serverEligible: false,
  adminPasswordSet: false,
  dualDb: false, // v0.14.6: 移行期間の二重DB参照が有効か（メーター連続性）
  editWindowDays: 30,
  loaded: false,
};
// 実効的な管理者フラグを再計算（serverEligible / adminPasswordSet / adminToken から）
function recomputeAdmin() {
  if (!me.serverEligible) { me.isAdmin = false; return; }
  if (!me.adminPasswordSet) { me.isAdmin = true; return; } // 移行期間：パスワード未設定なら従来通り
  me.isAdmin = !!getAdminToken();
}
async function fetchMe() {
  if (!cfg.url || !cfg.token || !cfg.userId) return;
  try {
    const j = await apiGet('me', { userId: cfg.userId });
    me.serverEligible = !!j.isAdmin;
    me.adminPasswordSet = !!j.adminPasswordSet;
    me.dualDb = !!j.dualDb;
    me.editWindowDays = j.editWindowDays || 30;
    me.loaded = true;
    recomputeAdmin();
  } catch (e) {
    console.warn('fetchMe failed', e);
  }
}
// Phase G: 社員マスタ（動的取得）
let staffList = []; // [{社員ID, 氏名, 退職フラグ}]
async function fetchStaff(includeRetired = true) {
  // v0.9.7: デフォルトは全件取得（退職含む）。activeStaff()で在職フィルタ。
  // activeCheckers()が退職判定するために staffList に退職者情報が必要。
  try {
    const params = includeRetired ? { all: 'true' } : {};
    const j = await apiGet('staff', params);
    staffList = j.data || [];
    dbPut('cache', { key: 'staff_list', value: staffList, at: Date.now() }).catch(() => {});
    return staffList;
  } catch (e) {
    // フォールバック: キャッシュ → STAFF_FALLBACK
    const c = await dbGet('cache', 'staff_list');
    if (c?.value && c.value.length > 0) {
      staffList = c.value;
    } else {
      staffList = STAFF_FALLBACK.map(s => ({ '社員ID': s.id, '氏名': s.name, '退職フラグ': false }));
    }
    return staffList;
  }
}
// 表示用の在職者だけのリスト
function activeStaff() {
  return staffList.filter(s => !s['退職フラグ']);
}

// v0.9.6: 確認者リストから退職者を除外
// 「アルコールチェック」シートには姓のみ（山田、神原…）が入っており、
// 社員マスタは氏名フルネーム（山田 賢哉）。姓部分でマッチング。
// 全員が退職している姓だけ除外。「その他」など社員でない選択肢は残す。
// v0.9.8: 引退車種の判定（部分一致・大文字小文字無視）
const RETIRED_VEHICLE_KEYWORDS = ['ファイター', 'TONEZ', 'レンタカー'];
function isActiveVehicle(v) {
  const name = String(v['車種'] || '').trim();
  if (!name) return false; // 空欄除外
  const up = name.toUpperCase();
  return !RETIRED_VEHICLE_KEYWORDS.some(kw => up.includes(kw.toUpperCase()));
}

function activeCheckers() {
  // 社員マスタの在職者の姓のセット
  const activeLastNames = new Set(
    activeStaff().map(s => {
      const name = String(s['氏名'] || '');
      // 全角・半角スペースで分割して最初の要素（姓）
      return name.split(/[\s\u3000]+/)[0].trim();
    }).filter(Boolean)
  );
  // 退職者の姓のセット（在職者がいない姓だけが「全員退職」）
  const retiredLastNames = new Set();
  for (const s of staffList) {
    if (s['退職フラグ']) {
      const name = String(s['氏名'] || '');
      const last = name.split(/[\s\u3000]+/)[0].trim();
      if (last && !activeLastNames.has(last)) {
        retiredLastNames.add(last);
      }
    }
  }
  // checkersList から除外
  return checkersList.filter(c => {
    const checker = String(c['確認者'] || '').trim();
    if (!checker) return false;
    // 「その他」「その他（仮）」など社員ではない選択肢は常に残す
    if (checker.includes('その他') || checker.includes('（仮）')) return true;
    // 社員マスタとの姓マッチ：在職者の姓に含まれる or 退職者の姓ではない場合は表示
    // つまり「明示的に全員退職している姓」だけを除外
    if (retiredLastNames.has(checker)) return false;
    return true;
  });
}

// Phase H: アルコールチェック確認者リスト
let checkersList = []; // [{ID, 確認者}]
async function fetchCheckers() {
  try {
    const j = await apiGet('checkers');
    checkersList = (j.data && j.data.rows) ? j.data.rows : [];
    dbPut('cache', { key: 'checkers_list', value: checkersList, at: Date.now() }).catch(() => {});
    return checkersList;
  } catch (e) {
    const c = await dbGet('cache', 'checkers_list');
    checkersList = c?.value || [];
    return checkersList;
  }
}

// レコードを「自分が編集可能か」判定（PWA側）
function canEdit(record) {
  if (me.isAdmin) return true;
  if (!record) return false;
  const driver = String(record['運転者'] || '');
  if (driver !== String(cfg.userId)) return false;
  const d = record['日時'] ? new Date(record['日時']) : null;
  if (!d || isNaN(d)) return false;
  const diffDays = (Date.now() - d.getTime()) / 86400000;
  return diffDays <= me.editWindowDays;
}

// 万一 social マスタAPIが失敗したときのフォールバック（最低限：管理者 1名のみ）
const STAFF_FALLBACK = [
  { id: 'NIP006', name: '門田' },
];

// v0.9.10: 「門田」は UI 上「管理者」と表示する（社員マスタは触らない＝過去データも維持）
// 社員管理画面（renderStaff）だけは退職処理の混乱を防ぐため実名のまま。
const ADMIN_DISPLAY_NAME = '管理者';
const ADMIN_RAW_KEYS = new Set(['NIP006']);
function displayStaffName(raw) {
  const s = String(raw || '').trim();
  if (!s) return s;
  if (ADMIN_RAW_KEYS.has(s)) return ADMIN_DISPLAY_NAME;
  // 氏名先頭が「門田」（単独 or 「門田 ◯◯」など）も管理者扱い
  if (s === '門田' || s.startsWith('門田 ') || s.startsWith('門田　')) return ADMIN_DISPLAY_NAME;
  return s;
}

// v0.12.0: 到着後メーター異常値チェック（禁止=block / 警告=warn）
const DIST_BLOCK_MAX = 2000;
const DIST_WARN_MAX = 500;
function validateDistance(startRaw, endRaw) {
  const s = parseFloat(startRaw), e = parseFloat(endRaw);
  if (isNaN(s) || isNaN(e)) return { level: 'ok' };
  const dist = e - s;
  if (dist < 0) return { level: 'block', dist, message: `到着後メーター（${e}）が発車前メーター（${s}）より小さいです。メーターは戻らないので数値を確認してください。` };
  if (dist > DIST_BLOCK_MAX) return { level: 'block', dist, message: `走行距離が ${dist.toLocaleString()}km になっています。2000kmを超えるため登録できません（桁の打ち間違いの可能性があります）。` };
  if (dist === 0) return { level: 'warn', dist, message: `走行距離が 0km です（発車前と到着後が同じ）。このまま登録しますか？` };
  if (dist > DIST_WARN_MAX) return { level: 'warn', dist, message: `走行距離が ${dist.toLocaleString()}km と大きめです。このまま登録しますか？` };
  return { level: 'ok', dist };
}

// ----- IndexedDB ヘルパ -----
const DB_NAME = 'unten_nisshi';
const DB_VERSION = 1;
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('pending')) {
        db.createObjectStore('pending', { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains('cache')) {
        db.createObjectStore('cache', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function dbAdd(store, value) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    const r = tx.objectStore(store).add(value);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function dbPut(store, value) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    const r = tx.objectStore(store).put(value);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function dbGet(store, key) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readonly');
    const r = tx.objectStore(store).get(key);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function dbAll(store) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readonly');
    const r = tx.objectStore(store).getAll();
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function dbDel(store, key) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    const r = tx.objectStore(store).delete(key);
    r.onsuccess = () => res();
    r.onerror = () => rej(r.error);
  });
}

// v0.10.6: 社内配布APK向けに接続設定を既定値として埋め込み（初回設定を省略、入力者選択から開始）
const DEFAULT_GAS_URL = 'https://script.google.com/macros/s/AKfycbyAKtGvfOWv98qpeNQhBfOTOaRQX5FNk_XPrZoCw24KR4U8ew7kqlS3vjiqMUW3HDrPMQ/exec';
const DEFAULT_TOKEN = 'nip-unten-poc-2026-a8c3f9e2';

// ----- 設定 -----
const cfg = {
  get url() { return localStorage.getItem(LS_URL) || DEFAULT_GAS_URL; },
  set url(v) { localStorage.setItem(LS_URL, v); },
  get token() { return localStorage.getItem(LS_TOKEN) || DEFAULT_TOKEN; },
  set token(v) { localStorage.setItem(LS_TOKEN, v); },
  get userId() { return localStorage.getItem(LS_USER) || ''; },
  set userId(v) { localStorage.setItem(LS_USER, v); },
  get userName() { return localStorage.getItem(LS_USER_NAME) || ''; },
  set userName(v) { localStorage.setItem(LS_USER_NAME, v); },
};

// ----- API クライアント -----
async function apiGet(action, params = {}) {
  if (!cfg.url || !cfg.token) throw new Error('未設定: GAS URL / Token');
  const u = new URL(cfg.url);
  u.searchParams.set('action', action);
  u.searchParams.set('token', cfg.token);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  // v0.14.0: 管理者トークンがあれば自動付与（管理者GETの認可に使用）
  const at = getAdminToken();
  if (at) u.searchParams.set('adminToken', at);
  const r = await fetch(u.toString(), { method: 'GET' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || 'API failed');
  return j;
}
async function apiPost(action, payload, extra = {}) {
  if (!cfg.url || !cfg.token) throw new Error('未設定: GAS URL / Token');
  const r = await fetch(cfg.url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    // v0.14.0: 管理者トークンを自動付与（extra で上書き可能）
    body: JSON.stringify({ token: cfg.token, action, payload, adminToken: getAdminToken(), ...extra }),
    redirect: 'follow',
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || 'API failed');
  return j;
}

// ----- v0.14.0: 管理者ログイン -----
// パスワードをGASに送って照合。成功で adminToken を受け取り sessionStorage に保持する。
async function adminLogin(password) {
  const j = await apiPost('admin_login', { password }); // 失敗時は apiPost が throw
  if (j.adminToken) {
    setAdminToken(j.adminToken);
    recomputeAdmin();
  }
  return j;
}
// 管理者ログインのモーダルを表示。成功=true / キャンセル=false を返す。
function showAdminLogin() {
  return new Promise((resolve) => {
    const ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:1000;padding:16px;';
    ov.innerHTML = `
      <div class="card" style="max-width:340px;width:100%;margin:0;">
        <h2 style="margin-top:0;">管理者ログイン</h2>
        <p class="hint">管理者機能を使うにはパスワードが必要です。</p>
        <label>パスワード
          <input id="adm-pw" type="password" autocomplete="off">
        </label>
        <div class="row" style="margin-top:8px;">
          <button id="adm-cancel" class="ghost" type="button">キャンセル</button>
          <button id="adm-ok" class="primary" type="button">ログイン</button>
        </div>
        <p id="adm-msg" class="msg"></p>
      </div>`;
    document.body.appendChild(ov);
    const pw = ov.querySelector('#adm-pw');
    const msg = ov.querySelector('#adm-msg');
    const okBtn = ov.querySelector('#adm-ok');
    const close = (val) => { ov.remove(); resolve(val); };
    ov.querySelector('#adm-cancel').onclick = () => close(false);
    const submit = async () => {
      const v = pw.value;
      if (!v) { msg.className = 'msg ng'; msg.textContent = 'パスワードを入力してください'; return; }
      msg.className = 'msg'; msg.textContent = '確認中…';
      okBtn.disabled = true;
      try {
        await adminLogin(v);
        close(true);
      } catch (e) {
        msg.className = 'msg ng'; msg.textContent = 'ログイン失敗: ' + e.message;
        okBtn.disabled = false; pw.value = ''; pw.focus();
      }
    };
    okBtn.onclick = submit;
    pw.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
    setTimeout(() => pw.focus(), 50);
  });
}

// ----- ルーター -----
const routes = {
  '#/config': renderConfig,
  '#/picker': renderPicker,
  '#/list': renderList,
  '#/new': renderForm,
  '#/bulk': renderBulk,
  '#/staff': renderStaff,
  '#/pdf': renderPdf,
  '#/settings': renderSettings,
};
function go(hash) {
  if (location.hash !== hash) location.hash = hash;
  else handleRoute();
}
function handleRoute() {
  const v = document.getElementById('view');
  v.innerHTML = '';
  // ルーティング前のガード: 設定または社員ID未設定なら強制誘導
  if (!cfg.url || !cfg.token) {
    document.getElementById('page-title').textContent = '初回設定';
    return renderConfig();
  }
  if (!cfg.userId) {
    document.getElementById('page-title').textContent = '入力者選択';
    return renderPicker();
  }
  // Phase B: #/edit/<dataId> ルートを動的解釈
  const editMatch = location.hash.match(/^#\/edit\/(.+)$/);
  if (editMatch) {
    renderForm({ mode: 'edit', dataId: decodeURIComponent(editMatch[1]) });
  } else {
    const fn = routes[location.hash] || renderList;
    fn();
  }
  // ナビ active 表示 + Phase E: 管理者用ボタンの表示制御
  document.querySelectorAll('.navbtn').forEach(b => {
    b.classList.toggle('active', b.dataset.route === location.hash);
    if (b.classList.contains('admin-only')) {
      b.hidden = !me.isAdmin;
    }
  });
  // 戻るボタン制御
  document.getElementById('btn-back').hidden = (location.hash === '' || location.hash === '#/list' || location.hash === '#');
}

// ----- 共通 UI 要素 -----
function setTitle(t) { document.getElementById('page-title').textContent = t; }
function whoLabel() {
  const w = document.getElementById('who');
  w.textContent = cfg.userName ? displayStaffName(cfg.userName) : '';
}
function setNetStatus() {
  const el = document.getElementById('net-status');
  if (navigator.onLine) {
    el.classList.remove('net-offline');
    el.classList.add('net-online');
    el.title = 'オンライン';
  } else {
    el.classList.remove('net-online');
    el.classList.add('net-offline');
    el.title = 'オフライン';
  }
}

// ----- ビュー: 設定 -----
function renderConfig() {
  setTitle('初回設定');
  const view = document.getElementById('view');
  view.appendChild(document.getElementById('tpl-config').content.cloneNode(true));
  document.getElementById('cfg-url').value = cfg.url;
  document.getElementById('cfg-token').value = cfg.token;
  const msg = document.getElementById('cfg-msg');

  document.getElementById('cfg-test').onclick = async () => {
    const url = document.getElementById('cfg-url').value.trim();
    const tk = document.getElementById('cfg-token').value.trim();
    if (!url || !tk) { msg.className = 'msg ng'; msg.textContent = 'URL とトークン両方が必要です'; return; }
    msg.className = 'msg'; msg.textContent = 'テスト中…';
    // 一時保存して試す
    const oldU = cfg.url, oldT = cfg.token;
    cfg.url = url; cfg.token = tk;
    try {
      const j = await apiGet('list', { limit: 1 });
      msg.className = 'msg ok';
      msg.textContent = `OK（${j.count}件取得）`;
    } catch (e) {
      cfg.url = oldU; cfg.token = oldT;
      msg.className = 'msg ng';
      msg.textContent = '失敗: ' + e.message;
    }
  };

  document.getElementById('cfg-save').onclick = () => {
    const url = document.getElementById('cfg-url').value.trim();
    const tk = document.getElementById('cfg-token').value.trim();
    if (!url || !tk) { msg.className = 'msg ng'; msg.textContent = 'URL とトークン両方が必要です'; return; }
    cfg.url = url; cfg.token = tk;
    msg.className = 'msg ok'; msg.textContent = '保存しました';
    setTimeout(() => go('#/picker'), 600);
  };
}

// ----- ビュー: 社員選択 -----
async function renderPicker() {
  setTitle('入力者選択');
  const view = document.getElementById('view');
  view.appendChild(document.getElementById('tpl-picker').content.cloneNode(true));
  const list = document.getElementById('picker-list');
  // v0.9.5: 社員マスタの在職者から動的に選べるように
  if (staffList.length === 0) {
    list.innerHTML = '<p class="hint">社員マスタを読み込み中…</p>';
    await fetchStaff();
  }
  list.innerHTML = '';
  const visible = activeStaff();
  if (visible.length === 0) {
    list.innerHTML = '<p class="msg ng">社員マスタが取得できませんでした。管理者に連絡してください。</p>';
    return;
  }
  visible.forEach(s => {
    const id = String(s['社員ID']);
    const rawName = String(s['氏名'] || id);
    const name = displayStaffName(rawName); // v0.9.10: 門田→管理者
    const isAdminEntry = ADMIN_RAW_KEYS.has(id); // v0.14.0: 管理者はパスワード要求
    const b = document.createElement('button');
    // 社員IDが氏名と同じ場合はID表示を省略
    b.innerHTML = (id === name)
      ? escape(name)
      : `${escape(name)}<span class="pid">${escape(id)}</span>`;
    if (isAdminEntry) b.innerHTML += '<span class="pid">🔒</span>';
    b.onclick = async () => {
      if (isAdminEntry) {
        // パスワード設定済みかを確認（未設定なら移行期間としてパスワードなしで通す）
        let pwSet = false;
        try { const probe = await apiGet('me', { userId: id }); pwSet = !!probe.adminPasswordSet; } catch (_) {}
        if (pwSet) {
          const ok = await showAdminLogin();
          if (!ok) return; // ログインしないと管理者にはなれない（選択をキャンセル）
        }
      } else {
        clearAdminToken(); // 一般ユーザーに切替えたら管理者状態を解除
      }
      cfg.userId = id;
      cfg.userName = name;
      whoLabel();
      await fetchMe(); // 自分の権限を取得（adminToken と合わせて me.isAdmin を再計算）
      go('#/list');
    };
    list.appendChild(b);
  });
}

// ----- ビュー: 一覧 -----
let _showDeleted = false; // Phase D: 管理者用「削除済を表示」トグル状態
async function renderList() {
  setTitle('運転日誌');
  const view = document.getElementById('view');
  view.appendChild(document.getElementById('tpl-list').content.cloneNode(true));
  const items = document.getElementById('list-items');
  const msg = document.getElementById('list-msg');
  const countEl = document.getElementById('list-count');
  const toolbar = document.querySelector('.list-toolbar');

  // v0.14.5: 非管理者（管理者ログアウト/別ユーザー選択後）になったら「削除済表示」を解除。
  // トグルが非表示になり解除手段が無くなる＆showDeletedを送り続けるスタックを防ぐ。
  if (!me.isAdmin) _showDeleted = false;

  // Phase D: 管理者のみ「削除済を表示」トグル
  if (me.isAdmin && toolbar && !toolbar.querySelector('.admin-toggle')) {
    const toggleLabel = document.createElement('label');
    toggleLabel.className = 'admin-toggle';
    toggleLabel.innerHTML = '<input type="checkbox" id="chk-show-deleted"> 削除済を表示';
    toolbar.insertBefore(toggleLabel, toolbar.querySelector('#btn-refresh'));
    const chk = toggleLabel.querySelector('#chk-show-deleted');
    chk.checked = _showDeleted;
    chk.onchange = () => { _showDeleted = chk.checked; refresh(); };
  }

  // v0.10.1: ページング状態（「次の20件」ボタン）
  const PAGE_SIZE = 20;
  let loaded = 0;     // 表示済み件数（サーバー側レコードのみ）
  let total = 0;      // サーバー側の総件数
  let pendingCount = 0;

  // 「次の20件」ボタンを一覧の下に動的生成
  const moreBtn = document.createElement('button');
  moreBtn.className = 'ghost';
  moreBtn.style.cssText = 'display:block;width:100%;margin:10px 0;';
  moreBtn.textContent = '次の20件を表示';
  moreBtn.hidden = true;
  items.after(moreBtn);

  const updateCount = () => {
    const suffix = _showDeleted ? '（削除済含む）' : '';
    countEl.textContent = `全 ${total} 件中 ${loaded} 件表示${suffix}${pendingCount > 0 ? `（未送信 ${pendingCount}）` : ''}`;
  };

  const fetchPage = async (offset) => {
    const params = { limit: PAGE_SIZE, offset: offset };
    if (_showDeleted) params.showDeleted = 'true';
    return apiGet('list', params);
  };

  const loadMore = async () => {
    moreBtn.disabled = true;
    moreBtn.textContent = '読み込み中…';
    try {
      const j = await fetchPage(loaded);
      j.data.forEach(d => items.appendChild(renderLogCard(d, false)));
      loaded += j.count;
      total = j.total ?? total;
      moreBtn.hidden = !j.hasMore;
      updateCount();
    } catch (e) {
      msg.className = 'msg ng';
      msg.textContent = `読み込み失敗: ${e.message}`;
    } finally {
      moreBtn.disabled = false;
      moreBtn.textContent = '次の20件を表示';
    }
  };
  moreBtn.onclick = loadMore;

  const refresh = async () => {
    msg.className = 'msg'; msg.textContent = '読み込み中…';
    items.innerHTML = '';
    loaded = 0; total = 0;
    moreBtn.hidden = true;
    // 未送信表示
    const pending = await dbAll('pending');
    pendingCount = pending.length;
    if (pending.length > 0) {
      const banner = document.getElementById('pending-banner');
      banner.hidden = false;
      document.getElementById('pending-count').textContent = pending.length;
      pending.forEach(p => items.appendChild(renderLogCard(p.payload, true)));
    } else {
      document.getElementById('pending-banner').hidden = true;
    }
    // サーバーから取得（Phase D: showDeleted を引き渡し / v0.10.1: 1ページ目）
    try {
      const j = await fetchPage(0);
      j.data.forEach(d => items.appendChild(renderLogCard(d, false)));
      loaded = j.count;
      total = j.total ?? j.count;
      moreBtn.hidden = !j.hasMore;
      updateCount();
      msg.textContent = '';
      // キャッシュ（1ページ目のみ）
      dbPut('cache', { key: 'list_last', value: j.data, at: Date.now() }).catch(() => {});
    } catch (e) {
      msg.className = 'msg ng';
      msg.textContent = `オフラインまたは通信エラー: ${e.message}`;
      // キャッシュから表示
      const cached = await dbGet('cache', 'list_last');
      if (cached?.value) {
        countEl.textContent = `キャッシュ ${cached.value.length} 件（${pending.length} 件未送信）`;
        cached.value.forEach(d => items.appendChild(renderLogCard(d, false)));
      }
    }
  };

  document.getElementById('btn-refresh').onclick = refresh;
  document.getElementById('btn-sync').onclick = async () => {
    await syncPending();
    refresh();
  };
  refresh();
}
function renderLogCard(d, isPending) {
  const div = document.createElement('div');
  // Phase D: 削除済フラグ判定
  const delFlag = d['削除フラグ'];
  const isDeleted = (delFlag === true || delFlag === 'TRUE' || delFlag === 'true');
  div.className = 'log-item' + (isPending ? ' pending' : '') + (isDeleted ? ' deleted' : '');
  // v0.14.5: ユーザー由来の文字列は全て escape（運転者名・メータ等の未エスケープによるHTML注入を防ぐ）
  const date = escape(formatDate(d['日時']));
  const km = escape(String(d['走行距離（km)'] ?? d['走行距離(km)'] ?? '-'));
  const fuel = d['給油(L)'] ? ` / 給油 ${escape(String(d['給油(L)']))}L` : '';
  const driver = d['運転者'] ? ` / 運転者 ${escape(displayStaffName(d['運転者']))}` : '';
  const dataId = d['データID'] || '';
  // 削除済は管理者のみ「復活」ボタン、編集/削除は出さない
  const editable = !isPending && dataId && !isDeleted && canEdit(d);
  const restorable = !isPending && dataId && isDeleted && me.isAdmin;
  let actionsHtml = '';
  if (editable) {
    actionsHtml = `<div class="actions"><button class="ghost small" data-edit="${escape(dataId)}">編集</button><button class="ghost small danger" data-del="${escape(dataId)}">削除</button></div>`;
  } else if (restorable) {
    actionsHtml = `<div class="actions"><span class="deleted-badge">削除済</span><button class="ghost small" data-restore="${escape(dataId)}">復活</button></div>`;
  }
  div.innerHTML = `
    <div class="top">
      <span>${date}${isPending ? ' <b style="color:#f1a500;">未送信</b>' : ''}${isDeleted ? ' <b style="color:#b3261e;">削除済</b>' : ''}</span>
      <span>${d['ETC 使用'] || d['ETC\n使用'] ? 'ETC ✓' : ''}</span>
    </div>
    <div class="vehicle">${escape(d['車種表示'] || '車種ID:' + d['車種'])}</div>
    <div class="nums">
      <b>${km} km</b> ／ ${escape(String(d['発車前メータ'] || '?'))} → ${escape(String(d['到着後メータ'] || '?'))}${fuel}${driver}
    </div>
    ${actionsHtml}
  `;
  if (editable) {
    div.querySelector('[data-edit]').onclick = (ev) => {
      ev.preventDefault();
      go('#/edit/' + encodeURIComponent(dataId));
    };
    div.querySelector('[data-del]').onclick = async (ev) => {
      ev.preventDefault();
      await deleteRecord(dataId, d);
    };
  } else if (restorable) {
    div.querySelector('[data-restore]').onclick = async (ev) => {
      ev.preventDefault();
      await restoreRecord(dataId, d);
    };
  }
  return div;
}

// Phase D: 削除済レコードを復活（管理者のみ）
async function restoreRecord(dataId, record) {
  const label = `${formatDate(record['日時'])} / ${record['車種表示'] || '車種ID:' + record['車種']}`;
  if (!confirm(`このレコードを復活させますか？\n\n${label}`)) return;
  if (!navigator.onLine) {
    alert('オフラインでは復活できません。');
    return;
  }
  try {
    await apiPost('delete_log', { 'データID': dataId, restore: true }, { userId: cfg.userId });
    if (location.hash === '#/list' || location.hash === '' || location.hash === '#') {
      handleRoute();
    } else {
      go('#/list');
    }
  } catch (e) {
    alert('復活失敗: ' + e.message);
  }
}

// Phase C: レコード論理削除（確認ダイアログ付き）
async function deleteRecord(dataId, record) {
  const label = `${formatDate(record['日時'])} / ${record['車種表示'] || '車種ID:' + record['車種']}`;
  if (!confirm(`このレコードを削除しますか？\n\n${label}\n\n削除しても管理者が後で復活できます。`)) return;
  if (!navigator.onLine) {
    alert('オフラインでは削除できません。オンラインになってからお試しください。');
    return;
  }
  try {
    await apiPost('delete_log', { 'データID': dataId }, { userId: cfg.userId });
    if (location.hash === '#/list' || location.hash === '' || location.hash === '#') {
      handleRoute();
    } else {
      go('#/list');
    }
  } catch (e) {
    alert('削除失敗: ' + e.message);
  }
}

// v0.14.4: 行先サジェストを「外側タップ」で閉じる（blur依存をやめてリストをスクロール可能に）。
//   document に一度だけ登録。タップ位置が属さない .dest-row のパネルだけ閉じる。
let _destOutsideBound = false;
function bindDestOutsideClose() {
  if (_destOutsideBound) return;
  _destOutsideBound = true;
  document.addEventListener('pointerdown', (ev) => {
    document.querySelectorAll('.dest-row').forEach(r => {
      if (!r.contains(ev.target)) {
        const p = r.querySelector('.dest-suggest');
        if (p) p.hidden = true;
      }
    });
  });
}

// ----- ビュー: 入力フォーム（新規 / 編集 共用） -----
async function renderForm(opts = {}) {
  // Phase F: 管理者判定をフォーム描画前に確実に取得
  if (!me.loaded) {
    await fetchMe();
  }
  const mode = opts.mode || 'new';
  const editId = opts.dataId || '';
  const isEdit = mode === 'edit';
  setTitle(isEdit ? `編集 (ID: ${editId})` : '新規入力');
  const view = document.getElementById('view');
  view.appendChild(document.getElementById('tpl-form').content.cloneNode(true));
  const h2 = view.querySelector('h2');
  if (h2) h2.textContent = isEdit ? '編集' : '新規入力';
  const submitBtn = document.getElementById('btn-submit');
  if (submitBtn) submitBtn.textContent = isEdit ? '更新' : '登録';

  // 編集モード：対象レコード取得
  let editRecord = null;
  let editDestinations = [];
  if (isEdit) {
    try {
      const jl = await apiGet('list', { limit: 200 });
      editRecord = (jl.data || []).find(d => String(d['データID']) === String(editId));
      if (!editRecord) {
        alert('レコードが見つかりません: ' + editId);
        return go('#/list');
      }
      if (!canEdit(editRecord)) {
        alert('このレコードは編集できません（期間外または他人の入力）');
        return go('#/list');
      }
      try {
        const jd = await apiGet('destinations_for', { dataId: editId });
        editDestinations = jd.data || [];
      } catch (_) { editDestinations = []; }
    } catch (e) {
      alert('レコード取得失敗: ' + e.message);
      return go('#/list');
    }
  }

  // 日付の初期値
  const today = new Date().toISOString().slice(0, 10);
  if (isEdit && editRecord && editRecord['日時']) {
    const d = new Date(editRecord['日時']);
    if (!isNaN(d)) {
      const ymd = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      document.getElementById('f-date').value = ymd;
    } else {
      document.getElementById('f-date').value = today;
    }
  } else {
    document.getElementById('f-date').value = today;
  }

  // Phase F/G: 運転者ドロップダウン構築（社員マスタから動的取得、退職者除外）
  if (staffList.length === 0) await fetchStaff();
  const driverSel = document.getElementById('f-driver');
  const driverHint = document.getElementById('f-driver-hint');
  // 編集モードでは既存運転者が退職済でも選択できるよう、退職含むリストも考慮
  const editingDriver = isEdit && editRecord ? String(editRecord['運転者'] || '') : '';
  let visibleStaff = activeStaff();
  if (editingDriver && !visibleStaff.find(s => String(s['社員ID']) === editingDriver)) {
    const retiredMatch = staffList.find(s => String(s['社員ID']) === editingDriver);
    if (retiredMatch) visibleStaff = [retiredMatch, ...visibleStaff];
  }
  driverSel.innerHTML = '<option value="">選択</option>' + visibleStaff.map(s => {
    const id = String(s['社員ID']);
    const name = displayStaffName(String(s['氏名'] || id)); // v0.9.10
    const isSelected = (isEdit && editingDriver === id) || (!isEdit && cfg.userId === id);
    const retiredLabel = s['退職フラグ'] ? '【退職済】' : '';
    return `<option value="${escape(id)}"${isSelected ? ' selected' : ''}>${escape(name)}${retiredLabel}</option>`;
  }).join('');
  // 編集時：運転者は変更不可（GAS update_log 仕様）
  // 一般ユーザー：自分以外を選べないようロック
  if (isEdit) {
    driverSel.disabled = true;
    driverHint.textContent = '（編集時は変更不可）';
  } else if (!me.isAdmin) {
    driverSel.disabled = true;
    driverHint.textContent = '（自分以外を選ぶには管理者権限が必要）';
  } else {
    driverHint.textContent = '（管理者：代理入力で他人を選べます）';
  }

  // 車種オプション読み込み（キャッシュ優先）
  const sel = document.getElementById('f-vehicle');
  sel.innerHTML = '<option value="">読み込み中…</option>';
  let vehicles = [];
  try {
    const j = await apiGet('vehicles');
    vehicles = j.data;
    dbPut('cache', { key: 'vehicles', value: vehicles, at: Date.now() }).catch(() => {});
  } catch (_) {
    const c = await dbGet('cache', 'vehicles');
    vehicles = c?.value || [];
  }
  sel.innerHTML = vehicles.length === 0
    ? '<option value="">（車種マスタが取得できません）</option>'
    : '<option value="">選択してください</option>';
  // v0.9.8: 引退車種＋空欄を除外。ただし編集モードで現在の車種が引退車種の場合は残す
  const editingVehicleId = isEdit && editRecord ? String(editRecord['車種'] || '') : '';
  const visibleVehicles = vehicles.filter(v => {
    if (isActiveVehicle(v)) return true;
    if (editingVehicleId && String(v.ID) === editingVehicleId) return true;
    return false;
  });
  visibleVehicles.forEach(v => {
    const opt = document.createElement('option');
    opt.value = v.ID;
    // 引退車種が編集時に出る場合はラベルに【引退】を付ける
    const isRetired = !isActiveVehicle(v);
    const baseLabel = `${v['車種'] || ''} / ${v['車輛番号'] || ''}`.trim().replace(/\s*\/\s*$/, '').replace(/^\s*\/\s*/, '');
    opt.textContent = isRetired ? `【引退】${baseLabel}` : baseLabel;
    opt.dataset.user = v['使用者'] || '';
    sel.appendChild(opt);
  });
  // 編集モード：既存値で各項目を埋める
  if (isEdit && editRecord) {
    if (editRecord['車種'] != null && editRecord['車種'] !== '') sel.value = String(editRecord['車種']);
    document.getElementById('f-start').value = editRecord['発車前メータ'] ?? '';
    document.getElementById('f-end').value = editRecord['到着後メータ'] ?? '';
    const etcVal = editRecord['ETC 使用'] ?? editRecord['ETC\n使用'];
    document.getElementById('f-etc').checked = (etcVal === true || etcVal === 'TRUE' || etcVal === 'true' || etcVal === 1);
    document.getElementById('f-fuel').value = editRecord['給油(L)'] ?? '';
    document.getElementById('f-alc').value = editRecord['アルコールチェック表示'] ?? '';
    document.getElementById('f-memo').value = editRecord['備考'] ?? '';
  }

  // Phase H: アルコールチェック確認者 datalist
  if (checkersList.length === 0) await fetchCheckers();
  const alcDl = document.getElementById('alc-options');
  if (alcDl) {
    alcDl.innerHTML = activeCheckers().map(c => `<option value="${escape(c['確認者'])}">`).join('');
  }
  // Phase H: 行先用 datalist は行追加時に構築する

  // Phase H/v0.9.2: 発車前メータ自動補完（新規時のみ）
  // 戦略: ①キャッシュから即時取得 ②並行で最新APIをfetch ③ハンドラ即登録
  // これによりGAS応答が遅くてもユーザーが車種を選んだ瞬間にキャッシュベースで動く
  let recentLogs = [];
  let recentLogsFetched = false; // 最新版が来たかどうか
  if (!isEdit) {
    // 1. キャッシュから即座に取得
    try {
      const cached = await dbGet('cache', 'list_last');
      if (cached?.value && Array.isArray(cached.value)) {
        recentLogs = cached.value;
      }
    } catch (_) {}
    // 2. 並行して最新を取りに行く（await しない）
    apiGet('list', { limit: 100 }).then(j => {
      if (j.data && j.data.length > 0) {
        recentLogs = j.data;
        recentLogsFetched = true;
        dbPut('cache', { key: 'list_last', value: j.data, at: Date.now() }).catch(() => {});
        // v0.14.0: 最新データで前回車両を再プリセット（キャッシュが空/古かった場合に効く）
        localPreset(driverSel.value || cfg.userId);
        // 既に車種が選ばれていてメータ未補完なら、メータだけ補完
        const startInput = document.getElementById('f-start');
        if (sel.value && (!startInput || startInput.value === '')) {
          sel.dispatchEvent(new Event('change'));
        }
      }
    }).catch(() => {});
  }
  // 3. v0.9.4: 手入力と自動入力を区別。ユーザーが手で打った値だけ保護、自動補完値は車種変更で上書き
  const startInputElem = document.getElementById('f-start');
  // 手入力検知：event.isTrusted=true はユーザー操作、=false は dispatchEvent
  startInputElem.addEventListener('input', (e) => {
    if (e.isTrusted) {
      startInputElem.dataset.userInput = '1';
    }
  });
  // v0.14.6: 移行期間だけ、選んだ車種の発車前メータを「新DB＋旧DB(AppSheet)の和集合」の
  //   最新到着メータで補正する（車両が両系にまたがってもメーターが不連続にならない）。
  //   recentLogs（新DBのみ・直近100件）の値を、サーバーの全DB照合値で上書きする。
  let _meterCheckedVid = '';
  async function correctMeterCrossDB(vehicleId) {
    if (isEdit || !me.dualDb) return;          // 移行モード(dualDb)のみ
    vehicleId = String(vehicleId || '');
    if (!vehicleId) return;
    const startInput = document.getElementById('f-start');
    if (!startInput || startInput.dataset.userInput === '1') return; // 手入力は尊重
    if (_meterCheckedVid === vehicleId) return; // 同一車種の二重照会を抑制
    _meterCheckedVid = vehicleId;
    try {
      const j = await apiGet('vehicle_last_meter', { vehicle: vehicleId });
      if (sel.value !== vehicleId) return;       // 照会中に車種が変わった
      if (startInput.dataset.userInput === '1') return;
      const m = j && j.found ? j['到着後メータ'] : null;
      if (m !== '' && m != null && String(startInput.value) !== String(m)) {
        startInput.value = m;
        const hint = document.getElementById('f-start-hint');
        if (hint) hint.textContent = `（前回到着 ${m} から自動入力・新旧DB照合）`;
        startInput.dispatchEvent(new Event('input'));
      }
    } catch (_) {}
  }
  const handleVehicleChange = () => {
    if (isEdit) return; // 編集モードは触らない
    const vehicleId = String(sel.value);
    const startInput = document.getElementById('f-start');
    const hint = document.getElementById('f-start-hint');
    if (!vehicleId) {
      if (hint) hint.textContent = '';
      return;
    }
    // 手入力済みの場合のみ上書きしない（自動補完値は上書きOK）
    if (startInput.dataset.userInput === '1') {
      if (hint) hint.textContent = '（手入力のため自動補完を停止）';
      return;
    }
    // v0.14.6: 移行期間は全DB照合で発車前メータを補正（recentLogsの新DB値を上書きしうる）
    correctMeterCrossDB(vehicleId);
    if (recentLogs.length === 0) {
      if (hint) hint.textContent = '（過去データを取得中…車種を選び直してください）';
      return;
    }
    // 同じ車種の最新レコードを探す（listは新しい順）
    const lastRecord = recentLogs.find(r => String(r['車種']) === vehicleId);
    if (lastRecord && lastRecord['到着後メータ'] !== '' && lastRecord['到着後メータ'] != null) {
      startInput.value = lastRecord['到着後メータ'];
      if (hint) hint.textContent = `（前回到着 ${lastRecord['到着後メータ']} / ${formatDate(lastRecord['日時'])} から自動入力${recentLogsFetched ? '' : ' ・キャッシュ'}）`;
      startInput.dispatchEvent(new Event('input')); // 走行距離再計算（isTrusted=falseなので userInput フラグは立たない）
    } else {
      // この車種の過去レコードがなければ、前の値はクリアしておく
      if (startInput.value !== '' && startInput.dataset.userInput !== '1') {
        startInput.value = '';
        startInput.dispatchEvent(new Event('input'));
      }
      if (hint) hint.textContent = '（この車種の過去レコードが見つかりません）';
    }
  };
  sel.addEventListener('change', handleVehicleChange);
  sel.addEventListener('input', handleVehicleChange); // 念のため input イベントも

  // v0.14.0: 「以前に使った車両」の自動セット（運転者ごと）
  // 手動で車種を選んだら（isTrusted=true）以後の自動セットを止める。
  sel.addEventListener('change', (e) => { if (e.isTrusted) sel.dataset.userChosen = '1'; });
  // 指定車種IDをドロップダウンに設定し、メータ自動補完を誘発。選択肢に在ればtrue。
  //   meterFallback: その車種の最新到着後メータ（直近100件に無くメータが空のままの場合の保険）
  function setVehicleAndMeter(vid, meterFallback) {
    if (!vid) return false;
    const exists = Array.from(sel.options).some(o => String(o.value) === String(vid));
    if (!exists) return false; // 引退車種・空欄は選択肢に無いのでプリセットしない
    if (String(sel.value) !== String(vid)) sel.value = String(vid);
    sel.dispatchEvent(new Event('change')); // handleVehicleChange がrecentLogsからメータ補完を試みる
    // recentLogsに無くメータが空のままなら、保険のメータで補完
    const startInput = document.getElementById('f-start');
    const hint = document.getElementById('f-start-hint');
    if (startInput && startInput.value === '' && startInput.dataset.userInput !== '1' && meterFallback !== '' && meterFallback != null) {
      startInput.value = meterFallback;
      if (hint) hint.textContent = `（前回到着 ${meterFallback} から自動入力）`;
      startInput.dispatchEvent(new Event('input'));
    }
    return true;
  }
  // ローカル情報（①recentLogs ②端末メモリ）で即時プリセット。設定できたら true。
  function localPreset(driverId) {
    if (isEdit || sel.dataset.userChosen === '1' || !driverId) return false;
    // ① recentLogs: その運転者の最新車種（メータはrecentLogsから新鮮に補完されるので保険不要）
    for (const rec of recentLogs) {
      if (String(rec['運転者']) === String(driverId)) {
        const vid = String(rec['車種'] || '').trim();
        if (vid && setVehicleAndMeter(vid, '')) return true;
      }
    }
    // ② 端末メモリ {v, m}（起動時の先読みや前回入力で温められている）
    const mem = getLastVehicleForDriver(driverId);
    if (mem && mem.v) return setVehicleAndMeter(mem.v, mem.m);
    return false;
  }
  const vehicleHint = document.getElementById('f-vehicle-hint');
  // v0.14.1/0.14.2: ローカルで見つからなければサーバーに全データ走査を依頼。
  //   待つ間は車種欄に「確認中…」を表示（ユーザーが空欄を見て手入力しないように）。
  async function presetVehicle(driverId) {
    if (isEdit || sel.dataset.userChosen === '1') return;
    if (localPreset(driverId)) { if (vehicleHint) vehicleHint.textContent = ''; return; } // ①即時
    if (!driverId) return;
    if (vehicleHint) vehicleHint.textContent = '⏳ 前回車両を確認中…';
    try {
      const j = await apiGet('last_vehicle', { driver: driverId });
      // 非同期の間に手動選択／運転者切替があれば中止
      if (sel.dataset.userChosen === '1' || (driverSel.value || cfg.userId) !== String(driverId)) {
        if (vehicleHint) vehicleHint.textContent = '';
        return;
      }
      if (j && j.found && setVehicleAndMeter(String(j['車種'] || ''), j['到着後メータ'])) {
        setLastVehicleForDriver(driverId, String(j['車種'] || ''), j['到着後メータ']); // 次回から即時
        if (vehicleHint) vehicleHint.textContent = '';
      } else {
        if (vehicleHint) vehicleHint.textContent = '（前回車両なし。手動で選んでください）';
      }
    } catch (_) {
      if (vehicleHint) vehicleHint.textContent = '（前回車両の取得に失敗。手動で選んでください）';
    }
  }
  if (!isEdit) {
    // 初期表示時に、現在の運転者の前回車両をプリセット（ローカル→サーバーの順）
    presetVehicle(driverSel.value || cfg.userId);
    // 管理者の代理入力で運転者を変えたら、その運転者の前回車両に追従（手動選択時は除く）
    // v0.14.5: 切替時に前の運転者の車種が残って誤登録されないよう、手動選択でなければ一旦クリア
    //   してから引き直す（新運転者の前回車両が見つからなければ空のままになる）。
    driverSel.addEventListener('change', () => {
      if (sel.dataset.userChosen !== '1') {
        sel.value = '';
        const si = document.getElementById('f-start');
        if (si && si.dataset.userInput !== '1') { si.value = ''; si.dispatchEvent(new Event('input')); }
        sel.dispatchEvent(new Event('change')); // ヒント/距離をクリア（vehicleId空でhandleVehicleChangeは即return）
      }
      presetVehicle(driverSel.value || cfg.userId);
    });
  }

  // 走行距離 自動計算
  const calcDist = () => {
    const s = parseFloat(document.getElementById('f-start').value);
    const e = parseFloat(document.getElementById('f-end').value);
    const span = document.getElementById('f-dist');
    if (!isNaN(s) && !isNaN(e) && e >= s) span.textContent = (e - s).toFixed(0);
    else span.textContent = '—';
  };
  document.getElementById('f-start').oninput = calcDist;
  document.getElementById('f-end').oninput = calcDist;

  // 行先マスタ読み込み（キャッシュ優先）
  let destMaster = [];
  try {
    const j = await apiGet('destinations');
    destMaster = j.data;
    dbPut('cache', { key: 'destinations_master', value: destMaster, at: Date.now() }).catch(() => {});
  } catch (_) {
    const c = await dbGet('cache', 'destinations_master');
    destMaster = c?.value || [];
  }

  // 行先データ UI 構築
  const destContainer = document.getElementById('f-destinations');
  bindDestOutsideClose(); // v0.14.4: サジェストを外側タップで閉じる（スクロール可能化）
  let destRowSeq = 0;
  const addDestRow = (preset = {}) => {
    destRowSeq++;
    const row = document.createElement('div');
    row.className = 'dest-row';
    // 拠店: select（既存拠店のみ／新規拠店の追加は運転者側ではロック）v0.10.4
    const placeSel = document.createElement('select');
    placeSel.className = 'dest-place';
    const places = [...new Set(destMaster.map(d => d['拠店']).filter(Boolean))];
    let placeOpts = '<option value="">拠店を選択</option>'
      + places.map(p => `<option value="${escape(p)}"${preset['拠店'] === p ? ' selected' : ''}>${escape(p)}</option>`).join('');
    // 編集時、既存値がマスタに無ければ選択肢として補う（値の消失防止）
    if (preset['拠店'] && places.indexOf(preset['拠店']) < 0) {
      placeOpts += `<option value="${escape(preset['拠店'])}" selected>${escape(preset['拠店'])}</option>`;
    }
    placeSel.innerHTML = placeOpts;
    // v0.13.0: 行先は自前の縦サジェストリスト（拠店連動 + 部分一致絞り込み + 自由入力）
    const destWrap = document.createElement('div');
    destWrap.className = 'dest-name-wrap';
    const destInput = document.createElement('input');
    destInput.type = 'text';
    destInput.className = 'dest-name';
    destInput.placeholder = '行先を入力 or 選択';
    destInput.value = preset['行先'] || '';
    destInput.autocomplete = 'off';
    const panel = document.createElement('div');
    panel.className = 'dest-suggest';
    panel.hidden = true;
    const renderSuggest = () => {
      const place = placeSel.value.trim();
      const q = destInput.value.trim().toLowerCase();
      let opts = [...new Set(destMaster.filter(d => !place || d['拠店'] === place).map(d => d['行先']).filter(Boolean))];
      if (q) opts = opts.filter(o => String(o).toLowerCase().includes(q));
      opts = opts.slice(0, 100);
      if (opts.length === 0) { panel.hidden = true; return; }
      panel.innerHTML = opts.map(o => `<div class="dest-suggest-item">${escape(o)}</div>`).join('');
      Array.from(panel.querySelectorAll('.dest-suggest-item')).forEach((el, idx) => {
        // v0.14.4: click で選択。pointerdown+preventDefault はタッチのスクロールを妨げるため使わない。
        el.addEventListener('click', () => { destInput.value = opts[idx]; panel.hidden = true; });
      });
      panel.hidden = false;
    };
    destInput.addEventListener('focus', renderSuggest);
    destInput.addEventListener('input', renderSuggest);
    // v0.14.4: blur→hide は廃止（リストをスクロールしようと触れると即閉じてしまうため）。
    //   閉じるのは「外側タップ」で行う（bindDestOutsideClose、renderForm で一度だけ登録）。
    placeSel.onchange = () => { destInput.value = ''; renderSuggest(); };
    destWrap.appendChild(destInput);
    destWrap.appendChild(panel);
    // v0.14.3: 縦並び — 1行目に[拠店＋削除]、2行目に行先（全幅）
    const line1 = document.createElement('div');
    line1.className = 'dest-line1';
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'rm';
    rm.textContent = '×';
    rm.setAttribute('aria-label', 'この行先を削除');
    rm.onclick = () => row.remove();
    line1.appendChild(placeSel);
    line1.appendChild(rm);
    row.appendChild(line1);
    row.appendChild(destWrap);
    destContainer.appendChild(row);
  };
  document.getElementById('btn-add-dest').onclick = () => addDestRow();
  // 編集モードなら既存行先で初期化、なければ1行
  if (isEdit && editDestinations.length > 0) {
    editDestinations.forEach(d => addDestRow({ '拠店': d['拠店'] || '', '行先': d['行先'] || '' }));
  } else {
    addDestRow();
  }

  // 送信
  document.getElementById('form-new').onsubmit = async (ev) => {
    ev.preventDefault();
    const msg = document.getElementById('form-msg');
    const btn = document.getElementById('btn-submit');
    btn.disabled = true;
    msg.textContent = '送信中…';

    // v0.13.1: 必須項目チェック（新規のみ。ETC・備考・給油は任意）
    if (!isEdit) {
      const reqErrors = [];
      if (!document.getElementById('f-date').value) reqErrors.push('日時');
      if (!document.getElementById('f-vehicle').value) reqErrors.push('車種');
      if (document.getElementById('f-start').value === '') reqErrors.push('発車前メータ');
      if (document.getElementById('f-end').value === '') reqErrors.push('到着後メータ');
      if (!document.getElementById('f-alc').value.trim()) reqErrors.push('アルコールチェック確認者');
      const hasDest = Array.from(document.querySelectorAll('.dest-row')).some(r => (r.querySelector('.dest-name')?.value || '').trim() !== '');
      if (!hasDest) reqErrors.push('行先');
      if (reqErrors.length > 0) {
        msg.className = 'msg ng';
        msg.textContent = '必須項目が未入力です: ' + reqErrors.join('、');
        btn.disabled = false;
        return;
      }
    }

    // v0.12.0: 到着後メーター異常値チェック
    const _vchk = validateDistance(document.getElementById('f-start').value, document.getElementById('f-end').value);
    if (_vchk.level === 'block') { msg.className = 'msg ng'; msg.textContent = _vchk.message; btn.disabled = false; return; }
    if (_vchk.level === 'warn') { if (!confirm(_vchk.message)) { msg.className = 'msg'; msg.textContent = ''; btn.disabled = false; return; } }

    // 行先データ収集
    const destinations = [];
    document.querySelectorAll('.dest-row').forEach(r => {
      const place = r.querySelector('.dest-place')?.value || '';
      const dest = r.querySelector('.dest-name')?.value || '';
      if (place || dest) destinations.push({ '拠店': place, '行先': dest });
    });

    // Phase F: 運転者はドロップダウンから取得（編集時は disabled だが既存値が入っている）
    const selectedDriver = driverSel.value || cfg.userId;
    const payload = {
      '日時': document.getElementById('f-date').value.replace(/-/g, '/'),
      '車種': document.getElementById('f-vehicle').value,
      'ETC 使用': document.getElementById('f-etc').checked ? 'TRUE' : 'FALSE',
      '発車前メータ': Number(document.getElementById('f-start').value),
      '到着後メータ': Number(document.getElementById('f-end').value),
      '給油(L)': document.getElementById('f-fuel').value ? Number(document.getElementById('f-fuel').value) : '',
      'アルコールチェック表示': document.getElementById('f-alc').value || '',
      '備考': document.getElementById('f-memo').value || '',
      '運転者': selectedDriver,
      '車種表示': sel.options[sel.selectedIndex]?.textContent || '',
      'destinations': destinations,
    };

    // 編集モードの送信
    if (isEdit) {
      if (!navigator.onLine) {
        msg.className = 'msg ng';
        msg.textContent = 'オフラインでは編集できません（オンラインになってからお試しください）';
        btn.disabled = false;
        return;
      }
      try {
        payload['データID'] = editId;
        const j = await apiPost('update_log', payload, { userId: cfg.userId });
        msg.className = 'msg ok';
        const nm2 = Array.isArray(j.newMasterDestinations) ? j.newMasterDestinations.length : 0;
        msg.textContent = `更新しました（権限: ${j.by || 'OK'}）` + (nm2 > 0 ? ` ／ 新しい行先 ${nm2} 件をリストに追加` : '');
        setTimeout(() => go('#/list'), nm2 > 0 ? 1500 : 800);
      } catch (e) {
        msg.className = 'msg ng';
        msg.textContent = `更新失敗: ${e.message}`;
        btn.disabled = false;
      }
      return;
    }

    // 新規登録
    // v0.14.0/0.14.2: この運転者の「前回車両」と、その車種の最新メータ（＝今回の到着後）を端末に記憶
    setLastVehicleForDriver(selectedDriver, payload['車種'], payload['到着後メータ']);
    if (!navigator.onLine) {
      // オフライン: キューに積む
      await dbAdd('pending', { payload, at: Date.now() });
      msg.className = 'msg ok';
      msg.textContent = '⚠️ オフライン: 端末に保存しました（オンライン時に自動送信）';
      btn.disabled = false;
      setTimeout(() => go('#/list'), 1000);
      return;
    }

    try {
      const j = await apiPost('create_log', payload);
      msg.className = 'msg ok';
      const nm1 = Array.isArray(j.newMasterDestinations) ? j.newMasterDestinations.length : 0;
      msg.textContent = `登録しました（ID: ${j.id}）` + (nm1 > 0 ? ` ／ 新しい行先 ${nm1} 件をリストに追加` : '');
      setTimeout(() => go('#/list'), nm1 > 0 ? 1500 : 800);
    } catch (e) {
      // 失敗したらキューに退避
      await dbAdd('pending', { payload, at: Date.now() });
      msg.className = 'msg ng';
      msg.textContent = `送信失敗（端末に退避しました）: ${e.message}`;
      btn.disabled = false;
    }
  };
}

// ----- Phase E: ビュー: 一括入力（管理者専用） -----
async function renderBulk() {
  // 管理者ガード
  if (!me.loaded) {
    await fetchMe();
  }
  if (!me.isAdmin) {
    alert('一括入力は管理者のみ利用できます');
    return go('#/list');
  }
  if (staffList.length === 0) await fetchStaff();
  setTitle('一括入力');
  const view = document.getElementById('view');
  view.appendChild(document.getElementById('tpl-bulk').content.cloneNode(true));

  // 車種マスタ取得（キャッシュ優先）
  let vehicles = [];
  try {
    const j = await apiGet('vehicles');
    vehicles = j.data;
    dbPut('cache', { key: 'vehicles', value: vehicles, at: Date.now() }).catch(() => {});
  } catch (_) {
    const c = await dbGet('cache', 'vehicles');
    vehicles = c?.value || [];
  }

  const tbody = document.getElementById('bulk-rows');
  const rowcount = document.getElementById('bulk-rowcount');
  const progress = document.getElementById('bulk-progress');
  const msg = document.getElementById('bulk-msg');

  const updateRowCount = () => {
    rowcount.textContent = tbody.querySelectorAll('.bulk-row').length + ' 行';
  };

  const addBulkRow = (preset = {}) => {
    const tr = document.createElement('tr');
    tr.className = 'bulk-row';
    // 日付
    const dateInput = `<input type="date" class="b-date" value="${escape(preset.date || new Date().toISOString().slice(0,10))}">`;
    // 運転者セレクト（社員マスタから、退職者除外）
    const driverOpts = activeStaff().map(s => { // v0.9.10: 表示時のみ管理者置換
      const id = String(s['社員ID']);
      const name = displayStaffName(String(s['氏名'] || id));
      return `<option value="${escape(id)}"${preset.driver === id ? ' selected' : ''}>${escape(name)}</option>`;
    }).join('');
    const driverInput = `<select class="b-driver"><option value="">選択</option>${driverOpts}</select>`;
    // 車種セレクト
    const vehicleOpts = vehicles.map(v => {
      const label = `${v['車種'] || ''} / ${v['車輛番号'] || ''}`.trim().replace(/\s*\/\s*$/, '').replace(/^\s*\/\s*/, '');
      return `<option value="${escape(v.ID)}"${String(preset.vehicle) === String(v.ID) ? ' selected' : ''}>${escape(label)}</option>`;
    }).join('');
    const vehicleInput = `<select class="b-vehicle"><option value="">選択</option>${vehicleOpts}</select>`;
    tr.innerHTML = `
      <td>${dateInput}</td>
      <td>${driverInput}</td>
      <td>${vehicleInput}</td>
      <td><input type="number" class="b-start" inputmode="numeric" min="0" value="${preset.start ?? ''}"></td>
      <td><input type="number" class="b-end" inputmode="numeric" min="0" value="${preset.end ?? ''}"></td>
      <td class="b-dist">—</td>
      <td><input type="checkbox" class="b-etc" ${preset.etc === false ? '' : 'checked'}></td>
      <td><input type="number" class="b-fuel" inputmode="decimal" step="0.01" min="0" value="${preset.fuel ?? ''}"></td>
      <td><input type="text" class="b-memo" value="${escape(preset.memo || '')}"></td>
      <td><button type="button" class="rm-row">×</button></td>
    `;
    // 距離自動計算
    const calc = () => {
      const s = parseFloat(tr.querySelector('.b-start').value);
      const e = parseFloat(tr.querySelector('.b-end').value);
      const distCell = tr.querySelector('.b-dist');
      if (!isNaN(s) && !isNaN(e) && e >= s) distCell.textContent = (e - s).toFixed(0);
      else distCell.textContent = '—';
    };
    tr.querySelector('.b-start').oninput = calc;
    tr.querySelector('.b-end').oninput = calc;
    // 行削除
    tr.querySelector('.rm-row').onclick = () => {
      tr.remove();
      updateRowCount();
    };
    tbody.appendChild(tr);
    updateRowCount();
  };

  document.getElementById('btn-bulk-add').onclick = () => addBulkRow();
  document.getElementById('btn-bulk-clear').onclick = () => {
    if (tbody.children.length === 0) return;
    if (!confirm('全行をクリアしますか？')) return;
    tbody.innerHTML = '';
    progress.innerHTML = '';
    msg.textContent = '';
    updateRowCount();
  };

  // 初期1行
  addBulkRow();

  // 送信処理
  document.getElementById('btn-bulk-submit').onclick = async () => {
    const rows = Array.from(tbody.querySelectorAll('.bulk-row'));
    if (rows.length === 0) {
      msg.className = 'msg ng';
      msg.textContent = '入力された行がありません';
      return;
    }
    if (!navigator.onLine) {
      msg.className = 'msg ng';
      msg.textContent = 'オフラインでは一括送信できません';
      return;
    }
    // バリデーション
    const payloads = [];
    const bulkWarnings = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const date = r.querySelector('.b-date').value;
      const driver = r.querySelector('.b-driver').value;
      const vehicle = r.querySelector('.b-vehicle').value;
      const start = r.querySelector('.b-start').value;
      const end = r.querySelector('.b-end').value;
      if (!date || !driver || !vehicle || start === '' || end === '') {
        msg.className = 'msg ng';
        msg.textContent = `${i+1}行目: 必須項目が未入力です（日付/運転者/車種/メータ）`;
        r.style.background = '#fde7e7';
        return;
      }
      r.style.background = '';
      const _bv = validateDistance(start, end);
      if (_bv.level === 'block') {
        msg.className = 'msg ng';
        msg.textContent = `${i+1}行目: ${_bv.message}`;
        r.style.background = '#fde7e7';
        return;
      }
      if (_bv.level === 'warn') bulkWarnings.push(`${i+1}行目: ${_bv.message.replace('このまま登録しますか？','').trim()}`);
      payloads.push({
        rowEl: r,
        index: i,
        payload: {
          '日時': String(date).replace(/-/g, '/'),
          '車種': vehicle,
          'ETC 使用': r.querySelector('.b-etc').checked ? 'TRUE' : 'FALSE',
          '発車前メータ': Number(start),
          '到着後メータ': Number(end),
          '給油(L)': r.querySelector('.b-fuel').value ? Number(r.querySelector('.b-fuel').value) : '',
          '備考': r.querySelector('.b-memo').value || '',
          '運転者': driver,
        }
      });
    }
    // v0.12.0: 警告行があればまとめて確認
    if (bulkWarnings.length > 0) {
      if (!confirm('以下の行は走行距離が通常と異なります。このまま全件登録しますか？\n\n' + bulkWarnings.join('\n'))) {
        msg.className = 'msg'; msg.textContent = '送信を中止しました';
        return;
      }
    }
    // 並列送信
    progress.innerHTML = `<div class="bulk-bar"><span style="width:0%"></span></div><div class="bulk-stat">0 / ${payloads.length}</div>`;
    const bar = progress.querySelector('.bulk-bar span');
    const stat = progress.querySelector('.bulk-stat');
    let done = 0, ok = 0, ng = 0;
    const errors = [];
    msg.className = 'msg';
    msg.textContent = '送信中…';
    // 並列だがレートを抑える（5本同時まで）
    const concurrency = 5;
    let cursor = 0;
    const worker = async () => {
      while (cursor < payloads.length) {
        const i = cursor++;
        const p = payloads[i];
        try {
          await apiPost('create_log', p.payload);
          p.rowEl.style.background = '#e2f5ea';
          ok++;
        } catch (e) {
          p.rowEl.style.background = '#fde7e7';
          ng++;
          errors.push(`行${i+1}: ${e.message}`);
        }
        done++;
        bar.style.width = (done / payloads.length * 100) + '%';
        stat.textContent = `${done} / ${payloads.length}（成功 ${ok} / 失敗 ${ng}）`;
      }
    };
    const workers = Array.from({length: Math.min(concurrency, payloads.length)}, () => worker());
    await Promise.all(workers);
    if (ng === 0) {
      msg.className = 'msg ok';
      msg.textContent = `全 ${ok} 件 登録完了`;
    } else {
      msg.className = 'msg ng';
      msg.textContent = `${ng} 件失敗：` + errors.slice(0, 3).join(' / ') + (errors.length > 3 ? ' …他' : '');
    }
  };
}

// ----- Phase G: ビュー: 社員管理（管理者専用） -----
// v0.9.11: AppSheet 取り込みカードのバインド
function bindAppsheetImport() {
  const btnInspect = document.getElementById('btn-appsheet-inspect');
  const btnImport = document.getElementById('btn-appsheet-import');
  const result = document.getElementById('appsheet-result');
  const msg = document.getElementById('appsheet-msg');
  if (!btnInspect || !btnImport) return;

  const setBusy = (b) => {
    btnInspect.disabled = b;
    if (b) btnImport.disabled = true;
  };
  const showResult = (obj) => {
    result.hidden = false;
    result.textContent = JSON.stringify(obj, null, 2);
  };

  btnInspect.onclick = async () => {
    msg.className = 'msg'; msg.textContent = '確認中…'; setBusy(true);
    try {
      // ステップ1: 列差分・件数
      const inspect = await apiGet('inspect_appsheet', { userId: cfg.userId });
      // ステップ2: ドライランで取り込み件数
      const dry = await apiPost('import_appsheet', {}, { userId: cfg.userId, dryRun: true });
      const summary = {
        AppSheet側: {
          総行数: inspect.appsheet.rowCount,
          列: inspect.appsheet.headers,
        },
        PWA側: {
          総行数: inspect.pwa.rowCount,
          列: inspect.pwa.headers,
        },
        列の差分: {
          両方にある: inspect.headerDiff.bothSides,
          AppSheet側のみ: inspect.headerDiff.onlyAppsheet,
          PWA側のみ: inspect.headerDiff.onlyPwa,
        },
        重複判定: {
          キー列: inspect.duplicateCheck.keyColumn,
          既存マッチ: dry.existingMatched,
          取り込み対象: dry.toImport,
        },
        取り込みサンプル: dry.sample,
      };
      showResult(summary);
      msg.className = 'msg ok';
      msg.textContent = `取り込み対象: ${dry.toImport} 件（${inspect.appsheet.rowCount} 件中、${dry.existingMatched} 件は既存）`;
      btnImport.disabled = dry.toImport === 0;
    } catch (e) {
      msg.className = 'msg ng'; msg.textContent = '失敗: ' + e.message;
    } finally {
      setBusy(false);
    }
  };

  btnImport.onclick = async () => {
    if (!confirm('AppSheet 版から PWA「データ」シートに追記します。よろしいですか？\n（重複データはスキップされます）')) return;
    msg.className = 'msg'; msg.textContent = '取り込み実行中…'; setBusy(true);
    btnImport.disabled = true;
    try {
      const r = await apiPost('import_appsheet', {}, { userId: cfg.userId, dryRun: false });
      showResult(r);
      msg.className = 'msg ok';
      msg.textContent = r.message || `${r.imported || 0} 件取り込みました`;
    } catch (e) {
      msg.className = 'msg ng'; msg.textContent = '失敗: ' + e.message;
    } finally {
      setBusy(false);
    }
  };
}

// v0.14.9: アルコールチェック確認者の追加/削除（管理者専用）
function bindCheckerMgmt() {
  const listEl = document.getElementById('checker-list');
  const addBtn = document.getElementById('btn-checker-add');
  const addInput = document.getElementById('checker-new');
  const addMsg = document.getElementById('checker-add-msg');
  const msgEl = document.getElementById('checker-msg');
  if (!listEl || !addBtn) return;
  let rows = [];
  const render = () => {
    listEl.innerHTML = '';
    for (const c of rows) {
      const name = String(c['確認者'] || '').trim();
      if (!name) continue;
      const id = c['ID'];
      const div = document.createElement('div');
      div.className = 'staff-item';
      div.innerHTML = `<div><span class="name">${escape(name)}</span></div><span class="id">${escape(String(id == null ? '' : id))}</span><div class="actions"><button class="ghost small danger" data-del-checker>削除</button></div>`;
      div.querySelector('[data-del-checker]').onclick = async (ev) => {
        ev.preventDefault();
        if (!confirm(`確認者「${name}」を候補から削除しますか？\n（過去の記録は残ります）`)) return;
        const btn = ev.currentTarget; btn.disabled = true;
        msgEl.className = 'msg'; msgEl.textContent = '削除中…';
        try {
          await apiPost('checker_delete', { 'ID': id, '確認者': name }, { userId: cfg.userId });
          await refresh();
          msgEl.className = 'msg ok'; msgEl.textContent = `「${name}」を削除しました`;
          setTimeout(() => { msgEl.textContent = ''; msgEl.className = 'msg'; }, 3000);
        } catch (e) { btn.disabled = false; msgEl.className = 'msg ng'; msgEl.textContent = '失敗: ' + e.message; }
      };
      listEl.appendChild(div);
    }
  };
  const refresh = async () => {
    try {
      const j = await apiGet('checkers');
      rows = (j.data && j.data.rows) ? j.data.rows : [];
      checkersList = rows; // フォームの候補（activeCheckers）にも反映
      render();
    } catch (e) { msgEl.className = 'msg ng'; msgEl.textContent = '取得失敗: ' + e.message; }
  };
  addBtn.onclick = async () => {
    const name = addInput.value.trim();
    if (!name) { addMsg.className = 'msg ng'; addMsg.textContent = '確認者名を入力してください'; return; }
    addBtn.disabled = true;
    addMsg.className = 'msg'; addMsg.textContent = '追加中…';
    try {
      const j = await apiPost('checker_add', { '確認者': name }, { userId: cfg.userId });
      addMsg.className = 'msg ok'; addMsg.textContent = (j.action === 'exists') ? `「${name}」は既にあります` : `「${name}」を追加しました`;
      addInput.value = '';
      await refresh();
    } catch (e) { addMsg.className = 'msg ng'; addMsg.textContent = '失敗: ' + e.message; }
    finally { addBtn.disabled = false; }
  };
  refresh();
}

async function renderStaff() {
  if (!me.loaded) await fetchMe();
  if (!me.isAdmin) {
    alert('社員管理は管理者のみ利用できます');
    return go('#/list');
  }
  setTitle('社員管理');
  const view = document.getElementById('view');
  view.appendChild(document.getElementById('tpl-staff').content.cloneNode(true));

  // v0.9.11: AppSheet 取り込みカードのハンドラ
  bindAppsheetImport();
  // v0.14.9: アルコールチェック確認者の管理カード
  bindCheckerMgmt();

  const listEl = document.getElementById('staff-list');
  const countEl = document.getElementById('staff-count');
  const msgEl = document.getElementById('staff-msg');
  const showRetired = document.getElementById('chk-show-retired');

  let allStaff = [];
  const refresh = async () => {
    try {
      const j = await apiGet('staff', { all: 'true' });
      allStaff = j.data || [];
      // グローバルも更新（在職者のみ）
      staffList = allStaff;
      render();
    } catch (e) {
      msgEl.className = 'msg ng';
      msgEl.textContent = '取得失敗: ' + e.message;
    }
  };

  const render = () => {
    listEl.innerHTML = '';
    const showAll = showRetired.checked;
    const visible = showAll ? allStaff : allStaff.filter(s => !s['退職フラグ']);
    const retiredCount = allStaff.filter(s => s['退職フラグ']).length;
    countEl.textContent = `${visible.length} 件${showAll && retiredCount > 0 ? `（うち退職 ${retiredCount}）` : ''}`;
    for (const s of visible) {
      const id = String(s['社員ID']);
      const name = String(s['氏名'] || id);
      const isRetired = !!s['退職フラグ'];
      const div = document.createElement('div');
      div.className = 'staff-item' + (isRetired ? ' retired' : '');
      div.innerHTML = `
        <div>
          <span class="name">${escape(name)}</span>
          ${isRetired ? '<span class="retired-badge">退職済</span>' : ''}
        </div>
        <span class="id">${escape(id)}</span>
        <div class="actions">
          <button class="ghost small" data-edit="${escape(id)}">編集</button>
          <button class="ghost small ${isRetired ? '' : 'danger'}" data-toggle="${escape(id)}" data-retired="${isRetired ? '1' : '0'}">${isRetired ? '復職' : '退職'}</button>
        </div>
      `;
      // v0.14.8: 氏名の編集（社員IDは変えない＝過去データとの紐付け維持）。管理者専用。
      div.querySelector('[data-edit]').onclick = (ev) => {
        ev.preventDefault();
        const nameCell = div.querySelector('.name').parentElement;
        const actions = div.querySelector('.actions');
        const input = document.createElement('input');
        input.type = 'text';
        input.value = name;
        input.style.cssText = 'width:100%;font-size:0.95rem;padding:6px;';
        nameCell.innerHTML = '';
        nameCell.appendChild(input);
        const save = document.createElement('button');
        save.type = 'button'; save.className = 'primary small'; save.textContent = '保存';
        const cancel = document.createElement('button');
        cancel.type = 'button'; cancel.className = 'ghost small'; cancel.textContent = 'キャンセル';
        actions.innerHTML = '';
        actions.appendChild(save); actions.appendChild(cancel);
        setTimeout(() => { input.focus(); input.select(); }, 0);
        cancel.onclick = () => render();
        const doSave = async () => {
          const newName = input.value.trim();
          if (!newName) { input.focus(); return; }
          if (newName === name) { render(); return; }
          save.disabled = true; cancel.disabled = true;
          msgEl.className = 'msg'; msgEl.textContent = '更新中…';
          try {
            await apiPost('staff_upsert', { '社員ID': id, '氏名': newName }, { userId: cfg.userId });
            await refresh();
            msgEl.className = 'msg ok'; msgEl.textContent = `「${name}」→「${newName}」に更新しました`;
            setTimeout(() => { msgEl.textContent = ''; msgEl.className = 'msg'; }, 3000);
          } catch (e) {
            msgEl.className = 'msg ng'; msgEl.textContent = '失敗: ' + e.message;
            render();
          }
        };
        save.onclick = doSave;
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doSave(); } });
      };
      div.querySelector('[data-toggle]').onclick = async (ev) => {
        ev.preventDefault();
        const targetRetire = !isRetired;
        const msg = targetRetire ? `「${name}」を退職にしますか？\nドロップダウンから消えますが、過去データは残ります。` : `「${name}」を復職させますか？`;
        if (!confirm(msg)) return;
        const btn = ev.currentTarget;
        const origText = btn.textContent;
        btn.disabled = true;
        btn.textContent = targetRetire ? '退職処理中…' : '復職処理中…';
        msgEl.className = 'msg';
        msgEl.textContent = '更新中…';
        try {
          await apiPost('staff_retire', { '社員ID': id, '退職フラグ': targetRetire }, { userId: cfg.userId });
          await refresh();
          msgEl.className = 'msg ok';
          msgEl.textContent = `「${name}」を${targetRetire ? '退職' : '復職'}しました`;
          setTimeout(() => { msgEl.textContent = ''; msgEl.className = 'msg'; }, 3000);
        } catch (e) {
          btn.disabled = false;
          btn.textContent = origText;
          msgEl.className = 'msg ng';
          msgEl.textContent = '失敗: ' + e.message;
          alert('失敗: ' + e.message);
        }
      };
      listEl.appendChild(div);
    }
  };

  showRetired.onchange = render;

  document.getElementById('btn-staff-add').onclick = async () => {
    const idEl = document.getElementById('staff-new-id');
    const nameEl = document.getElementById('staff-new-name');
    const addMsg = document.getElementById('staff-add-msg');
    const newId = idEl.value.trim();
    const newName = nameEl.value.trim() || newId;
    if (!newId) {
      addMsg.className = 'msg ng';
      addMsg.textContent = '社員IDが必要です';
      return;
    }
    try {
      const j = await apiPost('staff_upsert', { '社員ID': newId, '氏名': newName }, { userId: cfg.userId });
      addMsg.className = 'msg ok';
      addMsg.textContent = `${j.action === 'created' ? '追加' : '更新'}しました: ${newName}（${newId}）`;
      idEl.value = '';
      nameEl.value = '';
      await refresh();
    } catch (e) {
      addMsg.className = 'msg ng';
      addMsg.textContent = '失敗: ' + e.message;
    }
  };

  await refresh();
}

// ----- ビュー: 設定 -----
// ----- ビュー: PDF出力（v0.10.0、管理者専用） -----
async function renderPdf() {
  if (!me.loaded) await fetchMe();
  if (!me.isAdmin) {
    alert('PDF出力は管理者のみ利用できます');
    return go('#/list');
  }
  setTitle('PDF出力');
  const view = document.getElementById('view');
  view.appendChild(document.getElementById('tpl-pdf').content.cloneNode(true));

  // 既定値: 当月1日〜今日
  const now = new Date();
  const z = n => String(n).padStart(2, '0');
  const iso = d => `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
  document.getElementById('p-start').value = iso(new Date(now.getFullYear(), now.getMonth(), 1));
  document.getElementById('p-end').value = iso(now);

  const msg = document.getElementById('pdf-msg');
  const results = document.getElementById('pdf-results');

  // 車種（引退車種も含む。過去期間のPDFを出すため。引退は【引退】表示）
  const vSel = document.getElementById('p-vehicle');
  let vehicles = [];
  try {
    const j = await apiGet('vehicles');
    vehicles = j.data;
    dbPut('cache', { key: 'vehicles', value: vehicles, at: Date.now() }).catch(() => {});
  } catch (e) {
    const c = await dbGet('cache', 'vehicles');
    vehicles = c?.value || [];
  }
  for (const v of vehicles) {
    const name = String(v['車種'] || '').trim();
    if (!name) continue;
    const opt = document.createElement('option');
    opt.value = String(v['ID']);
    const prefix = isActiveVehicle(v) ? '' : '【引退】';
    opt.textContent = prefix + name + (v['車輛番号'] ? ' / ' + String(v['車輛番号']).trim() : '');
    vSel.appendChild(opt);
  }

  // 運転者（退職者も含む。過去期間のPDFを出すため）
  const dSel = document.getElementById('p-driver');
  if (staffList.length === 0) await fetchStaff();
  for (const s of staffList) {
    const opt = document.createElement('option');
    opt.value = String(s['社員ID']);
    opt.textContent = displayStaffName(String(s['氏名'] || s['社員ID'])) + (s['退職フラグ'] ? '（退職）' : '');
    dSel.appendChild(opt);
  }

  // 印鑑（Driveの「ハンコ」フォルダから動的取得）
  const hSel = document.getElementById('p-hanko');
  try {
    const j = await apiGet('hanko_list', { userId: cfg.userId });
    for (const name of (j.data || [])) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name.replace(/\.(png|jpg|jpeg)$/i, '');
      hSel.appendChild(opt);
    }
  } catch (e) {
    msg.className = 'msg';
    msg.textContent = '印鑑リストの取得に失敗しました（印鑑なしでは出力できます）: ' + e.message;
  }

  document.getElementById('form-pdf').onsubmit = async (ev) => {
    ev.preventDefault();
    if (!navigator.onLine) {
      alert('PDF出力はオンライン時のみ可能です');
      return;
    }
    const btn = document.getElementById('btn-pdf');
    btn.disabled = true;
    btn.textContent = 'PDF作成中…（30秒ほどかかることがあります）';
    msg.className = 'msg';
    msg.textContent = '';
    results.innerHTML = '';
    try {
      const payload = {
        '開始日': document.getElementById('p-start').value,
        '終了日': document.getElementById('p-end').value,
      };
      if (vSel.value) payload['車種'] = vSel.value;
      if (dSel.value) payload['運転者'] = dSel.value;
      if (hSel.value) payload['印鑑'] = hSel.value;
      const j = await apiPost('export_pdf', payload, { userId: cfg.userId });
      const files = j.files || [];
      msg.className = 'msg ok';
      const unmatched = Array.isArray(j.unmatchedRegions) ? j.unmatchedRegions : [];
      const warn = unmatched.length ? `\n⚠️ 印鑑が自動割当できなかった車両（エリア未対応）: ${unmatched.join('、')}` : '';
      msg.style.whiteSpace = 'pre-line';
      msg.textContent = `${files.length} 件のPDFを作成しました（対象 ${j.count} レコード／車両ごとに結合）。Driveの「PDF」フォルダにも保存済みです。下のリンクからダウンロードできます。${warn}`;
      for (const f of files) {
        const bytes = Uint8Array.from(atob(f.base64), c => c.charCodeAt(0));
        const blob = new Blob([bytes], { type: 'application/pdf' });
        const url = URL.createObjectURL(blob);
        const div = document.createElement('div');
        div.style.margin = '8px 0';
        const a = document.createElement('a');
        a.href = url;
        a.download = f.name;
        a.textContent = '⬇ ' + f.name;
        div.appendChild(a);
        results.appendChild(div);
      }
    } catch (e) {
      msg.className = 'msg ng';
      msg.textContent = '失敗: ' + e.message;
    } finally {
      btn.disabled = false;
      btn.textContent = 'PDF作成';
    }
  };
}

async function renderSettings() {
  if (!me.loaded) await fetchMe();
  setTitle('設定');
  const view = document.getElementById('view');
  view.appendChild(document.getElementById('tpl-settings').content.cloneNode(true));
  document.getElementById('set-who').textContent = `${displayStaffName(cfg.userName)} (${cfg.userId})`;
  document.getElementById('set-url').textContent = cfg.url || '（未設定）';
  document.getElementById('set-token').textContent = cfg.token ? cfg.token.slice(0, 8) + '...' : '（未設定）';
  document.getElementById('ver').textContent = APP_VERSION;
  const pending = await dbAll('pending');
  document.getElementById('set-pending').textContent = pending.length;

  // v0.14.0: 管理者ログイン状態の表示と操作（管理者IDかつパスワード設定済のときのみ）
  const whoP = document.getElementById('set-who').closest('p');
  if (whoP && me.serverEligible && me.adminPasswordSet) {
    const wrap = document.createElement('p');
    const refreshAdminUI = () => {
      wrap.innerHTML = '';
      const span = document.createElement('span');
      const btn = document.createElement('button');
      btn.className = 'ghost'; btn.type = 'button';
      btn.style.marginLeft = '8px';
      if (me.isAdmin) {
        span.textContent = '管理者: ✅ ログイン中';
        btn.textContent = '管理者ログアウト';
        btn.onclick = () => {
          clearAdminToken(); recomputeAdmin();
          document.querySelectorAll('.navbtn.admin-only').forEach(x => { x.hidden = !me.isAdmin; });
          go('#/list');
        };
      } else {
        span.textContent = '管理者: 🔒 未ログイン';
        btn.textContent = '管理者ログイン';
        btn.onclick = async () => {
          const ok = await showAdminLogin();
          if (ok) {
            document.querySelectorAll('.navbtn.admin-only').forEach(x => { x.hidden = !me.isAdmin; });
            refreshAdminUI();
          }
        };
      }
      wrap.appendChild(span); wrap.appendChild(btn);
    };
    refreshAdminUI();
    whoP.after(wrap);
  }

  document.getElementById('btn-change-user').onclick = () => go('#/picker');
  document.getElementById('btn-edit-config').onclick = () => go('#/config');
  document.getElementById('btn-clear-cache').onclick = async () => {
    if (!confirm('全てのローカルデータ（設定・未送信を含む）を消去します。よろしいですか？')) return;
    clearAdminToken();
    localStorage.clear();
    const db = await openDB();
    db.close();
    indexedDB.deleteDatabase(DB_NAME);
    location.reload();
  };
  const btnUpd = document.getElementById('btn-check-update');
  if (btnUpd) {
    btnUpd.onclick = async () => {
      const st = document.getElementById('update-status');
      st.textContent = '確認中…';
      const r = await checkApkUpdate({ force: true });
      if (r.error) { st.textContent = '確認に失敗しました: ' + r.error; return; }
      if (r.hasUpdate) {
        st.innerHTML = `新しいアプリ版 v${escape(r.latest)} があります。<a href="${escape(r.manifest.url || '#')}" target="_blank" rel="noopener noreferrer">ダウンロード</a>`;
      } else {
        st.textContent = `最新です（入っているAPK: v${r.installed} ／ 公開中の最新: v${r.latest}）`;
      }
    };
  }
}

// ----- 同期 -----
async function syncPending() {
  if (!navigator.onLine) return 0;
  const pending = await dbAll('pending');
  let sent = 0;
  for (const p of pending) {
    try {
      await apiPost('create_log', p.payload);
      await dbDel('pending', p.id);
      sent++;
    } catch (e) {
      console.warn('sync failed', e);
      break; // 1件失敗したら以降は次回に持ち越し
    }
  }
  return sent;
}

// ----- ユーティリティ -----
function escape(s) {
  return String(s).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
}
function formatDate(s) {
  if (!s) return '';
  const d = new Date(s);
  if (isNaN(d)) return s;
  const m = (d.getMonth() + 1).toString().padStart(2, '0');
  const day = d.getDate().toString().padStart(2, '0');
  return `${d.getFullYear()}/${m}/${day}`;
}

// ----- 起動 -----
window.addEventListener('hashchange', handleRoute);
window.addEventListener('online', async () => {
  setNetStatus();
  const n = await syncPending();
  if (n > 0 && location.hash === '#/list') handleRoute();
});
window.addEventListener('offline', setNetStatus);

document.getElementById('btn-back').onclick = () => history.length > 1 ? history.back() : go('#/list');
document.querySelectorAll('.navbtn').forEach(b => {
  b.onclick = () => go(b.dataset.route);
});

// Service Worker 登録
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./service-worker.js').catch(e => console.warn('SW failed', e));
  });
}

setNetStatus();
whoLabel();
if (!location.hash) location.hash = '#/list';
handleRoute();
// v0.10.5: アプリ本体(APK)の更新チェック（APK内のみバナー表示）
checkApkUpdate().catch(() => {});
// Phase B/E/G/H: 起動時に権限・社員マスタ・確認者リストを取得
// v0.9.3: 裏で list キャッシュも温める（直接 #/new で開いても発車前メータ自動補完が効くように）
(async () => {
  if (cfg.url && cfg.token && cfg.userId) {
    await fetchMe();
    // v0.14.0「毎回入力」: 管理者IDだが、この起動でまだ未ログイン（adminToken無し）なら
    // 入力者選択へ誘導して再ログインを促す。一般ユーザー・パスワード未設定時は従来通り。
    const adminNeedsLogin = me.serverEligible && me.adminPasswordSet && !getAdminToken();
    await fetchStaff(); // Phase G: 社員マスタ取得
    await fetchCheckers(); // Phase H: 確認者リスト取得
    document.querySelectorAll('.navbtn.admin-only').forEach(b => { b.hidden = !me.isAdmin; });
    // 裏で list キャッシュを温める（await しない）
    apiGet('list', { limit: 100 }).then(j => {
      if (j.data && j.data.length > 0) {
        dbPut('cache', { key: 'list_last', value: j.data, at: Date.now() }).catch(() => {});
      }
    }).catch(() => {});
    // v0.14.2: 自分の前回車両を起動時に先読みして端末メモリへ（次回の新規フォームを待ち時間ゼロに）
    apiGet('last_vehicle', { driver: cfg.userId }).then(j => {
      if (j && j.found && j['車種']) setLastVehicleForDriver(cfg.userId, String(j['車種']), j['到着後メータ']);
    }).catch(() => {});
    if (adminNeedsLogin) {
      go('#/picker');
    } else if (location.hash === '' || location.hash === '#/list' || location.hash === '#') {
      handleRoute();
    }
  }
})();
