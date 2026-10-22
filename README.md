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

## 自动采集与审核

已接入 GitHub Actions，每 30 分钟采集一次（每小时第 23 和 53 分钟，平台调度可能延迟）。读取 `public/data/sources.json` 的公开 RSS 和官网列表，新条目只写入 `review/queue.json`，不会修改正式数据。失败入口会留下原因；403、登录墙和付费 X 接口不会被绕过。GitHub 自带的工作流令牌即可运行，不需要 AI API key。

在本机启动审核入口（需要 Node 22+、Git、已登录仓库维护者账户的 GitHub CLI）：

```bash
cd /Users/xixi/Documents/Codex/model-atlas
npm run review
```

打开 <http://127.0.0.1:8787>，选择候选，读取原文，填写模型名称、事件类型和支持它们的摘录，再点击「审核通过并发布」。未来计划没有明确日期就留空；误报可忽略，证据不足可暂缓。更新已有记录时选择「更新」，旧值、来源和修改原因都会保留。

页面提交人工审核后，GitHub 会再读一次原文，核对正文指纹、来源归属、候选版本与审核内容。通过后提交正式数据并触发部署；页面上的「已提交」不等于已经上线，以工作流结果为准。原文发生变化或无法读取时，保留待审，需重新核对。自动检查不能判断一句话的全部语义，最终的名称、日期和事件对应关系仍由审核人核实。

- [采集运行记录](https://github.com/beteey/model-atlas/actions/workflows/collect.yml)
- [审核运行记录](https://github.com/beteey/model-atlas/actions/workflows/review.yml)
- [部署运行记录](https://github.com/beteey/model-atlas/actions/workflows/deploy.yml)

`review/` 不在网站发布目录中；队列和审核记录保存在 Git 仓库，仓库若公开则也可被查看，不适合保存私密信息。网络正文仅用于当前审核，不整篇写入仓库。采集和审核共用写入队列，失败的 Git 推送不会强行覆盖远端；失败后同步并重新提交。机器人提交不会自动触发另一个 push 工作流，因此审核任务会显式启动部署。

本机读取来源会使用 macOS 已启用的 HTTPS 回环代理（如果有）；GitHub 定时采集直接运行在云端，电脑无需保持开启。来源网页有地区差异、动态内容或无法提取正文时，暂缓处理。

手动启动云端采集：`gh workflow run collect.yml`。`npm run collect` 只更新本地队列，提交到仓库后云端审核任务才能读取。回归检查：`npm test`。`scripts/probe-sources.mjs` 仍仅用于诊断入口，不承担发布。GLM 当前是单页更新日志，页内新增条目和 X 原帖暂需人工补充，不拼造独立文章链接。

## 手动维护已有资料

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
