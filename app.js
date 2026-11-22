/* ============================================================
   小帳本 — 記帳 App（PWA）
   2.0.0 起資料存在雲端（Firebase Firestore），用 Google 帳號登入。
   每個人有自己的「個人帳本」，也可以建立和家人共用的「家用帳本」。
   舊版存在手機 localStorage 的資料，第一次登入時會搬到個人帳本（手機裡的原始資料不刪）。
   ============================================================ */
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import { getAuth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, signOut } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  doc, collection, query, where, getDoc, getDocs, setDoc, updateDoc, deleteDoc, onSnapshot, writeBatch,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

const STORE_KEY = 'xiaozhangben:v1'; // 舊版（1.x）存在手機裡的資料
const APP_VERSION = '2.5.1';
// 1.2.0 起支出分類分成「主分類 + 次分類」，資料格式 version 2（舊資料自動轉換）。
// 1.1.0 起只記支出。舊版的收入／轉帳記錄仍保留在資料與備份檔中，只是不顯示。

// ---------- 小工具 ----------
const $ = (s, el = document) => el.querySelector(s);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const round2 = (n) => Math.round(n * 100) / 100;
const fmt = (n) => round2(n).toLocaleString('zh-TW', { maximumFractionDigits: 2 });
const money = (n) => (n < 0 ? '−' : '') + '$' + fmt(Math.abs(n));
const pad = (n) => String(n).padStart(2, '0');
const dateStr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayStr = () => dateStr(new Date());
const parseDate = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
const TYPE_LABEL = { expense: '支出', income: '收入', transfer: '轉帳' };

const EMOJIS = ['🍳','🍱','🍜','🍔','☕','🧋','🍰','🍺','🛒','🧻','🚌','🚇','🚕','⛽','🅿️','🚗','🛵','✈️','🛍️','👕','💄','🎮','🎬','🎤','🏨','💊','🏥','🏠','🛋️','📱','💡','💧','🔥','📚','🎓','🎁','❤️','🐶','👶','💇','🏋️','💻','🔧','📦','💰','🎉','📈','💼','🏦','🪙','💵','💳','👛','🐷','🧾','❔'];

// 預設的支出分類：[主分類, 圖示, [次分類…]]
const DEFAULT_TREE = [
  ['飲食', '🍱', ['早餐', '午餐', '晚餐', '飲料', '點心', '宵夜']],
  ['交通', '🚌', ['捷運公車', '計程車', '加油', '停車', '高鐵火車']],
  ['購物', '🛍️', ['衣服', '鞋包', '3C', '網購']],
  ['日用品', '🧻', ['清潔用品', '衛浴用品', '廚房用品']],
  ['居家', '🏠', ['房租', '家具', '修繕']],
  ['帳單', '💡', ['水電瓦斯', '電話網路', '訂閱']],
  ['娛樂', '🎮', ['電影', '遊戲', '旅遊', 'KTV']],
  ['醫療', '💊', ['看診', '藥品', '保健食品']],
  ['教育', '📚', ['書籍', '課程']],
  ['人情', '🎁', ['紅包', '禮物', '請客']],
  ['其他', '📦', []],
];

function defaultData() {
  const c = (name, icon) => ({ id: uid(), name, icon });
  return {
    version: 2,
    accounts: [
      { id: uid(), name: '現金', icon: '💵', initial: 0 },
      { id: uid(), name: '銀行', icon: '🏦', initial: 0 },
      { id: uid(), name: '信用卡', icon: '💳', initial: 0 },
    ],
    categories: {
      expense: DEFAULT_TREE.map(([name, icon, subs]) => ({ id: uid(), name, icon, subs: subs.map((s) => ({ id: uid(), name: s })) })),
      income: [
        c('薪水', '💰'), c('獎金', '🎉'), c('投資', '📈'), c('兼職', '💼'), c('利息', '🏦'), c('其他', '📦'),
      ],
    },
    txs: [],
    prefs: {},
    budget: 0,       // 每月預算（0 = 沒設定）
    recurring: [],   // 固定支出
    shortcuts: [],   // 記一筆的常用捷徑
  };
}

function validData(d) {
  return d && Array.isArray(d.txs) && Array.isArray(d.accounts) && d.categories &&
    Array.isArray(d.categories.expense) && Array.isArray(d.categories.income);
}

// 舊版（單層分類）→ 新版（主分類 + 次分類）。
// 依名稱對應預設分類：例如舊的「早餐」變成「飲食 › 早餐」，原本的記錄跟著搬過去；
// 自己新增、對不上的分類保留為主分類。所有 id 都沿用，不會遺失任何記錄。
function migrateFlat(d) {
  const old = d.categories.expense.map((c) => ({ id: String(c.id), name: String(c.name ?? ''), icon: c.icon || '❔' }));
  const used = new Set();
  const take = (name) => { const c = old.find((o) => o.name === name && !used.has(o.id)); if (c) used.add(c.id); return c; };
  const moved = new Map(); // 舊分類 id → { main, sub }
  const tree = DEFAULT_TREE.map(([name, icon, subNames]) => {
    const asMain = take(name);
    const main = { id: asMain?.id ?? uid(), name, icon: asMain?.icon ?? icon, subs: [] };
    for (const s of subNames) {
      const asSub = take(s);
      const sub = { id: asSub?.id ?? uid(), name: s };
      main.subs.push(sub);
      if (asSub) moved.set(asSub.id, { main: main.id, sub: sub.id });
    }
    return main;
  });
  for (const o of old) if (!used.has(o.id)) tree.push({ ...o, subs: [] });
  d.categories.expense = tree;
  for (const t of d.txs) {
    const m = t && t.type === 'expense' && moved.get(String(t.categoryId));
    if (m) { t.categoryId = m.main; t.subCategoryId = m.sub; }
  }
  return d;
}

let migratedOnLoad = false;
function normalize(d) {
  if (!d.categories.expense.every((c) => Array.isArray(c.subs))) { migrateFlat(d); migratedOnLoad = true; }
  return {
    version: 2,
    accounts: d.accounts.map((a) => ({ id: String(a.id), name: String(a.name ?? ''), icon: a.icon || '👛', initial: Number(a.initial) || 0 })),
    categories: {
      expense: d.categories.expense.map((c) => ({
        id: String(c.id), name: String(c.name ?? ''), icon: c.icon || '❔',
        subs: c.subs.map((s) => ({ id: String(s.id), name: String(s.name ?? '') })),
      })),
      income: d.categories.income.map((c) => ({ id: String(c.id), name: String(c.name ?? ''), icon: c.icon || '❔' })),
    },
    txs: d.txs
      .filter((t) => t && ['expense', 'income', 'transfer'].includes(t.type) && /^\d{4}-\d{2}-\d{2}$/.test(t.date))
      .map((t) => ({ ...t, amount: Number(t.amount) || 0, note: String(t.note ?? ''), subCategoryId: t.subCategoryId ? String(t.subCategoryId) : null })),
    prefs: d.prefs && typeof d.prefs === 'object' ? d.prefs : {},
    ...normExtras(d),
  };
}

// 2.3.0 起帳本多了：每月預算、固定支出、常用捷徑（舊資料沒有就用空的）
function normExtras(d) {
  const str = (v) => (v == null || v === '' ? null : String(v));
  return {
    budget: Math.max(0, Number(d.budget) || 0),
    recurring: (Array.isArray(d.recurring) ? d.recurring : []).filter((r) => r && r.id).map((r) => ({
      id: String(r.id), name: String(r.name ?? ''), amount: Number(r.amount) || 0,
      day: Math.min(31, Math.max(1, Number(r.day) || 1)),
      categoryId: str(r.categoryId), subCategoryId: str(r.subCategoryId), accountId: str(r.accountId),
      lastDone: str(r.lastDone), // 最後處理的月份 'YYYY-MM'
    })),
    shortcuts: (Array.isArray(d.shortcuts) ? d.shortcuts : []).filter((s) => s && s.id).map((s) => ({
      id: String(s.id), name: String(s.name ?? ''), amount: Number(s.amount) || 0,
      categoryId: str(s.categoryId), subCategoryId: str(s.subCategoryId), accountId: str(s.accountId),
    })),
  };
}

// ---------- 手機裡的小設定（不重要、不同步） ----------
const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };

// 舊版存在手機裡的資料（沒有就回傳 null）
function loadLocal() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) { const d = JSON.parse(raw); if (validData(d)) return normalize(d); }
  } catch {}
  return null;
}

// ---------- 雲端（Firebase） ----------
const firebaseConfig = {
  apiKey: 'AIzaSyAKyW6CjZbb36AQm6VnoCgqfHMRBYpqwxg',
  authDomain: 'xiaozhangben-7d819.firebaseapp.com',
  projectId: 'xiaozhangben-7d819',
  storageBucket: 'xiaozhangben-7d819.firebasestorage.app',
  messagingSenderId: '874281493317',
  appId: '1:874281493317:web:859b3870f68846e21d542c',
};
const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
// 開啟手機端快取：沒網路也能看、能記，連上網路後自動上傳
const db = initializeFirestore(fbApp, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });

/*
  雲端資料結構
  ledgers/{帳本id}            帳本：{ type:'personal'|'family', name, owner, memberEmails[], members{uid:{name,email}}, accounts[], categories{} }
                               個人帳本的 id 固定是 'p_' + uid
  ledgers/{帳本id}/txs/{id}   每一筆記錄（欄位跟舊版一樣，另外多了 by／byName：誰記的）
*/
const cloud = {
  status: 'init',   // init 載入中、signedOut 未登入、migrating 搬資料中、ready 可以用
  user: null,
  email: '',
  ledgers: [],      // 我能看的帳本（個人＋家用）
  activeId: null,
  meta: null,       // 目前帳本的資訊（名稱、成員…）
  gotMeta: false, gotTxs: false,
  pending: false,   // 有還沒上傳到雲端的修改
  unsub: [],
  loginError: '',
};
const myName = () => cloud.user?.displayName || cloud.email.split('@')[0] || '我';
const activeLedger = () => cloud.ledgers.find((l) => l.id === cloud.activeId) || null;
const isFamily = () => cloud.meta?.type === 'family';
const isOwner = () => cloud.meta?.owner === cloud.user?.uid;
const ledgerLabel = (l) => (l.type === 'personal' ? '👤 個人' : `🏠 ${l.name || '家用'}`);

// 目前顯示的帳本資料（格式跟舊版相同，畫面程式不用改）
let data = { ...defaultData(), accounts: [], categories: { expense: [], income: [] } };
// 上次跟雲端同步時的樣子：save() 比對出有改的地方才上傳
let synced = { meta: '', txs: new Map() };
// 帳本本身的設定（不含每筆記錄）：有變才寫回雲端
const META_KEYS = ['accounts', 'categories', 'budget', 'recurring', 'shortcuts'];
const metaOf = (d) => Object.fromEntries(META_KEYS.map((k) => [k, d[k]]));
const metaJSON = (d) => JSON.stringify(metaOf(d));
const clean = (o) => JSON.parse(JSON.stringify(o)); // 拿掉 undefined（Firestore 不接受）
const ledgerRef = (id) => doc(db, 'ledgers', id);
const txRef = (lid, id) => doc(db, 'ledgers', lid, 'txs', String(id).replace(/\//g, '_'));

// 分批寫入（Firestore 一次最多 500 筆）
async function commitOps(ops) {
  for (let i = 0; i < ops.length; i += 400) {
    const b = writeBatch(db);
    for (const [kind, ref, val, opt] of ops.slice(i, i + 400)) {
      if (kind === 'del') b.delete(ref); else b.set(ref, val, opt || {});
    }
    await b.commit();
  }
}

// 把目前的 data 跟雲端比對，有改的才寫上去（離線時會先存在手機，連上網路再上傳）
function save() {
  const lid = cloud.activeId;
  if (cloud.status !== 'ready' || !lid || !cloud.gotMeta || !cloud.gotTxs) return;
  const book = books.get(lid);
  if (book) book.data = data; // 匯入、清除時 data 會整個換掉，要接回這本帳本
  lsSet('xiaozhangben:prefs:' + lid, JSON.stringify(data.prefs || {}));
  const ops = [];
  const mj = metaJSON(data);
  if (mj !== synced.meta) {
    ops.push(['set', ledgerRef(lid), clean({ ...metaOf(data), updatedAt: Date.now() }), { merge: true }]);
    synced.meta = mj;
    if (cloud.meta?.apiKey) publishApi(lid).catch(() => {}); // 分類或付款方式改了，給 AI 讀的那份也更新
  }
  const seen = new Set();
  for (const t of data.txs) {
    seen.add(t.id);
    const j = JSON.stringify(t);
    if (synced.txs.get(t.id) !== j) { ops.push(['set', txRef(lid, t.id), clean(t)]); synced.txs.set(t.id, j); }
  }
  for (const id of [...synced.txs.keys()]) {
    if (!seen.has(id)) { ops.push(['del', txRef(lid, id)]); synced.txs.delete(id); }
  }
  if (!ops.length) return;
  commitOps(ops).catch((e) => {
    console.error(e);
    toast(e.code === 'permission-denied' ? '沒有權限修改這本帳本' : '上傳到雲端失敗，請檢查網路');
  });
}

// 每一本帳本都在背景持續同步（books），切換帳本時直接換畫面，不用重新載入
const books = new Map(); // 帳本id → { id, meta, data, synced, gotMeta, gotTxs, pending, unsub[] }

function stopListening() {
  cloud.unsub.forEach((f) => { try { f(); } catch {} });
  cloud.unsub = [];
  for (const b of books.values()) closeBook(b);
  books.clear();
}
function closeBook(b) {
  b.unsub.forEach((f) => { try { f(); } catch {} });
  b.unsub = [];
}

// 讓畫面改用某本帳本的資料
function activate(b) {
  data = b.data; synced = b.synced;
  cloud.meta = b.meta; cloud.gotMeta = b.gotMeta; cloud.gotTxs = b.gotTxs; cloud.pending = b.pending;
}

// 取得（沒有就建立並開始同步）某本帳本
function bookFor(id) {
  if (books.has(id)) return books.get(id);
  let prefs = {};
  try { prefs = JSON.parse(lsGet('xiaozhangben:prefs:' + id) || '{}') || {}; } catch {}
  const b = {
    id, meta: null, gotMeta: false, gotTxs: false, pending: false, unsub: [],
    data: { version: 2, accounts: [], categories: { expense: [], income: [] }, txs: [], prefs, budget: 0, recurring: [], shortcuts: [] },
    synced: { meta: '', txs: new Map() },
  };
  books.set(id, b);
  const isActive = () => cloud.activeId === id && books.get(id) === b;
  const changed = () => { if (isActive()) { activate(b); render(); } };
  const onErr = (e) => {
    console.error(e);
    if (e.code !== 'permission-denied') return;
    closeBook(b);
    books.delete(id);
    if (isActive() || cloud.activeId === id) {
      toast('你已經不在這本帳本的成員裡');
      openLedger('p_' + cloud.user.uid);
    }
  };
  b.unsub.push(onSnapshot(ledgerRef(id), (snap) => {
    if (!snap.exists()) return;
    const m = snap.data();
    b.meta = { id, ...m };
    const d = normalize({ ...m, accounts: m.accounts || [], categories: { expense: m.categories?.expense || [], income: m.categories?.income || [] }, txs: [], prefs: {} });
    const mj = metaJSON(d);
    // 只有別人（或另一支手機）改過才換掉，避免打斷正在編輯的畫面
    if (mj !== b.synced.meta) { for (const k of META_KEYS) b.data[k] = d[k]; b.synced.meta = mj; }
    b.gotMeta = true;
    if (m.apiKey) publishApi(id).catch(() => {}); // 失敗的話下次再試
    // 家用帳本：把自己的名字記在成員名單上，讓大家看得到是誰記的
    if (m.type === 'family' && m.members?.[cloud.user.uid]?.name !== myName()) {
      updateDoc(ledgerRef(id), { [`members.${cloud.user.uid}`]: { name: myName(), email: cloud.email } }).catch(() => {});
    }
    changed();
  }, onErr));
  b.unsub.push(onSnapshot(collection(db, 'ledgers', id, 'txs'), { includeMetadataChanges: true }, (snap) => {
    const wasPending = b.pending;
    b.pending = snap.metadata.hasPendingWrites;
    const hasChanges = snap.docChanges().length > 0 || !b.gotTxs;
    if (hasChanges) {
      const txs = [];
      for (const ds of snap.docs) {
        const t = ds.data();
        if (t && t.id) txs.push(t);
      }
      b.data.txs = normalize({ accounts: [], categories: { expense: [], income: [] }, txs }).txs;
      // 用正規化後的內容當作比對基準
      b.synced.txs = new Map(b.data.txs.map((t) => [t.id, JSON.stringify(t)]));
      b.gotTxs = true;
    }
    if (hasChanges || wasPending !== b.pending) changed();
  }, onErr));
  return b;
}

// 切換到某一本帳本（已經在背景同步的話，畫面立刻換好）
function openLedger(id) {
  const switching = cloud.activeId && cloud.activeId !== id;
  cloud.activeId = id;
  activate(bookFor(id));
  ui.reportAccs.clear(); ui.reportSel = null; ui.search = null;
  lsSet('xiaozhangben:active:' + cloud.user.uid, id);
  render();
  if (switching) {
    const v = $('#view');
    v.classList.remove('swap'); void v.offsetWidth; v.classList.add('swap'); // 輕輕淡入，讓人知道換了帳本
  }
}

// 第一次登入：建立個人帳本，並把手機裡的舊資料搬上去
async function ensurePersonal() {
  const uid = cloud.user.uid;
  const ref = ledgerRef('p_' + uid);
  const local = loadLocal();
  const doneKey = 'xiaozhangben:migrated:' + uid;
  let snap = null, exists = false;
  try {
    snap = await getDoc(ref);
    exists = snap.exists();
  } catch (e) {
    if (!navigator.onLine) return;
    // 安全規則不允許讀取「還不存在」的帳本，所以讀不到 = 還沒建立
    if (e.code !== 'permission-denied') throw e;
  }
  const needMigrate = local && !lsGet(doneKey) && local.txs.length > 0;
  if (exists && !needMigrate) return;

  cloud.status = 'migrating'; render();
  if (!exists) {
    const base = local || defaultData();
    await setDoc(ref, clean({
      type: 'personal', name: '個人', owner: uid, ownerEmail: cloud.email, memberEmails: [cloud.email],
      members: { [uid]: { name: myName(), email: cloud.email } },
      accounts: base.accounts, categories: base.categories, createdAt: Date.now(),
    }));
  } else {
    // 雲端已經有個人帳本：空的就直接用手機的分類，已經有記錄就把手機的分類／付款方式合併進去
    const cur = snap.data();
    const has = await getDocs(collection(db, 'ledgers', 'p_' + uid, 'txs'));
    let accounts = local.accounts, categories = local.categories;
    if (!has.empty) {
      accounts = [...(cur.accounts || [])];
      for (const a of local.accounts) if (!accounts.some((x) => x.id === a.id)) accounts.push(a);
      const exp = (cur.categories?.expense || []).map((c) => ({ ...c, subs: [...(c.subs || [])] }));
      for (const c of local.categories.expense) {
        const hit = exp.find((x) => x.id === c.id);
        if (!hit) exp.push(c);
        else for (const s of c.subs) if (!hit.subs.some((x) => x.id === s.id)) hit.subs.push(s);
      }
      categories = { expense: exp, income: cur.categories?.income || local.categories.income };
    }
    await setDoc(ref, clean({ accounts, categories, updatedAt: Date.now() }), { merge: true });
  }
  if (local && local.txs.length && !lsGet(doneKey)) {
    await commitOps(local.txs.map((t) => ['set', txRef('p_' + uid, t.id), clean(t)]));
    lsSet(doneKey, String(Date.now()));
    setTimeout(() => toast(`已把手機裡的 ${local.txs.filter((t) => t.type === 'expense').length} 筆記錄搬到雲端`), 600);
  }
}

async function startSession(user) {
  cloud.user = user;
  cloud.email = (user.email || '').toLowerCase();
  cloud.status = 'init'; render();
  try {
    await ensurePersonal();
  } catch (e) {
    console.error(e);
    cloud.status = 'signedOut';
    cloud.loginError = '連線到雲端失敗，請確認網路後再試一次。（' + (e.code || e.message) + '）';
    render();
    return;
  }
  cloud.status = 'ready';
  stopListening();
  // 帳本清單（個人＋我被加入的家用帳本）
  cloud.unsub.push(onSnapshot(query(collection(db, 'ledgers'), where('memberEmails', 'array-contains', cloud.email)), (snap) => {
    const order = (l) => (l.type === 'personal' ? 0 : 1);
    cloud.ledgers = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => order(a) - order(b) || (a.createdAt || 0) - (b.createdAt || 0));
    // 每本帳本都先在背景同步好，切換時就不用等
    for (const l of cloud.ledgers) bookFor(l.id);
    if (!snap.metadata.fromCache) {
      for (const [id, b] of books) {
        if (id !== cloud.activeId && !cloud.ledgers.some((l) => l.id === id)) { closeBook(b); books.delete(id); }
      }
    }
    if (cloud.activeId && !cloud.ledgers.some((l) => l.id === cloud.activeId) && !snap.metadata.fromCache) openLedger('p_' + cloud.user.uid);
    else render();
  }, (e) => console.error(e)));
  const saved = lsGet('xiaozhangben:active:' + user.uid);
  openLedger(saved || 'p_' + user.uid);
}

async function login() {
  cloud.loginError = '';
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  try {
    await signInWithPopup(auth, provider);
  } catch (e) {
    if (['auth/popup-blocked', 'auth/operation-not-supported-in-this-environment', 'auth/cancelled-popup-request'].includes(e.code)) {
      try { await signInWithRedirect(auth, provider); return; } catch (e2) { e = e2; }
    }
    if (e.code === 'auth/popup-closed-by-user') return;
    cloud.loginError = '登入失敗：' + (e.code || e.message);
    render();
  }
}

async function logout() {
  if (!(await askConfirm({ title: '確定要登出嗎？', message: '資料都在雲端，下次登入同一個 Google 帳號就會回來。', ok: '登出', danger: false }))) return;
  closeLayer();
  stopListening();
  await signOut(auth);
}

// ---------- 畫面狀態 ----------
const currentYM = () => { const d = new Date(); return { y: d.getFullYear(), m: d.getMonth() + 1 }; };
const ymKey = (ym) => `${ym.y}-${pad(ym.m)}`;
// day：首頁選取的日期；range：明細清單要看「當天／當週／整月」；calOpen：是否展開整月日曆
// 電腦版（螢幕寬）：日曆預設就展開整月
const isWide = () => window.matchMedia('(min-width: 960px)').matches;
// search：明細頁的搜尋條件（null = 沒在搜尋）
const ui = { tab: 'list', ym: currentYM(), reportSel: null, reportAccs: new Set(), day: todayStr(), range: 'month', calOpen: isWide(), search: null };

// 換月份後的狀態：本月就選今天，其他月份選 1 號；清單回到看整月
function monthState(delta) {
  let { y, m } = ui.ym;
  m += delta;
  while (m < 1) { m += 12; y--; }
  while (m > 12) { m -= 12; y++; }
  const now = currentYM();
  return { ym: { y, m }, day: y === now.y && m === now.m ? todayStr() : `${y}-${pad(m)}-01`, range: 'month' };
}
function shiftMonth(delta) {
  Object.assign(ui, monthState(delta));
}

// ---------- 日期小工具（週一為一週的第一天） ----------
const addDays = (ds, n) => { const d = parseDate(ds); d.setDate(d.getDate() + n); return dateStr(d); };
const weekStartOf = (ds) => { const d = parseDate(ds); return addDays(ds, -((d.getDay() + 6) % 7)); };
const ymOf = (ds) => { const [y, m] = ds.split('-').map(Number); return { y, m }; };
const md = (ds) => { const d = parseDate(ds); return `${d.getMonth() + 1}/${d.getDate()}`; };
function selectDay(ds, range) {
  ui.day = ds;
  ui.ym = ymOf(ds);
  if (range) ui.range = range;
}

const findCat = (type, id) => (data.categories[type] || []).find((c) => c.id === id);
const findSub = (cat, subId) => (subId && cat?.subs ? cat.subs.find((s) => s.id === subId) : undefined);
const findAcc = (id) => data.accounts.find((a) => a.id === id);
const accName = (id) => findAcc(id)?.name ?? '（已刪除帳戶）';
// 只取「支出」記錄
const monthTxs = () => { const k = ymKey(ui.ym); return data.txs.filter((t) => t.type === 'expense' && t.date.startsWith(k)); };
const sumAmt = (txs) => round2(txs.reduce((s, t) => s + t.amount, 0));

// 算日平均用的天數：本月算到今天，其他月份算整個月
function daysForAvg() {
  const now = new Date();
  const isThisMonth = ui.ym.y === now.getFullYear() && ui.ym.m === now.getMonth() + 1;
  return isThisMonth ? now.getDate() : new Date(ui.ym.y, ui.ym.m, 0).getDate();
}

// ---------- 主畫面 ----------
function render() {
  const ready = cloud.status === 'ready';
  document.body.classList.toggle('no-tabs', !ready);
  if (!ready) { $('#view').innerHTML = viewGate(); $('#view').dataset.tab = 'gate'; return; }
  $('#view').dataset.tab = ui.tab;
  $('#view').innerHTML = cloud.gotMeta && cloud.gotTxs ? VIEWS[ui.tab]() : ledgerBar() + `<div class="empty"><div class="spinner"></div>載入帳本中…</div>`;
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('on', b.dataset.tab === ui.tab));
  // 電腦版左邊選單下方的帳本切換
  $('#sideLedger').innerHTML = cloud.ledgers.length < 2 ? '' : `<div class="side-h">帳本</div>` + cloud.ledgers.map((l) =>
    `<button class="side-lg${l.id === cloud.activeId ? ' on' : ''}" data-action="switch-ledger" data-id="${esc(l.id)}">${esc(ledgerLabel(l))}</button>`).join('');
}

// 登入畫面／載入中
function viewGate() {
  if (cloud.status === 'signedOut') {
    return `<div class="gate">
      <img class="gate-icon" src="icon-192.png" alt="">
      <h1>小帳本</h1>
      <p>用 Google 帳號登入，記帳資料會存在雲端。換手機也不會不見，還可以跟家人一起記。</p>
      <button class="btn-primary" data-action="login">
        <svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C36.9 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>
        用 Google 登入
      </button>
      ${cloud.loginError ? `<p class="gate-err">${esc(cloud.loginError)}</p>` : ''}
      ${loadLocal()?.txs.length ? `<p class="hint">登入後，這支手機裡原本的記錄會自動搬到你的個人帳本。</p>` : ''}
    </div>`;
  }
  const msg = cloud.status === 'migrating' ? '正在把手機裡的記錄搬到雲端…<br>請不要關掉 App' : '載入中…';
  return `<div class="gate"><div class="spinner"></div><p>${msg}</p></div>`;
}

// 帳本切換：月份列左邊的小按鈕（只有一本帳本時不顯示）
function ledgerPill() {
  if (cloud.ledgers.length < 2) return '';
  const cur = activeLedger() || cloud.meta;
  const fam = cur?.type === 'family';
  return `<button class="ledger-pill${fam ? ' fam' : ''}" data-action="choose-ledger" aria-label="切換帳本，目前是${esc(cur ? ledgerLabel(cur) : '')}">
    <span class="lp-icon">${fam ? '🏠' : '👤'}</span><span class="lp-name">${esc(fam ? (cur.name || '家用') : '個人')}</span></button>`;
}
const ledgerBar = () => (cloud.ledgers.length < 2 ? '' : `<div class="monthbar">${ledgerPill()}</div>`);

function monthBar(withCal = false) {
  const cal = withCal
    ? `<button class="cal-btn${ui.calOpen ? ' on' : ''}" data-action="toggle-cal" aria-label="${ui.calOpen ? '收起日曆' : '展開整月日曆'}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3.5" y="5" width="17" height="15" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>
      </button>`
    : '';
  return `<div class="monthbar">
    ${ledgerPill()}
    <button class="icon-btn" data-action="month" data-d="-1" aria-label="上個月">‹</button>
    <button class="month-label" data-action="month-now" title="回到本月">${ui.ym.y} 年 ${ui.ym.m} 月</button>
    <button class="icon-btn" data-action="month" data-d="1" aria-label="下個月">›</button>
    ${cal}
  </div>`;
}

// ---------- 首頁日曆：這星期（可展開成整月） ----------
// 滑到上一頁（-1）或下一頁（1）之後的狀態
function calNeighbor(dir) {
  if (ui.calOpen) return monthState(dir);
  const day = addDays(ui.day, dir * 7);
  return { ym: ymOf(day), day, range: ui.range };
}

// 一頁日曆（一週或整月），st = { ym, day, range }
function calRows(st, byDay) {
  const today = todayStr();
  const monthKey = ymKey(st.ym);
  const cell = (ds) => {
    const cls = ['dcell'];
    if (ds === today) cls.push('today');
    if (ds === st.day) cls.push('sel');
    if (!ds.startsWith(monthKey)) cls.push('out');
    const n = byDay.get(ds);
    return `<button class="${cls.join(' ')}" data-action="pick-day" data-date="${ds}" aria-label="${md(ds)}${n ? '，支出 ' + fmt(n.sum) : ''}">
      <span class="dnum">${parseDate(ds).getDate()}</span><span class="ddot${n ? ' on' : ''}"></span>
    </button>`;
  };
  const row = (start) => {
    const on = st.range === 'week' && weekStartOf(st.day) === start ? ' wk-on' : '';
    return `<div class="wk-row${on}">${[0, 1, 2, 3, 4, 5, 6].map((i) => cell(addDays(start, i))).join('')}</div>`;
  };
  if (!ui.calOpen) return row(weekStartOf(st.day));
  const first = `${monthKey}-01`;
  const last = `${monthKey}-${pad(new Date(st.ym.y, st.ym.m, 0).getDate())}`;
  let rows = '';
  for (let s = weekStartOf(first); s <= last; s = addDays(s, 7)) rows += row(s);
  return rows;
}

// 左右各多畫一頁（上一週／下一週或上個月／下個月），滑動時手指拖到哪、日曆就跟到哪
function calendarCard(byDay) {
  const cur = { ym: ui.ym, day: ui.day, range: ui.range };
  return `<div class="cal-card" data-swipe="${ui.calOpen ? 'month' : 'week'}">
    <div class="wk-head">${['一', '二', '三', '四', '五', '六', '日'].map((w, i) => `<span${i > 4 ? ' class="we"' : ''}>週${w}</span>`).join('')}</div>
    <div class="cal-vp"><div class="cal-track">
      <div class="cal-pane prev" aria-hidden="true">${calRows(calNeighbor(-1), byDay)}</div>
      <div class="cal-pane cur">${calRows(cur, byDay)}</div>
      <div class="cal-pane next" aria-hidden="true">${calRows(calNeighbor(1), byDay)}</div>
    </div></div>
    <div class="cal-hint">${ui.calOpen ? '左右滑動切換月份' : '左右滑動切換星期'}</div>
  </div>`;
}

// 今日／本週／本月：同時是明細清單的篩選按鈕
function rangeStats(byDay) {
  const today = todayStr();
  const ws = weekStartOf(ui.day), we = addDays(ws, 6);
  let wSum = 0, wCnt = 0;
  for (let ds = ws; ds <= we; ds = addDays(ds, 1)) { const n = byDay.get(ds); if (n) { wSum += n.sum; wCnt += n.cnt; } }
  const mTx = monthTxs();
  const mSum = sumAmt(mTx);
  const d = byDay.get(ui.day) || { sum: 0, cnt: 0 };
  const box = (r, label, value, sub) => `<button class="stat${ui.range === r ? ' on' : ''}" data-action="range" data-r="${r}">
    <span class="lbl">${label}</span><span class="sv">$${fmt(value)}</span><span class="ss">${sub}</span></button>`;
  return `<div class="stats">
    ${box('day', ui.day === today ? '今日' : md(ui.day), d.sum, `${d.cnt} 筆`)}
    ${box('week', ws <= today && today <= we ? '本週' : `${md(ws)}–${md(we)}`, round2(wSum), `${wCnt} 筆`)}
    ${box('month', `${ui.ym.m} 月`, mSum, `日均 $${fmt(Math.round(mSum / daysForAvg()))}`)}
  </div>`;
}

function summaryCard(txs, label = `${ui.ym.m} 月支出`) {
  const total = sumAmt(txs);
  return `<div class="card month-sum">
    <div class="lbl">${esc(label)}</div>
    <div class="month-total">$${fmt(total)}</div>
    <div class="month-meta">共 ${txs.length} 筆 · 日平均 $${fmt(Math.round(total / daysForAvg()))}</div>
  </div>`;
}

// 標題顯示次分類（沒有就顯示主分類）；第二行用不同顏色的小標籤分開「主分類」「付款方式」「記錄者」；有備註時第三行顯示備註
function txRow(t) {
  const c = findCat('expense', t.categoryId);
  const s = findSub(c, t.subCategoryId);
  const title = s ? s.name : (c?.name ?? '未分類');
  const who = isFamily() && t.by ? (t.by === cloud.user.uid ? '我' : (cloud.meta.members?.[t.by]?.name || t.byName || '家人')) : null;
  const a = findAcc(t.accountId);
  const tags = [
    s ? `<span class="tag tag-cat">${esc(c.name)}</span>` : '',
    `<span class="tag tag-acc">${a ? `<i>${esc(a.icon)}</i>` : ''}${esc(a?.name ?? '（已刪除帳戶）')}</span>`,
    who ? `<span class="tag tag-who"><i>👤</i>${esc(who)}</span>` : '',
  ].join('');
  return `<button class="tx" data-action="edit-tx" data-id="${esc(t.id)}">
    <span class="tx-icon">${esc(c?.icon ?? '❔')}</span>
    <span class="tx-main"><span class="tx-name">${esc(title)}</span><span class="tx-tags">${tags}</span>${t.note ? `<span class="tx-note">${esc(t.note)}</span>` : ''}</span>
    <span class="tx-amt">${fmt(t.amount)}</span>
  </button>`;
}

function dayLabel(ds) {
  const d = parseDate(ds);
  const today = todayStr();
  const y = new Date(); y.setDate(y.getDate() - 1);
  let tag = '';
  if (ds === today) tag = '<span class="tag">今天</span>';
  else if (ds === dateStr(y)) tag = '<span class="tag">昨天</span>';
  return `${d.getMonth() + 1}月${d.getDate()}日 週${WEEK[d.getDay()]}${tag}`;
}

// ---------- 搜尋與篩選 ----------
const SEARCH_EMPTY = { q: '', from: '', to: '', acc: '', by: '' };
const memberList = () => Object.entries(cloud.meta?.members || {}).map(([id, m]) => ({ id, name: m.name || m.email || '家人' }));

function viewSearch() {
  const s = ui.search;
  const opt = (v, label, sel) => `<option value="${esc(v)}"${v === sel ? ' selected' : ''}>${esc(label)}</option>`;
  return `<div class="search-page">
    <div class="search-top">
      <label class="search-box">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
        <input id="sQ" type="search" placeholder="搜尋備註、主分類、次分類…" value="${esc(s.q)}" enterkeyhint="search" autocomplete="off">
      </label>
      <button class="text-btn" data-action="search-close">完成</button>
    </div>
    <div class="search-filters">
      <label class="sf sf-date"><span>從</span><input id="sFrom" type="date" value="${esc(s.from)}"></label>
      <label class="sf sf-date"><span>到</span><input id="sTo" type="date" value="${esc(s.to)}"></label>
      <label class="sf"><select id="sAcc" aria-label="付款方式">${opt('', '全部付款方式', s.acc)}${data.accounts.map((a) => opt(a.id, `${a.icon} ${a.name}`, s.acc)).join('')}</select></label>
      ${isFamily() ? `<label class="sf"><select id="sBy" aria-label="記錄者">${opt('', '全部記錄者', s.by)}${memberList().map((m) => opt(m.id, m.id === cloud.user.uid ? `${m.name}（我）` : m.name, s.by)).join('')}</select></label>` : ''}
      ${s.q || s.from || s.to || s.acc || s.by ? `<button class="text-btn sf-clear" data-action="search-clear">清除條件</button>` : ''}
    </div>
    <div id="searchResults">${searchResults()}</div>
  </div>`;
}

function searchResults() {
  const s = ui.search;
  const q = s.q.trim().toLowerCase();
  if (!q && !s.from && !s.to && !s.acc && !s.by) {
    return `<div class="empty"><div class="big">🔍</div>輸入關鍵字，或選擇日期、付款方式${isFamily() ? '、記錄者' : ''}來篩選</div>`;
  }
  const hits = data.txs.filter((t) => {
    if (t.type !== 'expense') return false;
    if (s.from && t.date < s.from) return false;
    if (s.to && t.date > s.to) return false;
    if (s.acc && t.accountId !== s.acc) return false;
    if (s.by && t.by !== s.by) return false;
    if (!q) return true;
    const c = findCat('expense', t.categoryId);
    const sub = findSub(c, t.subCategoryId);
    return [t.note, c?.name, sub?.name].some((x) => x && String(x).toLowerCase().includes(q));
  }).sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || 0) - (a.createdAt || 0));
  let html = `<div class="search-sum">找到 <b>${hits.length}</b> 筆，合計 <b>$${fmt(sumAmt(hits))}</b></div>`;
  if (!hits.length) return html + `<div class="empty">沒有符合的記錄</div>`;
  const groups = new Map();
  for (const t of hits.slice(0, 500)) {
    if (!groups.has(t.date)) groups.set(t.date, []);
    groups.get(t.date).push(t);
  }
  for (const [ds, list] of groups) {
    html += `<section class="day"><div class="day-head"><span>${ds.slice(0, 4)}年${dayLabel(ds)}</span><span>$${fmt(sumAmt(list))}</span></div>
      <div class="rows">${list.map(txRow).join('')}</div></section>`;
  }
  if (hits.length > 500) html += `<p class="hint">只顯示最近 500 筆，可以加上日期縮小範圍。</p>`;
  return html;
}

// 搜尋框和篩選條件改變時，只更新結果（不重畫整頁，打字才不會被打斷）
function onSearchInput(ev) {
  if (!ui.search || !ev.target.closest('.search-page')) return;
  const map = { sQ: 'q', sFrom: 'from', sTo: 'to', sAcc: 'acc', sBy: 'by' };
  const key = map[ev.target.id];
  if (!key) return;
  ui.search[key] = ev.target.value;
  $('#searchResults').innerHTML = searchResults();
  const clearBtn = $('.sf-clear'), any = Object.values(ui.search).some(Boolean);
  if (any && !clearBtn) $('.search-filters').insertAdjacentHTML('beforeend', `<button class="text-btn sf-clear" data-action="search-clear">清除條件</button>`);
  if (!any && clearBtn) clearBtn.remove();
}
document.addEventListener('input', onSearchInput);
document.addEventListener('change', onSearchInput);

// ---------- 每月預算 ----------
function budgetBar() {
  const budget = data.budget || 0;
  if (!budget) return '';
  const spent = sumAmt(monthTxs());
  const left = round2(budget - spent);
  const ratio = spent / budget;
  const cls = left < 0 ? ' over' : ratio >= 0.8 ? ' warn' : '';
  const now = currentYM();
  let tip = '';
  if (ui.ym.y === now.y && ui.ym.m === now.m && left > 0) {
    const daysLeft = new Date(now.y, now.m, 0).getDate() - new Date().getDate() + 1;
    tip = ` · 平均每天可花 $${fmt(Math.floor(left / daysLeft))}`;
  }
  return `<button class="budget${cls}" data-action="edit-budget" aria-label="每月預算，點一下修改">
    <div class="bg-top"><span>${ui.ym.m} 月已花 <b>$${fmt(spent)}</b></span><span>${left < 0 ? `超支 <b>$${fmt(-left)}</b>` : `還剩 <b>$${fmt(left)}</b>`}</span></div>
    <div class="bg-bar"><i style="width:${Math.min(100, ratio * 100).toFixed(1)}%"></i></div>
    <div class="bg-sub">預算 $${fmt(budget)}${tip}</div>
  </button>`;
}

function editBudget() {
  openForm({
    title: '每月預算',
    fields: [
      { key: 'budget', label: `「${isFamily() ? (cloud.meta?.name || '家用') : '個人'}」帳本每個月的預算`, type: 'number', value: data.budget ? String(data.budget) : '', placeholder: '例如：20000', max: 9 },
      { type: 'note', key: 'n', label: isFamily() ? '家用帳本的預算全家共用，大家看到的都一樣。清空再儲存就會取消預算。' : '首頁會顯示這個月已花多少、還剩多少。清空再儲存就會取消預算。' },
    ],
    onSave: (v) => {
      const n = Number(String(v.budget).replace(/[,，\s]/g, ''));
      if (v.budget && !(n >= 0)) { toast('請輸入數字'); return false; }
      data.budget = v.budget ? Math.round(n) : 0;
      save(); render(); toast(data.budget ? `每月預算設為 $${fmt(data.budget)}` : '已取消每月預算');
    },
  });
}

// ---------- 固定支出 ----------
const dueDateOf = (r, ym) => `${ymKey(ym)}-${pad(Math.min(r.day, new Date(ym.y, ym.m, 0).getDate()))}`;
// 這個月已經到期、還沒處理的固定支出
function dueItems() {
  const now = currentYM(), key = ymKey(now), today = todayStr();
  return (data.recurring || []).filter((r) => r.lastDone !== key && dueDateOf(r, now) <= today);
}

function dueCard() {
  const items = dueItems();
  if (!items.length) return '';
  return `<div class="due-card"><div class="due-h">🔔 固定支出到期了</div>${items.map((r) => {
    const c = findCat('expense', r.categoryId);
    const sub = findSub(c, r.subCategoryId);
    return `<div class="due-row">
      <span class="tx-icon">${esc(c?.icon || '📌')}</span>
      <span class="tx-main"><span class="tx-name">${esc(r.name)}</span><span class="tx-sub">每月 ${r.day} 號 · ${esc([sub?.name || c?.name, accName(r.accountId)].filter(Boolean).join(' · '))}</span></span>
      <span class="tx-amt">$${fmt(r.amount)}</span>
      <div class="due-btns"><button class="cbtn" data-action="due-skip" data-id="${esc(r.id)}">這個月略過</button><button class="cbtn primary" data-action="due-pay" data-id="${esc(r.id)}">記一筆</button></div>
    </div>`;
  }).join('')}</div>`;
}

// 給表單用：「主分類 › 次分類」的選項
function catOptions() {
  const out = [];
  for (const c of data.categories.expense) {
    out.push({ value: c.id, label: `${c.icon} ${c.name}` });
    for (const s of c.subs) out.push({ value: `${c.id}|${s.id}`, label: `　${c.name} › ${s.name}` });
  }
  return out;
}
const splitCat = (v) => { const [c, s] = String(v || '').split('|'); return { categoryId: c || null, subCategoryId: s || null }; };
const catValue = (o) => (o?.categoryId ? (o.subCategoryId ? `${o.categoryId}|${o.subCategoryId}` : o.categoryId) : (data.categories.expense[0]?.id ?? ''));
const accOpts = () => data.accounts.map((a) => ({ value: a.id, label: `${a.icon} ${a.name}` }));

function editRecurring(r) {
  openForm({
    title: r ? '編輯固定支出' : '新增固定支出',
    fields: [
      { key: 'name', label: '名稱', value: r?.name ?? '', placeholder: '例如：房租、電信費、Netflix', max: 20 },
      { key: 'amount', label: '金額', type: 'number', value: r?.amount ? String(r.amount) : '', placeholder: '例如：899', max: 9 },
      { key: 'day', label: '每月幾號扣款（1–31）', type: 'number', value: String(r?.day ?? new Date().getDate()), max: 2 },
      { key: 'cat', label: '分類', type: 'select', value: catValue(r), options: catOptions() },
      { key: 'acc', label: '付款方式', type: 'select', value: r?.accountId ?? data.accounts[0]?.id, options: accOpts() },
      { type: 'note', key: 'n', label: '到了扣款日，首頁會出現提醒，點「記一筆」就會帶入這些內容，金額可以再改。' },
    ],
    onSave: (v) => {
      const amount = Number(String(v.amount).replace(/[,，\s]/g, ''));
      const day = Number(v.day);
      if (!v.name) { toast('請輸入名稱'); return false; }
      if (!(amount > 0)) { toast('請輸入金額'); return false; }
      if (!(day >= 1 && day <= 31)) { toast('扣款日請輸入 1 到 31'); return false; }
      const val = { name: v.name, amount: round2(amount), day: Math.round(day), ...splitCat(v.cat), accountId: v.acc || null };
      if (r) Object.assign(r, val);
      else data.recurring = [...(data.recurring || []), { id: uid(), ...val, lastDone: null }];
      save(); render(); toast('已儲存');
    },
    onDelete: r ? async () => {
      if (!(await askConfirm({ title: `確定刪除固定支出「${r.name}」嗎？`, message: '已經記下的帳不會受影響。', ok: '刪除' }))) return false;
      data.recurring = data.recurring.filter((x) => x.id !== r.id);
      save(); render(); toast('已刪除');
    } : null,
  });
}

// ---------- 常用捷徑 ----------
function editShortcut(s, fromEntry = null) {
  const base = s || fromEntry || {};
  openForm({
    title: s ? '編輯捷徑' : '新增捷徑',
    fields: [
      { key: 'name', label: '名稱', value: base.name ?? '', placeholder: '例如：早餐、停車、捷運', max: 8 },
      { key: 'cat', label: '分類', type: 'select', value: catValue(base), options: catOptions() },
      { key: 'acc', label: '付款方式', type: 'select', value: base.accountId ?? data.accounts[0]?.id, options: accOpts() },
      { key: 'amount', label: '預設金額（可不填）', type: 'number', value: base.amount ? String(base.amount) : '', placeholder: '不填就每次自己輸入', max: 9 },
    ],
    onSave: (v) => {
      if (!v.name) { toast('請輸入名稱'); return false; }
      const amount = v.amount ? Number(String(v.amount).replace(/[,，\s]/g, '')) : 0;
      if (v.amount && !(amount > 0)) { toast('金額請輸入數字'); return false; }
      const val = { name: v.name, ...splitCat(v.cat), accountId: v.acc || null, amount: round2(amount) };
      if (s) Object.assign(s, val);
      else data.shortcuts = [...(data.shortcuts || []), { id: uid(), ...val }];
      save();
      if (entry && $('#scRow')) $('#scRow').outerHTML = shortcutRow();
      render(); toast('已儲存捷徑');
    },
    onDelete: s ? async () => {
      if (!(await askConfirm({ title: `確定刪除捷徑「${s.name}」嗎？`, ok: '刪除' }))) return false;
      data.shortcuts = data.shortcuts.filter((x) => x.id !== s.id);
      save(); render(); toast('已刪除');
    } : null,
  });
}

function viewList() {
  if (ui.search) return viewSearch();
  // 每天的支出總額與筆數（給日曆小圓點和統計用）
  const byDay = new Map();
  for (const t of data.txs) {
    if (t.type !== 'expense') continue;
    const n = byDay.get(t.date) || { sum: 0, cnt: 0 };
    n.sum = round2(n.sum + t.amount); n.cnt++;
    byDay.set(t.date, n);
  }
  let pool, emptyMsg;
  if (ui.range === 'day') {
    pool = data.txs.filter((t) => t.type === 'expense' && t.date === ui.day);
    emptyMsg = `${md(ui.day)} 還沒有記錄`;
  } else if (ui.range === 'week') {
    const ws = weekStartOf(ui.day), we = addDays(ws, 6);
    pool = data.txs.filter((t) => t.type === 'expense' && t.date >= ws && t.date <= we);
    emptyMsg = '這個星期還沒有記錄';
  } else {
    pool = monthTxs();
    emptyMsg = '這個月還沒有記錄';
  }
  const txs = pool.sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || 0) - (a.createdAt || 0));
  // 手機：上下排；電腦：左邊日曆、右邊明細
  const side = monthBar(true) + calendarCard(byDay) + rangeStats(byDay) + budgetBar();
  let main = dueCard() + `<button class="search-open" data-action="search-open">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
      <span>搜尋明細（備註、分類、日期…）</span></button>`;
  if (!txs.length) {
    main += `<div class="empty"><div class="big">📝</div>${emptyMsg}<br>按「＋ 記一筆」開始記帳</div>`;
  } else {
    const groups = new Map();
    for (const t of txs) {
      if (!groups.has(t.date)) groups.set(t.date, []);
      groups.get(t.date).push(t);
    }
    for (const [ds, list] of groups) {
      main += `<section class="day">
        <div class="day-head"><span>${dayLabel(ds)}</span><span>$${fmt(sumAmt(list))}</span></div>
        <div class="rows">${list.map(txRow).join('')}</div>
      </section>`;
    }
  }
  return `<div class="lay-list"><div class="lay-side">${side}</div><div class="lay-main">${main}</div></div>`;
}

// ---------- 報表 ----------
function arcPath(cx, cy, r0, r1, a0, a1) {
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const p = (r, a) => `${(cx + r * Math.sin(a)).toFixed(2)} ${(cy - r * Math.cos(a)).toFixed(2)}`;
  return `M${p(r1, a0)}A${r1} ${r1} 0 ${large} 1 ${p(r1, a1)}L${p(r0, a1)}A${r0} ${r0} 0 ${large} 0 ${p(r0, a0)}Z`;
}

function donutSvg(slices, total, selId) {
  let inner;
  if (slices.length === 1) {
    const s = slices[0];
    inner = `<circle class="slice" cx="100" cy="100" r="80" style="fill:none;stroke:${s.color};stroke-width:32" data-action="report-sel" data-id="${esc(s.id)}"><title>${esc(s.name)} $${fmt(s.value)}</title></circle>`;
  } else {
    let a = 0;
    inner = slices.map((s) => {
      const a0 = a;
      const a1 = a + (s.value / total) * Math.PI * 2;
      a = a1;
      const dim = selId && selId !== s.id ? ' dim' : '';
      return `<path class="slice${dim}" d="${arcPath(100, 100, 64, 96, a0, a1)}" style="fill:${s.color}" data-action="report-sel" data-id="${esc(s.id)}"><title>${esc(s.name)} $${fmt(s.value)}</title></path>`;
    }).join('');
  }
  return `<svg class="donut" viewBox="0 0 200 200" role="img" aria-label="分類比例圖">${inner}</svg>`;
}

const pct = (v, total) => (total ? Math.round((v / total) * 1000) / 10 : 0) + '%';

// 報表的帳戶篩選：可多選，沒選任何一個就是「全部」
function accFilterBar() {
  for (const id of ui.reportAccs) if (!findAcc(id)) ui.reportAccs.delete(id); // 帳戶被刪掉了
  const all = ui.reportAccs.size === 0;
  return `<div class="acc-filter" role="group" aria-label="選擇帳戶">
    <button class="chip${all ? ' on' : ''}" data-action="report-acc" data-id="" aria-pressed="${all}">全部</button>
    ${data.accounts.map((a) => {
      const on = ui.reportAccs.has(a.id);
      return `<button class="chip${on ? ' on' : ''}" data-action="report-acc" data-id="${esc(a.id)}" aria-pressed="${on}">${on ? '✓ ' : ''}${esc(a.icon)} ${esc(a.name)}</button>`;
    }).join('')}
  </div>`;
}

// 近 12 個月支出長條圖（跟著上方的帳戶篩選）；點長條可以切到那個月
function trendCard() {
  const accs = ui.reportAccs;
  const idx = (ym) => ym.y * 12 + (ym.m - 1);
  const now = currentYM();
  // 平常顯示到本月為止的 12 個月；如果正在看的月份不在這段裡，就改成以那個月為結尾
  let end = idx(now);
  if (idx(ui.ym) > end || idx(ui.ym) < end - 11) end = idx(ui.ym);
  const months = [];
  for (let i = end - 11; i <= end; i++) months.push({ y: Math.floor(i / 12), m: (i % 12) + 1 });
  const sums = new Map();
  for (const t of data.txs) {
    if (t.type !== 'expense' || (accs.size && !accs.has(t.accountId))) continue;
    const k = t.date.slice(0, 7);
    sums.set(k, (sums.get(k) || 0) + t.amount);
  }
  const vals = months.map((ym) => round2(sums.get(ymKey(ym)) || 0));
  const max = Math.max(...vals);
  // 月平均只算有記帳的月份，剛開始用的時候才不會被前面空白的月份拉低
  const used = vals.filter((v) => v > 0);
  const avg = used.length ? used.reduce((s, v) => s + v, 0) / used.length : 0;
  const selKey = ymKey(ui.ym);
  const selVal = round2(sums.get(selKey) || 0);
  const first = months[0], last = months[11];
  return `<div class="card trend">
    <div class="trend-head">
      <span class="trend-title">近 12 個月支出</span>
      <span class="trend-sel">${ui.ym.m} 月 <b>$${fmt(selVal)}</b></span>
    </div>
    <div class="trend-bars">
      ${max && used.length > 1 ? `<div class="trend-avg" style="--p:${((avg / max) * 0.9).toFixed(4)}"></div>` : ''}
      ${months.map((ym, i) => {
        const v = vals[i];
        const h = max ? (v / max) * 90 : 0; // 最高的長條佔 90%，上面留一點空間
        const on = ymKey(ym) === selKey ? ' on' : '';
        return `<button class="tb${on}" data-action="trend-month" data-y="${ym.y}" data-m="${ym.m}" aria-label="${ym.y} 年 ${ym.m} 月 $${fmt(v)}" title="${ym.y}/${ym.m} $${fmt(v)}">
          <span class="tb-plot"><span class="tb-bar${v ? '' : ' zero'}" style="height:${v ? Math.max(2, h).toFixed(1) : 0}%"></span></span>
          <span class="tb-lbl">${ym.m}</span>
        </button>`;
      }).join('')}
    </div>
    <div class="trend-foot">
      <span>${used.length > 1 ? `<i class="avg-key"></i>月平均 $${fmt(Math.round(avg))}` : ''}</span>
      <span>${first.y}/${first.m} – ${last.y}/${last.m}</span>
    </div>
  </div>`;
}

function viewReport() {
  const accs = ui.reportAccs;
  const txs = accs.size ? monthTxs().filter((t) => accs.has(t.accountId)) : monthTxs();
  const type = 'expense';
  const label = accs.size ? `${ui.ym.m} 月支出 · ${data.accounts.filter((a) => accs.has(a.id)).map((a) => a.name).join('、')}` : undefined;
  // 電腦版：月份總額和 12 個月長條圖並排
  let html = monthBar() + accFilterBar() + `<div class="rep-top">${summaryCard(txs, label)}${trendCard()}</div>`;

  const sums = new Map();
  for (const t of txs) sums.set(t.categoryId, (sums.get(t.categoryId) || 0) + t.amount);
  const rows = [...sums].map(([id, value]) => {
    const c = findCat(type, id);
    return { id: id ?? '__none', name: c?.name ?? '未分類', icon: c?.icon ?? '❔', value: round2(value) };
  }).sort((a, b) => b.value - a.value);
  if (!rows.length) {
    return html + `<div class="empty"><div class="big">📊</div>${accs.size ? '選的帳戶這個月沒有支出' : `這個月還沒有${TYPE_LABEL[type]}記錄`}</div>`;
  }
  const total = round2(rows.reduce((s, r) => s + r.value, 0));

  // 圓餅圖只畫前 5 名，其餘合併成「其他」
  const TOP = 5;
  const colorOf = (i) => (i < TOP ? `var(--s${i + 1})` : 'var(--s-other)');
  const slices = rows.slice(0, TOP).map((r, i) => ({ ...r, color: colorOf(i) }));
  if (rows.length > TOP) {
    slices.push({ id: '__other', name: '其他（合併）', icon: '', value: round2(rows.slice(TOP).reduce((s, r) => s + r.value, 0)), color: 'var(--s-other)' });
  }
  // 選取的可能是圓餅的一塊，也可能是清單中排在第 6 名以後的主分類
  const selId = ui.reportSel;
  const rest = new Set(rows.slice(TOP).map((r) => r.id));
  const sel = slices.find((s) => s.id === selId) || rows.find((r) => r.id === selId);
  const sliceSel = selId && rest.has(selId) ? '__other' : selId;
  const center = sel
    ? `<div class="dc-lbl">${esc(sel.name)}</div><div class="dc-val">$${fmt(sel.value)}</div><div class="dc-sub">${pct(sel.value, total)}</div>`
    : `<div class="dc-lbl">總${TYPE_LABEL[type]}</div><div class="dc-val">$${fmt(total)}</div><div class="dc-sub">${rows.length} 個分類</div>`;

  html += `<div class="card cat-card">
    <div class="donut-box">${donutSvg(slices, total, sliceSel)}<div class="donut-center">${center}</div></div>
    <div class="rows cat-rows">
      ${rows.map((r, i) => {
        const on = selId === r.id || (selId === '__other' && i >= TOP);
        const dim = selId && !on ? ' dim' : '';
        const color = colorOf(i);
        const w = Math.max(1, (r.value / rows[0].value) * 100);
        return `<button class="crow${dim}" data-action="report-sel" data-id="${esc(r.id)}">
          <span class="dot" style="background:${color}"></span>
          <span class="ci">${esc(r.icon)}</span>
          <span class="cn">${esc(r.name)}<small>${pct(r.value, total)}</small></span>
          <span class="cv">$${fmt(r.value)}</span>
          <span class="cbar"><i style="width:${w}%;background:${color}"></i></span>
        </button>${selId === r.id ? subBreakdown(txs, r) : ''}`;
      }).join('')}
    </div>
  </div>
  <button class="btn-add" data-action="month-export">匯出 ${ui.ym.m} 月的支出明細</button>
  <p class="hint">上方可以選一個或多個帳戶，只看那些帳戶的支出。點長條圖可以切換到那個月。點主分類可以看它底下各個次分類花了多少。</p>`;
  return html;
}

// 某個主分類底下的次分類明細
function subBreakdown(txs, row) {
  const c = findCat('expense', row.id);
  const sums = new Map();
  for (const t of txs) {
    if (t.categoryId !== row.id) continue;
    const s = findSub(c, t.subCategoryId);
    const key = s ? s.id : '__none';
    sums.set(key, (sums.get(key) || 0) + t.amount);
  }
  const list = [...sums].map(([id, v]) => ({ name: id === '__none' ? '（未選次分類）' : findSub(c, id).name, value: round2(v) }))
    .sort((a, b) => b.value - a.value);
  return `<div class="srows">${list.map((s) =>
    `<div class="srow"><span class="sn">${esc(s.name)}</span><span class="sp">${pct(s.value, row.value)}</span><span class="sv">$${fmt(s.value)}</span></div>`).join('')}</div>`;
}

// ---------- 付款方式（每種付款方式本月花了多少） ----------
function viewPayments() {
  const txs = monthTxs();
  const sum = new Map(), cnt = new Map();
  for (const t of txs) {
    sum.set(t.accountId, (sum.get(t.accountId) || 0) + t.amount);
    cnt.set(t.accountId, (cnt.get(t.accountId) || 0) + 1);
  }
  return monthBar() + `<div class="rows">${data.accounts.map((a) =>
      `<button class="tx" data-action="edit-account" data-id="${esc(a.id)}">
        <span class="tx-icon">${esc(a.icon)}</span>
        <span class="tx-main"><span class="tx-name">${esc(a.name)}</span><span class="tx-sub">本月 ${cnt.get(a.id) || 0} 筆</span></span>
        <span class="tx-amt">$${fmt(sum.get(a.id) || 0)}</span>
      </button>`).join('')}</div>
    <button class="btn-add" data-action="add-account">＋ 新增付款方式</button>
    <p class="hint">這裡顯示每種付款方式這個月花了多少，例如信用卡這個月刷了多少。點一下可以修改名稱或圖示。</p>`;
}

// ---------- 設定 ----------
function viewSettings() {
  const fam = isFamily();
  const cur = cloud.meta;
  const hasFamily = cloud.ledgers.some((l) => l.type === 'family');
  const members = fam ? (cur.memberEmails || []) : [];
  const nameOf = (email) => Object.values(cur.members || {}).find((m) => m.email === email)?.name;
  const membersHtml = fam ? `<section class="group"><h2>「${esc(cur.name || '家用')}」的成員</h2><div class="rows">
      ${members.map((em) => `<div class="row member-row">
        <span class="tx-main"><span>${esc(nameOf(em) || em.split('@')[0])}${em === cloud.email ? '（我）' : ''}${em === cur.ownerEmail ? ' <small class="badge">建立者</small>' : ''}</span><span class="tx-sub">${esc(em)}</span></span>
        ${isOwner() && em !== cloud.email ? `<button class="text-btn danger" data-action="remove-member" data-email="${esc(em)}">移除</button>` : ''}
      </div>`).join('')}
      ${isOwner() ? `<button class="row" data-action="add-member"><span>＋ 加入家人</span><span class="row-val">用 Gmail ›</span></button>` : ''}
    </div>
    <p class="hint">${isOwner() ? '加入家人的 Gmail 後，請他用那個 Google 帳號登入小帳本，就會看到這本帳本。' : '只有建立者可以加入或移除成員。'}</p>
    ${isOwner() ? `<div class="rows" style="margin-top:12px"><button class="row danger" data-action="delete-family"><span>刪除這本家用帳本</span></button></div>` : ''}
    </section>` : '';
  return `<section class="group"><h2>帳號</h2><div class="rows">
      <div class="row member-row"><span class="tx-main"><span>${esc(myName())}</span><span class="tx-sub">${esc(cloud.email)}</span></span>
        <button class="text-btn" data-action="logout">登出</button></div>
    </div></section>
    <section class="group"><h2>帳本</h2><div class="rows">
      ${cloud.ledgers.map((l) => `<button class="row${l.id === cloud.activeId ? ' on' : ''}" data-action="switch-ledger" data-id="${esc(l.id)}">
        <span>${esc(ledgerLabel(l))}</span><span class="row-val">${l.id === cloud.activeId ? '✓ 目前' : '切換 ›'}</span></button>`).join('')}
      ${hasFamily ? '' : `<button class="row" data-action="create-family"><span>＋ 建立家用帳本</span><span class="row-val">跟家人一起記 ›</span></button>`}
    </div>
    <p class="hint">個人帳本只有你看得到；家用帳本你和加入的家人都看得到、都能記。</p>
    </section>
    ${membersHtml}
    <section class="group"><h2>每月預算</h2><div class="rows">
      <button class="row" data-action="edit-budget"><span>每月預算</span><span class="row-val">${data.budget ? `$${fmt(data.budget)}` : '未設定'} ›</span></button>
    </div><p class="hint">${fam ? '家用帳本全家共用同一個預算。' : ''}設定後首頁會顯示這個月已花多少、還剩多少。</p></section>
    <section class="group"><h2>固定支出</h2><div class="rows">
      ${(data.recurring || []).slice().sort((a, b) => a.day - b.day).map((r) => {
        const done = r.lastDone === ymKey(currentYM());
        return `<button class="row" data-action="edit-recurring" data-id="${esc(r.id)}"><span class="tx-main"><span>${esc(r.name)}</span><span class="tx-sub">每月 ${r.day} 號 · ${esc(accName(r.accountId))}${done ? ' · 本月已處理' : ''}</span></span><span class="row-val">$${fmt(r.amount)} ›</span></button>`;
      }).join('')}
      <button class="row" data-action="add-recurring"><span>＋ 新增固定支出</span><span class="row-val">房租、電信費… ›</span></button>
    </div><p class="hint">每月到扣款日，首頁會提醒你，點一下就能記一筆。</p></section>
    <section class="group"><h2>常用支出捷徑</h2><div class="rows">
      ${(data.shortcuts || []).map((s) => {
        const c = findCat('expense', s.categoryId), sub = findSub(c, s.subCategoryId);
        return `<button class="row" data-action="edit-shortcut" data-id="${esc(s.id)}"><span class="tx-main"><span>${esc(c?.icon || '⭐')} ${esc(s.name)}</span><span class="tx-sub">${esc([sub ? `${c.name} › ${sub.name}` : c?.name, accName(s.accountId)].filter(Boolean).join(' · '))}</span></span><span class="row-val">${s.amount ? `$${fmt(s.amount)}` : ''} ›</span></button>`;
      }).join('')}
      <button class="row" data-action="add-shortcut"><span>＋ 新增捷徑</span><span class="row-val">早餐、停車… ›</span></button>
    </div><p class="hint">記一筆時上方會出現這些捷徑，點一下帶入分類和付款方式。記一筆畫面也可以按「＋ 存成捷徑」。</p></section>
    <section class="group"><h2>分類</h2><div class="rows">
      <button class="row" data-action="manage-cats" data-type="expense"><span>支出分類</span><span class="row-val">${data.categories.expense.length} 個主分類 ›</span></button>
    </div>${fam ? '<p class="hint">家用帳本的分類和付款方式是全家共用的。</p>' : ''}</section>
    ${fam ? '' : `<section class="group"><h2>範例資料</h2><div class="rows">
      ${demoCount()
        ? `<button class="row danger" data-action="remove-demo"><span>移除範例資料</span><span class="row-val">${demoCount()} 筆 ›</span></button>`
        : `<button class="row" data-action="add-demo"><span>加入範例資料</span><span class="row-val">近 3 個月 ›</span></button>`}
    </div>
    <p class="hint">想先看看有資料時的樣子，可以加入一些假的支出記錄。範例資料可以一鍵移除，不會動到你自己記的帳。</p>
    </section>`}
    <section class="group"><h2>AI 整理帳單（分類 API）</h2><div class="rows">
      ${cur.apiKey ? `<div class="row api-row"><span class="tx-main"><span>API 網址</span><span class="tx-sub api-url">${esc(apiUrl(cur.apiKey))}</span></span>
          <button class="text-btn" data-action="api-copy-url">複製</button></div>
        <button class="row" data-action="api-copy-prompt"><span>複製給 AI 的指令</span><span class="row-val">含網址和分類 ›</span></button>
        <button class="row" data-action="api-regen"><span>重新產生網址</span><span class="row-val">舊網址會失效 ›</span></button>
        <button class="row danger" data-action="api-off"><span>停用 API</span></button>`
      : `<button class="row" data-action="api-on"><span>產生 API 網址</span><span class="row-val">讓 AI 讀分類 ›</span></button>
        <button class="row" data-action="api-copy-prompt"><span>複製給 AI 的指令</span><span class="row-val">只含分類 ›</span></button>`}
    </div>
    <p class="hint">把「給 AI 的指令」貼給 ChatGPT、Claude 等 AI，再附上信用卡帳單，AI 就會照小帳本的分類整理成 Excel，修改後用下面的「匯入 Excel」批次新增。API 網址只能讀到這本帳本的分類和付款方式名稱，讀不到記帳記錄，也不能修改帳本；請不要公開分享，萬一外流就按「重新產生網址」。</p>
    </section>
    <section class="group"><h2>匯入 Excel（批次新增）</h2><div class="rows">
      <button class="row" data-action="import-excel"><span>上傳 Excel 檔</span><span class="row-val">.xlsx / .csv ›</span></button>
      <button class="row" data-action="excel-template"><span>下載 Excel 範本</span><span class="row-val">含分類清單 ›</span></button>
      ${importBatches().map((b) => `<div class="row member-row"><span class="tx-main"><span>${esc(new Date(b.at).toLocaleDateString('zh-TW', { month: 'numeric', day: 'numeric' }))} 匯入 ${b.n} 筆 · $${fmt(b.sum)}</span><span class="tx-sub">記錄日期 ${esc(md(b.from))}${b.to !== b.from ? ` ～ ${esc(md(b.to))}` : ''}</span></span>
        <button class="text-btn danger" data-action="import-undo" data-id="${esc(b.id)}">刪除這批</button></div>`).join('')}
    </div>
    <p class="hint">Excel 第一列是欄位名稱：日期、金額、主分類、次分類、付款方式、備註。上傳後會先預覽，可以修改分類和付款方式，確認後才會存進目前這本帳本。匯錯了可以在這裡整批刪掉。</p>
    </section>
    <section class="group"><h2>資料備份（目前這本帳本）</h2><div class="rows">
      <button class="row" data-action="export-json"><span>匯出備份檔</span><span class="row-val">.json ›</span></button>
      ${fam && !isOwner() ? '' : `<button class="row" data-action="import-json"><span>從備份檔還原</span><span class="row-val">›</span></button>`}
      <button class="row" data-action="month-export"><span>匯出某個月的明細</span><span class="row-val">選月份 ›</span></button>
      <button class="row" data-action="export-csv"><span>匯出全部明細</span><span class="row-val">.csv ›</span></button>
      ${fam ? '' : `<button class="row danger" data-action="clear-all"><span>清除個人帳本的所有資料</span></button>`}
    </div>
    <p class="hint">記帳資料存在雲端（Google Firebase），換手機只要登入同一個 Google 帳號就會回來。沒有網路時也能記，連上網路後會自動上傳。想多一份保險，可以偶爾匯出備份檔。</p>
    </section>
    <section class="group"><h2>安裝到手機主畫面</h2><div class="rows">
      <div class="row"><span>iPhone（Safari）</span><span class="row-val">分享 → 加入主畫面</span></div>
      <div class="row"><span>Android（Chrome）</span><span class="row-val">⋮ → 安裝應用程式</span></div>
    </div></section>
    <section class="group"><h2>關於</h2><div class="rows">
      <div class="row"><span>記錄筆數</span><span class="row-val">${data.txs.filter((t) => t.type === 'expense').length}</span></div>
      <div class="row"><span>同步狀態</span><span class="row-val">${cloud.pending ? '⏳ 等待上傳（沒有網路？）' : '✓ 已同步到雲端'}</span></div>
      <div class="row"><span>版本</span><span class="row-val">${APP_VERSION}</span></div>
    </div></section>`;
}

// ---------- 範例資料（標記 demo: true，可一鍵移除） ----------
const demoCount = () => data.txs.filter((t) => t.demo).length;

function makeDemoTxs() {
  let seed = 20261121;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const between = (a, b, step = 5) => Math.round((a + rnd() * (b - a)) / step) * step;
  const acc = (i) => (data.accounts[i] || data.accounts[0]).id; // 0 現金、1 銀行、2 信用卡
  const out = [];
  // 依名稱找主分類／次分類；找不到主分類就用第一個，找不到次分類就不填
  const add = (date, mainName, subName, amount, accIdx, note = '') => {
    const c = data.categories.expense.find((x) => x.name === mainName) || data.categories.expense[0];
    const s = c.subs.find((x) => x.name === subName);
    out.push({
      id: uid(), type: 'expense', amount, categoryId: c.id, subCategoryId: s ? s.id : null, accountId: acc(accIdx),
      toAccountId: null, date, note, createdAt: Date.now() + out.length, demo: true,
    });
  };

  const today = new Date(); today.setHours(0, 0, 0, 0);
  for (let d = new Date(today.getFullYear(), today.getMonth() - 2, 1); d <= today; d.setDate(d.getDate() + 1)) {
    const ds = dateStr(d), day = d.getDate(), weekend = d.getDay() === 0 || d.getDay() === 6;
    if (rnd() < 0.8) add(ds, '飲食', '早餐', between(45, 95), 0, pick(['蛋餅豆漿', '三明治奶茶', '飯糰', '吐司加蛋', '']));
    if (rnd() < 0.85) add(ds, '飲食', '午餐', between(90, 180), 0, pick(['便當', '自助餐', '牛肉麵', '滷肉飯', '水餃', '']));
    if (rnd() < 0.7) {
      if (weekend) add(ds, '飲食', '晚餐', between(250, 650, 10), 2, pick(['火鍋', '燒肉', '義大利麵', '聚餐']));
      else add(ds, '飲食', '晚餐', between(100, 250), 0, pick(['拉麵', '小吃', '炒飯', '']));
    }
    if (rnd() < 0.5) add(ds, '飲食', '飲料', between(35, 75), 0, pick(['珍奶', '美式咖啡', '綠茶', '拿鐵']));
    if (rnd() < 0.15) add(ds, '飲食', '點心', between(40, 150), 0, pick(['雞排', '蛋糕', '鹹酥雞', '豆花']));
    if (rnd() < 0.05) add(ds, '飲食', '宵夜', between(80, 200), 0, pick(['鹽酥雞', '滷味']));
    if (day === 1) add(ds, '交通', '捷運公車', 500, 0, '悠遊卡加值');
    if (rnd() < 0.06) add(ds, '交通', '計程車', between(150, 400, 10), 2);
    if (day % 9 === 3) add(ds, '交通', '加油', between(800, 1300, 10), 2);
    if (rnd() < 0.06) {
      const [s, n] = pick([['衣服', '外套'], ['鞋包', '球鞋'], ['網購', '蝦皮'], ['3C', '充電線']]);
      add(ds, '購物', s, between(300, 2500, 10), 2, n);
    }
    if (rnd() < 0.08) {
      const [s, n] = pick([['清潔用品', '洗衣精'], ['衛浴用品', '洗髮精'], ['衛浴用品', '衛生紙'], ['廚房用品', '保鮮盒']]);
      add(ds, '日用品', s, between(80, 400), 0, n);
    }
    if (weekend && rnd() < 0.3) add(ds, '娛樂', pick(['電影', 'KTV', '遊戲']), between(250, 800, 10), 2);
    if (rnd() < 0.02) add(ds, '醫療', '看診', between(150, 500, 10), 0);
    if (rnd() < 0.02) add(ds, '醫療', '藥品', between(100, 400, 10), 0);
    if (rnd() < 0.03) add(ds, '居家', '家具', between(200, 1500, 10), 2, pick(['收納箱', '檯燈', '床單']));
    if (rnd() < 0.02) add(ds, '教育', '書籍', between(300, 600, 10), 2);
    if (rnd() < 0.015) add(ds, '人情', pick(['紅包', '禮物']), pick([600, 1200, 2000]), 0);
    if (day === 10) add(ds, '帳單', '水電瓦斯', between(600, 1800, 10), 1, pick(['電費', '水費', '瓦斯費']));
    if (day === 15) add(ds, '帳單', '電話網路', 899, 2, '月租費');
    if (day === 20) add(ds, '帳單', '訂閱', 390, 2, '影音串流');
  }
  return out;
}

const VIEWS = { list: viewList, report: viewReport, accounts: viewPayments, settings: viewSettings };

// ---------- 疊層（全螢幕頁 / 底部表單），支援手機返回鍵 ----------
const layers = [];
function openLayer(name) {
  $('#' + name).hidden = false;
  document.body.classList.add('locked');
  if (layers[layers.length - 1] !== name) {
    layers.push(name);
    history.pushState({ layer: name, depth: layers.length }, '');
  }
}
function closeLayer() {
  if (layers.length) history.back();
}
// 一次關掉好幾層（例如確認視窗＋後面的編輯畫面）
function closeLayers(n) {
  n = Math.min(n, layers.length);
  if (n > 0) history.go(-n);
}
function hideLayer(name) {
  const el = $('#' + name);
  el.hidden = true;
  el.innerHTML = '';
  if (name === 'sheet') { entry = null; catMgr = null; }
  if (name === 'modal') { form = null; imp = null; }
  if (name === 'confirm' && confirmCb) { const cb = confirmCb; confirmCb = null; cb(false); } // 按返回鍵／背景＝取消
  if (!layers.length) document.body.classList.remove('locked');
}
window.addEventListener('popstate', (ev) => {
  // 回到第幾層：關掉比它上面的所有疊層
  const keep = ev.state?.depth ?? 0;
  if (layers.length <= keep) { const name = layers.pop(); if (name) hideLayer(name); return; }
  while (layers.length > keep) hideLayer(layers.pop());
});

// ---------- App 內的確認視窗（取代瀏覽器內建的 confirm） ----------
let confirmCb = null;
// 按「確定」回傳 true（確認視窗還開著，由呼叫的地方關掉）；按取消、背景、返回鍵回傳 false
function askConfirm({ title, message = '', ok = '確定', danger = true, single = false }) {
  return new Promise((resolve) => {
    confirmCb = resolve;
    const btns = single
      ? `<button class="cbtn primary" data-action="confirm-no">${esc(ok)}</button>`
      : `<button class="cbtn" data-action="confirm-no">取消</button>
        <button class="cbtn ${danger ? 'danger' : 'primary'}" data-action="confirm-yes">${esc(ok)}</button>`;
    $('#confirm').innerHTML = `<div class="confirm-card" role="alertdialog" aria-modal="true" aria-label="${esc(title)}">
      <h3>${esc(title)}</h3>
      ${message ? `<p>${esc(message).replace(/\n/g, '<br>')}</p>` : ''}
      <div class="confirm-btns${single ? ' one' : ''}">${btns}</div>
    </div>`;
    openLayer('confirm');
    setTimeout(() => $('#confirm .cbtn.danger, #confirm .cbtn.primary')?.focus(), 50);
  });
}
// 只有一個「知道了」按鈕的提示視窗（取代瀏覽器內建的 alert），按了會自己關掉
const notice = (title, message = '') => askConfirm({ title, message, ok: '知道了', single: true });

// ---------- 記一筆 ----------
let entry = null;

// tx：要編輯的記錄；prefill：新增時先帶入的內容（固定支出、捷徑）
function openEntry(tx, prefill = null) {
  const lastAcc = findAcc(data.prefs.lastAccountId) ? data.prefs.lastAccountId : data.accounts[0]?.id;
  const p = tx || prefill || {};
  entry = {
    id: tx?.id ?? null,
    expr: p.amount ? String(p.amount) : '0',
    fresh: !!p.amount, // 已經有金額時，第一次按數字會取代原金額
    categoryId: (findCat('expense', p.categoryId) ? p.categoryId : null) ?? data.categories.expense[0]?.id ?? null,
    subCategoryId: p.subCategoryId ?? null,
    accountId: (findAcc(p.accountId) ? p.accountId : null) ?? lastAcc ?? null,
    date: p.date ?? (ui.tab === 'list' && ui.range === 'day' ? ui.day : todayStr()), // 選了某一天就預設記在那天
    note: p.note ?? '',
    recurringId: prefill?.recurringId ?? null, // 從固定支出來的：存檔後標記這個月已處理
  };
  if (!findSub(findCat('expense', entry.categoryId), entry.subCategoryId)) entry.subCategoryId = null;
  renderEntry();
  openLayer('sheet');
}

function accOptions(sel) {
  return data.accounts.map((a) => `<option value="${esc(a.id)}"${a.id === sel ? ' selected' : ''}>${esc(a.icon)} ${esc(a.name)}</option>`).join('');
}

function renderEntry() {
  const e = entry;
  const body = `<div class="cat-grid">${data.categories.expense.map((c) =>
    `<button class="cat${c.id === e.categoryId ? ' on' : ''}" data-action="pick-cat" data-id="${esc(c.id)}">
      <span class="cat-icon">${esc(c.icon)}</span><span class="cat-name">${esc(c.name)}</span>
    </button>`).join('')}</div>`;
  const K = (k, label, cls = '') => `<button class="${cls}" data-action="key" data-k="${k}">${label}</button>`;
  $('#sheet').innerHTML = `
    <div class="sheet-top">
      <button class="text-btn" data-action="close-layer">取消</button>
      <h3 class="sheet-title">${e.id ? '編輯支出' : '記一筆支出'}</h3>
      ${e.id ? '<button class="text-btn danger" data-action="delete-tx">刪除</button>' : '<span class="text-btn-spacer"></span>'}
    </div>
    <div class="amount-box"><span class="amount-cur">$</span><span class="amount-text" id="amountText"></span></div>
    <div class="amount-preview" id="amountPreview"></div>
    ${e.id ? '' : shortcutRow()}
    <div class="entry-body">${body}</div>
    <div class="sub-row" id="subRow">${subChips()}</div>
    <div class="entry-fields">
      <label class="field field-pay"><select data-bind="accountId" aria-label="付款方式">${accOptions(e.accountId)}</select></label>
      <label class="field field-date"><input type="date" aria-label="日期" data-bind="date" value="${esc(e.date)}" required></label>
      <label class="field field-note"><span>備註</span><input type="text" data-bind="note" value="${esc(e.note)}" placeholder="寫點什麼…（可不填）" maxlength="60" enterkeyhint="done"></label>
    </div>
    <div class="keypad-wrap"><div class="keypad">
      ${K('7', '7')}${K('8', '8')}${K('9', '9')}${K('back', '⌫', 'k-op')}
      ${K('4', '4')}${K('5', '5')}${K('6', '6')}${K('+', '+', 'k-op')}
      ${K('1', '1')}${K('2', '2')}${K('3', '3')}${K('-', '−', 'k-op')}
      ${K('clear', 'C', 'k-op')}${K('0', '0')}${K('.', '.')}<button class="k-ok" data-action="key" data-k="ok" id="keyOk">儲存</button>
    </div></div>`;
  updateAmount();
}

// 常用捷徑：點一下帶入分類和付款方式（有設定金額也一起帶入），最後一個「＋」把目前的選擇存成捷徑
function shortcutRow() {
  const list = data.shortcuts || [];
  return `<div class="sc-row" id="scRow"><span class="sub-label">常用 ›</span>${list.map((s) => {
    const c = findCat('expense', s.categoryId);
    return `<button class="chip sc-chip" data-action="use-shortcut" data-id="${esc(s.id)}"><span class="sc-ic">${esc(c?.icon || '⭐')}</span>${esc(s.name)}${s.amount ? ` <small>$${fmt(s.amount)}</small>` : ''}</button>`;
  }).join('')}<button class="chip sc-add" data-action="save-shortcut">＋ 存成捷徑</button></div>`;
}

// 次分類小按鈕（可不選；再點一次取消）
function subChips() {
  const c = findCat('expense', entry.categoryId);
  if (!c || !c.subs.length) return `<span class="sub-label">${c ? esc(c.name) + '：沒有次分類' : ''}</span>`;
  return `<span class="sub-label">${esc(c.name)} ›</span>` + c.subs.map((s) =>
    `<button class="chip${s.id === entry.subCategoryId ? ' on' : ''}" data-action="pick-sub" data-id="${esc(s.id)}">${esc(s.name)}</button>`).join('');
}

const hasOp = (s) => /[+-]/.test(s);
function evalExpr(s) {
  s = s.replace(/[+\-.]+$/, '');
  const parts = s.match(/[+-]?[0-9.]+/g) || [];
  return round2(parts.reduce((sum, p) => sum + (parseFloat(p) || 0), 0));
}

function updateAmount() {
  const e = entry.expr;
  $('#amountText').textContent = e.replace(/-/g, ' − ').replace(/\+/g, ' + ');
  const calc = hasOp(e);
  $('#amountPreview').textContent = calc ? '= ' + fmt(evalExpr(e)) : '';
  $('#keyOk').textContent = calc ? '=' : '儲存';
}

function pressKey(k) {
  let e = entry.expr;
  const isOp = (c) => c === '+' || c === '-';
  if (entry.fresh && /^[0-9.]$/.test(k)) e = '0';
  entry.fresh = false;
  const operand = () => e.split(/[+-]/).pop();

  if (/^[0-9]$/.test(k)) {
    const o = operand();
    if (o.includes('.') && o.split('.')[1].length >= 2) return;
    if (o.replace('.', '').length >= 9) return;
    e = o === '0' ? e.slice(0, -1) + k : e + k;
  } else if (k === '.') {
    const o = operand();
    if (o.includes('.')) return;
    e += o === '' ? '0.' : '.';
  } else if (isOp(k)) {
    if (isOp(e.slice(-1)) || e.endsWith('.')) e = e.slice(0, -1) + k;
    else e += k;
  } else if (k === 'back') {
    e = e.slice(0, -1) || '0';
  } else if (k === 'clear') {
    e = '0';
  } else if (k === 'ok') {
    if (hasOp(e)) {
      const v = evalExpr(e);
      entry.expr = String(v < 0 ? 0 : v);
      updateAmount();
      return;
    }
    saveEntry();
    return;
  }
  entry.expr = e;
  updateAmount();
}

function saveEntry() {
  const e = entry;
  const amount = evalExpr(e.expr);
  if (!(amount > 0)) return toast('請輸入金額');
  if (!e.accountId || !findAcc(e.accountId)) return toast('請先到「付款」新增付款方式');
  const cat = findCat('expense', e.categoryId);
  if (!cat) return toast('請選擇分類');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date)) return toast('請選擇日期');

  const old = e.id ? data.txs.find((t) => t.id === e.id) : null;
  const tx = {
    id: e.id || uid(),
    type: 'expense',
    amount,
    categoryId: e.categoryId,
    subCategoryId: findSub(cat, e.subCategoryId) ? e.subCategoryId : null,
    accountId: e.accountId,
    toAccountId: null,
    date: e.date,
    note: e.note.trim(),
    createdAt: old?.createdAt ?? Date.now(),
    updatedAt: Date.now(),
    by: old?.by ?? cloud.user.uid,          // 誰記的（家用帳本會顯示）
    byName: old?.byName ?? myName(),
    ...(old?.demo ? { demo: true } : {}), // 修改範例資料後仍算範例資料
  };
  if (old) data.txs[data.txs.indexOf(old)] = tx;
  else data.txs.push(tx);
  data.prefs.lastAccountId = e.accountId;
  // 從固定支出提醒記的：這個月就不再提醒
  const rec = e.recurringId && (data.recurring || []).find((r) => r.id === e.recurringId);
  if (rec) rec.lastDone = ymKey(currentYM());
  save();

  if (!ui.search) selectDay(tx.date); // 跳到這筆記錄的日期（保持目前的今日／本週／本月篩選；搜尋中就留在搜尋結果）
  closeLayer();
  render();
  toast(old ? '已更新' : `已記下 $${fmt(amount)}`);
}

// ---------- 底部表單（帳戶、分類） ----------
let form = null;

function openForm(opts) {
  form = { ...opts, emoji: {} };
  const fieldHtml = (f) => {
    if (f.type === 'emoji') {
      form.emoji[f.key] = f.value;
      const list = EMOJIS.includes(f.value) ? EMOJIS : [f.value, ...EMOJIS];
      return `<div class="f-row"><span>${esc(f.label)}</span><div class="emoji-grid">${list.map((em) =>
        `<button type="button" class="${em === f.value ? 'on' : ''}" data-action="form-emoji" data-key="${esc(f.key)}" data-v="${esc(em)}">${esc(em)}</button>`).join('')}</div></div>`;
    }
    if (f.type === 'select') {
      return `<label class="f-row"><span>${esc(f.label)}</span><select id="f_${esc(f.key)}">${f.options.map((o) =>
        `<option value="${esc(o.value)}"${o.value === (f.value ?? '') ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}</select></label>`;
    }
    if (f.type === 'note') return `<p class="hint f-note">${esc(f.label)}</p>`;
    return `<label class="f-row"><span>${esc(f.label)}</span><input id="f_${esc(f.key)}" type="text" inputmode="${f.type === 'number' ? 'decimal' : 'text'}"
      value="${esc(f.value ?? '')}" placeholder="${esc(f.placeholder || '')}" maxlength="${f.max || 20}" autocomplete="off"></label>`;
  };
  $('#modal').innerHTML = `<div class="modal-card" role="dialog" aria-modal="true" aria-label="${esc(opts.title)}">
    <div class="modal-head">
      <button class="text-btn" data-action="close-layer">取消</button>
      <h3>${esc(opts.title)}</h3>
      <button class="text-btn" data-action="form-save">儲存</button>
    </div>
    <div class="form-body">${opts.fields.map(fieldHtml).join('')}</div>
    ${opts.onDelete ? `<button class="btn-danger-block" data-action="form-delete">刪除</button>` : ''}
  </div>`;
  openLayer('modal');
}

function editAccount(acc) {
  openForm({
    title: acc ? '編輯付款方式' : '新增付款方式',
    fields: [
      { key: 'name', label: '名稱', value: acc?.name ?? '', placeholder: '例如：悠遊卡、LINE Pay、玉山卡' },
      { key: 'icon', label: '圖示', type: 'emoji', value: acc?.icon ?? '👛' },
    ],
    onSave: (v) => {
      if (!v.name) { toast('請輸入名稱'); return false; }
      if (acc) Object.assign(acc, { name: v.name, icon: v.icon });
      else data.accounts.push({ id: uid(), name: v.name, icon: v.icon, initial: 0 });
      save(); render(); toast('已儲存');
    },
    onDelete: acc ? async () => {
      const n = data.txs.filter((t) => t.accountId === acc.id || t.toAccountId === acc.id).length;
      if (n) { await notice('還不能刪除', `「${acc.name}」還有 ${n} 筆記錄，請先把這些記錄改成其他付款方式或刪除，才能刪除它。`); return false; }
      if (data.accounts.length <= 1) { await notice('還不能刪除', '至少要保留一種付款方式。'); return false; }
      if (!(await askConfirm({ title: `確定要刪除付款方式「${acc.name}」嗎？`, ok: '刪除' }))) return false;
      data.accounts = data.accounts.filter((a) => a.id !== acc.id);
      save(); render(); toast('已刪除');
    } : null,
  });
}

// ---------- 分類管理 ----------
let catMgr = null;

// catMgr.mainId 為 null 時顯示主分類清單；有值時顯示那個主分類底下的次分類
function openCatManager(type) {
  catMgr = { type, mainId: null };
  renderCatManager();
  openLayer('sheet');
}

function renderCatManager() {
  const list = data.categories.expense;
  const main = catMgr.mainId ? findCat('expense', catMgr.mainId) : null;
  if (catMgr.mainId && !main) catMgr.mainId = null;

  if (!main) {
    $('#sheet').innerHTML = `
      <div class="sheet-top">
        <button class="text-btn" data-action="close-layer">完成</button>
        <h3 class="sheet-title">支出分類</h3>
        <button class="text-btn" data-action="add-cat">新增</button>
      </div>
      <div class="entry-body">
        <div class="rows">${list.map((c, i) => `<div class="row cat-row">
          <button class="cat-row-main" data-action="open-main" data-id="${esc(c.id)}">
            <span class="tx-icon">${esc(c.icon)}</span>
            <span class="tx-main"><span>${esc(c.name)}</span><span class="tx-sub">${c.subs.length ? c.subs.map((s) => esc(s.name)).join('、') : '沒有次分類'}</span></span>
          </button>
          ${i > 0 ? `<button class="icon-btn sm" data-action="cat-up" data-id="${esc(c.id)}" aria-label="往上移">↑</button>` : ''}
        </div>`).join('')}</div>
        <p class="hint">點主分類可以管理它的次分類、改名稱或圖示；按 ↑ 調整在記帳畫面的順序。右上角「新增」是新增主分類。</p>
      </div>`;
    return;
  }

  $('#sheet').innerHTML = `
    <div class="sheet-top">
      <button class="text-btn" data-action="cat-back">‹ 返回</button>
      <h3 class="sheet-title">${esc(main.icon)} ${esc(main.name)}</h3>
      <button class="text-btn" data-action="add-sub">新增</button>
    </div>
    <div class="entry-body">
      <div class="group"><h2>次分類</h2>
        ${main.subs.length ? `<div class="rows">${main.subs.map((s, i) => `<div class="row cat-row">
          <button class="cat-row-main" data-action="edit-sub" data-id="${esc(s.id)}"><span>${esc(s.name)}</span></button>
          ${i > 0 ? `<button class="icon-btn sm" data-action="sub-up" data-id="${esc(s.id)}" aria-label="往上移">↑</button>` : ''}
        </div>`).join('')}</div>` : `<p class="hint">還沒有次分類，按右上角「新增」加一個。</p>`}
      </div>
      <div class="group"><h2>主分類</h2><div class="rows">
        <button class="row" data-action="edit-cat" data-id="${esc(main.id)}"><span>修改名稱、圖示或刪除</span><span class="row-val">›</span></button>
      </div></div>
      <p class="hint">點次分類可以改名稱或刪除；按 ↑ 調整順序。</p>
    </div>`;
}

function editCat(type, cat) {
  openForm({
    title: cat ? '編輯主分類' : '新增主分類',
    fields: [
      { key: 'name', label: '名稱', value: cat?.name ?? '', placeholder: '例如：寵物、保險', max: 8 },
      { key: 'icon', label: '圖示', type: 'emoji', value: cat?.icon ?? '📦' },
    ],
    onSave: (v) => {
      if (!v.name) { toast('請輸入名稱'); return false; }
      if (cat) Object.assign(cat, { name: v.name, icon: v.icon });
      else data.categories.expense.push({ id: uid(), name: v.name, icon: v.icon, subs: [] });
      save(); renderCatManager(); render(); toast('已儲存');
    },
    onDelete: cat ? async () => {
      if (data.categories.expense.length <= 1) { await notice('還不能刪除', '至少要保留一個主分類。'); return false; }
      const n = data.txs.filter((t) => t.type === 'expense' && t.categoryId === cat.id).length;
      const subs = cat.subs.length ? `包含 ${cat.subs.length} 個次分類。` : '';
      const msg = n ? `${subs}有 ${n} 筆記錄，刪除後這些記錄會顯示為「未分類」。` : subs;
      if (!(await askConfirm({ title: `確定刪除主分類「${cat.name}」嗎？`, message: msg, ok: '刪除' }))) return false;
      data.categories.expense = data.categories.expense.filter((c) => c.id !== cat.id);
      catMgr.mainId = null;
      save(); renderCatManager(); render(); toast('已刪除');
    } : null,
  });
}

function editSub(main, sub) {
  openForm({
    title: sub ? '編輯次分類' : `新增「${main.name}」的次分類`,
    fields: [{ key: 'name', label: '名稱', value: sub?.name ?? '', placeholder: '例如：早午餐、捷運', max: 10 }],
    onSave: (v) => {
      if (!v.name) { toast('請輸入名稱'); return false; }
      if (sub) sub.name = v.name;
      else main.subs.push({ id: uid(), name: v.name });
      save(); renderCatManager(); render(); toast('已儲存');
    },
    onDelete: sub ? async () => {
      const hits = data.txs.filter((t) => t.subCategoryId === sub.id);
      const msg = hits.length ? `有 ${hits.length} 筆記錄，刪除後這些記錄會只顯示主分類「${main.name}」。` : '';
      if (!(await askConfirm({ title: `確定刪除次分類「${sub.name}」嗎？`, message: msg, ok: '刪除' }))) return false;
      for (const t of hits) t.subCategoryId = null;
      main.subs = main.subs.filter((s) => s.id !== sub.id);
      save(); renderCatManager(); render(); toast('已刪除');
    } : null,
  });
}

// ---------- 匯出 / 匯入 ----------
async function shareOrDownload(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  if (isMobile && navigator.canShare) {
    try {
      const file = new File([blob], filename, { type: mime });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: filename });
        return;
      }
    } catch (err) {
      if (err.name === 'AbortError') return;
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const stamp = () => todayStr().replace(/-/g, '');

function exportJSON() {
  const payload = { app: 'xiaozhangben', exportedAt: new Date().toISOString(), ...data };
  shareOrDownload(`小帳本備份-${stamp()}.json`, JSON.stringify(payload, null, 1), 'application/json');
}

// 明細轉成 CSV（Excel 可以直接開）；家用帳本多一欄「記錄者」；最後一行是合計
function buildCSV(txs) {
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const fam = isFamily();
  const who = (t) => (t.by ? (cloud.meta?.members?.[t.by]?.name || t.byName || '') : '');
  const head = ['日期', '主分類', '次分類', '金額', '付款方式', '備註', ...(fam ? ['記錄者'] : [])];
  const lines = [head.map(q).join(',')];
  const sorted = txs.filter((t) => t.type === 'expense').sort((a, b) => a.date.localeCompare(b.date) || (a.createdAt || 0) - (b.createdAt || 0));
  for (const t of sorted) {
    const c = findCat('expense', t.categoryId);
    lines.push([t.date, c?.name ?? '未分類', findSub(c, t.subCategoryId)?.name ?? '', t.amount, accName(t.accountId), t.note, ...(fam ? [who(t)] : [])].map(q).join(','));
  }
  lines.push('');
  lines.push([`合計（${sorted.length} 筆）`, '', '', sumAmt(sorted)].map(q).join(','));
  return '﻿' + lines.join('\r\n');
}
const ledgerFileName = () => (isFamily() ? (cloud.meta?.name || '家用') : '個人');

function exportCSV() {
  shareOrDownload(`小帳本-${ledgerFileName()}-全部明細-${stamp()}.csv`, buildCSV(data.txs), 'text/csv');
}

// 選一個月份，匯出那個月的支出明細（含合計）
function openMonthExport(ym = ui.ym) {
  const val = ymKey(ym);
  const stats = (k) => { const list = data.txs.filter((t) => t.type === 'expense' && t.date.startsWith(k)); return { n: list.length, sum: sumAmt(list) }; };
  const s = stats(val);
  $('#modal').innerHTML = `<div class="modal-card" role="dialog" aria-modal="true" aria-label="匯出月份明細">
    <div class="modal-head">
      <button class="text-btn" data-action="close-layer">取消</button>
      <h3>匯出月份明細</h3>
      <button class="text-btn" data-action="do-month-export">匯出</button>
    </div>
    <div class="form-body">
      <label class="f-row"><span>選擇月份</span><input type="month" id="exportMonth" value="${val}" max="${ymKey(currentYM())}"></label>
      <div class="export-sum" id="exportSum">${s.n} 筆，共 <b>$${fmt(s.sum)}</b></div>
      <p class="hint">會匯出${esc(isFamily() ? `「${cloud.meta?.name || '家用'}」帳本` : '個人帳本')}這個月每一筆支出（日期、分類、金額、付款方式、備註${isFamily() ? '、記錄者' : ''}），最後一行是總支出。檔案是 .csv，用 Excel 或 Google 試算表都能打開。</p>
      <button class="btn-block" data-action="do-month-export">匯出這個月的明細</button>
    </div>
  </div>`;
  const inp = $('#exportMonth');
  inp.addEventListener('input', () => {
    if (!/^\d{4}-\d{2}$/.test(inp.value)) return;
    const x = stats(inp.value);
    $('#exportSum').innerHTML = `${x.n} 筆，共 <b>$${fmt(x.sum)}</b>`;
  });
  openLayer('modal');
}

function doMonthExport() {
  const v = $('#exportMonth')?.value;
  if (!/^\d{4}-\d{2}$/.test(v || '')) { toast('請選擇月份'); return; }
  const list = data.txs.filter((t) => t.type === 'expense' && t.date.startsWith(v));
  if (!list.length) { toast('這個月沒有支出記錄'); return; }
  const [y, m] = v.split('-');
  shareOrDownload(`小帳本-${ledgerFileName()}-${y}年${Number(m)}月明細.csv`, buildCSV(list), 'text/csv');
  closeLayer();
}

// ---------- 給 AI 讀分類的 API（唯讀） ----------
// 帳本文件的 apiKey 是一組隨機金鑰；apiKeys/{金鑰} 存一份「分類＋付款方式名稱」的 JSON，
// 任何人知道網址就能讀這一份（規則只允許 get，不能列出、不能讀記帳記錄、不能修改帳本）。
// 分類或付款方式有改時，App 會自動更新這一份。
const API_BASE = `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/(default)/documents/apiKeys/`;
const apiUrl = (key) => `${API_BASE}${key}?mask.fieldPaths=json`;
function newApiKey() {
  const a = new Uint8Array(24);
  crypto.getRandomValues(a);
  return btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const IMPORT_HEAD = ['日期', '金額', '主分類', '次分類', '付款方式', '備註'];
const cardAccName = (d) => (d.accounts.find((a) => a.name.includes('信用卡')) || d.accounts[0])?.name || '信用卡';
function apiPayload(d, meta) {
  return {
    app: '小帳本',
    ledger: meta?.type === 'family' ? (meta.name || '家用') : '個人',
    excelColumns: IMPORT_HEAD,
    categories: d.categories.expense.map((c) => ({ name: c.name, subs: c.subs.map((s) => s.name) })),
    accounts: d.accounts.map((a) => a.name),
    notes: [
      '主分類請用 categories 裡的 name；次分類請用該主分類 subs 裡的名稱，沒有適合的可以空白',
      `付款方式請用 accounts 裡的名稱（信用卡帳單填「${cardAccName(d)}」）`,
      '日期格式 YYYY/MM/DD；金額填正數（新台幣）；退款、繳款、利息不是消費，不要放進明細',
    ],
  };
}
// 把某本帳本的分類寫到 API 那一份（內容沒變就不寫）
function publishApi(lid, force = false) {
  const b = books.get(lid);
  const key = b?.meta?.apiKey;
  if (!key || !b.gotMeta) return Promise.resolve();
  const payload = apiPayload(b.data, b.meta);
  const sig = key + JSON.stringify(payload);
  if (!force && b.apiSig === sig) return Promise.resolve();
  b.apiSig = sig;
  return setDoc(doc(db, 'apiKeys', key), { ledgerId: lid, json: JSON.stringify({ ...payload, updatedAt: new Date().toISOString() }), updatedAt: Date.now() })
    .catch((e) => { console.error('publishApi', e); b.apiSig = ''; throw e; });
}
async function enableApi() {
  const lid = cloud.activeId;
  const b = books.get(lid);
  const old = b?.meta?.apiKey;
  const key = newApiKey();
  try {
    b.meta = { ...b.meta, apiKey: key }; cloud.meta = b.meta;
    await publishApi(lid, true);
    await updateDoc(ledgerRef(lid), { apiKey: key });
    if (old) await deleteDoc(doc(db, 'apiKeys', old)).catch(() => {});
    render();
    toast(old ? '已產生新網址，舊網址不能用了' : '已產生 API 網址');
  } catch (e) {
    b.meta = { ...b.meta, apiKey: old || null }; cloud.meta = b.meta;
    render();
    notice('產生失敗', e.code === 'permission-denied' ? '雲端的安全規則還沒更新，請先更新 Firebase 的規則。' : '請檢查網路後再試一次。');
  }
}
async function disableApi() {
  const lid = cloud.activeId;
  const old = cloud.meta?.apiKey;
  if (!old) return;
  try {
    await updateDoc(ledgerRef(lid), { apiKey: null });
    await deleteDoc(doc(db, 'apiKeys', old)).catch(() => {});
    toast('已停用 API，網址不能用了');
  } catch (e) { console.error(e); notice('停用失敗', '請檢查網路後再試一次。'); }
}
// 複製到剪貼簿；不行的話開一個視窗讓使用者自己全選複製
async function copyText(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`已複製${label}`);
  } catch {
    $('#modal').innerHTML = `<div class="modal-card" role="dialog" aria-modal="true" aria-label="複製${esc(label)}">
      <div class="modal-head"><span class="text-btn-spacer"></span><h3>複製${esc(label)}</h3><button class="text-btn" data-action="close-layer">完成</button></div>
      <div class="form-body"><p class="hint" style="margin-top:0">請長按下面的文字 → 全選 → 複製。</p>
      <textarea class="copy-box" readonly rows="10">${esc(text)}</textarea></div></div>`;
    openLayer('modal');
    const ta = $('#modal .copy-box'); ta.focus(); ta.select();
  }
}
// 給 AI 的指令：分類清單直接寫在指令裡（大部分聊天 AI 例如 Gemini 不能開外部網址）；
// 有 API 網址的話附在最後，給能上網讀資料的 AI 工具用
function aiPrompt() {
  const key = cloud.meta?.apiKey;
  const cats = data.categories.expense.map((c) => `${c.name}：${c.subs.map((s) => s.name).join('、') || '（沒有次分類）'}`).join('\n');
  return `你是我的記帳助理。請幫我把信用卡帳單整理成可以匯入「小帳本」記帳 App 的 Excel。

【小帳本的分類清單】（主分類：次分類）
${cats}

【付款方式】${data.accounts.map((a) => a.name).join('、')}

【要做的事】
1. 讀我提供的信用卡帳單，把每一筆消費判斷成上面清單裡的「主分類」和「次分類」。
2. 產生 Excel（.xlsx），只要一個工作表，第一列欄位名稱固定是：${IMPORT_HEAD.join('、')}
   - 日期：YYYY/MM/DD（帳單上的消費日）
   - 金額：正數，新台幣（外幣消費用帳單上的台幣金額）
   - 主分類、次分類：只能用上面清單裡的名稱；沒有適合的次分類就空白
   - 付款方式：${cardAccName(data)}
   - 備註：商店名稱或消費說明
   - 退款、繳款、利息、年費折抵等不是一般消費的項目不要放進去，另外列出來給我看
3. 如果你不能直接產生 .xlsx 檔，就用上面的欄位輸出一個表格（或 CSV 文字），我會自己貼到 Excel 或 Google 試算表。
4. 最後列出你不確定分類的項目，讓我檢查。${key ? `

（給能上網讀資料的 AI 工具：小帳本最新的分類也可以從這個網址讀到，回傳內容裡 fields.json.stringValue 是一段 JSON：
${apiUrl(key)}
如果你不能開啟網址，直接用上面的清單就好，不需要這個網址，也不用問我。）` : ''}`;
}

// ---------- 匯入 Excel（批次新增，例如 AI 整理好的信用卡帳單） ----------
// Excel 欄位：日期、金額、主分類、次分類、付款方式、備註（第一列是欄位名稱；小帳本匯出的 CSV 也能直接匯回來）
// 讀 Excel 用 SheetJS，第一次用到才從官方 CDN 載入
const XLSX_URL = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs';
let xlsxLib = null;
async function loadXLSX() {
  if (!xlsxLib) xlsxLib = await import(XLSX_URL);
  return xlsxLib;
}
const IMPORT_COLS = {
  date: ['日期', '消費日', '消費日期', '交易日期', '交易日'],
  amount: ['金額', '消費金額', '台幣金額', '新台幣金額', '新臺幣金額'],
  sub: ['次分類', '子分類', '細項'],
  cat: ['主分類', '分類', '類別'],
  acc: ['付款方式', '帳戶', '付款'],
  note: ['備註', '說明', '摘要', '消費明細', '商店', '商店名稱', '項目'],
};
let imp = null; // 匯入預覽中的資料 { rows, fileName }

const validYMD = (y, m, d) => {
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d ? `${y}-${pad(m)}-${pad(d)}` : null;
};
// 日期：Excel 日期、2026/11/3、2026-11-03、20261103、民國 115/11/03、只有 11/3（猜年份）
function parseImportDate(v, X) {
  if (typeof v === 'number') {
    if (v > 19000000 && v < 21000000) return validYMD(Math.floor(v / 10000), Math.floor(v / 100) % 100, v % 100);
    const p = v > 20000 && v < 80000 ? X.SSF.parse_date_code(v) : null;
    return p ? validYMD(p.y, p.m, p.d) : null;
  }
  const s = String(v ?? '').trim().replace(/[年月]/g, '/').replace(/日/g, '').replace(/[.\-]/g, '/').split(/\s+/)[0];
  let m = s.match(/^(\d{8})$/);
  if (m) return validYMD(+s.slice(0, 4), +s.slice(4, 6), +s.slice(6, 8));
  m = s.match(/^(\d{2,4})\/(\d{1,2})\/(\d{1,2})$/);
  if (m) { let y = +m[1]; if (y < 100) y += 2000; else if (y < 1911) y += 1911; return validYMD(y, +m[2], +m[3]); }
  m = s.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (m) { const now = currentYM(); const y = +m[1] > now.m ? now.y - 1 : now.y; return validYMD(y, +m[1], +m[2]); }
  return null;
}
const parseImportAmount = (v) => round2(typeof v === 'number' ? v : Number(String(v ?? '').replace(/NT\$?|[,\s$元＄]/gi, '')));

// 依名稱找分類（主分類欄也可以寫「飲食 › 早餐」）
function resolveCat(mainName, subName) {
  const mn = String(mainName ?? '').trim(), sn = String(subName ?? '').trim();
  const cats = data.categories.expense;
  let c = mn ? cats.find((x) => x.name === mn) : null;
  if (!c && mn && !sn) {
    const parts = mn.split(/\s*[›>/／]\s*/);
    if (parts.length === 2) return resolveCat(parts[0], parts[1]);
  }
  if (!c && !mn && sn) { const hits = cats.filter((x) => x.subs.some((s) => s.name === sn)); if (hits.length === 1) c = hits[0]; }
  if (!c) return { val: '', err: mn ? `找不到主分類「${mn}」，請選擇分類` : '沒有填主分類，請選擇分類' };
  if (!sn) return { val: c.id };
  const s = c.subs.find((x) => x.name === sn);
  if (!s) return { val: c.id, warn: `「${c.name}」沒有次分類「${sn}」，先不選次分類` };
  return { val: `${c.id}|${s.id}` };
}
function resolveAcc(name, defId) {
  const n = String(name ?? '').trim();
  if (!n) return { id: defId };
  const exact = data.accounts.find((a) => a.name === n);
  if (exact) return { id: exact.id };
  const near = data.accounts.filter((a) => a.name && (n.includes(a.name) || a.name.includes(n)));
  if (near.length === 1) return { id: near[0].id };
  return { id: defId, warn: `找不到付款方式「${n}」，先用「${accName(defId)}」` };
}
const defaultImportAcc = () => (data.accounts.find((a) => a.name.includes('信用卡')) || findAcc(data.prefs.lastAccountId) || data.accounts[0])?.id || '';
const rowOk = (r) => !!(r.date && r.amount > 0 && r.catVal && findAcc(r.accId));

async function readImportFile(file) {
  const X = await loadXLSX();
  const buf = await file.arrayBuffer();
  let wb;
  if (/\.(csv|txt)$/i.test(file.name)) {
    // CSV 可能是 UTF-8 或 Big5（銀行網站常見）
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { text = new TextDecoder('big5').decode(buf); }
    wb = X.read(text.replace(/^﻿/, ''), { type: 'string', raw: true });
  } else {
    wb = X.read(buf, { type: 'array' });
  }
  const key = (v) => String(v ?? '').replace(/\s/g, '');
  for (const name of wb.SheetNames) {
    const aoa = X.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: '' });
    for (let h = 0; h < Math.min(aoa.length, 15); h++) {
      const head = aoa[h].map(key);
      const col = {};
      for (const [f, names] of Object.entries(IMPORT_COLS)) { const i = head.findIndex((c, j) => names.includes(c) && !Object.values(col).includes(j)); if (i >= 0) col[f] = i; }
      for (const [f, names] of Object.entries(IMPORT_COLS)) {
        if (col[f] != null) continue;
        const i = head.findIndex((c, j) => c && names.some((n) => c.includes(n)) && !Object.values(col).includes(j));
        if (i >= 0) col[f] = i;
      }
      if (col.date == null || col.amount == null) continue;
      return { X, col, rows: aoa.slice(h + 1) };
    }
  }
  return null;
}

async function startImport(file) {
  if (!data.accounts.length) { notice('還沒有付款方式', '請先到「付款」新增付款方式，再匯入。'); return; }
  let got;
  try { got = await readImportFile(file); } catch (e) {
    console.error(e);
    notice('無法讀取這個檔案', navigator.onLine ? '請確認是 Excel（.xlsx）或 CSV 檔。' : '第一次匯入需要網路（要下載讀取 Excel 的程式），請連上網路再試一次。');
    return;
  }
  if (!got) { notice('找不到欄位名稱', '第一列要有欄位名稱，至少要有「日期」和「金額」。\n建議的欄位：日期、金額、主分類、次分類、付款方式、備註。\n可以在「設定」下載 Excel 範本。'); return; }
  const { X, col, rows: raw } = got;
  const cell = (r, f) => (col[f] == null ? '' : r[col[f]]);
  const defAcc = defaultImportAcc();
  const have = new Set(data.txs.filter((t) => t.type === 'expense').map((t) => `${t.date}|${round2(t.amount)}`));
  const rows = [];
  for (const r of raw) {
    if (!r.some((v) => String(v ?? '').trim() !== '')) continue;
    const first = String(r.find((v) => String(v ?? '').trim() !== '') ?? '').trim();
    if (/^(合計|總計|小計)/.test(first)) continue;
    if (rows.length >= 2000) break;
    const date = parseImportDate(cell(r, 'date'), X);
    const amount = parseImportAmount(cell(r, 'amount'));
    const cat = resolveCat(cell(r, 'cat'), cell(r, 'sub'));
    const acc = resolveAcc(cell(r, 'acc'), defAcc);
    const errs = [];
    if (!date) errs.push(`日期看不懂「${String(cell(r, 'date') ?? '')}」`);
    if (!(amount > 0)) errs.push(amount < 0 ? '金額是負的（退款？）預設不匯入，要記請自己在 App 處理' : `金額看不懂「${String(cell(r, 'amount') ?? '')}」`);
    const row = {
      i: rows.length, date, amount, note: String(cell(r, 'note') ?? '').trim().slice(0, 100),
      catVal: cat.val, accId: acc.id, errs, catErr: cat.err || '', warns: [cat.warn, acc.warn].filter(Boolean),
      dup: !!date && amount > 0 && have.has(`${date}|${amount}`),
    };
    row.on = rowOk(row) && !row.dup && !errs.length;
    rows.push(row);
  }
  if (!rows.length) { notice('檔案裡沒有資料', '找到欄位名稱了，但下面沒有任何一筆記錄。'); return; }
  imp = { rows, fileName: file.name };
  renderImport();
  openLayer('modal');
}

function impRowHtml(r) {
  const ok = rowOk(r) && !r.errs.length;
  const opt = (list, v) => list.map((o) => `<option value="${esc(o.value)}"${o.value === v ? ' selected' : ''}>${esc(o.label)}</option>`).join('');
  const tips = [
    ...r.errs.map((m) => `<b class="bad">✕ ${esc(m)}</b>`),
    r.catErr ? `<b class="bad">✕ ${esc(r.catErr)}</b>` : '',
    r.dup ? '<b class="dup">⚠ 可能重複：帳本裡已有同一天、同金額的記錄</b>' : '',
    ...r.warns.map((m) => `<span>⚠ ${esc(m)}</span>`),
  ].filter(Boolean).join('');
  return `<div class="imp-row${ok ? '' : ' bad'}${r.on ? '' : ' off'}">
    <label class="imp-chk"><input type="checkbox" data-imp="on" data-i="${r.i}"${r.on ? ' checked' : ''}${ok ? '' : ' disabled'} aria-label="匯入這筆"></label>
    <span class="imp-date">${r.date ? esc(r.date.replace(/-/g, '/')) : '日期？'}</span>
    <span class="imp-note">${esc(r.note || '（沒有備註）')}</span>
    <span class="imp-amt">${r.amount > 0 ? '$' + fmt(r.amount) : esc(String(r.amount || '金額？'))}</span>
    <select class="imp-cat${r.catVal ? '' : ' need'}" data-imp="cat" data-i="${r.i}" aria-label="分類">${r.catVal ? '' : '<option value="" selected>請選擇分類</option>'}${opt(catOptions(), r.catVal)}</select>
    <select class="imp-acc" data-imp="acc" data-i="${r.i}" aria-label="付款方式">${opt(accOpts(), r.accId)}</select>
    ${tips ? `<span class="imp-tip">${tips}</span>` : ''}
  </div>`;
}

function renderImport() {
  const rows = imp.rows;
  const sel = rows.filter((r) => r.on);
  const nBad = rows.filter((r) => !rowOk(r) || r.errs.length).length;
  const nDup = rows.filter((r) => r.dup).length;
  const where = activeLedger() ? ledgerLabel(activeLedger()) : '目前的帳本';
  const card = $('#modal .import-card');
  const sc = card ? card.scrollTop : 0;
  $('#modal').innerHTML = `<div class="modal-card import-card" role="dialog" aria-modal="true" aria-label="匯入 Excel">
    <div class="modal-head">
      <button class="text-btn" data-action="close-layer">取消</button>
      <h3>匯入 Excel</h3>
      <button class="text-btn" data-action="import-do"${sel.length ? '' : ' disabled'}>匯入</button>
    </div>
    <div class="form-body">
      <div class="export-sum imp-sum">
        <div>${esc(imp.fileName)} · 共 ${rows.length} 筆</div>
        <div>勾選 <b>${sel.length}</b> 筆，合計 <b>$${fmt(sumAmt(sel))}</b>，匯入到 ${esc(where)}</div>
      </div>
      <div class="imp-tools">
        <label class="sf"><span>付款方式全部改成</span><select id="impAllAcc"><option value="">選擇…</option>${accOpts().map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('')}</select></label>
        <button class="text-btn" data-action="import-all" data-on="1">全選</button>
        <button class="text-btn" data-action="import-all" data-on="">全不選</button>
      </div>
      ${nBad ? `<p class="imp-msg bad">有 ${nBad} 筆需要處理（紅色）：分類可以直接在下面選；日期或金額有問題的請改 Excel 再上傳。</p>` : ''}
      ${nDup ? `<p class="imp-msg">有 ${nDup} 筆跟帳本裡同一天、同金額的記錄一樣，可能已經記過，預設不匯入；確定要匯入請自己勾選。</p>` : ''}
      <div class="imp-cols"><span></span><span>日期</span><span>備註</span><span>金額</span><span>分類</span><span>付款方式</span></div>
      <div class="imp-list">${rows.map(impRowHtml).join('')}</div>
      <button class="btn-block" data-action="import-do"${sel.length ? '' : ' disabled'}>匯入 ${sel.length} 筆到 ${esc(where)}</button>
    </div>
  </div>`;
  const nc = $('#modal .import-card');
  if (nc && sc) nc.scrollTop = sc;
}

$('#modal').addEventListener('change', (ev) => {
  if (!imp) return;
  const t = ev.target;
  if (t.id === 'impAllAcc') {
    if (!findAcc(t.value)) return;
    for (const r of imp.rows) { r.accId = t.value; r.warns = r.warns.filter((m) => !m.startsWith('找不到付款方式')); }
    renderImport(); toast(`付款方式都改成「${accName(t.value)}」`); return;
  }
  const r = imp.rows[Number(t.dataset.i)];
  if (!r || !t.dataset.imp) return;
  if (t.dataset.imp === 'on') r.on = t.checked && rowOk(r) && !r.errs.length;
  if (t.dataset.imp === 'cat') {
    const wasOk = rowOk(r);
    r.catVal = t.value; r.catErr = ''; r.warns = r.warns.filter((m) => !m.includes('次分類'));
    if (!wasOk && rowOk(r) && !r.errs.length && !r.dup) r.on = true;
  }
  if (t.dataset.imp === 'acc') { r.accId = t.value; r.warns = r.warns.filter((m) => !m.startsWith('找不到付款方式')); }
  renderImport();
});

function doImport() {
  const rows = imp.rows.filter((r) => r.on && rowOk(r) && !r.errs.length);
  if (!rows.length) { toast('沒有勾選要匯入的記錄'); return; }
  const importId = 'imp_' + uid();
  const now = Date.now();
  rows.forEach((r, k) => {
    const { categoryId, subCategoryId } = splitCat(r.catVal);
    data.txs.push({
      id: uid() + k, type: 'expense', amount: r.amount, categoryId, subCategoryId, accountId: r.accId, toAccountId: null,
      date: r.date, note: r.note, createdAt: now + k, updatedAt: now + k, by: cloud.user.uid, byName: myName(), importId,
    });
  });
  const sum = sumAmt(rows);
  save();
  closeLayer();
  render();
  toast(`已匯入 ${rows.length} 筆，共 $${fmt(sum)}`);
}

// 最近幾次匯入（可以整批刪掉）
function importBatches() {
  const m = new Map();
  for (const t of data.txs) {
    if (!t.importId) continue;
    const b = m.get(t.importId) || { id: t.importId, n: 0, sum: 0, at: t.createdAt || 0, from: t.date, to: t.date };
    b.n++; b.sum += t.amount; b.at = Math.min(b.at, t.createdAt || b.at);
    if (t.date < b.from) b.from = t.date;
    if (t.date > b.to) b.to = t.date;
    m.set(t.importId, b);
  }
  return [...m.values()].sort((a, b) => b.at - a.at).slice(0, 5);
}

// Excel 範本：「明細」工作表只有欄位名稱，另外附上分類清單和付款方式
async function downloadTemplate() {
  let X;
  try { X = await loadXLSX(); } catch { notice('下載失敗', '需要網路才能產生 Excel 範本，請連上網路再試一次。'); return; }
  const wb = X.utils.book_new();
  const main = X.utils.aoa_to_sheet([['日期', '金額', '主分類', '次分類', '付款方式', '備註']]);
  main['!cols'] = [{ wch: 12 }, { wch: 10 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 30 }];
  X.utils.book_append_sheet(wb, main, '明細');
  const cats = [['主分類', '次分類']];
  for (const c of data.categories.expense) { if (!c.subs.length) cats.push([c.name, '']); for (const s of c.subs) cats.push([c.name, s.name]); }
  const cs = X.utils.aoa_to_sheet(cats); cs['!cols'] = [{ wch: 12 }, { wch: 14 }];
  X.utils.book_append_sheet(wb, cs, '分類清單');
  const as = X.utils.aoa_to_sheet([['付款方式'], ...data.accounts.map((a) => [a.name])]); as['!cols'] = [{ wch: 14 }];
  X.utils.book_append_sheet(wb, as, '付款方式');
  const help = X.utils.aoa_to_sheet([
    ['小帳本 Excel 匯入說明'], [''],
    ['1. 在「明細」工作表一列填一筆支出，第一列的欄位名稱不要改。'],
    ['2. 日期：2026/11/03、2026-11-03 或民國 115/11/03 都可以。'],
    ['3. 金額：正數，不用加 $ 或逗號也可以。'],
    ['4. 主分類、次分類：請用「分類清單」工作表裡的名稱；次分類可以空白。'],
    ['5. 付款方式：請用「付款方式」工作表裡的名稱；空白的話匯入時可以一次指定。'],
    ['6. 在小帳本「設定」→「匯入 Excel」上傳，預覽確認後才會存進帳本。'],
  ]);
  help['!cols'] = [{ wch: 70 }];
  X.utils.book_append_sheet(wb, help, '說明');
  const out = X.write(wb, { type: 'array', bookType: 'xlsx' });
  shareOrDownload(`小帳本-匯入範本-${ledgerFileName()}.xlsx`, out, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
}

$('#excelFile').addEventListener('change', (ev) => {
  const file = ev.target.files[0];
  ev.target.value = '';
  if (file) startImport(file);
});

$('#importFile').addEventListener('change', async (ev) => {
  const file = ev.target.files[0];
  ev.target.value = '';
  if (!file) return;
  let incoming;
  try {
    const d = JSON.parse(await file.text());
    if (!validData(d)) throw new Error('格式不符');
    incoming = normalize(d);
  } catch (err) {
    notice('無法讀取這個檔案', '請確認是「小帳本」匯出的備份檔。');
    return;
  }
  const where = activeLedger() ? ledgerLabel(activeLedger()) : '目前的帳本';
  const ok = await askConfirm({
    title: '確定要從備份檔還原嗎？',
    message: `備份檔裡有 ${incoming.txs.length} 筆記錄。\n還原會「取代」${where}目前的 ${data.txs.length} 筆記錄。`,
    ok: '還原',
  });
  if (!ok) return;
  closeLayer();
  data = { ...incoming, prefs: data.prefs };
  save(); render(); toast('已還原備份');
});

// ---------- 提示訊息 ----------
let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2000);
}

// ---------- 事件 ----------
const actions = {
  'tab': (el) => { ui.tab = el.dataset.tab; ui.reportSel = null; ui.search = null; render(); window.scrollTo(0, 0); },
  // 搜尋
  'search-open': () => { ui.search = { ...SEARCH_EMPTY }; render(); window.scrollTo(0, 0); setTimeout(() => $('#sQ')?.focus(), 30); },
  'search-close': () => { ui.search = null; render(); window.scrollTo(0, 0); },
  'search-clear': () => { ui.search = { ...SEARCH_EMPTY }; render(); setTimeout(() => $('#sQ')?.focus(), 30); },
  // 預算
  'edit-budget': () => editBudget(),
  // 固定支出
  'add-recurring': () => editRecurring(null),
  'edit-recurring': (el) => { const r = (data.recurring || []).find((x) => x.id === el.dataset.id); if (r) editRecurring(r); },
  'due-pay': (el) => {
    const r = (data.recurring || []).find((x) => x.id === el.dataset.id);
    if (r) openEntry(null, { amount: r.amount, categoryId: r.categoryId, subCategoryId: r.subCategoryId, accountId: r.accountId, note: r.name, date: todayStr(), recurringId: r.id });
  },
  'due-skip': (el) => {
    const r = (data.recurring || []).find((x) => x.id === el.dataset.id);
    if (!r) return;
    r.lastDone = ymKey(currentYM());
    save(); render(); toast(`這個月的「${r.name}」已略過`);
  },
  // 常用捷徑
  'add-shortcut': () => editShortcut(null),
  'edit-shortcut': (el) => { const s = (data.shortcuts || []).find((x) => x.id === el.dataset.id); if (s) editShortcut(s); },
  'use-shortcut': (el) => {
    const s = (data.shortcuts || []).find((x) => x.id === el.dataset.id);
    if (!s || !entry) return;
    if (findCat('expense', s.categoryId)) { entry.categoryId = s.categoryId; entry.subCategoryId = s.subCategoryId; }
    if (findAcc(s.accountId)) entry.accountId = s.accountId;
    if (s.amount) { entry.expr = String(s.amount); entry.fresh = true; }
    renderEntry();
    toast(`已帶入「${s.name}」`);
  },
  'save-shortcut': () => {
    if (!entry) return;
    const c = findCat('expense', entry.categoryId);
    const sub = findSub(c, entry.subCategoryId);
    const amt = evalExpr(entry.expr);
    editShortcut(null, { name: sub?.name || c?.name || '', categoryId: entry.categoryId, subCategoryId: entry.subCategoryId, accountId: entry.accountId, amount: amt > 0 ? amt : 0 });
  },
  'month': (el) => { shiftMonth(Number(el.dataset.d)); ui.reportSel = null; render(); },
  'month-now': () => { ui.ym = currentYM(); ui.day = todayStr(); ui.range = 'month'; ui.reportSel = null; render(); },
  'toggle-cal': () => { if (isWide()) return; ui.calOpen = !ui.calOpen; render(); }, // 電腦版固定顯示整月
  'pick-day': (el) => {
    const ds = el.dataset.date;
    // 再點一次已選的那天 → 回到看整月
    if (ds === ui.day && ui.range === 'day') ui.range = 'month';
    else selectDay(ds, 'day');
    render();
  },
  'range': (el) => { ui.range = el.dataset.r; render(); },
  'new-tx': () => { if (cloud.status === 'ready' && cloud.gotMeta && cloud.gotTxs) openEntry(null); },
  'edit-tx': (el) => { const t = data.txs.find((x) => x.id === el.dataset.id); if (t) openEntry(t); },
  'close-layer': () => closeLayer(),
  'pick-cat': (el) => {
    if (entry.categoryId !== el.dataset.id) entry.subCategoryId = null;
    entry.categoryId = el.dataset.id;
    document.querySelectorAll('#sheet .cat').forEach((b) => b.classList.toggle('on', b.dataset.id === entry.categoryId));
    const row = $('#subRow');
    row.innerHTML = subChips();
    row.scrollLeft = 0;
  },
  'pick-sub': (el) => {
    entry.subCategoryId = entry.subCategoryId === el.dataset.id ? null : el.dataset.id;
    document.querySelectorAll('#subRow .chip').forEach((b) => b.classList.toggle('on', b.dataset.id === entry.subCategoryId));
  },
  'key': (el) => pressKey(el.dataset.k),
  'delete-tx': async () => {
    const id = entry?.id;
    const t = data.txs.find((x) => x.id === id);
    if (!t) return;
    const c = findCat('expense', t.categoryId);
    const name = findSub(c, t.subCategoryId)?.name || c?.name || '這筆記錄';
    const ok = await askConfirm({ title: '確定刪除這筆記錄嗎？', message: `${md(t.date)}　${name}　$${fmt(t.amount)}\n刪除後無法復原。`, ok: '刪除' });
    if (!ok) return;
    data.txs = data.txs.filter((x) => x.id !== id);
    save();
    closeLayers(2); // 關掉確認視窗和編輯畫面
    render(); toast('已刪除');
  },
  'confirm-yes': () => { const cb = confirmCb; confirmCb = null; if (cb) cb(true); },
  'confirm-no': () => closeLayer(),
  'trend-month': (el) => {
    const y = Number(el.dataset.y), m = Number(el.dataset.m);
    Object.assign(ui, monthState((y - ui.ym.y) * 12 + (m - ui.ym.m)));
    ui.reportSel = null;
    render();
  },
  'report-acc': (el) => {
    const id = el.dataset.id;
    if (!id) ui.reportAccs.clear();
    else if (ui.reportAccs.has(id)) ui.reportAccs.delete(id);
    else ui.reportAccs.add(id);
    ui.reportSel = null;
    render();
  },
  'report-sel': (el) => { const id = el.dataset.id; ui.reportSel = ui.reportSel === id ? null : id; render(); },
  'add-account': () => editAccount(null),
  'edit-account': (el) => { const a = findAcc(el.dataset.id); if (a) editAccount(a); },
  'manage-cats': (el) => openCatManager(el.dataset.type),
  'add-cat': () => editCat('expense', null),
  'edit-cat': (el) => { const c = findCat('expense', el.dataset.id); if (c) editCat('expense', c); },
  'open-main': (el) => { catMgr.mainId = el.dataset.id; renderCatManager(); },
  'cat-back': () => { catMgr.mainId = null; renderCatManager(); },
  'cat-up': (el) => {
    const list = data.categories.expense;
    const i = list.findIndex((c) => c.id === el.dataset.id);
    if (i > 0) { [list[i - 1], list[i]] = [list[i], list[i - 1]]; save(); renderCatManager(); }
  },
  'add-sub': () => { const m = findCat('expense', catMgr.mainId); if (m) editSub(m, null); },
  'edit-sub': (el) => { const m = findCat('expense', catMgr.mainId); const s = findSub(m, el.dataset.id); if (s) editSub(m, s); },
  'sub-up': (el) => {
    const m = findCat('expense', catMgr.mainId);
    const i = m ? m.subs.findIndex((s) => s.id === el.dataset.id) : -1;
    if (i > 0) { [m.subs[i - 1], m.subs[i]] = [m.subs[i], m.subs[i - 1]]; save(); renderCatManager(); }
  },
  'form-emoji': (el) => {
    form.emoji[el.dataset.key] = el.dataset.v;
    el.parentElement.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === el));
  },
  'form-save': () => {
    const values = {};
    for (const f of form.fields) {
      if (f.type === 'note') continue;
      values[f.key] = f.type === 'emoji' ? form.emoji[f.key] : $('#f_' + f.key).value.trim();
    }
    if (form.onSave(values) !== false) closeLayer();
  },
  // 表單裡的「刪除」：確認後要關掉確認視窗和表單兩層
  'form-delete': async () => { if ((await form.onDelete()) !== false) closeLayers(2); },
  'add-demo': () => {
    const demo = makeDemoTxs();
    data.txs.push(...demo);
    save();
    ui.tab = 'list'; ui.ym = currentYM();
    render(); window.scrollTo(0, 0);
    toast(`已加入 ${demo.length} 筆範例資料`);
  },
  'remove-demo': async () => {
    const n = demoCount();
    if (!(await askConfirm({ title: `要移除 ${n} 筆範例資料嗎？`, message: '你自己記的帳不會受影響。', ok: '移除' }))) return;
    closeLayer();
    data.txs = data.txs.filter((t) => !t.demo);
    save(); render(); toast('已移除範例資料');
  },
  'login': () => login(),
  'logout': () => logout(),
  // 點一下就換到下一本帳本（兩本時就是來回切換）
  'choose-ledger': () => {
    const list = cloud.ledgers;
    if (list.length < 2) return;
    const i = list.findIndex((l) => l.id === cloud.activeId);
    const next = list[(i + 1) % list.length];
    openLedger(next.id);
    toast(`切換到 ${ledgerLabel(next)}`);
  },
  'switch-ledger': (el) => {
    const id = el.dataset.id;
    if (layers.length) closeLayer();
    if (id === cloud.activeId) return;
    openLedger(id);
    const l = cloud.ledgers.find((x) => x.id === id);
    if (l) toast(`切換到${ledgerLabel(l)}`);
  },
  'create-family': () => openForm({
    title: '建立家用帳本',
    fields: [{ key: 'name', label: '帳本名稱', value: '家用', placeholder: '例如：家用、潘家', max: 10 }],
    onSave: (v) => {
      const name = v.name || '家用';
      const id = 'f_' + uid();
      const me = cloud.user.uid;
      // 分類和付款方式先複製目前帳本的，之後可以另外改
      if (!navigator.onLine) { toast('建立家用帳本需要網路'); return false; }
      toast('建立中…');
      // 等雲端真的建好再打開（不然安全規則會擋住還不存在的帳本）
      setDoc(ledgerRef(id), clean({
        type: 'family', name, owner: me, ownerEmail: cloud.email, memberEmails: [cloud.email],
        members: { [me]: { name: myName(), email: cloud.email } },
        accounts: data.accounts, categories: data.categories, createdAt: Date.now(),
      }))
        .then(() => { openLedger(id); ui.tab = 'settings'; render(); toast(`已建立「${name}」，可以加入家人了`); })
        .catch((e) => { console.error(e); toast('建立失敗：' + (e.code || e.message)); });
    },
  }),
  'add-member': () => openForm({
    title: '加入家人',
    fields: [{ key: 'email', label: '家人的 Gmail', value: '', placeholder: '例如：mom@gmail.com', max: 80 }],
    onSave: (v) => {
      const em = v.email.trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) { toast('請輸入正確的 Email'); return false; }
      const list = cloud.meta.memberEmails || [];
      if (list.includes(em)) { toast('這個人已經在成員裡了'); return false; }
      if (list.length >= 20) { toast('成員最多 20 人'); return false; }
      updateDoc(ledgerRef(cloud.activeId), { memberEmails: [...list, em] })
        .then(() => toast('已加入，請家人用這個 Google 帳號登入'))
        .catch((e) => { console.error(e); toast('加入失敗：' + (e.code || e.message)); });
    },
  }),
  'remove-member': async (el) => {
    const em = el.dataset.email;
    if (!(await askConfirm({ title: '要把這位成員移出帳本嗎？', message: `${em}\n移除後他就看不到這本帳本了（他之前記的帳會留著）。`, ok: '移除' }))) return;
    closeLayer();
    updateDoc(ledgerRef(cloud.activeId), { memberEmails: (cloud.meta.memberEmails || []).filter((x) => x !== em) })
      .then(() => toast('已移除'))
      .catch((e) => { console.error(e); toast('移除失敗：' + (e.code || e.message)); });
  },
  'delete-family': async () => {
    if (!isFamily() || !isOwner()) return;
    const name = cloud.meta.name || '家用';
    if (!(await askConfirm({ title: `確定要刪除「${name}」嗎？`, message: `裡面 ${data.txs.length} 筆記錄會全部刪除，所有成員都看不到，而且無法復原。\n建議先「匯出備份檔」。`, ok: '刪除帳本' }))) return;
    closeLayer();
    if (!navigator.onLine) { toast('刪除帳本需要網路'); return; }
    const id = cloud.activeId;
    const ids = data.txs.map((t) => t.id);
    openLedger('p_' + cloud.user.uid);
    try {
      await commitOps(ids.map((tid) => ['del', txRef(id, tid)]));
      const b = writeBatch(db); b.delete(ledgerRef(id)); await b.commit();
      toast(`已刪除「${name}」`);
    } catch (e) { console.error(e); toast('刪除失敗：' + (e.code || e.message)); }
  },
  'export-json': () => exportJSON(),
  'import-json': () => $('#importFile').click(),
  // 給 AI 讀分類的 API
  'api-on': () => enableApi(),
  'api-regen': async () => {
    if (!(await askConfirm({ title: '重新產生 API 網址？', message: '舊的網址會馬上失效，已經給 AI 的指令要換成新的。', ok: '重新產生' }))) return;
    closeLayer();
    enableApi();
  },
  'api-off': async () => {
    if (!(await askConfirm({ title: '停用 API？', message: '網址會馬上失效。之後要用可以再產生一組新的。', ok: '停用' }))) return;
    closeLayer();
    disableApi();
  },
  'api-copy-url': () => { if (cloud.meta?.apiKey) copyText(apiUrl(cloud.meta.apiKey), ' API 網址'); },
  'api-copy-prompt': () => copyText(aiPrompt(), '給 AI 的指令'),
  // 匯入 Excel
  'import-excel': () => $('#excelFile').click(),
  'excel-template': () => downloadTemplate(),
  'import-do': () => doImport(),
  'import-all': (el) => {
    if (!imp) return;
    for (const r of imp.rows) r.on = !!el.dataset.on && rowOk(r) && !r.errs.length;
    renderImport();
  },
  'import-undo': async (el) => {
    const b = importBatches().find((x) => x.id === el.dataset.id);
    if (!b) return;
    if (!(await askConfirm({ title: '刪除這批匯入？', message: `會刪除這次匯入的 ${b.n} 筆記錄（共 $${fmt(b.sum)}），之後自己修改過的也會一起刪掉，而且無法復原。`, ok: '刪除這批' }))) return;
    closeLayer();
    data.txs = data.txs.filter((t) => t.importId !== b.id);
    save(); render(); toast(`已刪除 ${b.n} 筆匯入的記錄`);
  },
  'export-csv': () => exportCSV(),
  'month-export': () => openMonthExport(),
  'do-month-export': () => doMonthExport(),
  'clear-all': async () => {
    if (isFamily()) return;
    if (!(await askConfirm({ title: '確定要全部清除嗎？', message: '這會刪除個人帳本（雲端）的所有記錄、付款方式和分類設定，而且無法復原。\n建議先「匯出備份檔」。', ok: '全部清除' }))) return;
    closeLayer();
    data = defaultData(); save(); render(); toast('已清除');
  },
};

document.addEventListener('click', (ev) => {
  if (ev.target.id === 'modal' && imp) return; // 匯入預覽不要因為點到背景就整個關掉
  if (ev.target.id === 'modal' || ev.target.id === 'confirm') { closeLayer(); return; } // 點背景關閉
  const el = ev.target.closest('[data-action]');
  if (!el) return;
  const fn = actions[el.dataset.action];
  if (fn) { ev.preventDefault(); fn(el, ev); }
});

// 首頁日曆左右滑動：收起時切換星期，展開時切換月份。
// 日曆跟著手指移動，放開後順順地滑到下一頁（或彈回原位）。
let swipe = null, calBusy = false, swipeEndAt = 0;
const EASE = 'cubic-bezier(.22,.8,.28,1)';
document.addEventListener('pointerdown', (ev) => {
  if (calBusy || !ev.isPrimary || (ev.pointerType === 'mouse' && ev.button !== 0)) return;
  const card = ev.target.closest('[data-swipe]');
  if (!card) { swipe = null; return; }
  const track = card.querySelector('.cal-track');
  swipe = { card, track, vp: card.querySelector('.cal-vp'), x: ev.clientX, y: ev.clientY, t: ev.timeStamp, dx: 0, axis: null, id: ev.pointerId, hist: [] };
});
document.addEventListener('pointermove', (ev) => {
  if (!swipe || ev.pointerId !== swipe.id) return;
  const dx = ev.clientX - swipe.x, dy = ev.clientY - swipe.y;
  if (!swipe.axis) {
    if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
    swipe.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
    if (swipe.axis === 'y') { swipe = null; return; } // 上下捲動就交給頁面
    swipe.track.style.transition = 'none';
    try { swipe.card.setPointerCapture(ev.pointerId); } catch {}
  }
  swipe.dx = dx;
  swipe.hist.push([ev.timeStamp, dx]);
  if (swipe.hist.length > 6) swipe.hist.shift();
  swipe.track.style.transform = `translate3d(${dx}px,0,0)`;
  if (ui.calOpen) {
    // 整月模式：兩個月週數不同時，高度跟著拖動的比例慢慢變
    const s = swipe;
    if (!s.h) s.h = { cur: s.vp.offsetHeight, prev: s.card.querySelector('.cal-pane.prev').offsetHeight, next: s.card.querySelector('.cal-pane.next').offsetHeight, w: s.vp.offsetWidth };
    const p = Math.min(1, Math.abs(dx) / s.h.w), to = dx < 0 ? s.h.next : s.h.prev;
    s.vp.style.transition = 'none';
    s.vp.style.height = `${s.h.cur + (to - s.h.cur) * p}px`;
  }
});
function endSwipe(ev, cancelled) {
  if (!swipe || ev.pointerId !== swipe.id) return;
  const s = swipe;
  swipe = null;
  if (s.axis !== 'x') return;
  swipeEndAt = Date.now();
  const w = s.vp.offsetWidth;
  // 用最後一小段的速度判斷是不是「快速一撥」
  const h = s.hist, a = h[0], b = h[h.length - 1];
  const v = a && b && b[0] > a[0] ? (b[1] - a[1]) / (b[0] - a[0]) : 0; // px/ms
  let dir = 0;
  if (!cancelled) {
    if (Math.abs(s.dx) > w * 0.3) dir = s.dx < 0 ? 1 : -1;
    else if (Math.abs(v) > 0.35 && Math.abs(s.dx) > 16 && Math.sign(v) === Math.sign(s.dx)) dir = v < 0 ? 1 : -1;
  }
  calBusy = true;
  const remain = dir ? w - Math.abs(s.dx) : Math.abs(s.dx);
  const ms = Math.round(Math.min(320, Math.max(160, remain * 0.9)));
  s.track.style.transition = `transform ${ms}ms ${EASE}`;
  s.track.style.transform = dir ? `translate3d(${-dir * w}px,0,0)` : 'translate3d(0,0,0)';
  if (s.h) {
    // 整月模式：高度一起平滑變到目標月份（或回到原本）
    s.vp.style.transition = `height ${ms}ms ${EASE}`;
    s.vp.style.height = `${dir > 0 ? s.h.next : dir < 0 ? s.h.prev : s.h.cur}px`;
  }
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    calBusy = false;
    if (dir) { Object.assign(ui, calNeighbor(dir)); render(); }
    else { s.track.style.transition = ''; s.track.style.transform = ''; s.vp.style.transition = ''; s.vp.style.height = ''; }
  };
  s.track.addEventListener('transitionend', (e) => { if (e.propertyName === 'transform') finish(); }, { once: false });
  setTimeout(finish, ms + 80); // 保險：萬一 transitionend 沒觸發
}
document.addEventListener('pointerup', (ev) => endSwipe(ev, false));
document.addEventListener('pointercancel', (ev) => endSwipe(ev, true));
// 剛滑完不要誤觸日期
document.addEventListener('click', (ev) => {
  if (Date.now() - swipeEndAt < 350 && ev.target.closest('[data-swipe]')) { ev.stopPropagation(); ev.preventDefault(); }
}, true);

// 記帳畫面裡的下拉選單、日期、備註
const onBind = (ev) => {
  const key = ev.target.dataset?.bind;
  if (!key || !entry) return;
  entry[key] = ev.target.value;
};
$('#sheet').addEventListener('input', onBind);
$('#sheet').addEventListener('change', onBind);

// 電腦鍵盤也能輸入金額
document.addEventListener('keydown', (ev) => {
  const top = layers[layers.length - 1];
  if (ev.target.matches?.('input, select, textarea')) {
    if (ev.key === 'Enter' && ev.target.type === 'text') ev.target.blur();
    if (ev.key === 'Escape' && top) { ev.target.blur(); closeLayer(); }
    else if (ev.key === 'Escape' && ui.search) actions['search-close']();
    return;
  }
  if (ev.key === 'Escape' && top) { closeLayer(); return; }
  if (ev.key === 'Escape' && ui.search) { actions['search-close'](); return; }
  // 電腦快捷鍵（沒有開任何視窗時）：N 記一筆、← → 換月份
  if (!top && !ev.ctrlKey && !ev.metaKey && !ev.altKey && cloud.status === 'ready') {
    if (ev.key === 'n' || ev.key === 'N') { ev.preventDefault(); actions['new-tx'](); return; }
    if ((ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') && !ui.search && (ui.tab === 'list' || ui.tab === 'report')) {
      ev.preventDefault(); shiftMonth(ev.key === 'ArrowLeft' ? -1 : 1); ui.reportSel = null; render(); return;
    }
  }
  if (!entry || top !== 'sheet') return;
  if (/^[0-9.+\-]$/.test(ev.key)) { ev.preventDefault(); pressKey(ev.key); }
  else if (ev.key === 'Backspace') { ev.preventDefault(); pressKey('back'); }
  else if (ev.key === 'Enter') { ev.preventDefault(); pressKey('ok'); }
});

// ---------- 啟動 ----------
// 視窗拉寬變成電腦版時，日曆自動展開整月
window.matchMedia('(min-width: 960px)').addEventListener('change', (e) => { ui.calOpen = e.matches; render(); });
render();
getRedirectResult(auth).catch((e) => { cloud.loginError = '登入失敗：' + (e.code || e.message); render(); });
onAuthStateChanged(auth, (user) => {
  if (user) { if (cloud.user?.uid !== user.uid) startSession(user); return; }
  stopListening();
  Object.assign(cloud, { status: 'signedOut', user: null, email: '', ledgers: [], activeId: null, meta: null, gotMeta: false, gotTxs: false });
  data = { ...defaultData(), accounts: [], categories: { expense: [], income: [] } };
  layers.length = 0; hideLayer('sheet'); hideLayer('modal'); hideLayer('confirm');
  ui.tab = 'list';
  render();
});


if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  // updateViaCache:'none'：檢查 sw.js 有沒有新版時不要用手機裡的舊檔
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {}));
}
