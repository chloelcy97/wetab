/* ==========================================================================
   WeTab — 几个人一起记账
   零构建：原生 ES module。数据存 localStorage，汇率走 frankfurter，同步走 Supabase。
   ========================================================================== */

import { SUPABASE_URL, SUPABASE_KEY, SYNC_AVAILABLE,
         RATES_URL, SUPPORT_URL } from './config.js';
/* 取名 tr 而不是 t：这份文件里 t 已经是 trip / tab 的循环变量，
   叫 t 会被就近遮蔽，而且是那种不报错、只是一直显示中文的静默 bug。 */
import { t as tr, getLang, setLang, LANGS } from './i18n.js';

/* ---------- 小工具 ---------- */
const $  = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = (name, cls = 'icon') =>
  `<svg class="${cls}" aria-hidden="true"><use href="#ph-${name}"></use></svg>`;

/* 品牌标记：斜等号。等号斜过来的两道平行线 —— 还是两清 / 平分，只是多一点走势。
   fill="none" 写在 path 上而不是 svg 上：.icon 的 fill: currentColor 会盖过
   svg 上的同名属性，但盖不过 path 自己的。
   不放进 sprite，因为 sprite 是从 icons/ 里的 Phosphor 原文件重建的。 */
const brand = (cls = 'icon') =>
  `<svg class="${cls}" viewBox="0 0 256 256" aria-hidden="true">
     <path d="M69 190 117 66" fill="none" stroke="currentColor"
           stroke-width="29" stroke-linecap="round"/>
     <path d="M139 190 187 66" fill="none" stroke="currentColor"
           stroke-width="29" stroke-linecap="round"/>
   </svg>`;
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ==========================================================================
   币种
   ========================================================================== */
const CURRENCIES = {
  HKD: { sym: 'HK$', dec: 2 },
  GBP: { sym: '£', dec: 2 },
  CNY: { sym: '¥', dec: 2 },
  USD: { sym: 'US$', dec: 2 },
  EUR: { sym: '€', dec: 2 },
  JPY: { sym: 'JP¥', dec: 0 },
  KRW: { sym: '₩', dec: 0 },
  SGD: { sym: 'S$', dec: 2 },
  AUD: { sym: 'A$', dec: 2 },
  CAD: { sym: 'C$', dec: 2 },
  CHF: { sym: 'CHF', dec: 2 },
  NZD: { sym: 'NZ$', dec: 2 },
  THB: { sym: '฿', dec: 2 },
  MYR: { sym: 'RM', dec: 2 },
  IDR: { sym: 'Rp', dec: 0 },
  PHP: { sym: '₱', dec: 2 },
  INR: { sym: '₹', dec: 2 },
};
const DISPLAY = ['HKD', 'GBP', 'CNY'];

/* 离线兜底汇率（以 EUR 为基准），仅在拿不到实时汇率时使用 */
const FALLBACK = {
  base: 'EUR', date: null, stale: true,
  rates: { EUR: 1, HKD: 9.077, GBP: 0.8545, CNY: 7.7977, USD: 1.1567, JPY: 183.93,
           KRW: 1583, SGD: 1.48, AUD: 1.76, CAD: 1.58, CHF: 0.93, NZD: 1.92,
           THB: 37.3, MYR: 4.87, IDR: 18700, PHP: 65.5, INR: 101.2 },
};

let rates = FALLBACK;

async function loadRates({ force = false } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  if (!force) {
    try {
      const c = JSON.parse(localStorage.getItem('wetab.rates') || 'null');
      if (c && c.fetchedOn === today) { rates = c; return rates; }
    } catch {}
  }
  try {
    const res = await fetch(RATES_URL);
    if (!res.ok) throw new Error('rates ' + res.status);
    const data = await res.json();
    if (!data.rates || !data.rates.HKD) throw new Error('bad payload');
    data.rates.EUR = 1;
    rates = { ...data, stale: false, fetchedOn: today };
    localStorage.setItem('wetab.rates', JSON.stringify(rates));
  } catch (e) {
    console.warn('[rates] 使用离线汇率:', e.message);
    rates = { ...FALLBACK, error: true };
  }
  return rates;
}

function convert(amount, from, to) {
  if (from === to) return amount;
  const r = rates.rates || {};
  const rf = from === rates.base ? 1 : r[from];
  const rt = to === rates.base ? 1 : r[to];
  if (!rf || !rt) return amount;
  return (amount / rf) * rt;
}

function fmt(amount, cur, { sym = true } = {}) {
  const meta = CURRENCIES[cur] || { sym: cur + ' ', dec: 2 };
  const n = new Intl.NumberFormat('zh-Hans', {
    minimumFractionDigits: meta.dec, maximumFractionDigits: meta.dec,
  }).format(Math.abs(amount));
  const sign = amount < 0 ? '-' : '';
  return sym ? `${sign}${meta.sym}${n}` : `${sign}${n}`;
}

/* ==========================================================================
   分类
   ========================================================================== */
const CATS = [
  { id: 'food',    icon: 'fork-knife' },
  { id: 'transit', icon: 'car' },
  { id: 'stay',    icon: 'bed' },
  { id: 'shop',    icon: 'shopping-bag' },
  { id: 'ticket',  icon: 'ticket' },
];

/* 旧账里的分类映射到新的五类。娱乐多半是门票，日用和医疗都归购物。 */
const CAT_ALIAS = { fun: 'ticket', daily: 'shop', health: 'shop', other: 'shop' };
const normCat = (id) => CAT_ALIAS[id] || id;

const catOf = (id) => CATS.find((c) => c.id === normCat(id)) || CATS[0];

/* ==========================================================================
   状态
   ========================================================================== */
const KEY = 'wetab.state.v1';
const LEGACY_KEY = 'tally.state.v1';   // 改名前的 key，读一次就迁移过来

const dback = (back) => {
  const t = new Date();
  t.setDate(t.getDate() - back);
  return new Date(t.getTime() - t.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};

function seedTrips() {
  return [
    { id: 't-tokyo', name: tr('seed.tokyo'),    from: dback(7), to: dback(5), currency: 'JPY' },
    { id: 't-sz',    name: tr('seed.shenzhen'), from: dback(3), to: dback(2), currency: 'CNY' },
  ];
}

function seed() {
  const d = dback;
  const ids = state.members.map((m) => m.id);
  const ALL = () => ids.slice();
  const ONLY = (id) => [id];
  const E = (n, payer, amount, currency, cat, date, parts, tripId, ago) => ({
    id: uid(), type: 'expense', payerId: payer, amount, currency, cat,
    merchant: tr(`seed.m${n}`), note: tr(`seed.n${n}`),
    date, participants: parts, tripId, createdAt: Date.now() - ago,
  });
  return [
    E(1, 'a', 486,  'HKD', 'food',    d(0), ALL(), null,       1e5),
    E(2, 'b', 128,  'HKD', 'transit', d(0), ALL(), null,       2e5),
    E(3, 'b', 32.4, 'GBP', 'shop',    d(1), ALL(), null,       9e6),
    E(4, 'a', 1240, 'CNY', 'stay',    d(2), ALL(), 't-sz',     2e7),
    E(5, 'a', 268,  'HKD', 'ticket',  d(3), ALL(), null,       3e7),
    E(6, 'b', 74.5, 'HKD', 'shop',    d(4), ALL(), null,       4e7),
    E(7, 'a', 9800, 'JPY', 'food',    d(6), ONLY(ids[1]), 't-tokyo', 6e7),
  ];
}

/* 随机默认名字。分享给别人时，第一次打开不该看到别人的名字，
   所以从这里抽两个不重样的，引导页里能摇也能直接改。名单跟着语言走。 */
const NAME_POOL = () => tr('names');

function pickNames() {
  const pool = NAME_POOL();
  const a = Math.floor(Math.random() * pool.length);
  let b = Math.floor(Math.random() * (pool.length - 1));
  if (b >= a) b += 1;                       // 保证两个不一样
  return [pool[a], pool[b]];
}

const DEFAULT_STATE = (() => {
  const [n1, n2] = pickNames();
  return {
    members: [{ id: 'a', name: n1 }, { id: 'b', name: n2 }],
    display: 'HKD',
    trips: [],
    expenses: [],
    onboarded: false,
  };
})();

const MAX_MEMBERS = 8;
const liveMembers = () => state.members.filter((m) => !m.removed);
const memberIndex = (id) => state.members.findIndex((m) => m.id === id);

/* 当前筛选：'all' 全部 · 'daily' 没归到项目的日常 · 其余是 trip id */
let activeTrip = 'all';

let state = load();

function load() {
  try {
    const raw = localStorage.getItem(KEY) || localStorage.getItem(LEGACY_KEY);
    if (!raw) return structuredClone(DEFAULT_STATE);
    const s = JSON.parse(raw);
    // 已经有存档的人不该再被引导一次
    const st = { ...structuredClone(DEFAULT_STATE), onboarded: true, ...s };
    const ids = st.members.map((m) => m.id);
    st.expenses.forEach((e) => { migrateSplit(e, ids); e.cat = normCat(e.cat); });
    return st;
  } catch {
    return structuredClone(DEFAULT_STATE);
  }
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(state)); }
  catch (e) { toast(tr('err.storage'), 'warning-circle'); }
}
function setState(patch) { Object.assign(state, patch); save(); render(); }

/* ==========================================================================
   同步元数据
   每条记录都带 updatedAt（谁后写谁赢）和 deleted（软删除，硬删对方收不到）。
   dirty 是本地标记，不上传，push 成功后清掉。
   ========================================================================== */
function touch(rec) {
  rec.updatedAt = new Date().toISOString();
  rec.dirty = true;
  return rec;
}
/** 改了成员名字 / 默认币种，下次 push 要带上 */
function touchMeta() { state.metaDirty = true; }

const liveExpenses = () => state.expenses.filter((e) => !e.deleted);

/* 两人时代的 split 三选一，到多人就是「这笔由谁分摊」的集合。
   even  → 所有人      payer → 只有付款人      other → 除付款人以外的人
   读档时就地迁移一次，之后只认 participants。 */
function migrateSplit(e, memberIds) {
  if (Array.isArray(e.participants)) return e;
  const others = memberIds.filter((id) => id !== e.payerId);
  e.participants =
    e.type === 'settle' ? []
    : e.split === 'payer' ? [e.payerId]
    : e.split === 'other' ? others
    : memberIds.slice();
  if (e.type === 'settle' && !e.toId) e.toId = others[0] || null;
  delete e.split;
  return e;
}
const liveTrips    = () => state.trips.filter((t) => !t.deleted);

const memberName = (id) => (state.members.find((m) => m.id === id) || {}).name || '?';

/* ==========================================================================
   结算计算
   ========================================================================== */
/**
 * 每个人的净额（显示币种）。正数 = 别人欠他，负数 = 他欠别人。
 * 所有人加起来恒为 0，这是这套账最基本的自洽性。
 */
function balances(list = liveExpenses(), cur = state.display) {
  const net = {};
  for (const m of state.members) net[m.id] = 0;

  for (const e of list) {
    const v = convert(e.amount, e.currency, cur);

    if (e.type === 'settle') {
      // 转账：付的人净额上升，收的人下降
      if (net[e.payerId] === undefined) continue;
      net[e.payerId] += v;
      if (net[e.toId] !== undefined) net[e.toId] -= v;
      continue;
    }

    const parts = (e.participants || []).filter((id) => net[id] !== undefined);
    if (!parts.length || net[e.payerId] === undefined) continue;
    const share = v / parts.length;
    net[e.payerId] += v;                          // 他垫了全款
    for (const id of parts) net[id] -= share;     // 每个分摊人各欠一份
  }
  return net;
}

/**
 * 把净额化成「谁转给谁多少」。贪心：金额最大的债务人先还给金额最大的债权人。
 * 不保证笔数理论最优（那是 NP 难的），但一定不超过 N-1 笔，够用。
 */
function settlements(net) {
  const owe = [], due = [];
  for (const m of state.members) {
    const v = net[m.id] || 0;
    if (v < -0.005) owe.push({ id: m.id, v: -v });
    else if (v > 0.005) due.push({ id: m.id, v });
  }
  owe.sort((a, b) => b.v - a.v);
  due.sort((a, b) => b.v - a.v);

  const out = [];
  let i = 0, j = 0;
  while (i < owe.length && j < due.length) {
    const amt = Math.min(owe[i].v, due[j].v);
    out.push({ from: owe[i].id, to: due[j].id, amount: amt });
    owe[i].v -= amt; due[j].v -= amt;
    if (owe[i].v < 0.005) i++;
    if (due[j].v < 0.005) j++;
  }
  return out;
}

/** 每人实际承担的总额（显示币种），不含结算记录 */
function personTotals(list, cur = state.display) {
  const out = {};
  for (const m of state.members) out[m.id] = 0;
  for (const e of list) {
    if (e.type === 'settle') continue;
    const parts = (e.participants || []).filter((id) => out[id] !== undefined);
    if (!parts.length) continue;
    const share = convert(e.amount, e.currency, cur) / parts.length;
    for (const id of parts) out[id] += share;
  }
  return out;
}

const sorted = (list = liveExpenses()) => [...list].sort(
  (x, y) => (y.date.localeCompare(x.date)) || (y.createdAt - x.createdAt));

/* ==========================================================================
   项目（一次旅行 / 一个城市 / 一段共同开销）
   ========================================================================== */
const tripOf = (id) => state.trips.find((t) => t.id === id && !t.deleted) || null;

/** 按当前筛选取记录 */
function scopedExpenses(scope = activeTrip) {
  const live = liveExpenses();
  if (scope === 'all') return live;
  if (scope === 'daily') return live.filter((e) => !e.tripId);
  return live.filter((e) => e.tripId === scope);
}

/** 一个项目的汇总：总花费、每人份额、起止日期、笔数 */
function tripSummary(trip, cur = state.display) {
  const list = liveExpenses().filter((e) => e.tripId === trip.id);
  const spend = list.filter((e) => e.type !== 'settle');
  return {
    trip,
    count: spend.length,
    total: spend.reduce((s, e) => s + convert(e.amount, e.currency, cur), 0),
    totals: personTotals(list, cur),
    settle: settlements(balances(list, cur)),
    days: (trip.from && trip.to)
      ? Math.round((new Date(trip.to) - new Date(trip.from)) / 86400000) + 1 : 0,
  };
}

/** 记账时按日期猜项目：日期落在某个项目区间内就自动归进去 */
function guessTrip(dateISO) {
  if (activeTrip !== 'all' && activeTrip !== 'daily') return activeTrip;
  const hit = liveTrips().find((t) => t.from && t.to && dateISO >= t.from && dateISO <= t.to);
  return hit ? hit.id : null;
}

/* 不用 M/D：英文里 8/9 分不清是 8 月 9 日还是 9 月 8 日。
   月份用缩写就没有这个问题，中文那边照样是「8月9日」。 */
const tripRange = (t) => {
  if (!t.from || !t.to) return '';
  const fmtD = new Intl.DateTimeFormat(getLang() === 'zh' ? 'zh-Hant-HK' : 'en-GB',
                                       { month: 'short', day: 'numeric' });
  const f = (iso) => fmtD.format(new Date(iso + 'T00:00:00'));
  return t.from === t.to ? f(t.from) : `${f(t.from)} - ${f(t.to)}`;
};

/* ==========================================================================
   日期
   ========================================================================== */
/* 星期和月日的排法两种语言不一样，交给 Intl，别自己拼 */
function dayLabel(iso) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const d = new Date(iso + 'T00:00:00');
  const diff = Math.round((today - d) / 86400000);
  if (diff === 0) return tr('date.today');
  if (diff === 1) return tr('date.yesterday');
  const sameYear = d.getFullYear() === today.getFullYear();
  return new Intl.DateTimeFormat(getLang() === 'zh' ? 'zh-Hant-HK' : 'en-GB', {
    year: sameYear ? undefined : 'numeric',
    month: 'long', day: 'numeric', weekday: 'short',
  }).format(d);
}
const todayISO = () => {
  const t = new Date();
  return new Date(t.getTime() - t.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};

/* ==========================================================================
   路由
   ========================================================================== */
let route = 'ledger';
let statsMonth = todayISO().slice(0, 7);

const TABS = [
  { id: 'ledger',   icon: 'receipt' },
  { id: 'stats',    icon: 'chart-pie-slice' },
  { id: 'settings', icon: 'gear' },
];

function go(r) { route = r; render(); window.scrollTo({ top: 0, behavior: reduceMotion() ? 'auto' : 'smooth' }); }

/* ==========================================================================
   渲染
   ========================================================================== */
function render() {
  $('#topbar').innerHTML = `
    <div class="wordmark">${brand()}<span>WeTab</span></div>
    ${isSynced() ? `<span class="syncdot" data-sync-badge data-state="${syncStatus}">
      <i></i><span>${syncLabel()}</span></span>` : ''}`;
  $('#view').innerHTML =
    route === 'ledger'  ? viewLedger()  :
    route === 'stats'   ? viewStats()   :
    route === 'support' ? viewSupport() : viewSettings();
  renderNav();
  renderRail();
  wireView();
  animateRows = false;
}

function renderNav() {
  $('#nav').innerHTML = `
    <div class="nav__inner">
      ${TABS.slice(0, 1).map(navBtn).join('')}
      <button class="fab" data-add title="${tr('act.add')}" aria-label="${tr('act.add')}">${icon('plus')}</button>
      ${TABS.slice(1).map(navBtn).join('')}
    </div>`;
}
const navBtn = (tab) => `
  <button class="nav__btn" data-go="${tab.id}" ${
    route === tab.id || (tab.id === 'settings' && route === 'support') ? 'aria-current="page"' : ''}>
    ${icon(tab.icon)}<span>${tr('nav.' + tab.id)}</span>
  </button>`;

function renderRail() {
  $('#rail').innerHTML = `
    <div class="wordmark">${brand()}<span>WeTab</span></div>
    ${TABS.map((tab) => `
      <button class="rail__btn" data-go="${tab.id}" ${
        route === tab.id || (tab.id === 'settings' && route === 'support') ? 'aria-current="page"' : ''}>
        ${icon(tab.icon)}<span>${tr('nav.' + tab.id)}</span>
      </button>`).join('')}
    <button class="btn btn--primary" data-add>${icon('plus')}${tr('act.add')}</button>
    <div class="rail__foot">
      ${isSynced()
        ? `<span class="syncdot" data-sync-badge data-state="${syncStatus}"><i></i><span>${syncLabel()}</span></span>`
        : `<div class="footnote">${tr('localOnly')}</div>`}
    </div>`;
}

/* ---------- 账本 ---------- */
function viewLedger() {
  const scope = activeTrip;
  const list = sorted(scopedExpenses());
  const net = balances(list);
  const moves = settlements(net);
  const settled = moves.length === 0;
  const totals = personTotals(list);
  const trip = tripOf(scope);
  const ms = liveMembers();

  const groups = [];
  for (const e of list) {
    const g = groups[groups.length - 1];
    if (g && g.date === e.date) g.items.push(e);
    else groups.push({ date: e.date, items: [e] });
  }

  /* 余额卡的主视觉：一笔转账时是个大数字，多笔时是一张清单 */
  const head = !list.length
    ? `<div class="balance__label">${icon('scales')}<span>${tr('bal.none')}</span></div>
       <div class="balance__amount num">${fmt(0, state.display, { sym: false })}
         <span class="cur">${state.display}</span></div>`
    : settled
    ? `<div class="balance__label">${icon('scales')}<span>${tr('bal.clear')}</span></div>
       <div class="balance__amount num">${fmt(0, state.display, { sym: false })}
         <span class="cur">${state.display}</span></div>`
    : moves.length === 1
    ? `<div class="balance__label">${icon('hand-coins')}
         <span>${tr('bal.transferTo', esc(memberName(moves[0].from)), esc(memberName(moves[0].to)))}</span></div>
       <div class="balance__amount num">${fmt(moves[0].amount, state.display, { sym: false })}
         <span class="cur">${state.display}</span></div>
       <p class="balance__sub">${tr('bal.afterClear')}</p>`
    : `<div class="balance__label">${icon('hand-coins')}<span>${tr('bal.nMoves', moves.length)}</span></div>
       <div class="moves">
         ${moves.map((m) => `
           <div class="move">
             ${avatar(m.from, 'sm')}
             <span class="move__arrow">${icon('arrow-right')}</span>
             ${avatar(m.to, 'sm')}
             <span class="move__who">${esc(memberName(m.from))} → ${esc(memberName(m.to))}</span>
             <span class="move__amt num">${fmt(m.amount, state.display)}</span>
           </div>`).join('')}
       </div>`;

  const side = `
    <div class="ledger-grid__side">
      <section class="balance ${settled ? 'balance--settled' : ''}">
        ${head}
        <div class="balance__split">
          <div class="who who--head">
            <span class="who__name">${tr('bal.who')}</span>
            <span class="who__sum">${tr('bal.owes', state.display)}</span>
          </div>
          ${ms.map((m) => who(m, totals[m.id] || 0)).join('')}
        </div>
        ${settled ? '' : `
          <button class="btn btn--ghost btn--block" data-settle style="margin-top:16px">
            ${icon('arrow-u-down-left')}${tr('act.settle')}
          </button>`}
      </section>

      <div>
        <div class="seg" role="tablist" aria-label="${tr('bal.displayCur')}">
          ${DISPLAY.map((c) => `
            <button class="seg__btn" role="tab" data-cur="${c}"
              aria-selected="${state.display === c}">${c}</button>`).join('')}
        </div>
        <p class="rate-note">
          ${icon(rates.stale || rates.error ? 'warning-circle' : 'arrows-clockwise')}
          <span>${rates.stale || rates.error
            ? tr('rates.offline')
            : tr('rates.ecb', rates.date || tr('rates.today'))}</span>
          <button data-refresh-rates>${tr('act.update')}</button>
        </p>
      </div>
    </div>`;

  const tripBar = `
    <div class="chips" role="tablist" aria-label="${tr('trip.section')}">
      <button class="chip" role="tab" data-scope="all" aria-selected="${scope === 'all'}">${tr('trip.all')}</button>
      <button class="chip" role="tab" data-scope="daily" aria-selected="${scope === 'daily'}">
        ${icon('house-line')}${tr('trip.daily')}
      </button>
      ${liveTrips().map((t) => `
        <button class="chip" role="tab" data-scope="${t.id}" aria-selected="${scope === t.id}">
          ${icon('airplane-tilt')}${esc(t.name)}
        </button>`).join('')}
      <button class="chip chip--new" data-new-trip>${icon('plus')}${tr('trip.new')}</button>
    </div>`;

  const tripHead = trip ? `
    <div class="triphead">
      <div class="triphead__main">
        <h2>${esc(trip.name)}</h2>
        <p>${tripRange(trip) ? tripRange(trip) + ' · ' : ''}${tr('entries', list.filter((e) => e.type !== 'settle').length)}${
          trip.currency ? ' · ' + tr('trip.defaultCur', trip.currency) : ''}</p>
      </div>
      <button class="iconbtn" data-edit-trip="${trip.id}" aria-label="${tr('trip.edit')}">${icon('pencil-simple')}</button>
    </div>` : '';

  const emptyCopy = scope === 'all'
    ? { h: tr('ledger.empty'), p: tr('ledger.emptyHint') }
    : scope === 'daily'
    ? { h: tr('ledger.dailyEmpty'), p: tr('ledger.dailyEmptyHint') }
    : { h: tr('ledger.tripEmpty', trip ? trip.name : tr('ledger.thisTrip')), p: tr('ledger.tripEmptyHint') };

  const body = list.length === 0 ? `
    <div class="empty">
      ${icon('receipt')}
      <h3>${esc(emptyCopy.h)}</h3>
      <p>${esc(emptyCopy.p)}</p>
      <button class="btn btn--primary" data-add>${
        icon('plus') + tr('ledger.addFirst')}</button>
    </div>` : `
    <div class="sec">
      <h2>${tr('ledger.spend')}</h2>
      <span class="sec__aside">${tr('ledger.total', list.length)}</span>
    </div>
    ${groups.map(dayGroup).join('')}`;

  return tripBar + tripHead + `<div class="ledger-grid">${side}<div>${body}</div></div>`;
}

/* 头像颜色按成员在列表里的位置定，见 styles.css 的 --member-N */
const initial = (name) => (name || '?').trim().slice(0, 1).toUpperCase();

const avatar = (id, size = '') => {
  const i = Math.max(0, memberIndex(id)) % 8;
  return `<span class="avatar avatar--m${i}${size ? ' avatar--' + size : ''}">${
    esc(initial(memberName(id)))}</span>`;
};

const who = (m, sum) => `
  <div class="who">
    ${avatar(m.id, 'sm')}
    <span class="who__name">${esc(m.name)}</span>
    <span class="who__sum num">${fmt(sum, state.display, { sym: false })}</span>
  </div>`;

function dayGroup(g) {
  const daySum = g.items.reduce((s, e) =>
    e.type === 'settle' ? s : s + convert(e.amount, e.currency, state.display), 0);
  return `
    <section class="daygroup">
      <div class="daygroup__head">
        <span>${dayLabel(g.date)}</span>
        <span class="num">${fmt(daySum, state.display)}</span>
      </div>
      <div class="rows">${g.items.map(rowHTML).join('')}</div>
    </section>`;
}

/* 进场动画只跑首屏那一次；之后切币种、增删记录都不再重播 */
let animateRows = true;

function rowHTML(e, i = 0) {
  const delay = (animateRows && !reduceMotion())
    ? `class="row row--in" style="animation-delay:${Math.min(i * 35, 280)}ms"`
    : 'class="row"';
  const payer = memberName(e.payerId);
  const shown = convert(e.amount, e.currency, state.display);
  const orig = e.currency !== state.display ? `<div class="sub num">${fmt(e.amount, e.currency)}</div>` : '';

  const t = e.tripId ? tripOf(e.tripId) : null;
  const tripTag = (activeTrip === 'all' && t)
    ? `<i class="dot"></i><span class="row__trip">${icon('airplane-tilt')}${esc(t.name)}</span>` : '';

  if (e.type === 'settle') {
    const to = memberName(e.toId);
    return `
      <button ${delay} data-open="${e.id}">
        <div class="tile tile--accent">${icon('arrow-u-down-left')}</div>
        <div class="row__body">
          <div class="row__title">${tr('row.settleTitle', esc(payer), esc(to))}</div>
          <div class="row__meta"><span>${tr('row.notCounted')}</span>${tripTag}</div>
        </div>
        <div class="row__amt"><div class="big num">${fmt(shown, state.display)}</div>${orig}</div>
      </button>`;
  }

  const c = catOf(e.cat);
  const parts = e.participants || [];
  const all = liveMembers().length;
  const splitTxt =
    parts.length === 0 ? tr('split.none')
    : parts.length === 1 && parts[0] === e.payerId ? tr('split.self', esc(payer))
    : parts.length === 1 ? tr('split.onOne', esc(memberName(parts[0])))
    : parts.length >= all ? tr('split.evenN', parts.length)
    : tr('split.among', parts.map((id) => esc(memberName(id))).join(tr('listSep')));
  return `
    <button ${delay} data-open="${e.id}">
      <div class="tile">${icon(c.icon)}</div>
      <div class="row__body">
        <div class="row__title">${esc(e.merchant || tr('cat.' + c.id))}</div>
        <div class="row__meta">
          <span>${tr('row.paid', esc(payer))}</span><i class="dot"></i><span>${splitTxt}</span>${tripTag}
          ${e.note ? `<i class="dot"></i><span class="row__note">${esc(e.note)}</span>` : ''}
        </div>
      </div>
      <div class="row__amt"><div class="big num">${fmt(shown, state.display)}</div>${orig}</div>
    </button>`;
}

/* ---------- 统计 ---------- */
function viewStats() {
  const inMonth = liveExpenses().filter((e) => e.type !== 'settle' && e.date.startsWith(statsMonth));
  const total = inMonth.reduce((s, e) => s + convert(e.amount, e.currency, state.display), 0);
  const totals = personTotals(inMonth);

  const byCat = CATS.map((c) => ({
    ...c,
    sum: inMonth.filter((e) => e.cat === c.id)
      .reduce((s, e) => s + convert(e.amount, e.currency, state.display), 0),
  })).filter((c) => c.sum > 0).sort((x, y) => y.sum - x.sum);

  const max = byCat[0]?.sum || 1;
  const [y, m] = statsMonth.split('-').map(Number);
  const atCurrent = statsMonth >= todayISO().slice(0, 7);

  const head = `
    <div class="sec">
      <h2>${tr('stats.title')}</h2>
      <div class="monthnav">
        <button data-month="-1" aria-label="${tr('stats.prevMonth')}">${icon('caret-left')}</button>
        <span class="monthnav__label">${tr('stats.month', y, m)}</span>
        <button data-month="1" aria-label="${tr('stats.nextMonth')}" ${atCurrent ? 'disabled' : ''}>${icon('caret-right')}</button>
      </div>
    </div>`;

  if (!inMonth.length) return head + `
    <div class="empty">
      ${icon('chart-pie-slice')}
      <h3>${tr('stats.empty')}</h3>
      <p>${tr('stats.emptyHint')}</p>
    </div>
    ${tripsSection()}`;

  return head + `
    <section class="balance" style="margin-bottom:20px">
      <div class="balance__label">${icon('wallet')}<span>${tr('stats.monthSpend')}</span></div>
      <div class="balance__amount num">${fmt(total, state.display, { sym: false })}<span class="cur">${state.display}</span></div>
      <div class="balance__split">
        <div class="who who--head">
          <span class="who__name">${tr('bal.who')}</span>
          <span class="who__sum">${tr('bal.owes', state.display)}</span>
        </div>
        ${liveMembers().map((m) => who(m, totals[m.id] || 0)).join('')}
      </div>
    </section>

    <div class="sec"><h2>${tr('stats.cats')}</h2><span class="sec__aside">${tr('stats.nCats', byCat.length)}</span></div>
    <div class="statcard">
      ${byCat.map((c, i) => `
        <div class="catline">
          <div class="catline__top">
            ${icon(c.icon)}
            <span class="catline__name">${tr('cat.' + c.id)}</span>
            <span class="catline__pct num">${Math.round((c.sum / total) * 100)}%</span>
            <span class="catline__val num">${fmt(c.sum, state.display)}</span>
          </div>
          <div class="bar" style="width:${Math.max((c.sum / max) * 100, 2)}%;animation-delay:${i * 60}ms"></div>
        </div>`).join('')}
    </div>

    ${tripsSection()}`;
}

/* 「按项目」看的是每个项目的全部花费，不受上面的月份影响 */
function tripsSection() {
  if (!liveTrips().length) return `
    <div class="sec"><h2>${tr('trip.section')}</h2></div>
    <div class="empty">
      ${icon('airplane-tilt')}
      <h3>${tr('trip.none')}</h3>
      <p>${tr('trip.noneHint')}</p>
      <button class="btn btn--primary" data-new-trip>${icon('plus')}${tr('trip.newFull')}</button>
    </div>`;

  const sums = liveTrips().map((t) => tripSummary(t))
    .sort((x, y) => (y.trip.from || '').localeCompare(x.trip.from || ''));
  const max = Math.max(...sums.map((s) => s.total), 1);

  return `
    <div class="sec">
      <h2>${tr('trip.section')}</h2>
      <button class="btn btn--quiet" data-new-trip>${icon('plus')}${tr('act.new')}</button>
    </div>
    <div class="tripgrid">
      ${sums.map((s, i) => `
        <button class="tripcard" data-open-trip="${s.trip.id}">
          <div class="tripcard__top">
            <span class="tripcard__name">${icon('airplane-tilt')}${esc(s.trip.name)}</span>
            <span class="tripcard__meta">${tripRange(s.trip) || tr('trip.noDate')}${
              s.days ? ' · ' + tr('trip.days', s.days) : ''}</span>
          </div>
          <div class="tripcard__amt num">${fmt(s.total, state.display, { sym: false })}
            <span class="cur">${state.display}</span></div>
          <div class="bar" style="width:${Math.max((s.total / max) * 100, 2)}%;animation-delay:${i * 70}ms"></div>
          <div class="tripcard__foot">
            ${liveMembers().filter((m) => (s.totals[m.id] || 0) > 0.005).map((m) => `
              <span>${esc(m.name)} ${fmt(s.totals[m.id] || 0, state.display)}</span>`).join('')}
          </div>
          ${!s.settle.length ? '' : `
            <div class="tripcard__net">${s.settle.length === 1
              ? tr('trip.oneMove', esc(memberName(s.settle[0].from)), fmt(s.settle[0].amount, state.display))
              : tr('trip.nMoves', s.settle.length)}</div>`}
        </button>`).join('')}
    </div>`;
}


/* ==========================================================================
   支持页的插画

   风格参考 Noritake 那一路：均匀细线、圆头线帽、纯几何、不填色、大量留白。
   全是原创的形，不是任何人作品的临摹。线宽用 stroke-width 统一，缩放时
   靠 vector-effect 保持一致，所以同一段路径在 28px 和 160px 下都好看。
   ========================================================================== */
/* 线宽交给 CSS + vector-effect: non-scaling-stroke，
   所以同一段路径在 22px 和 220px 下都是同样纤细的一根线。 */
const LINE = 'fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"';

/** 一杯冒热气的咖啡。主插画 */
const artCoffee = (cls = 'art') => `
  <svg class="${cls}" viewBox="0 0 160 128" aria-hidden="true">
    <g ${LINE}>
      <path d="M42 50 H110"/>
      <path d="M46 50 L52 96 a9 9 0 0 0 9 8 h34 a9 9 0 0 0 9 -8 L106 50"/>
      <path d="M105 60 c16 -2 18 26 0 24"/>
      <path d="M32 114 H128"/>
      <path d="M68 40 c6 -6 -6 -10 0 -16 s-6 -10 0 -16"/>
      <path d="M89 37 c5 -5 -5 -9 0 -14 s-5 -9 0 -14"/>
    </g>
  </svg>`;

/** 对切的三明治 */
const artSandwich = (cls = 'art') => `
  <svg class="${cls}" viewBox="0 0 64 64" aria-hidden="true">
    <g ${LINE}>
      <path d="M9 50 L32 12 L55 50 z"/>
      <path d="M17 43 c5 -4 7 3 12 -1 s7 3 12 -1 s4 1 5 2"/>
    </g>
  </svg>`;

/** 一顿正经饭：碗和筷子 */
const artBowl = (cls = 'art') => `
  <svg class="${cls}" viewBox="0 0 64 64" aria-hidden="true">
    <g ${LINE}>
      <path d="M8 31 H50 a21 21 0 0 1 -42 0 z"/>
      <path d="M4 55 H60"/>
      <path d="M45 8 L34 27"/>
      <path d="M53 11 L41 28"/>
    </g>
  </svg>`;

/** 挥手的小人。页脚的句号 */
const artWave = (cls = 'art') => `
  <svg class="${cls}" viewBox="0 0 64 76" aria-hidden="true">
    <g ${LINE}>
      <circle cx="30" cy="20" r="14"/>
      <path d="M30 34 v20"/>
      <path d="M30 41 L17 51"/>
      <path d="M30 39 L47 26"/>
      <path d="M30 54 L21 70"/>
      <path d="M30 54 L39 70"/>
      <path d="M47 26 l-3 -5 M47 26 l5 -2"/>
    </g>
    <g fill="currentColor" stroke="none">
      <circle cx="25" cy="19" r="1.9"/>
      <circle cx="35" cy="19" r="1.9"/>
    </g>
  </svg>`;

const TIERS = [
  { id: 'coffee',   art: artCoffee },
  { id: 'sandwich', art: artSandwich },
  { id: 'meal',     art: artBowl },
];

/* ---------- 支持页 ---------- */
function viewSupport() {
  return `
    <div class="sec" style="margin-top:8px">
      <button class="btn btn--quiet" data-go="settings" style="margin-left:-14px">
        ${icon('caret-left')}${tr('nav.settings')}
      </button>
    </div>

    <section class="support">
      ${artCoffee('art art--hero')}
      <h2 class="support__title">${tr('sup.title')}</h2>
      <p class="support__lead">
        ${tr('sup.body')}
      </p>
    </section>

    <div class="tiers">
      ${TIERS.map((tier) => `
        <a class="tier" href="${esc(SUPPORT_URL)}" target="_blank" rel="noopener noreferrer">
          ${tier.art('art art--tier')}
          <span class="tier__body">
            <span class="tier__label">${tr('sup.' + tier.id)}</span>
            <span class="tier__note">${tr('sup.' + tier.id + 'Note')}</span>
          </span>
          ${icon('arrow-right', 'icon tier__go')}
        </a>`).join('')}
    </div>

    <div class="support__foot">
      ${artWave('art art--wave')}
      <p>${tr('sup.foot')}</p>
    </div>`;
}

/* ---------- 设置 ---------- */
function viewSettings() {
  return `
    <div class="sec"><h2>${tr('set.title')}</h2></div>

    <div class="card">
      ${liveMembers().map((m, i) => `
        <div class="listrow">
          ${avatar(m.id, 'sm')}
          <input class="nameinput" data-name="${m.id}" value="${esc(m.name)}"
                 maxlength="12" aria-label="${tr('set.memberName', i + 1)}">
          ${liveMembers().length > 2
            ? `<button class="iconbtn" data-rm-member="${m.id}" aria-label="${tr('set.removeMember', esc(m.name))}">${icon('x')}</button>`
            : ''}
        </div>`).join('')}
      ${liveMembers().length < MAX_MEMBERS ? `
        <button class="listrow" data-add-member>
          ${icon('user-plus')}
          <span class="listrow__label">${tr('set.addPerson')}</span>
        </button>` : ''}
    </div>

    ${lookPanel()}

    <div class="sec">
      <h2>${tr('trip.section')}</h2>
      <button class="btn btn--quiet" data-new-trip>${icon('plus')}${tr('act.new')}</button>
    </div>
    ${liveTrips().length ? `
      <div class="card">
        ${liveTrips().map((t) => `
          <button class="listrow" data-edit-trip="${t.id}">
            ${icon('airplane-tilt')}
            <span class="listrow__label">${esc(t.name)}</span>
            <span class="listrow__value">${tr('entries',
              liveExpenses().filter((e) => e.tripId === t.id && e.type !== 'settle').length)}</span>
            ${icon('caret-right')}
          </button>`).join('')}
      </div>` : `
      <p class="footnote" style="padding-top:0">${tr('trip.beforeTrip')}</p>`}

    <div class="sec"><h2>${tr('set.currency')}</h2></div>
    <div class="seg" role="tablist" aria-label="${tr('set.defaultCur')}">
      ${DISPLAY.map((c) => `
        <button class="seg__btn" role="tab" data-cur="${c}" aria-selected="${state.display === c}">
          ${c} · ${tr('cur.' + c)}
        </button>`).join('')}
    </div>
    <p class="footnote">${tr('set.thisDeviceOnly')}</p>

    ${SYNC_AVAILABLE ? syncPanel() : ''}

    ${SUPPORT_URL ? `
      <div class="card" style="margin-top:26px">
        <button class="listrow" data-go="support">
          ${artCoffee('art art--row')}
          <span class="listrow__label">${tr('set.support')}</span>
          ${icon('caret-right')}
        </button>
      </div>` : ''}

    <div class="sec"><h2>${tr('set.data')}</h2></div>
    <div class="card">
      <button class="listrow" data-refresh-rates>
        ${icon('arrows-clockwise')}
        <span class="listrow__label">${tr('set.refreshRates')}</span>
        <span class="listrow__value num">${rates.date || tr('set.offline')}</span>
      </button>
      <button class="listrow" data-export>
        ${icon('note-pencil')}
        <span class="listrow__label">${tr('set.export')}</span>
        <span class="listrow__value">${tr('entries', liveExpenses().length)}</span>
      </button>
      <button class="listrow" data-import>
        ${icon('arrows-clockwise')}
        <span class="listrow__label">${tr('set.import')}</span>
      </button>
      <button class="listrow" data-clear>
        ${icon('trash')}
        <span class="listrow__label">${tr('set.clear')}</span>
      </button>
    </div>
    <p class="footnote">
      ${tr('set.storedLocally')}
    </p>`;
}


/* ---------- 同步面板 ---------- */
function syncPanel() {
  if (!isSynced()) return `
    <div class="sec"><h2>${tr('sync.title')}</h2></div>
    <div class="card">
      <button class="listrow" data-sync-create>
        ${icon('users')}
        <span class="listrow__label">${tr('sync.createLedger')}</span>
        ${icon('caret-right')}
      </button>
      <button class="listrow" data-sync-join>
        ${icon('user-plus')}
        <span class="listrow__label">${tr('sync.joinLedger')}</span>
        ${icon('caret-right')}
      </button>
    </div>
    <p class="footnote">
      ${tr('sync.localHint')}
    </p>`;

  return `
    <div class="sec"><h2>${tr('sync.title')}</h2></div>
    <div class="card">
      <div class="listrow">
        <span class="syncdot" data-sync-badge data-state="${syncStatus}"><i></i><span>${syncLabel()}</span></span>
      </div>
      <div class="listrow codeRow">
        <div style="flex:1;min-width:0">
          <div class="label" style="margin-bottom:5px">${tr('sync.code')}</div>
          <div class="codeval num">${esc(syncState.code)}</div>
        </div>
        <button class="btn btn--ghost" data-copy-code style="height:38px;padding:0 16px">
          ${icon('check')}${tr('act.copy')}
        </button>
      </div>
      <button class="listrow" data-sync-now>
        ${icon('arrows-clockwise')}
        <span class="listrow__label">${tr('sync.title')}</span>
        <span class="listrow__value" data-sync-status>${syncLabel()}</span>
      </button>
      <button class="listrow" data-sync-off>
        ${icon('x')}
        <span class="listrow__label">${tr('sync.disconnect')}</span>
      </button>
    </div>
    <p class="footnote">
      ${tr('sync.keyWarning')}
    </p>`;
}

/* ---------- 创建 / 加入 ---------- */
function openSyncCreate() {
  const n = liveExpenses().length;
  openSheet({
    title: tr('sync.createTitle'),
    body: `
      <div class="alert">${icon('users')}
        <span>${tr('sync.createIntro')}</span></div>
      <p style="font-size:14px;color:var(--ink-2);line-height:1.65;margin-top:16px">
        ${tr('sync.createUpload', n, liveTrips().length)}
      </p>
      <p class="hint" style="margin-top:10px">
        ${tr('sync.createWarn')}
      </p>`,
    foot: `<button class="btn btn--ghost" data-close>${tr('act.cancel')}</button>
           <button class="btn btn--primary" data-ok>${icon('check')}${tr('act.create')}</button>`,
    onMount: (host) => {
      host.querySelector('[data-ok]').onclick = async (ev) => {
        const b = ev.currentTarget;
        b.disabled = true; b.textContent = tr('sync.creating');
        try {
          const code = await createLedger();
          closeSheetNow(); render();
          openSyncCode(code);
        } catch (err) {
          b.disabled = false; b.innerHTML = tr('act.create');
          toast(tr('sync.createFailed', err.message), 'warning-circle');
        }
      };
    },
  });
}

function openSyncCode(code) {
  openSheet({
    title: tr('sync.createdTitle'),
    body: `
      <p style="font-size:14px;color:var(--ink-2);line-height:1.65">
        ${tr('sync.createdHint')}
      </p>
      <div class="codebig num">${esc(code)}</div>
      <button class="btn btn--ghost btn--block" data-copy-code>${icon('check')}${tr('sync.copyCode')}</button>
      <p class="hint" style="margin-top:14px">
        ${tr('sync.foundInSettings')}
      </p>`,
    foot: `<button class="btn btn--primary" data-close>${tr('act.ok')}</button>`,
    onMount: (host) => {
      host.querySelector('[data-copy-code]').onclick = () => copyCode(code);
    },
  });
}

function openSyncJoin() {
  const n = liveExpenses().length;
  openSheet({
    title: tr('sync.joinTitle'),
    body: `
      <div class="field">
        <label class="label" for="jn-code">${tr('sync.code')}</label>
        <input class="input num" id="jn-code" placeholder="${tr('sync.codePlaceholder')}"
               autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="20">
        <p class="err" id="jn-err" hidden></p>
      </div>
      ${n ? `
        <div class="alert" style="margin-top:16px">${icon('warning-circle')}
          <span>${tr('sync.joinWarn', n)}</span>
        </div>` : ''}`,
    foot: `<button class="btn btn--ghost" data-close>${tr('act.cancel')}</button>
           <button class="btn btn--primary" data-ok>${icon('check')}${tr('act.join')}</button>`,
    onMount: (host) => {
      const input = host.querySelector('#jn-code');
      const err = host.querySelector('#jn-err');
      const go = async (ev) => {
        const b = host.querySelector('[data-ok]');
        const v = input.value.trim();
        if (v.length < 6) { err.textContent = tr('sync.codeShort'); err.hidden = false; return; }
        err.hidden = true; b.disabled = true;
        try {
          await joinLedger(v);
          closeSheetNow(); render(); startSyncLoop();
          toast(tr('sync.joined'), 'check');
        } catch (e2) {
          b.disabled = false;
          err.textContent = e2.pgcode === 'P0002' ? tr('sync.codeBad') : tr('sync.joinFailed', e2.message);
          err.hidden = false;
          input.focus();
        }
      };
      host.querySelector('[data-ok]').onclick = go;
      input.onkeydown = (ev) => { if (ev.key === 'Enter') go(ev); };
      setTimeout(() => input.focus(), 60);
    },
  });
}

async function copyCode(code) {
  try {
    await navigator.clipboard.writeText(code);
    toast(tr('sync.copied'), 'check');
  } catch {
    toast(tr('sync.copyFailed'), 'warning-circle');
  }
}


/* ==========================================================================
   外观：配色 + 明暗
   都是本机设置，不跟着账本同步 —— 你在香港想要青瓷，对方想要墨色，各挑各的。
   ========================================================================== */
const PALETTES = [
  { id: 'cobalt', swatch: ['#2F53D6', '#EEF0ED', '#14171A'], themeColor: { light: '#EEF0ED', dark: '#0D0F11' } },
  { id: 'celadon', swatch: ['#2E7D6A', '#EDF1EE', '#131A17'], themeColor: { light: '#EDF1EE', dark: '#0B100E' } },
  { id: 'indigo', swatch: ['#5B52A3', '#EFEEF3', '#17161F'], themeColor: { light: '#EFEEF3', dark: '#0E0D13' } },
  { id: 'mist', swatch: ['#4A6070', '#EEEFF0', '#15181B'], themeColor: { light: '#EEEFF0', dark: '#0D0F10' } }
];
const MODES = [
  { id: 'auto' },
  { id: 'light' },
  { id: 'dark' },
];
const LOOK_KEY = 'wetab.look.v1';

let look = loadLook();

function loadLook() {
  try {
    const o = JSON.parse(localStorage.getItem(LOOK_KEY)) || {};
    return {
      palette: PALETTES.some((p) => p.id === o.palette) ? o.palette : 'cobalt',
      mode: MODES.some((m) => m.id === o.mode) ? o.mode : 'auto',
    };
  } catch { return { palette: 'cobalt', mode: 'auto' }; }
}

function applyLook() {
  const root = document.documentElement;
  root.dataset.palette = look.palette;
  if (look.mode === 'auto') delete root.dataset.theme;
  else root.dataset.theme = look.mode;

  /* 手机上状态栏 / 地址栏的颜色跟着走 */
  const p = PALETTES.find((x) => x.id === look.palette);
  const dark = look.mode === 'dark'
    || (look.mode === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.remove());
  const meta = document.createElement('meta');
  meta.name = 'theme-color';
  meta.content = dark ? p.themeColor.dark : p.themeColor.light;
  document.head.appendChild(meta);
}

function setLook(patch) {
  Object.assign(look, patch);
  localStorage.setItem(LOOK_KEY, JSON.stringify(look));
  applyLook();
  render();
}

/* ---------- 设置页的外观面板 ----------
   语言并在这里：和配色、明暗一样，都是只影响这台设备的显示偏好。 */
function lookPanel() {
  return `
    <div class="sec"><h2>${tr('set.appearance')}</h2></div>
    <div class="seg" role="tablist" aria-label="${tr('set.language')}">
      ${LANGS.map((l) => `
        <button class="seg__btn" role="tab" data-lang="${l.id}"
          aria-selected="${getLang() === l.id}">${l.label}</button>`).join('')}
    </div>
    <div class="swatches" role="radiogroup" aria-label="${tr('set.palette')}" style="margin-top:10px">
      ${PALETTES.map((p) => `
        <button class="swatch" role="radio" data-palette="${p.id}"
                aria-checked="${look.palette === p.id}">
          <span class="swatch__chip">
            ${p.swatch.map((c) => `<i style="background:${c}"></i>`).join('')}
          </span>
          <span class="swatch__name">${tr('pal.' + p.id)}</span>
        </button>`).join('')}
    </div>

    <div class="seg" role="tablist" aria-label="${tr('set.mode')}">
      ${MODES.map((m) => `
        <button class="seg__btn" role="tab" data-mode="${m.id}"
          aria-selected="${look.mode === m.id}">${tr('mode.' + m.id)}</button>`).join('')}
    </div>
    <p class="footnote">${tr('set.thisDeviceOnly')}</p>`;
}


/* ==========================================================================
   首次打开的引导
   分享给别人时，第一屏不该是别人的名字和别人的旅行。这里让人当场
   把两个名字改成自己的，示例数据改成可选。
   ========================================================================== */
function openOnboarding() {
  let names = state.members.map((m) => m.name);
  let withDemo = false;

  const fill = (host) => {
    host.querySelector('#ob-a').value = names[0];
    host.querySelector('#ob-b').value = names[1];
  };

  openSheet({
    title: tr('ob.title'),
    dismissible: false,
    body: `
      <p style="font-size:14px;color:var(--ink-2);line-height:1.65">
        ${tr('ob.intro')}
      </p>

      <div class="namepair">
        <div class="field">
          <label class="label" for="ob-a">${tr('ob.you')}</label>
          <input class="input" id="ob-a" maxlength="12" autocomplete="off" spellcheck="false">
        </div>
        <div class="field">
          <label class="label" for="ob-b">${tr('ob.other')}</label>
          <input class="input" id="ob-b" maxlength="12" autocomplete="off" spellcheck="false">
        </div>
        <button class="iconbtn namepair__roll" id="ob-roll" title="${tr('ob.reroll')}" aria-label="${tr('ob.reroll')}">
          ${icon('arrows-clockwise')}
        </button>
      </div>
      <p class="err" id="ob-err" hidden></p>

      <div class="field" style="margin-top:24px">
        <span class="label">${tr('ob.startFrom')}</span>
        <div class="pick" id="ob-demo">
          <button type="button" class="pickbtn" data-demo="0" aria-pressed="true">${tr('ob.blank')}</button>
          <button type="button" class="pickbtn" data-demo="1" aria-pressed="false">${tr('ob.demo')}</button>
        </div>
      </div>

      <p class="footnote" style="padding-top:20px">
        ${tr('ob.haveCode')}<button id="ob-join" style="color:var(--accent);text-decoration:underline;text-underline-offset:2px">${tr('act.join')}</button>
      </p>`,
    foot: `<button class="btn btn--primary btn--block" data-ok>${icon('check')}${tr('act.start')}</button>`,
    onMount: (host) => {
      const q = (sel) => host.querySelector(sel);
      fill(host);

      q('#ob-roll').onclick = () => {
        names = pickNames();
        fill(host);
      };

      host.querySelectorAll('#ob-demo [data-demo]').forEach((b) => b.onclick = () => {
        withDemo = b.dataset.demo === '1';
        host.querySelectorAll('#ob-demo [data-demo]').forEach((x) =>
          x.setAttribute('aria-pressed', String(x === b)));
      });

      q('#ob-join').onclick = () => { closeSheetNow(); openSyncJoin(); };

      q('[data-ok]').onclick = () => {
        const a = q('#ob-a').value.trim();
        const b = q('#ob-b').value.trim();
        const err = q('#ob-err');
        if (!a || !b) {
          err.textContent = tr('ob.nameErr'); err.hidden = false; return;
        }
        if (a === b) {
          err.textContent = tr('ob.sameErr');
          err.hidden = false; return;
        }
        state.members = [{ id: 'a', name: a }, { id: 'b', name: b }];
        if (withDemo) {
          state.trips = seedTrips();
          state.expenses = seed();
          const ids = state.members.map((x) => x.id);
          state.expenses.forEach((e) => migrateSplit(e, ids));   // 兜底
        }
        state.onboarded = true;
        animateRows = true;
        save(); closeSheetNow(); render();
      };
    },
  });
}

/* ==========================================================================
   事件绑定
   ========================================================================== */
function wireView() {
  document.querySelectorAll('[data-go]').forEach((el) =>
    el.onclick = () => go(el.dataset.go));
  document.querySelectorAll('[data-add]').forEach((el) =>
    el.onclick = () => openAdd());
  document.querySelectorAll('[data-cur]').forEach((el) =>
    el.onclick = () => setState({ display: el.dataset.cur }));
  document.querySelectorAll('[data-refresh-rates]').forEach((el) =>
    el.onclick = async () => {
      el.disabled = true;
      await loadRates({ force: true });
      render();
      toast(rates.error ? tr('rates.stillOffline') : tr('rates.updated'),
            rates.error ? 'warning-circle' : 'check');
    });
  document.querySelectorAll('[data-open]').forEach((el) =>
    el.onclick = () => openAdd(state.expenses.find((e) => e.id === el.dataset.open)));
  document.querySelectorAll('[data-month]').forEach((el) =>
    el.onclick = () => {
      const [y, m] = statsMonth.split('-').map(Number);
      const d = new Date(y, m - 1 + Number(el.dataset.month), 1);
      statsMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      render();
    });
  document.querySelectorAll('[data-name]').forEach((el) =>
    el.onchange = () => {
      const m = state.members.find((x) => x.id === el.dataset.name);
      m.name = el.value.trim() || m.name;
      touchMeta(); save(); render(); queueSync();
    });

  const on = (sel, fn) => document.querySelectorAll(sel).forEach((el) => el.onclick = () => fn(el));
  on('[data-palette]', (el) => setLook({ palette: el.dataset.palette }));
  on('[data-mode]', (el) => setLook({ mode: el.dataset.mode }));
  on('[data-lang]', (el) => { setLang(el.dataset.lang); render(); });
  on('[data-sync-create]', openSyncCreate);
  on('[data-sync-join]', openSyncJoin);
  on('[data-sync-now]', () => syncNow({ manual: true }));
  on('[data-copy-code]', () => copyCode(syncState.code));
  on('[data-sync-off]', () => confirmSheet({
    title: tr('sync.disconnectTitle'),
    body: tr('sync.disconnectBody'),
    danger: tr('sync.disconnect'),
    onOk: () => { disconnectSync(); toast(tr('sync.disconnected'), 'check'); },
  }));

  document.querySelectorAll('[data-scope]').forEach((el) =>
    el.onclick = () => { activeTrip = el.dataset.scope; animateRows = true; render(); });
  document.querySelectorAll('[data-new-trip]').forEach((el) =>
    el.onclick = () => openTrip());
  document.querySelectorAll('[data-edit-trip]').forEach((el) =>
    el.onclick = () => openTrip(tripOf(el.dataset.editTrip)));
  document.querySelectorAll('[data-open-trip]').forEach((el) =>
    el.onclick = () => { activeTrip = el.dataset.openTrip; animateRows = true; go('ledger'); });

  document.querySelectorAll('[data-add-member]').forEach((el) => el.onclick = () => {
    const used = new Set(state.members.map((m) => m.id));
    let id = 'a';
    for (let i = 0; i < 26 && used.has(id); i++) id = String.fromCharCode(97 + i + 1);
    if (used.has(id)) id = uid();
    const taken = new Set(liveMembers().map((m) => m.name));
    const name = NAME_POOL().find((n) => !taken.has(n)) || tr('set.newMember');
    state.members.push({ id, name });
    touchMeta(); save(); render(); queueSync();
    // 直接聚焦新名字，方便立刻改
    const input = document.querySelector(`[data-name="${id}"]`);
    if (input) { input.focus(); input.select(); }
  });

  document.querySelectorAll('[data-rm-member]').forEach((el) => el.onclick = () => {
    const id = el.dataset.rmMember;
    const m = state.members.find((x) => x.id === id);
    const n = liveExpenses().filter((e) =>
      e.payerId === id || e.toId === id || (e.participants || []).includes(id)).length;
    confirmSheet({
      title: tr('set.rmTitle', m.name),
      body: n
        ? tr('set.rmBody', m.name, n)
        : tr('set.rmEmpty', m.name),
      danger: tr('set.rmOk'),
      onOk: () => {
        m.removed = true;
        touchMeta(); save(); render(); queueSync();
        toast(tr('set.removed', m.name), 'check');
      },
    });
  });

  const settle = $('[data-settle]');
  if (settle) settle.onclick = openSettle;

  const exp = $('[data-export]');
  if (exp) exp.onclick = () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `wetab-${todayISO()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  const imp = $('[data-import]');
  if (imp) imp.onclick = () => {
    const f = document.createElement('input');
    f.type = 'file';
    f.accept = 'application/json,.json';
    f.onchange = async () => {
      const file = f.files && f.files[0];
      if (!file) return;
      let plan, data;
      try {
        data = readBackup(await file.text());
        plan = planImport(data);
      } catch (e) {
        toast(e.message, 'warning-circle');
        return;
      }
      if (!plan.add && !plan.update && !plan.trips && !plan.members) {
        toast(tr('imp.nothingNew'), 'check');
        return;
      }
      const bits = [];
      if (plan.add) bits.push(tr('imp.add', plan.add));
      if (plan.update) bits.push(tr('imp.update', plan.update));
      if (plan.trips) bits.push(tr('imp.trips', plan.trips));
      if (plan.members) bits.push(tr('imp.members', plan.members));
      if (plan.keep) bits.push(tr('imp.keep', plan.keep));
      confirmSheet({
        title: tr('imp.title'),
        body: tr('imp.body', bits.join(tr('imp.sep'))),
        danger: tr('imp.ok'),
        onOk: () => {
          applyImport(data, plan);
          toast(tr('imp.done', tr('entries', plan.add + plan.update)), 'check');
        },
      });
    };
    f.click();
  };

  const clr = $('[data-clear]');
  if (clr) clr.onclick = () => confirmSheet({
    title: tr('clear.title'),
    body: tr('clear.body', liveExpenses().length),
    danger: tr('clear.ok'),
    onOk: () => {
      state.expenses.forEach((e) => { if (!e.deleted) { e.deleted = true; touch(e); } });
      state.seeded = false;
      save(); render(); queueSync(); toast(tr('clear.done'), 'check');
    },
  });
}

/* ==========================================================================
   Toast
   ========================================================================== */
let toastTimer;
function toast(msg, ic = 'check') {
  clearTimeout(toastTimer);
  $('#toast-host').innerHTML = `<div class="toast">${icon(ic)}<span>${esc(msg)}</span></div>`;
  toastTimer = setTimeout(() => ($('#toast-host').innerHTML = ''), 2600);
}

/* ==========================================================================
   Sheet 基础设施
   ========================================================================== */
let closeSheet = null;
let lockedAt = 0;

/* iOS 上 overflow:hidden 拦不住背景滚动，得把 body 定住再还原位置 */
function lockScroll() {
  lockedAt = window.scrollY || 0;
  document.body.style.top = `-${lockedAt}px`;
  document.body.classList.add('is-locked');
}
function unlockScroll() {
  document.body.classList.remove('is-locked');
  document.body.style.top = '';
  window.scrollTo(0, lockedAt);
}

function openSheet({ title, body, foot, onMount, dismissible = true }) {
  closeSheetNow();
  const host = $('#overlay');
  host.innerHTML = `
    <div class="scrim" ${dismissible ? 'data-close' : ''}></div>
    <div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="sheet__head">
        <span class="sheet__title">${esc(title)}</span>
        ${dismissible ? `<button class="iconbtn" data-close aria-label="${tr('act.close')}">${icon('x')}</button>` : ''}
      </div>
      <div class="sheet__body">${body}</div>
      ${foot ? `<div class="sheet__foot">${foot}</div>` : ''}
    </div>`;
  lockScroll();
  host.querySelectorAll('[data-close]').forEach((el) => el.onclick = closeSheetNow);

  const onKey = (ev) => { if (ev.key === 'Escape' && dismissible) closeSheetNow(); };
  document.addEventListener('keydown', onKey);
  closeSheet = () => {
    document.removeEventListener('keydown', onKey);
    host.innerHTML = '';
    unlockScroll();
    closeSheet = null;
  };
  onMount?.(host);
  host.querySelector('input, select, button:not([data-close])')?.focus?.();
}
function closeSheetNow() { closeSheet?.(); }

function confirmSheet({ title, body, danger, onOk }) {
  openSheet({
    title,
    body: `<p style="font-size:14px;color:var(--ink-2);line-height:1.6">${esc(body)}</p>`,
    foot: `<button class="btn btn--ghost" data-close>${tr('act.cancel')}</button>
           <button class="btn btn--primary" data-ok>${esc(danger)}</button>`,
    onMount: (host) => {
      host.querySelector('[data-ok]').onclick = () => { closeSheetNow(); onOk(); };
    },
  });
}

/* ==========================================================================
   结清
   ========================================================================== */
function openSettle() {
  const scoped = scopedExpenses();
  const moves = settlements(balances(scoped));
  const trip = tripOf(activeTrip);
  if (!moves.length) { toast(tr('settle.already'), 'check'); return; }

  let pick = 0;                                   // 选中第几笔建议
  const cur0 = state.display;

  const row = (m, i) => `
    <button type="button" class="movepick" data-move="${i}" aria-pressed="${i === 0}">
      ${avatar(m.from, 'sm')}
      <span class="move__arrow">${icon('arrow-right')}</span>
      ${avatar(m.to, 'sm')}
      <span class="movepick__who">${esc(memberName(m.from))} → ${esc(memberName(m.to))}</span>
      <span class="movepick__amt num">${fmt(m.amount, cur0)}</span>
    </button>`;

  openSheet({
    title: tr('settle.title'),
    body: `
      <div class="alert">${icon('scales')}
        <span>${tr('settle.intro', trip ? esc(trip.name) : '')}</span></div>

      ${moves.length > 1 ? `
        <div class="field" style="margin-top:18px">
          <span class="label">${tr('settle.whichOne')}</span>
          <div class="movelist">${moves.map(row).join('')}</div>
        </div>` : ''}

      <div class="field" style="margin-top:18px">
        <label class="label" for="st-amt" id="st-label">
          ${tr('bal.transferTo', esc(memberName(moves[0].from)), esc(memberName(moves[0].to)))}
        </label>
        <div class="amountbox">
          <input id="st-amt" class="num" type="text" inputmode="decimal"
                 value="${moves[0].amount.toFixed(CURRENCIES[cur0].dec)}">
          <select id="st-cur">${DISPLAY.map((c) =>
            `<option value="${c}" ${c === cur0 ? 'selected' : ''}>${c}</option>`).join('')}</select>
        </div>
      </div>`,
    foot: `<button class="btn btn--ghost" data-close>${tr('act.cancel')}</button>
           <button class="btn btn--primary" data-ok>${icon('check')}${tr('act.confirm')}</button>`,
    onMount: (host) => {
      const q = (sel) => host.querySelector(sel);

      host.querySelectorAll('[data-move]').forEach((b) => b.onclick = () => {
        pick = Number(b.dataset.move);
        host.querySelectorAll('[data-move]').forEach((x) =>
          x.setAttribute('aria-pressed', String(x === b)));
        const m = moves[pick];
        q('#st-label').textContent = tr('bal.transferTo', memberName(m.from), memberName(m.to));
        q('#st-amt').value = m.amount.toFixed(CURRENCIES[q('#st-cur').value].dec);
      });

      q('[data-ok]').onclick = () => {
        const v = parseFloat(q('#st-amt').value);
        if (!(v > 0)) { toast(tr('settle.amountErr'), 'warning-circle'); return; }
        const m = moves[pick];
        state.expenses.push(touch({
          id: uid(), type: 'settle', payerId: m.from, toId: m.to, amount: v,
          currency: q('#st-cur').value, cat: 'shop', merchant: '', note: '',
          date: todayISO(), participants: [], tripId: trip ? trip.id : null,
          createdAt: Date.now(),
        }));
        save(); closeSheetNow(); render(); queueSync();
        toast(tr('settle.done'), 'check');
      };
    },
  });
}

/* ==========================================================================
   项目：新建 / 编辑
   ========================================================================== */
function openTrip(existing) {
  const editing = !!existing;
  const t = editing ? { ...existing }
    : { id: uid(), name: '', from: todayISO(), to: todayISO(), currency: '' };

  openSheet({
    title: editing ? tr('trip.edit') : tr('trip.newFull'),
    body: `
      <div class="alert">${icon('airplane-tilt')}
        <span>${tr('trip.intro')}</span></div>

      <div class="field" style="margin-top:18px">
        <label class="label" for="tp-name">${tr('trip.nameLabel')}</label>
        <input class="input" id="tp-name" placeholder="${tr('trip.namePlaceholder')}"
               value="${esc(t.name)}" maxlength="16" autocomplete="off">
        <p class="err" id="tp-name-err" hidden>${tr('trip.nameErr')}</p>
      </div>

      <div class="fieldrow">
        <div class="field">
          <label class="label" for="tp-from">${tr('trip.from')}</label>
          <input class="input" id="tp-from" type="date" value="${t.from || ''}">
        </div>
        <div class="field">
          <label class="label" for="tp-to">${tr('trip.to')}</label>
          <input class="input" id="tp-to" type="date" value="${t.to || ''}">
        </div>
      </div>
      <p class="hint" style="margin:7px 0 16px">${tr('trip.dateHint')}</p>

      <div class="field">
        <label class="label" for="tp-cur">${tr('trip.curLabel')}</label>
        <div class="selectwrap">
          <select class="select" id="tp-cur">
            <option value="">${tr('trip.curNone')}</option>
            ${Object.keys(CURRENCIES).map((c) => `
              <option value="${c}" ${t.currency === c ? 'selected' : ''}>
                ${c} · ${tr('cur.' + c)}
              </option>`).join('')}
          </select>
          ${icon('caret-down')}
        </div>
        <p class="hint">${tr('trip.curHint')}</p>
      </div>`,
    foot: `
      ${editing ? `<button class="btn btn--ghost" data-del-trip aria-label="${tr('trip.delOk')}">${icon('trash')}</button>` : ''}
      <button class="btn btn--primary" data-ok>${icon('check')}${editing ? tr('act.save') : tr('act.create')}</button>`,
    onMount: (host) => {
      const q = (sel) => host.querySelector(sel);

      q('[data-ok]').onclick = () => {
        const name = q('#tp-name').value.trim();
        q('#tp-name-err').hidden = !!name;
        q('#tp-name').setAttribute('aria-invalid', String(!name));
        if (!name) { q('#tp-name').focus(); return; }

        let from = q('#tp-from').value, to = q('#tp-to').value;
        if (from && to && from > to) [from, to] = [to, from];   // 填反了就换过来

        const rec = touch({ id: t.id, name, from, to, currency: q('#tp-cur').value });
        if (editing) {
          state.trips[state.trips.findIndex((x) => x.id === t.id)] = rec;
        } else {
          state.trips.push(rec);
          activeTrip = rec.id;
        }
        save(); closeSheetNow(); render(); queueSync();
        toast(editing ? tr('trip.updated') : tr('trip.created', name), 'check');
      };

      const del = q('[data-del-trip]');
      if (del) del.onclick = () => {
        const n = liveExpenses().filter((e) => e.tripId === t.id).length;
        confirmSheet({
          title: tr('trip.delTitle', t.name),
          body: n
            ? tr('trip.delBody', n)
            : tr('trip.delEmpty'),
          danger: tr('trip.delOk'),
          onOk: () => {
            state.expenses.forEach((e) => {
              if (e.tripId === t.id) { e.tripId = null; touch(e); }
            });
            const rec = state.trips.find((x) => x.id === t.id);
            if (rec) { rec.deleted = true; touch(rec); }
            if (activeTrip === t.id) activeTrip = 'all';
            save(); render(); queueSync(); toast(tr('trip.deleted'), 'check');
          },
        });
      };
    },
  });
}

/* ==========================================================================
   记一笔 / 编辑
   ========================================================================== */
function openAdd(existing) {
  const editing = !!existing && existing.type !== 'settle';
  const guessed = guessTrip(todayISO());
  const guessedTrip = tripOf(guessed);
  const draft = editing ? { tripId: null, ...existing } : {
    id: uid(), type: 'expense', payerId: liveMembers()[0].id, amount: '',
    currency: (guessedTrip && guessedTrip.currency) || state.display,
    cat: '', merchant: '', note: '', date: todayISO(),
    participants: liveMembers().map((m) => m.id),
    tripId: guessed, createdAt: Date.now(),
  };

  if (existing && existing.type === 'settle') return openSettleDetail(existing);

  const curOptions = Object.keys(CURRENCIES).map((c) =>
    `<option value="${c}">${c}</option>`).join('');

  openSheet({
    title: editing ? tr('add.editTitle') : tr('add.title'),
    body: `

      <form id="f" novalidate>
        <div class="field">
          <label class="label" for="f-amt">${tr('add.amount')}</label>
          <div class="amountbox">
            <input id="f-amt" class="num" type="text" inputmode="decimal" placeholder="0.00"
                   value="${draft.amount || ''}" aria-describedby="f-conv">
            <select id="f-cur" aria-label="${tr('set.currency')}">${curOptions}</select>
          </div>
          <div class="converted" id="f-conv"></div>
          <p class="err" id="f-amt-err" hidden>${tr('add.amountErr')}</p>
        </div>

        <div class="field">
          <label class="label" for="f-merchant">${tr('add.merchant')}</label>
          <input class="input" id="f-merchant" placeholder="${tr('add.merchantPlaceholder')}"
                 value="${esc(draft.merchant)}" maxlength="40">
        </div>

        <div class="field">
          <span class="label">${tr('add.cat')}</span>
          <div class="catgrid" id="f-cats">
            ${CATS.map((c) => `
              <button type="button" class="catbtn" data-cat="${c.id}"
                      aria-pressed="${draft.cat === c.id}">
                ${icon(c.icon)}<span>${tr('cat.' + c.id)}</span>
              </button>`).join('')}
          </div>
          <p class="err" id="f-cat-err" hidden>${tr('add.catErr')}</p>
        </div>

        <div class="field">
          <span class="label">${tr('add.payer')}</span>
          <div class="pick pick--wrap" id="f-payer">
            ${liveMembers().map((m) => `
              <button type="button" class="pickbtn" data-payer="${m.id}"
                      aria-pressed="${draft.payerId === m.id}">
                ${avatar(m.id, 'sm')}${esc(m.name)}
              </button>`).join('')}
          </div>
        </div>

        <div class="field">
          <div style="display:flex;align-items:baseline;gap:10px">
            <span class="label" style="margin-right:auto">${tr('add.split')}</span>
            <button type="button" class="linkbtn" id="f-all">${tr('add.selectAll')}</button>
            <button type="button" class="linkbtn" id="f-only">${tr('add.onlyPayer')}</button>
          </div>
          <div class="pick pick--wrap" id="f-parts">
            ${liveMembers().map((m) => `
              <button type="button" class="pickbtn" data-part="${m.id}"
                      aria-pressed="${(draft.participants || []).includes(m.id)}">
                ${avatar(m.id, 'sm')}${esc(m.name)}
              </button>`).join('')}
          </div>
          <p class="hint" id="f-split-hint"></p>
          <p class="err" id="f-part-err" hidden>${tr('add.splitErr')}</p>
        </div>

        <div class="field">
          <label class="label" for="f-trip">${tr('add.trip')}</label>
          <div class="selectwrap">
            <select class="select" id="f-trip">
              <option value="">${tr('trip.daily')}</option>
              ${liveTrips().map((t) => `
                <option value="${t.id}" ${draft.tripId === t.id ? 'selected' : ''}>
                  ${esc(t.name)}${tripRange(t) ? ' · ' + tripRange(t) : ''}
                </option>`).join('')}
            </select>
            ${icon('caret-down')}
          </div>
          <p class="hint" id="f-trip-hint"></p>
        </div>

        <div class="fieldrow">
          <div class="field">
            <label class="label" for="f-date">${tr('add.date')}</label>
            <input class="input" id="f-date" type="date" value="${draft.date}" max="${todayISO()}">
          </div>
          <div class="field">
            <label class="label" for="f-note">${tr('add.note')}</label>
            <input class="input" id="f-note" placeholder="${tr('add.notePlaceholder')}" value="${esc(draft.note)}" maxlength="30">
          </div>
        </div>
      </form>`,
    foot: `
      ${editing ? `<button class="btn btn--ghost" data-del aria-label="${tr('add.delOne')}">${icon('trash')}</button>` : ''}
      <button class="btn btn--primary" data-ok>${icon('check')}${editing ? tr('act.save') : tr('act.record')}</button>`,
    onMount: (host) => wireAddForm(host, draft, editing),
  });
}

function wireAddForm(host, draft, editing) {
  const q = (s) => host.querySelector(s);
  const curSel = q('#f-cur');
  curSel.value = draft.currency;

  const syncConverted = () => {
    const v = parseFloat(q('#f-amt').value);
    const from = curSel.value;
    q('#f-conv').innerHTML = !(v > 0) ? '' :
      DISPLAY.filter((c) => c !== from)
        .map((c) => `<span>${c} <b class="num">${fmt(convert(v, from, c), c)}</b></span>`)
        .join('');
  };
  const syncSplitHint = () => {
    const parts = draft.participants || [];
    const payer = memberName(draft.payerId);
    const n = parts.length;
    q('#f-split-hint').textContent =
      n === 0 ? '' :
      n === 1 && parts[0] === draft.payerId ? tr('add.hintSelf', payer) :
      n === 1 ? tr('add.hintOnOne', memberName(parts[0])) :
      tr('add.hintEven', payer, n);
    q('#f-part-err').hidden = n > 0;
  };

  const tripSel = q('#f-trip');
  const syncTripHint = () => {
    const t = tripOf(tripSel.value);
    q('#f-trip-hint').textContent = t
      ? tr('add.inTrip', t.name)
      : tr('add.noTrip');
  };

  /* 改日期时，如果这天落在某个项目的区间里就自动归过去 */
  q('#f-date').onchange = () => {
    const d = q('#f-date').value;
    const hit = liveTrips().find((t) => t.from && t.to && d >= t.from && d <= t.to);
    if (hit && tripSel.value !== hit.id) {
      tripSel.value = hit.id;
      syncTripHint();
      toast(tr('trip.autoFiled', hit.name), 'airplane-tilt');
    }
  };
  tripSel.onchange = syncTripHint;

  q('#f-amt').oninput = syncConverted;
  curSel.onchange = () => { draft.currency = curSel.value; syncConverted(); };
  syncConverted();
  syncSplitHint();
  syncTripHint();

  const pickGroup = (sel, attr, key, after) =>
    host.querySelectorAll(`${sel} [data-${attr}]`).forEach((b) => b.onclick = () => {
      draft[key] = b.dataset[attr];
      host.querySelectorAll(`${sel} [data-${attr}]`).forEach((x) =>
        x.setAttribute('aria-pressed', String(x === b)));
      after?.();
    });
  pickGroup('#f-cats', 'cat', 'cat', () => q('#f-cat-err').hidden = true);
  pickGroup('#f-payer', 'payer', 'payerId', syncSplitHint);

  /* 分摊人是多选，不能复用单选的 pickGroup */
  const paintParts = () => host.querySelectorAll('#f-parts [data-part]').forEach((b) =>
    b.setAttribute('aria-pressed', String((draft.participants || []).includes(b.dataset.part))));
  host.querySelectorAll('#f-parts [data-part]').forEach((b) => b.onclick = () => {
    const id = b.dataset.part;
    const set = new Set(draft.participants || []);
    set.has(id) ? set.delete(id) : set.add(id);
    draft.participants = liveMembers().map((m) => m.id).filter((x) => set.has(x));
    paintParts(); syncSplitHint();
  });
  q('#f-all').onclick = () => {
    draft.participants = liveMembers().map((m) => m.id);
    paintParts(); syncSplitHint();
  };
  q('#f-only').onclick = () => {
    draft.participants = [draft.payerId];
    paintParts(); syncSplitHint();
  };

  /* --- 保存 / 删除 --- */
  host.querySelector('[data-ok]').onclick = () => {
    const v = parseFloat(q('#f-amt').value);
    let bad = false;
    q('#f-amt-err').hidden = v > 0;
    q('#f-amt').setAttribute('aria-invalid', String(!(v > 0)));
    if (!(v > 0)) bad = true;
    q('#f-cat-err').hidden = !!draft.cat;
    if (!draft.cat) bad = true;
    const nParts = (draft.participants || []).length;
    q('#f-part-err').hidden = nParts > 0;
    if (!nParts) bad = true;
    if (bad) { q('#f-amt').focus(); return; }

    const rec = {
      ...draft,
      type: 'expense',
      amount: v,
      currency: curSel.value,
      merchant: q('#f-merchant').value.trim(),
      note: q('#f-note').value.trim(),
      date: q('#f-date').value || todayISO(),
      tripId: q('#f-trip').value || null,
    };
    delete rec.dirty; touch(rec);
    if (editing) {
      const i = state.expenses.findIndex((e) => e.id === rec.id);
      state.expenses[i] = rec;
    } else {
      state.expenses.push(rec);
    }
    save(); closeSheetNow(); render(); queueSync();
    toast(editing ? tr('add.saved')
      : tr('add.recorded', fmt(convert(rec.amount, rec.currency, state.display), state.display)), 'check');
  };

  const del = host.querySelector('[data-del]');
  if (del) del.onclick = () => confirmSheet({
    title: tr('add.delTitle'),
    body: tr('add.delBody'),
    danger: tr('act.delete'),
    onOk: () => {
      const rec = state.expenses.find((e) => e.id === draft.id);
      if (rec) { rec.deleted = true; touch(rec); }
      save(); render(); queueSync(); toast(tr('add.deleted'), 'check');
    },
  });
}

function openSettleDetail(e) {
  const from = memberName(e.payerId), to = memberName(e.toId);
  confirmSheet({
    title: tr('settle.recTitle'),
    body: tr('settle.recBody', e.date, from, to, fmt(e.amount, e.currency)),
    danger: tr('settle.recDel'),
    onOk: () => {
      const rec = state.expenses.find((x) => x.id === e.id);
      if (rec) { rec.deleted = true; touch(rec); }
      save(); render(); queueSync(); toast(tr('add.deleted'), 'check');
    },
  });
}

/* ==========================================================================
   同步

   模型很简单：先把本地脏数据推上去，再拉服务器上比 lastPull 新的东西。
   冲突按 updatedAt 后写赢。删除是软删除，不然对方那台机器永远收不到「这条没了」。
   没网就把 dirty 标记留着，下次触发时再冲。
   ========================================================================== */
const SYNC_KEY = 'wetab.sync.v1';
const LEGACY_SYNC_KEY = 'tally.sync.v1';

let syncState = loadSync();           // { code, lastPull, lastOk }
let syncStatus = 'off';               // off | idle | busy | error | offline
let syncError = '';
let syncTimer = null;
let pollTimer = null;
let schemaOutdated = false;      // 数据库还是两人结构
let schemaWarned = false;

function loadSync() {
  try {
    const raw = localStorage.getItem(SYNC_KEY) || localStorage.getItem(LEGACY_SYNC_KEY);
    return JSON.parse(raw) || { code: null, lastPull: null, lastOk: null };
  }
  catch { return { code: null, lastPull: null, lastOk: null }; }
}
function saveSync() { localStorage.setItem(SYNC_KEY, JSON.stringify(syncState)); }

const isSynced = () => SYNC_AVAILABLE && !!syncState.code;

async function rpc(fn, args) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  });
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) {
    const e = new Error(data?.message || `HTTP ${res.status}`);
    e.pgcode = data?.code;
    throw e;
  }
  return data;
}

/** dirty 是本地字段，不往上传 */
const clean = (r) => { const { dirty, ...rest } = r; return rest; };

/** 记完账不立刻发，攒 700ms，连着改几笔只发一次 */
function queueSync() {
  if (!isSynced()) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => syncNow(), 700);
}

async function syncNow({ manual = false } = {}) {
  if (!isSynced() || syncStatus === 'busy') return;
  syncStatus = 'busy'; syncError = ''; paintSync();

  try {
    const dirtyE = state.expenses.filter((e) => e.dirty);
    const dirtyT = state.trips.filter((t) => t.dirty);

    if (dirtyE.length || dirtyT.length || state.metaDirty) {
      await rpc('tally_push', {
        p_code: syncState.code,
        p_entries: dirtyE.map(clean),
        p_trips: dirtyT.map(clean),
        p_members: state.metaDirty ? state.members : null,
        // display 故意不同步：Chloe 在香港看 HKD，Wen 在英国看 GBP，各看各的
      });
      dirtyE.forEach((e) => delete e.dirty);
      dirtyT.forEach((t) => delete t.dirty);
      state.metaDirty = false;
    }

    const out = await rpc('tally_pull', {
      p_code: syncState.code,
      p_since: syncState.lastPull,
    });
    const changed = mergePull(out);

    syncState.lastPull = out.serverTime;
    syncState.lastOk = Date.now();
    saveSync(); save();
    syncStatus = 'idle'; paintSync();

    if (changed || manual) render();
    if (schemaOutdated && !schemaWarned) {
      schemaWarned = true;
      toast(tr('sync.schemaOld'), 'warning-circle');
    } else if (manual) {
      toast(changed ? tr('sync.done') : tr('sync.upToDate'), 'check');
    }
  } catch (err) {
    const offline = !navigator.onLine || err.message === 'Failed to fetch';
    syncStatus = offline ? 'offline' : 'error';
    syncError = err.pgcode === 'P0002' ? tr('sync.codeInvalid') : err.message;
    paintSync();
    if (manual) toast(offline ? tr('sync.offline') : tr('sync.failed', syncError), 'warning-circle');
    console.warn('[sync]', err);
  }
}

/** 把服务器数据并回本地。返回「有没有真的变了」，没变就不重绘。 */
/* ==========================================================================
   导入账本

   合并规则和同步完全一致：按 id 比 updatedAt，谁新谁赢。
   所以导入一份旧备份不会盖掉现在更新的记录，只会把缺的补回来 —— 导入是「合并」，
   不是「还原」，重复导入同一个文件也不会多出东西。

   刻意不读文件里的 sync：账本码是「连到哪个账本」的钥匙，让它跟着备份走，
   会把人静悄悄换到另一个账本上，而且旧码可能早就断开了。
   ========================================================================== */
function readBackup(raw) {
  let data;
  try { data = JSON.parse(raw); } catch { throw new Error(tr('imp.notBackup')); }
  if (!data || !Array.isArray(data.members) || !Array.isArray(data.expenses)) {
    throw new Error(tr('imp.notBackup'));
  }
  return data;
}

/* 先算一遍会发生什么，好在确认框里如实说清楚，而不是导完再解释 */
function planImport(data) {
  const ids = (data.members || []).map((m) => m.id);
  /* 比内容时两边都要先过同一套整形，否则「字段缺失」和「字段是 null」、
     以及键的先后顺序都会被当成不一样。dirty 是本地标记，updatedAt 单独比，都不算内容。 */
  const bare = (r) => {
    const { dirty, updatedAt, ...rest } = r;
    return JSON.stringify(rest, Object.keys(rest).sort());
  };
  const same = (a, b) => bare(a) === bare(b);
  const plan = { add: 0, update: 0, keep: 0, trips: 0, members: 0, entries: [], tripRecs: [] };

  const walk = (incoming, local, norm, onAdd, onUpdate) => {
    for (const inc of incoming || []) {
      if (!inc || !inc.id) continue;
      const rec = norm(inc);
      if (!rec.updatedAt) rec.updatedAt = '1970-01-01T00:00:00.000Z';  // 老备份没这个字段
      const cur = local.find((x) => x.id === rec.id);
      if (!cur) { onAdd(rec); continue; }
      // 内容一模一样就别算进「要改的」。早期的记录没有 updatedAt，
      // 光比时间戳会把一堆没差别的记录报成「更新」，确认框里的数就成了假的。
      if (same(norm(cur), rec)) continue;
      if ((cur.updatedAt || '') >= rec.updatedAt) { plan.keep++; continue; }
      onUpdate(rec);
    }
  };

  walk(data.expenses, state.expenses, (e) => normEntry(e, ids)[0],
    (r) => { plan.add++; plan.entries.push(r); },
    (r) => { plan.update++; plan.entries.push(r); });

  walk(data.trips, state.trips, (t) => ({
    id: t.id, name: t.name || '', from: t.from || '', to: t.to || '',
    currency: t.currency || '', deleted: !!t.deleted, updatedAt: t.updatedAt,
  }), (r) => { plan.trips++; plan.tripRecs.push(r); },
     (r) => { plan.trips++; plan.tripRecs.push(r); });

  /* 成员：账本还是空的（一笔没记）就整份换成备份里的，这是「恢复到新设备」的情形。
     已经有账了就只补缺的 id，不改现有的名字 —— 导备份不该把人改名。
     这里不卡 MAX_MEMBERS：少一个成员会让引用他的记录算不出来，保数据优先。 */
  const known = new Set(state.members.map((m) => m.id));
  plan.replaceMembers = !state.expenses.some((e) => !e.deleted);
  plan.newMembers = (data.members || []).filter((m) => m && m.id && !known.has(m.id));
  plan.members = plan.replaceMembers
    ? (data.members || []).length
    : plan.newMembers.length;
  return plan;
}

function applyImport(data, plan) {
  if (plan.replaceMembers && data.members.length) state.members = data.members;
  else plan.newMembers.forEach((m) => state.members.push(m));

  const put = (list, rec) => {
    const i = list.findIndex((x) => x.id === rec.id);
    const stamped = { ...rec, dirty: true };   // 标脏，好推给同步的其他人
    if (i >= 0) list[i] = stamped; else list.push(stamped);
  };
  plan.tripRecs.forEach((t) => put(state.trips, t));
  plan.entries.forEach((e) => put(state.expenses, e));

  if (activeTrip !== 'all' && activeTrip !== 'daily' && !tripOf(activeTrip)) activeTrip = 'all';
  save();
  render();
  queueSync();
}

/* 一条记录从外面进来时统一整形。外面 = 服务器 pull，或者导入的备份文件。
   ids 是当前成员，用来还原两人时代的 split 字段。返回 [记录, 是不是老结构]。 */
function normEntry(e, ids) {
  const parts = Array.isArray(e.participants) ? e.participants : null;
  const others = ids.filter((id) => id !== e.payerId);
  return [{
    id: e.id, type: e.type || 'expense', payerId: e.payerId, amount: Number(e.amount) || 0,
    currency: e.currency, cat: normCat(e.cat) || '', merchant: e.merchant || '',
    note: e.note || '', date: e.date,
    participants: parts || (
      e.type === 'settle' ? []
      : e.split === 'payer' ? [e.payerId]
      : e.split === 'other' ? others
      : ids.slice()),
    toId: e.toId || (e.type === 'settle' ? others[0] || null : null),
    tripId: e.tripId || null,
    deleted: !!e.deleted, createdAt: Number(e.createdAt) || 0, updatedAt: e.updatedAt,
  }, !parts];
}

function mergePull(out) {
  let changed = false;

  const mergeList = (incoming, localList, keyFields) => {
    for (const inc of incoming || []) {
      const i = localList.findIndex((x) => x.id === inc.id);
      const local = i >= 0 ? localList[i] : null;

      // 本地还没推上去的改动更新，先留着，下一轮 push 会覆盖服务器
      if (local?.dirty) continue;
      if (local && local.updatedAt === inc.updatedAt) continue;

      const rec = keyFields(inc);
      if (i >= 0) localList[i] = rec; else localList.push(rec);
      changed = true;
    }
  };

  /* 数据库还没升级到多人结构时，pull 回来的是老的 split 字段。
     就地按老规则还原成 participants，界面不至于崩，同时提示去升级。 */
  let legacyRows = 0;
  const ids = state.members.map((m) => m.id);

  mergeList(out.entries, state.expenses, (e) => {
    const [rec, legacy] = normEntry(e, ids);
    if (legacy) legacyRows++;
    return rec;
  });

  if (legacyRows) schemaOutdated = true;

  mergeList(out.trips, state.trips, (t) => ({
    id: t.id, name: t.name, from: t.from || '', to: t.to || '',
    currency: t.currency || '', deleted: !!t.deleted, updatedAt: t.updatedAt,
  }));

  if (!state.metaDirty && out.members?.length) {
    if (JSON.stringify(out.members) !== JSON.stringify(state.members)) {
      state.members = out.members; changed = true;
    }
  }

  // 当前看的项目被对方删了，退回全部
  if (activeTrip !== 'all' && activeTrip !== 'daily' && !tripOf(activeTrip)) {
    activeTrip = 'all';
  }
  return changed;
}

/* ---------- 建账本 / 加入 / 断开 ---------- */
async function createLedger() {
  const out = await rpc('tally_create', { p_members: state.members });
  syncState = { code: out.code, lastPull: null, lastOk: null };
  saveSync();
  // 本地已有的记录全部标脏，第一次 syncNow 会整批推上去
  state.expenses.forEach(touch);
  state.trips.forEach(touch);
  touchMeta(); save();
  await syncNow();
  return out.code;
}

async function joinLedger(code) {
  const clean = code.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  const out = await rpc('tally_pull', { p_code: clean });   // 码不对这里就会抛
  syncState = { code: clean, lastPull: null, lastOk: null };
  saveSync();
  // 加入 = 以服务器为准，本地那份（多半是示例数据）整个换掉
  state.expenses = []; state.trips = []; state.metaDirty = false;
  mergePull(out);
  syncState.lastPull = out.serverTime;
  syncState.lastOk = Date.now();
  activeTrip = 'all';
  saveSync(); save();
  syncStatus = 'idle';
  return clean;
}

function disconnectSync() {
  syncState = { code: null, lastPull: null, lastOk: null };
  saveSync();
  state.expenses.forEach((e) => delete e.dirty);
  state.trips.forEach((t) => delete t.dirty);
  state.metaDirty = false;
  syncStatus = 'off';
  save(); render();
}

/* ---------- 状态指示 ---------- */
function syncLabel() {
  if (!isSynced()) return tr('st.local');
  if (syncStatus === 'busy') return tr('st.busy');
  if (syncStatus === 'offline') return tr('st.offline');
  if (syncStatus === 'error') return tr('st.error');
  if (!syncState.lastOk) return tr('st.pending');
  const mins = Math.floor((Date.now() - syncState.lastOk) / 60000);
  return mins < 1 ? tr('st.justNow') : mins < 60 ? tr('st.minsAgo', mins) : tr('st.longAgo');
}

function paintSync() {
  document.querySelectorAll('[data-sync-badge]').forEach((el) => {
    el.dataset.state = syncStatus;
    el.querySelector('span').textContent = syncLabel();
  });
  const v = $('[data-sync-status]');
  if (v) v.textContent = syncLabel();
}

/* ---------- 触发时机 ----------
   回到这个页面时拉一次（对方在别处记的账就出来了），
   有网了拉一次，另外每 90 秒兜一次底。轮询对记账来说完全够用，
   不值得为了它上 websocket。                                            */
function startSyncLoop() {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') syncNow();
  });
  window.addEventListener('online', () => syncNow());
  clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    if (document.visibilityState === 'visible') syncNow();
  }, 90000);
}

/* ==========================================================================
   离线
   ========================================================================== */
function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  // file:// 下没有 service worker，本地直接打开 index.html 时跳过
  if (location.protocol === 'file:') return;

  navigator.serviceWorker.register(new URL('./sw.js', import.meta.url))
    .then((reg) => {
      reg.addEventListener('updatefound', () => {
        const sw = reg.installing;
        if (!sw) return;
        sw.addEventListener('statechange', () => {
          // 已经有旧版在跑，说明这是一次更新而不是首次安装
          if (sw.state === 'installed' && navigator.serviceWorker.controller) {
            toast(tr('sw.updated'), 'arrows-clockwise');
          }
        });
      });
    })
    .catch((e) => console.warn('[sw] 注册失败:', e.message));
}

/* ==========================================================================
   启动
   ========================================================================== */
async function boot() {
  applyLook();
  const sprite = await fetch(new URL('./sprite.svg', import.meta.url)).then((r) => r.text());
  $('#sprite-host').innerHTML = sprite;
  if (isSynced()) syncStatus = 'idle';
  render();
  await loadRates();
  render();
  if (isSynced()) { startSyncLoop(); syncNow(); }
  if (!state.onboarded) openOnboarding();
  registerSW();
}
boot();
