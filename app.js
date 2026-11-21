'use strict';

/* ============================================================
   小帳本 — 個人記帳 App（PWA）
   資料全部存在這台裝置的瀏覽器 localStorage 裡。
   ============================================================ */

const STORE_KEY = 'xiaozhangben:v1';
const APP_VERSION = '1.2.0';
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
  };
}

// ---------- 儲存 ----------
let storageOK = true;
function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const d = JSON.parse(raw);
      if (validData(d)) return normalize(d);
    }
  } catch (e) {
    storageOK = false;
  }
  return defaultData();
}
function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(data));
    storageOK = true;
  } catch (e) {
    storageOK = false;
    toast('儲存失敗，請先匯出備份');
  }
}

let data = load();
if (migratedOnLoad) { save(); migratedOnLoad = false; } // 舊資料轉換完立刻存起來

// ---------- 畫面狀態 ----------
const currentYM = () => { const d = new Date(); return { y: d.getFullYear(), m: d.getMonth() + 1 }; };
const ymKey = (ym) => `${ym.y}-${pad(ym.m)}`;
const ui = { tab: 'list', ym: currentYM(), reportSel: null, persisted: null };

function shiftMonth(delta) {
  let { y, m } = ui.ym;
  m += delta;
  while (m < 1) { m += 12; y--; }
  while (m > 12) { m -= 12; y++; }
  ui.ym = { y, m };
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
  $('#view').innerHTML = VIEWS[ui.tab]();
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('on', b.dataset.tab === ui.tab));
}

function monthBar() {
  return `<div class="monthbar">
    <button class="icon-btn" data-action="month" data-d="-1" aria-label="上個月">‹</button>
    <button class="month-label" data-action="month-now" title="回到本月">${ui.ym.y} 年 ${ui.ym.m} 月</button>
    <button class="icon-btn" data-action="month" data-d="1" aria-label="下個月">›</button>
  </div>`;
}

function summaryCard(txs) {
  const total = sumAmt(txs);
  return `<div class="card month-sum">
    <div class="lbl">${ui.ym.m} 月支出</div>
    <div class="month-total">$${fmt(total)}</div>
    <div class="month-meta">共 ${txs.length} 筆 · 日平均 $${fmt(Math.round(total / daysForAvg()))}</div>
  </div>`;
}

// 標題顯示次分類（沒有就顯示主分類），第二行顯示「主分類 · 付款方式 · 備註」
function txRow(t) {
  const c = findCat('expense', t.categoryId);
  const s = findSub(c, t.subCategoryId);
  const title = s ? s.name : (c?.name ?? '未分類');
  const sub = [s ? c.name : null, accName(t.accountId), t.note || null].filter(Boolean).join(' · ');
  return `<button class="tx" data-action="edit-tx" data-id="${esc(t.id)}">
    <span class="tx-icon">${esc(c?.icon ?? '❔')}</span>
    <span class="tx-main"><span class="tx-name">${esc(title)}</span><span class="tx-sub">${esc(sub)}</span></span>
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

function viewList() {
  const txs = monthTxs().sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || 0) - (a.createdAt || 0));
  let html = '';
  if (!storageOK) html += `<div class="banner">⚠️ 這個瀏覽器目前無法儲存資料（可能是私密瀏覽模式），關掉後記錄會消失。</div>`;
  html += monthBar() + summaryCard(txs);
  if (!txs.length) {
    return html + `<div class="empty"><div class="big">📝</div>這個月還沒有記錄<br>按下方 ＋ 記第一筆吧</div>`;
  }
  const groups = new Map();
  for (const t of txs) {
    if (!groups.has(t.date)) groups.set(t.date, []);
    groups.get(t.date).push(t);
  }
  for (const [ds, list] of groups) {
    html += `<section class="day">
      <div class="day-head"><span>${dayLabel(ds)}</span><span>$${fmt(sumAmt(list))}</span></div>
      <div class="rows">${list.map(txRow).join('')}</div>
    </section>`;
  }
  return html;
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

function viewReport() {
  const txs = monthTxs();
  const type = 'expense';
  let html = monthBar() + summaryCard(txs);

  const sums = new Map();
  for (const t of txs) sums.set(t.categoryId, (sums.get(t.categoryId) || 0) + t.amount);
  const rows = [...sums].map(([id, value]) => {
    const c = findCat(type, id);
    return { id: id ?? '__none', name: c?.name ?? '未分類', icon: c?.icon ?? '❔', value: round2(value) };
  }).sort((a, b) => b.value - a.value);
  if (!rows.length) {
    return html + `<div class="empty"><div class="big">📊</div>這個月還沒有${TYPE_LABEL[type]}記錄</div>`;
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

  html += `<div class="card">
    <div class="donut-box">${donutSvg(slices, total, sliceSel)}<div class="donut-center">${center}</div></div>
    <div class="rows" style="box-shadow:none;margin:0 -16px -16px;border-radius:0 0 16px 16px">
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
  <p class="hint">點主分類可以看它底下各個次分類花了多少。</p>`;
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
  const persist = ui.persisted === true ? '已鎖定（不會被自動清除）' : ui.persisted === false ? '一般' : '—';
  return `<section class="group"><h2>分類</h2><div class="rows">
      <button class="row" data-action="manage-cats" data-type="expense"><span>支出分類</span><span class="row-val">${data.categories.expense.length} 個主分類 ›</span></button>
    </div></section>
    <section class="group"><h2>範例資料</h2><div class="rows">
      ${demoCount()
        ? `<button class="row danger" data-action="remove-demo"><span>移除範例資料</span><span class="row-val">${demoCount()} 筆 ›</span></button>`
        : `<button class="row" data-action="add-demo"><span>加入範例資料</span><span class="row-val">近 3 個月 ›</span></button>`}
    </div>
    <p class="hint">想先看看有資料時的樣子，可以加入一些假的支出記錄。範例資料可以一鍵移除，不會動到你自己記的帳。</p>
    </section>
    <section class="group"><h2>資料備份</h2><div class="rows">
      <button class="row" data-action="export-json"><span>匯出備份檔</span><span class="row-val">.json ›</span></button>
      <button class="row" data-action="import-json"><span>從備份檔還原</span><span class="row-val">›</span></button>
      <button class="row" data-action="export-csv"><span>匯出成 Excel 可開的檔案</span><span class="row-val">.csv ›</span></button>
      <button class="row danger" data-action="clear-all"><span>清除所有資料</span></button>
    </div>
    <p class="hint">資料只存在<b>這支手機的瀏覽器</b>裡，不會上傳到任何地方。換手機或清除瀏覽器資料前，記得先匯出備份檔（建議每月一次，存到雲端硬碟或傳給自己）。</p>
    </section>
    <section class="group"><h2>安裝到手機主畫面</h2><div class="rows">
      <div class="row"><span>iPhone（Safari）</span><span class="row-val">分享 → 加入主畫面</span></div>
      <div class="row"><span>Android（Chrome）</span><span class="row-val">⋮ → 安裝應用程式</span></div>
    </div></section>
    <section class="group"><h2>關於</h2><div class="rows">
      <div class="row"><span>記錄筆數</span><span class="row-val">${data.txs.filter((t) => t.type === 'expense').length}</span></div>
      <div class="row"><span>儲存狀態</span><span class="row-val">${persist}</span></div>
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
    history.pushState({ layer: name }, '');
  }
}
function closeLayer() {
  if (layers.length) history.back();
}
function hideLayer(name) {
  const el = $('#' + name);
  el.hidden = true;
  el.innerHTML = '';
  if (name === 'sheet') { entry = null; catMgr = null; }
  if (name === 'modal') form = null;
  if (!layers.length) document.body.classList.remove('locked');
}
window.addEventListener('popstate', () => {
  const name = layers.pop();
  if (name) hideLayer(name);
});

// ---------- 記一筆 ----------
let entry = null;

function openEntry(tx) {
  const lastAcc = findAcc(data.prefs.lastAccountId) ? data.prefs.lastAccountId : data.accounts[0]?.id;
  entry = {
    id: tx?.id ?? null,
    expr: tx ? String(tx.amount) : '0',
    fresh: !!tx, // 編輯時，第一次按數字會取代原金額
    categoryId: tx?.categoryId ?? data.categories.expense[0]?.id ?? null,
    subCategoryId: tx?.subCategoryId ?? null,
    accountId: tx?.accountId ?? lastAcc ?? null,
    date: tx?.date ?? todayStr(),
    note: tx?.note ?? '',
  };
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
    ...(old?.demo ? { demo: true } : {}), // 修改範例資料後仍算範例資料
  };
  if (old) data.txs[data.txs.indexOf(old)] = tx;
  else data.txs.push(tx);
  data.prefs.lastAccountId = e.accountId;
  save();

  const [y, m] = tx.date.split('-').map(Number);
  ui.ym = { y, m };
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
    onDelete: acc ? () => {
      const n = data.txs.filter((t) => t.accountId === acc.id || t.toAccountId === acc.id).length;
      if (n) { alert(`「${acc.name}」還有 ${n} 筆記錄，請先把這些記錄改成其他付款方式或刪除，才能刪除它。`); return false; }
      if (data.accounts.length <= 1) { alert('至少要保留一種付款方式。'); return false; }
      if (!confirm(`確定要刪除付款方式「${acc.name}」嗎？`)) return false;
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
    onDelete: cat ? () => {
      if (data.categories.expense.length <= 1) { alert('至少要保留一個主分類。'); return false; }
      const n = data.txs.filter((t) => t.type === 'expense' && t.categoryId === cat.id).length;
      const subs = cat.subs.length ? `（包含 ${cat.subs.length} 個次分類）` : '';
      const msg = n ? `「${cat.name}」${subs}有 ${n} 筆記錄，刪除後這些記錄會顯示為「未分類」。確定刪除嗎？` : `確定刪除主分類「${cat.name}」${subs}嗎？`;
      if (!confirm(msg)) return false;
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
    onDelete: sub ? () => {
      const hits = data.txs.filter((t) => t.subCategoryId === sub.id);
      const msg = hits.length ? `「${sub.name}」有 ${hits.length} 筆記錄，刪除後這些記錄會只顯示主分類「${main.name}」。確定刪除嗎？` : `確定刪除次分類「${sub.name}」嗎？`;
      if (!confirm(msg)) return false;
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

function exportCSV() {
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [['日期', '主分類', '次分類', '金額', '付款方式', '備註'].map(q).join(',')];
  const sorted = data.txs.filter((t) => t.type === 'expense').sort((a, b) => a.date.localeCompare(b.date));
  for (const t of sorted) {
    const c = findCat('expense', t.categoryId);
    lines.push([t.date, c?.name ?? '未分類', findSub(c, t.subCategoryId)?.name ?? '', t.amount, accName(t.accountId), t.note].map(q).join(','));
  }
  shareOrDownload(`小帳本明細-${stamp()}.csv`, '﻿' + lines.join('\r\n'), 'text/csv');
}

$('#importFile').addEventListener('change', async (ev) => {
  const file = ev.target.files[0];
  ev.target.value = '';
  if (!file) return;
  try {
    const d = JSON.parse(await file.text());
    if (!validData(d)) throw new Error('格式不符');
    const incoming = normalize(d);
    if (!confirm(`備份檔裡有 ${incoming.txs.length} 筆記錄。\n還原會「取代」目前的 ${data.txs.length} 筆記錄，確定嗎？`)) return;
    data = incoming;
    save(); render(); toast('已還原備份');
  } catch (err) {
    alert('這個檔案無法讀取，請確認是「小帳本」匯出的備份檔。');
  }
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
  'tab': (el) => { ui.tab = el.dataset.tab; ui.reportSel = null; render(); window.scrollTo(0, 0); },
  'month': (el) => { shiftMonth(Number(el.dataset.d)); ui.reportSel = null; render(); },
  'month-now': () => { ui.ym = currentYM(); ui.reportSel = null; render(); },
  'new-tx': () => openEntry(null),
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
  'delete-tx': () => {
    if (!confirm('確定刪除這筆記錄嗎？')) return;
    data.txs = data.txs.filter((t) => t.id !== entry.id);
    save(); closeLayer(); render(); toast('已刪除');
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
    for (const f of form.fields) values[f.key] = f.type === 'emoji' ? form.emoji[f.key] : $('#f_' + f.key).value.trim();
    if (form.onSave(values) !== false) closeLayer();
  },
  'form-delete': () => { if (form.onDelete() !== false) closeLayer(); },
  'add-demo': () => {
    const demo = makeDemoTxs();
    data.txs.push(...demo);
    save();
    ui.tab = 'list'; ui.ym = currentYM();
    render(); window.scrollTo(0, 0);
    toast(`已加入 ${demo.length} 筆範例資料`);
  },
  'remove-demo': () => {
    const n = demoCount();
    if (!confirm(`要移除 ${n} 筆範例資料嗎？\n你自己記的帳不會受影響。`)) return;
    data.txs = data.txs.filter((t) => !t.demo);
    save(); render(); toast('已移除範例資料');
  },
  'export-json': () => exportJSON(),
  'import-json': () => $('#importFile').click(),
  'export-csv': () => exportCSV(),
  'clear-all': () => {
    if (!confirm('這會刪除所有記錄、帳戶和分類設定，而且無法復原。\n建議先「匯出備份檔」。\n\n確定要全部清除嗎？')) return;
    data = defaultData(); save(); render(); toast('已清除');
  },
};

document.addEventListener('click', (ev) => {
  if (ev.target.id === 'modal') { closeLayer(); return; } // 點背景關閉表單
  const el = ev.target.closest('[data-action]');
  if (!el) return;
  const fn = actions[el.dataset.action];
  if (fn) { ev.preventDefault(); fn(el, ev); }
});

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
  if (ev.target.matches('input, select, textarea')) {
    if (ev.key === 'Enter' && ev.target.type === 'text') ev.target.blur();
    return;
  }
  if (ev.key === 'Escape' && top) { closeLayer(); return; }
  if (!entry || top !== 'sheet') return;
  if (/^[0-9.+\-]$/.test(ev.key)) { ev.preventDefault(); pressKey(ev.key); }
  else if (ev.key === 'Backspace') { ev.preventDefault(); pressKey('back'); }
  else if (ev.key === 'Enter') { ev.preventDefault(); pressKey('ok'); }
});

// ---------- 啟動 ----------
render();

if (navigator.storage?.persist) {
  navigator.storage.persisted()
    .then((p) => p || navigator.storage.persist())
    .then((p) => { ui.persisted = p; if (ui.tab === 'settings') render(); })
    .catch(() => {});
}

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
