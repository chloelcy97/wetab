/**
 * WeTab · 云函数 tally
 *
 * 对应原来 Supabase 里的 tally_create / tally_pull / tally_push 三个函数，
 * 合成一个云函数，用 action 分派。合成一个是因为云开发按函数个数算配额，
 * 而且三个动作共用同一套账本码校验。
 *
 * 安全模型和 Supabase 那版一致：
 *   三个集合在控制台里都设成「所有用户不可读写」，小程序端直接查库会被拒。
 *   只有云函数用管理员权限进得去，而它每次第一件事就是拿账本码换 ledger id。
 *   账本码 12 位、31 个字符，猜不出来；但拿到的人就能看账，别公开发。
 */

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const LEDGERS = db.collection('ledgers');
const TRIPS = db.collection('trips');
const ENTRIES = db.collection('entries');

/* 去掉 0 O o 1 l I i，避免手抄时看错 */
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const CODE_LEN = 12;

const PAGE = 100;          // 云数据库单次 get 上限是 100 条
const MAX_WRITE = 500;     // 一次 push 最多写这么多，超了让客户端分批

function genCode() {
  let out = '';
  for (let i = 0; i < CODE_LEN; i++) {
    out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return out;
}

async function ledgerByCode(code) {
  if (typeof code !== 'string' || code.length !== CODE_LEN) throw new Error('账本码不对');
  const r = await LEDGERS.where({ code }).limit(1).get();
  if (!r.data.length) throw new Error('账本码不对');
  return r.data[0];
}

/**
 * 分页读完一个集合。
 *
 * 上界 `until` 是调用方在最开头取的时间，把查询窗口钉死：
 * 不钉的话，翻页途中新写进来的记录会挤动排序，而且返回的 serverTime 会晚于
 * 查询时刻 —— 落在这中间的写入会被永远跳过，下次带着更晚的 since 也拉不到。
 *
 * 窗口内的记录被改到窗口外仍可能让某一页少一条，但它的 updatedAt 会变得比
 * since 更晚，下一轮同步自然带回来，不会永久丢。
 */
async function pullAll(coll, ledgerId, since, until) {
  const range = since
    ? _.gt(since).and(_.lte(until))
    : _.lte(until);
  const out = [];
  for (let skip = 0; ; skip += PAGE) {
    const r = await coll
      .where({ ledgerId, updatedAt: range })
      .orderBy('updatedAt', 'asc')
      .skip(skip)
      .limit(PAGE)
      .get();
    out.push(...r.data);
    if (r.data.length < PAGE) return out;
  }
}

const iso = (d) => (d instanceof Date ? d.toISOString() : d || null);
const day = (s) => (typeof s === 'string' && s ? s.slice(0, 10) : null);
const str = (v) => (v == null ? '' : String(v));

/* ---------------------------------------------------------------------------
   建账本
   --------------------------------------------------------------------------- */
async function create({ members }) {
  let code;
  for (let tries = 0; ; tries++) {
    code = genCode();
    const hit = await LEDGERS.where({ code }).limit(1).get();
    if (!hit.data.length) break;
    if (tries >= 5) throw new Error('生成账本码失败，请重试');
  }
  const now = new Date();
  const r = await LEDGERS.add({
    data: {
      code,
      members: Array.isArray(members) ? members : [],
      createdAt: now,
      updatedAt: now,
    },
  });
  return { id: r._id, code };
}

/* ---------------------------------------------------------------------------
   拉取：since 之后有变动的记录。since 传 null 就是全量。
   字段名转成前端用的那套，省得两边对不上。
   --------------------------------------------------------------------------- */
async function pull({ code, since }) {
  const until = new Date();               // 先取上界，见 pullAll 的注释
  const ledger = await ledgerByCode(code);
  const from = since ? new Date(since) : null;
  if (from && isNaN(from)) throw new Error('since 不是合法时间');

  const [trips, entries] = await Promise.all([
    pullAll(TRIPS, ledger._id, from, until),
    pullAll(ENTRIES, ledger._id, from, until),
  ]);

  return {
    serverTime: until.toISOString(),
    members: ledger.members || [],
    trips: trips.map((t) => ({
      id: t.id, name: t.name, from: t.from, to: t.to,
      currency: t.currency, deleted: !!t.deleted, updatedAt: iso(t.updatedAt),
    })),
    entries: entries.map((e) => ({
      id: e.id, type: e.type, payerId: e.payerId, amount: e.amount,
      currency: e.currency, cat: e.cat, merchant: e.merchant, note: e.note,
      date: e.date, participants: e.participants || [], toId: e.toId,
      tripId: e.tripId, deleted: !!e.deleted,
      createdAt: e.createdAt || 0, updatedAt: iso(e.updatedAt),
    })),
  };
}

/* ---------------------------------------------------------------------------
   推送：按条 upsert，后写的赢。

   _id 用「ledgerId:记录id」拼出来，不是记录 id 本身。这样一条记录天生只可能
   落在自己的账本里 —— 换成先查后写来挡跨账本覆盖的话，中间那一下是有竞态的。
   --------------------------------------------------------------------------- */
async function push({ code, entries, trips, members }) {
  const ledger = await ledgerByCode(code);
  const lid = ledger._id;
  const now = new Date();

  const es = Array.isArray(entries) ? entries : [];
  const ts = Array.isArray(trips) ? trips : [];
  if (es.length + ts.length > MAX_WRITE) {
    throw new Error(`一次最多推 ${MAX_WRITE} 条，请分批`);
  }

  for (const t of ts) {
    if (!t || !t.id) continue;
    await TRIPS.doc(`${lid}:${t.id}`).set({
      data: {
        ledgerId: lid, id: t.id, name: str(t.name),
        from: day(t.from), to: day(t.to), currency: str(t.currency),
        deleted: !!t.deleted, updatedAt: now,
      },
    });
  }

  for (const e of es) {
    if (!e || !e.id) continue;
    await ENTRIES.doc(`${lid}:${e.id}`).set({
      data: {
        ledgerId: lid, id: e.id,
        type: e.type === 'settle' ? 'settle' : 'expense',
        payerId: str(e.payerId),
        amount: Number(e.amount) || 0,
        currency: str(e.currency),
        cat: str(e.cat), merchant: str(e.merchant), note: str(e.note),
        date: day(e.date),
        participants: Array.isArray(e.participants) ? e.participants : [],
        toId: e.toId || null,
        tripId: e.tripId || null,
        deleted: !!e.deleted,
        createdAt: Number(e.createdAt) || 0,
        updatedAt: now,
      },
    });
  }

  if (Array.isArray(members)) {
    await LEDGERS.doc(lid).update({ data: { members, updatedAt: now } });
  }

  return { serverTime: now.toISOString() };
}

/* ---------------------------------------------------------------------------
   入口
   --------------------------------------------------------------------------- */
exports.main = async (event) => {
  try {
    switch (event && event.action) {
      case 'create': return { ok: true, data: await create(event) };
      case 'pull':   return { ok: true, data: await pull(event) };
      case 'push':   return { ok: true, data: await push(event) };
      default:       return { ok: false, error: '未知的 action' };
    }
  } catch (err) {
    // 报错也走正常返回，前端统一读 ok 字段，不用去分辨云函数抛错和业务出错
    return { ok: false, error: err.message || String(err) };
  }
};
