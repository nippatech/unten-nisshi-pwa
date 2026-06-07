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

const APP_VERSION = '0.9.6-poc';
const LS_URL = 'unten.gas_url';
const LS_TOKEN = 'unten.token';
const LS_USER = 'unten.user_id';
const LS_USER_NAME = 'unten.user_name';

// Phase B: 自分の権限情報（me APIの結果）をメモリにキャッシュ
const me = {
  isAdmin: false,
  editWindowDays: 30,
  loaded: false,
};
async function fetchMe() {
  if (!cfg.url || !cfg.token || !cfg.userId) return;
  try {
    const j = await apiGet('me', { userId: cfg.userId });
    me.isAdmin = !!j.isAdmin;
    me.editWindowDays = j.editWindowDays || 30;
    me.loaded = true;
  } catch (e) {
    console.warn('fetchMe failed', e);
  }
}
// Phase G: 社員マスタ（動的取得）
let staffList = []; // [{社員ID, 氏名, 退職フラグ}]
async function fetchStaff(includeRetired) {
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

// ----- 設定 -----
const cfg = {
  get url() { return localStorage.getItem(LS_URL) || ''; },
  set url(v) { localStorage.setItem(LS_URL, v); },
  get token() { return localStorage.getItem(LS_TOKEN) || ''; },
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
    body: JSON.stringify({ token: cfg.token, action, payload, ...extra }),
    redirect: 'follow',
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || 'API failed');
  return j;
}

// ----- ルーター -----
const routes = {
  '#/config': renderConfig,
  '#/picker': renderPicker,
  '#/list': renderList,
  '#/new': renderForm,
  '#/bulk': renderBulk,
  '#/staff': renderStaff,
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
  w.textContent = cfg.userName ? cfg.userName : '';
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
    const name = String(s['氏名'] || id);
    const b = document.createElement('button');
    // 社員IDが氏名と同じ場合はID表示を省略
    b.innerHTML = (id === name)
      ? escape(name)
      : `${escape(name)}<span class="pid">${escape(id)}</span>`;
    b.onclick = async () => {
      cfg.userId = id;
      cfg.userName = name;
      whoLabel();
      await fetchMe(); // 自分の権限を取得
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

  const refresh = async () => {
    msg.className = 'msg'; msg.textContent = '読み込み中…';
    items.innerHTML = '';
    // 未送信表示
    const pending = await dbAll('pending');
    if (pending.length > 0) {
      const banner = document.getElementById('pending-banner');
      banner.hidden = false;
      document.getElementById('pending-count').textContent = pending.length;
      pending.forEach(p => items.appendChild(renderLogCard(p.payload, true)));
    } else {
      document.getElementById('pending-banner').hidden = true;
    }
    // サーバーから取得（Phase D: showDeleted を引き渡し）
    try {
      const params = { limit: 20 };
      if (_showDeleted) params.showDeleted = 'true';
      const j = await apiGet('list', params);
      const suffix = _showDeleted ? '（削除済含む）' : '';
      countEl.textContent = `${j.count + pending.length} 件${suffix}（うち未送信 ${pending.length}）`;
      j.data.forEach(d => items.appendChild(renderLogCard(d, false)));
      msg.textContent = '';
      // キャッシュ
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
  const date = formatDate(d['日時']);
  const km = d['走行距離（km)'] ?? d['走行距離(km)'] ?? '-';
  const fuel = d['給油(L)'] ? ` / 給油 ${d['給油(L)']}L` : '';
  const driver = d['運転者'] ? ` / 運転者 ${d['運転者']}` : '';
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
      <b>${km} km</b> ／ ${d['発車前メータ'] || '?'} → ${d['到着後メータ'] || '?'}${fuel}${driver}
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
    const name = String(s['氏名'] || id);
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
  vehicles.forEach(v => {
    const opt = document.createElement('option');
    opt.value = v.ID;
    // 使用者は別ドロップダウン（運転者）で選ぶので車種ラベルからは除外（退職者名の残留防止）
    const label = `${v['車種'] || ''} / ${v['車輛番号'] || ''}`.trim().replace(/\s*\/\s*$/, '').replace(/^\s*\/\s*/, '');
    opt.textContent = label;
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
        // 既に車種が選ばれていてヒントが「過去レコードなし」だった場合は再試行
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
  let destRowSeq = 0;
  const addDestRow = (preset = {}) => {
    destRowSeq++;
    const row = document.createElement('div');
    row.className = 'dest-row';
    // 拠店セレクト
    const placeSel = document.createElement('select');
    placeSel.className = 'dest-place';
    const places = [...new Set(destMaster.map(d => d['拠店']).filter(Boolean))];
    placeSel.innerHTML = '<option value="">拠店を選択</option>'
      + places.map(p => `<option value="${escape(p)}"${preset['拠店'] === p ? ' selected' : ''}>${escape(p)}</option>`).join('');
    // Phase H: 行先 input + datalist（拠店連動 + 部分一致補完）
    const destInput = document.createElement('input');
    destInput.type = 'text';
    destInput.className = 'dest-name';
    destInput.placeholder = '行先を入力 or 選択';
    destInput.value = preset['行先'] || '';
    const dl = document.createElement('datalist');
    const dlId = 'dest-dl-' + destRowSeq + '-' + Date.now();
    dl.id = dlId;
    destInput.setAttribute('list', dlId);
    const fillDest = () => {
      const place = placeSel.value;
      const opts = destMaster.filter(d => !place || d['拠店'] === place).map(d => d['行先']).filter(Boolean);
      dl.innerHTML = [...new Set(opts)].map(o => `<option value="${escape(o)}">`).join('');
    };
    fillDest();
    placeSel.onchange = fillDest;
    // 削除ボタン
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'rm';
    rm.textContent = '×';
    rm.onclick = () => row.remove();
    row.appendChild(placeSel);
    row.appendChild(destInput);
    row.appendChild(dl);
    row.appendChild(rm);
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
        msg.textContent = `更新しました（権限: ${j.by || 'OK'}）`;
        setTimeout(() => go('#/list'), 800);
      } catch (e) {
        msg.className = 'msg ng';
        msg.textContent = `更新失敗: ${e.message}`;
        btn.disabled = false;
      }
      return;
    }

    // 新規登録
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
      msg.textContent = `登録しました（ID: ${j.id}）`;
      setTimeout(() => go('#/list'), 800);
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
    const driverOpts = activeStaff().map(s => {
      const id = String(s['社員ID']);
      const name = String(s['氏名'] || id);
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
async function renderStaff() {
  if (!me.loaded) await fetchMe();
  if (!me.isAdmin) {
    alert('社員管理は管理者のみ利用できます');
    return go('#/list');
  }
  setTitle('社員管理');
  const view = document.getElementById('view');
  view.appendChild(document.getElementById('tpl-staff').content.cloneNode(true));

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
          <button class="ghost small ${isRetired ? '' : 'danger'}" data-toggle="${escape(id)}" data-retired="${isRetired ? '1' : '0'}">${isRetired ? '復職' : '退職'}</button>
        </div>
      `;
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
async function renderSettings() {
  setTitle('設定');
  const view = document.getElementById('view');
  view.appendChild(document.getElementById('tpl-settings').content.cloneNode(true));
  document.getElementById('set-who').textContent = `${cfg.userName} (${cfg.userId})`;
  document.getElementById('set-url').textContent = cfg.url || '（未設定）';
  document.getElementById('set-token').textContent = cfg.token ? cfg.token.slice(0, 8) + '...' : '（未設定）';
  document.getElementById('ver').textContent = APP_VERSION;
  const pending = await dbAll('pending');
  document.getElementById('set-pending').textContent = pending.length;

  document.getElementById('btn-change-user').onclick = () => go('#/picker');
  document.getElementById('btn-edit-config').onclick = () => go('#/config');
  document.getElementById('btn-clear-cache').onclick = async () => {
    if (!confirm('全てのローカルデータ（設定・未送信を含む）を消去します。よろしいですか？')) return;
    localStorage.clear();
    const db = await openDB();
    db.close();
    indexedDB.deleteDatabase(DB_NAME);
    location.reload();
  };
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
// Phase B/E/G/H: 起動時に権限・社員マスタ・確認者リストを取得
// v0.9.3: 裏で list キャッシュも温める（直接 #/new で開いても発車前メータ自動補完が効くように）
(async () => {
  if (cfg.url && cfg.token && cfg.userId) {
    await fetchMe();
    await fetchStaff(); // Phase G: 社員マスタ取得
    await fetchCheckers(); // Phase H: 確認者リスト取得
    document.querySelectorAll('.navbtn.admin-only').forEach(b => { b.hidden = !me.isAdmin; });
    // 裏で list キャッシュを温める（await しない）
    apiGet('list', { limit: 100 }).then(j => {
      if (j.data && j.data.length > 0) {
        dbPut('cache', { key: 'list_last', value: j.data, at: Date.now() }).catch(() => {});
      }
    }).catch(() => {});
    if (location.hash === '' || location.hash === '#/list' || location.hash === '#') {
      handleRoute();
    }
  }
})();
