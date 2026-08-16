# Tally · 双人账本

两个人一起记账。多币种自动按实时汇率换算成港币 / 英镑 / 人民币，按分类拆开看，
拍一张小票就能自动填好整笔账。

零构建：不需要 Node、不需要 npm、不需要 `pip install`。只要有 Python 3.8+。

---

## 跑起来

```bash
python3 server.py
```

打开 http://localhost:5173 。首次进入会有一份示例账目，在「设置 → 清空所有记录」里可以清掉。

想换端口：

```bash
python3 server.py --port 8080
```

### 打开小票识别

不配 key 也能用，识别会返回一条固定的演示数据，界面流程完全走得通。
要真的读小票，设一个 Anthropic API key 再启动：

```bash
export ANTHROPIC_API_KEY=sk-ant-xxxxxxxx
python3 server.py
```

模型默认 `claude-opus-5`，想省钱可以换：

```bash
export TALLY_MODEL=claude-sonnet-5
```

### 装到手机主屏

手机和电脑在同一个 Wi-Fi 下，把 `server.py` 里的 `127.0.0.1` 改成 `0.0.0.0`，
然后手机 Safari 打开 `http://<电脑内网 IP>:5173`，「分享 → 加到主屏幕」。
有 manifest 和图标，打开后没有浏览器地址栏，跟原生 app 差不多。

---

## 它能做什么

**项目（按旅行 / 城市分开算）**
- 每次旅行开一个项目，填上起止日期和当地货币
- 账本顶部一排 chip 切换：全部 / 日常 / 各个项目
- 记账时按日期**自动归类**：日期落在某个项目区间内就自动归过去，会提示你一声
- 在项目里记账时，金额默认用这个项目的当地货币，不用每次改
- 每个项目单独算「谁先垫了多少」，可以只结算这一趟
- 统计页有「按项目」卡片：这趟总共花了多少、两个人各花多少、谁垫得多
- 删项目不会丢账，里面的记录会退回「日常」

**记账**
- 手动填，或者拍/选一张小票照片自动识别金额、币种、商家、日期、分类
- 17 种货币输入，输入时实时显示换算成 HKD / GBP / CNY 的结果
- 8 个分类：吃饭、交通、住宿、购物、娱乐、日用、医疗、其他
- 三种分摊方式：AA 平分 / 请客（不产生差额）/ 对方全付

**算账**
- 首页顶部一直显示「谁先垫了多少」，以及两个人各自花了多少
- 点「记一笔补款」把转账记进去，垫付差额就抵掉了，补款不算消费、不进统计
- 当前在某个项目里时，补款只结算这个项目
- 顶部切 HKD / GBP / CNY，全站金额跟着换，包括历史记录

**统计**
- 按月看总支出、两个人各自的份额、分类占比排行
- 可以翻到过去的月份
- 下面的「按项目」不受月份影响，看的是每个项目从头到尾的全部花费

**同步（两个人共用一个账本）**
- 一方在「设置 → 创建共享账本」拿到 12 位账本码，发给另一方，对方选「用账本码加入」
- 记账、改名、建项目、删除都会自动同步，攒 700ms 一起发，连着改几笔只发一次
- 按条 upsert，不是整包覆盖——两个人同时记账不会互相盖掉
- 删除是软删除，所以对方那边也会消失
- 没网就把改动存在本地，恢复网络后自动补上
- 回到页面时、有网时、每 90 秒各拉一次。记账不需要 websocket
- **显示币种不同步**：Chloe 可以看 HKD，Wen 同时看 GBP，底下是同一笔账

**汇率**
- 来自欧洲央行（通过 frankfurter.dev），每天首次打开时取一次，之后走本地缓存
- 取不到就退回内置的离线汇率，界面上会明确标出来

---

## 数据在哪

**没开同步时**：账目只存在浏览器的 `localStorage`（key 是 `tally.state.v1`），不上传任何地方。

**开了同步之后**：账目存在 Supabase。两张表的 RLS 全部锁死，anon key 碰不到表，
所有读写必须走 `tally_create / tally_pull / tally_push` 三个 security definer 函数，
每个函数第一件事就是拿账本码换 ledger id。所以那串 12 位账本码就是唯一的钥匙，
约 31¹² 种组合猜不出来，但拿到的人就能看账，别公开分享。
本地 `localStorage` 继续当离线缓存用。

「设置 → 导出为 JSON」可以随时把账本导出备份。

小票照片只在识别的那一次发给 Anthropic API，识别完就丢掉，不会存进账本、也不会落盘。
不配 API key 的话，照片根本不出这台电脑。

---

## 文件结构

```
server.py                     Python 标准库服务：静态文件 + /api/rates + /api/scan
public/
  index.html                  外壳
  styles.css                  设计系统（颜色 token、深色模式、全部组件）
  app.js                      全部逻辑：状态、汇率换算、结算、三个视图、表单、识别、同步
  config.js                   Supabase URL 与 publishable key
  sprite.svg                  Phosphor 图标合成的 sprite
  icons/                      原始 Phosphor SVG（改图标时从这里重新生成 sprite）
  manifest.webmanifest        PWA 配置
  icon-*.png                  主屏图标
.claude/launch.json           给 Claude Code 用的启动配置
supabase/schema.sql           建表 + RLS + 三个 RPC 函数，粘进 Supabase SQL Editor 跑
```

改图标的话，把新的 Phosphor SVG 丢进 `public/icons/`，然后：

```bash
python3 -c "import re,pathlib; d=pathlib.Path('public/icons'); out=['<svg xmlns=\"http://www.w3.org/2000/svg\" style=\"display:none\">']+[f'<symbol id=\"ph-{f.stem}\" viewBox=\"0 0 256 256\">'+re.sub(r'^<svg[^>]*>|</svg>\s*$','',f.read_text().strip())+'</symbol>' for f in sorted(d.glob('*.svg'))]+['</svg>']; pathlib.Path('public/sprite.svg').write_text('\n'.join(out))"
```

---

## 设计上定死的几条

- 一个强调色：钴蓝 `#2F53D6`（深色模式 `#6E8CF7`）。两个人用「强调色 / 墨色」两个头像色区分，不引入第三种颜色。
- 圆角只有四档：卡片 18px、输入 12px、图标底 14px、按钮和胶囊全圆。
- 所有数字用等宽字体 + `tabular-nums`，金额上下对齐、切币种时不跳动。
- 字体全用系统字体栈（iOS 上就是 SF Pro / SF Mono），不加载任何网络字体，首屏没有闪字。
- 深色模式跟随系统，两套颜色都验过对比度。
- 动效只有三处：列表首次进场、抽屉弹出、统计条形展开。都受 `prefers-reduced-motion` 控制，关掉动效后直接是静态。列表进场只在首屏跑一次，切币种和增删记录不重播。

---

## 如果之后要搬去别的地方

**做成真正的 App**：现在就是标准的响应式 Web App，用 Capacitor 直接包成 iOS/Android 壳最省事，
`app.js` 一行不用改，只要把 `/api/*` 指向一台公网服务器。

**做成微信小程序**：界面和交互可以照搬，但要重写渲染层（`app.js` 里用的是 DOM 和 `innerHTML`，
小程序里得换成 WXML + setData，或者用 Taro 重写一遍）。
`convert / balance / personTotals / tripSummary / fmt` 这几个纯计算函数可以原样复制过去。

**同步已经做好了**，见上面「同步」一节和 `supabase/schema.sql`。

**要让对方也能打开**：现在页面靠本机的 `python3 server.py`，只有你自己能访问。
要变成一个真正的网站，需要三件事：
1. 页面托管 —— GitHub Pages（只要 git，不用构建工具），免费且长期在线
2. 汇率 —— frankfurter.dev 允许浏览器直连（`access-control-allow-origin: *`），
   可以去掉 `/api/rates` 代理
3. 小票识别 —— 需要一个能藏 API key 的地方，Cloudflare Worker 有网页版编辑器，不用 CLI

数据层（Supabase）已经在云上了，不用动。
