# 模型纪元

大模型发布记录站：每条历史发布逐条核验出处，未来发布线索按官方、媒体、周期推测、社区线索分级，社区线索以账号历史命中率作为可信度依据。

纯静态站点，无构建步骤。页面在 `public/`，数据在 `public/data/`。

## 本地预览

```bash
npm run dev            # 或：python3 -m http.server -d public 8080
```

打开 <http://localhost:8080>。页面通过 `fetch` 读取 JSON，直接双击 HTML 打不开数据。

## 目录

```
public/
  index.html  about.html  404.html
  assets/     style.css  app.js  about.js  favicon.svg
  data/
    atlas.json      厂商、历史事件、未来线索
    watchlist.json  社区观察名单与历史说法
    site.json       站点名称、域名、仓库地址
  _headers         Cloudflare Pages 安全与缓存头
scripts/
  validate.mjs     数据校验（CI 必跑）
  archive.mjs      把已核验来源提交到 Internet Archive
  check-links.mjs  检查来源链接是否失效
```

`模型纪元-完整单文件.html` 是拆分前的原始版本，保留作对照，不参与部署。

## 日常维护

1. 改 `public/data/*.json`。
2. `npm run validate`，有错误必须先修。
3. 新增已核验来源后跑 `npm run archive`，自动补存档链接。
4. 提交并推送到 `main`，CI 校验通过后自动部署。

校验会拦下这些情况：重复 ID、未知厂商、日期格式错误、历史事件日期在未来、非 https 链接、“已核验”却没有核验日期或只读到检索摘录、分级高于证据所能支撑的级别、社区来源没有关联观察名单账号、社区说法没有原帖链接、已比对说法没有官方依据。

## 添加社区说法

在 `watchlist.json` 对应账号的 `trackRecord` 中追加：

```json
{
  "claim": "暗示 Fable 5.5 本周上线",
  "claimUrl": "https://x.com/…/status/…",
  "claimedAt": "2026-10-15",
  "windowEnd": "2026-10-22",
  "outcome": "pending"
}
```

时间窗结束后改 `outcome`（`hit` / `partial` / `miss`），并补 `resolvedAt`、`evidenceUrl`，有对应历史事件时填 `eventId`。判定规则见 `about.html#watchlist`。

把一条社区说法挂到未来线索上：在 forecast 的 `sources` 中加一条 `"sourceType": "community"`，并填 `"watchlistId": "账号 id"`。

## 部署

先改 `public/data/site.json` 里的 `url`、`repo`、`issues`。

### 方案 A：Cloudflare Pages（推荐，国内访问通常更稳）

1. 把仓库推到 GitHub。
2. Cloudflare 控制台 → Workers & Pages → Create → Pages → Connect to Git，选这个仓库。
3. Framework preset 选 None，Build command 留空，Build output directory 填 `public`。
4. 部署后得到 `*.pages.dev` 域名；可在 Custom domains 绑定自己的域名。
5. 在 GitHub 仓库 Settings → Secrets and variables → Actions → Variables 新建 `DEPLOY_TARGET=cloudflare`，关闭 GitHub Pages 部署任务，只保留校验。

注意：Cloudflare 的 Git 集成不会等 GitHub Actions 校验通过再部署。想要“校验不过就不上线”，可在 Cloudflare 里关掉自动部署、改用 `wrangler pages deploy public` 从 Actions 推送。

不用 Git 也可以直接上传：`npx wrangler pages deploy public --project-name model-atlas`。

### 方案 B：GitHub Pages

1. 推到 GitHub 的 `main` 分支。
2. 仓库 Settings → Pages → Source 选 GitHub Actions。
3. 推送后 `.github/workflows/deploy.yml` 会先校验、再部署，地址为 `https://<用户名>.github.io/model-atlas/`。

GitHub Pages 不读取 `_headers`，安全头只在 Cloudflare 上生效。

## 许可

数据 CC BY 4.0，代码 MIT。
