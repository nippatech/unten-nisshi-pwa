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

const APP_VERSION = '0.5.0-poc';
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

// PoCではマスタが整備されていないため、社員一覧をハードコード（将来は社員マスタAPIに差替え）
const STAFF_FALLBACK = [
  { id: 'NIP006', name: '門田' },
  { id: 'NIP500', name: '受領担当' },
  { id: 'NIP-A', name: '運転者A' },
  { id: 'NIP-B', name: '運転者B' },
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
  // ナビ active 表示
  document.querySelectorAll('.navbtn').forEach(b => {
    b.classList.toggle('active', b.dataset.route === location.hash);
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
function renderPicker() {
  setTitle('入力者選択');
  const view = document.getElementById('view');
  view.appendChild(document.getElementById('tpl-picker').content.cloneNode(true));
  const list = document.getElementById('picker-list');
  STAFF_FALLBACK.forEach(s => {
    const b = document.createElement('button');
    b.innerHTML = `${s.name}<span class="pid">${s.id}</span>`;
    b.onclick = async () => {
      cfg.userId = s.id;
      cfg.userName = s.name;
      whoLabel();
      await fetchMe(); // Phase B: 自分の権限を取得
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
    const label = `${v['車種'] || ''} / ${v['車輛番号'] || ''}`.trim() + (v['使用者'] ? ` / ${v['使用者']}` : '');
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
  const addDestRow = (preset = {}) => {
    const row = document.createElement('div');
    row.className = 'dest-row';
    // 拠店セレクト
    const placeSel = document.createElement('select');
    placeSel.className = 'dest-place';
    const places = [...new Set(destMaster.map(d => d['拠店']).filter(Boolean))];
    placeSel.innerHTML = '<option value="">拠店を選択</option>'
      + places.map(p => `<option value="${escape(p)}"${preset['拠店'] === p ? ' selected' : ''}>${escape(p)}</option>`).join('');
    // 行先セレクト
    const destSel = document.createElement('select');
    destSel.className = 'dest-name';
    const fillDest = () => {
      const place = placeSel.value;
      const opts = destMaster.filter(d => !place || d['拠店'] === place).map(d => d['行先']).filter(Boolean);
      destSel.innerHTML = '<option value="">行先を選択</option>'
        + [...new Set(opts)].map(o => `<option value="${escape(o)}"${preset['行先'] === o ? ' selected' : ''}>${escape(o)}</option>`).join('');
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
    row.appendChild(destSel);
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

    const payload = {
      '日時': document.getElementById('f-date').value,
      '車種': document.getElementById('f-vehicle').value,
      'ETC 使用': document.getElementById('f-etc').checked,
      '発車前メータ': Number(document.getElementById('f-start').value),
      '到着後メータ': Number(document.getElementById('f-end').value),
      '給油(L)': document.getElementById('f-fuel').value ? Number(document.getElementById('f-fuel').value) : '',
      'アルコールチェック表示': document.getElementById('f-alc').value || '',
      '備考': document.getElementById('f-memo').value || '',
      '運転者': cfg.userId,
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
// Phase B: 起動時に自分の権限情報を取得して一覧の編集ボタン表示に反映
(async () => {
  if (cfg.url && cfg.token && cfg.userId) {
    await fetchMe();
    if (location.hash === '' || location.hash === '#/list' || location.hash === '#') {
      handleRoute();
    }
  }
})();
