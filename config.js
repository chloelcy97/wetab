/* ==========================================================================
   配置

   这里的 Supabase key 是 publishable key，设计上就是要放在前端的，公开无妨。
   真正的门禁在数据库那边：两张表 RLS 全锁死，只有 tally_* 那几个函数开放给 anon，
   每个函数第一件事就是拿账本码换 ledger id，码不对直接报错。

   service_role key 绝对不要写进这个文件。
   ========================================================================== */

export const SUPABASE_URL = 'https://vcrgkfhsorrtxuumijta.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_MrVpgQISk_zqvuryRnGcqQ_gzm8QjOY';

/** 没填 URL / key 时，整个同步功能自动隐藏，App 退回纯本地模式 */
export const SYNC_AVAILABLE = Boolean(SUPABASE_URL && SUPABASE_KEY);

/* --------------------------------------------------------------------------
   汇率：欧洲央行数据，frankfurter.dev 允许浏览器直连（CORS 是 *），
   所以不需要任何后端代理，静态托管也能拿到实时汇率。
   -------------------------------------------------------------------------- */
export const RATES_URL =
  'https://api.frankfurter.dev/v1/latest?base=EUR&symbols=' +
  'HKD,GBP,CNY,USD,JPY,KRW,SGD,AUD,CAD,CHF,NZD,THB,MYR,IDR,PHP,INR';

/* --------------------------------------------------------------------------
   支持开发者

   填上你的收款页地址（Buy Me a Coffee / Ko-fi / PayPal.me / 爱发电 都行），
   设置页里就会出现「支持开发者」入口。留空则整个入口不显示。

   例：'https://buymeacoffee.com/yourname'
   -------------------------------------------------------------------------- */
export const SUPPORT_URL = '';
