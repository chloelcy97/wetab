# WeTab

几个人一起记账。多币种按实时汇率换算，按分类和行程拆开看，随时知道谁该转给谁多少。

**[打开 →](https://chloelcy97.github.io/wetab/)**  ·  中文 / English  ·  没网也能开、也能记

---

## 功能

- **多币种** 17 种货币输入，实时换算成港币 / 英镑 / 人民币，汇率来自欧洲央行
- **2 到 8 人** 谁付的、谁分摊分开选。全选是 AA，只勾自己是请客
- **算账** 每人一个净额，化成最少笔数的转账建议，点一下记为已结
- **项目** 按旅行或城市单独记一本，记账时按日期自动归类
- **同步** 一方创建账本拿到 12 位码，发给其他人即可共用
- **离线** 断网照常打开和记账，恢复网络自动补传
- **备份** 导出 JSON，导入时按时间戳合并，不会覆盖更新的记录
- **外观** 四套配色、深浅色、中英文，都只影响本机

装到手机主屏（Safari「分享 → 加到主屏幕」）后没有地址栏，跟原生 app 差不多。

---

## 本地跑

只要 Python 3.8+，不需要 Node、npm 或 pip install。

```bash
python3 server.py
```

打开 http://localhost:5173 。换端口用 `--port 8080`。

线上部署在 GitHub Pages，不需要任何后端。

---

## 部署自己的一份

Fork 之后开启 GitHub Pages 就能用，此时是纯本地模式，账目只存在浏览器里。

想要多人同步，再加一个 Supabase：

1. 建一个 Supabase 项目
2. SQL Editor 里跑一遍 `supabase/schema.sql`
3. 把项目 URL 和 publishable key 填进 `config.js`

三张表的 RLS 全部锁死，anon key 碰不到表，所有读写都走三个 security definer 函数，
每个函数第一件事是拿账本码换 ledger id。所以那串 12 位账本码就是唯一的钥匙，别公开分享。

`config.js` 里还可以填一个收款页地址，填了设置里才会出现「支持开发者」入口，留空则整个入口不显示。

---

## 技术

原生 ES module + 手写 CSS，零构建。数据存 `localStorage`，同步走 Supabase RPC，
service worker 做离线缓存。图标是 Phosphor，字体全用系统字体栈。

`cloud/` 是微信小程序用的云开发后端，界面层还没写，见 `cloud/README.md`。
