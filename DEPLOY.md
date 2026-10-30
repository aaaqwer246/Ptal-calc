# 部署

## 1. 高德

为本应用申请 **Web 服务 API** Key，确认地点搜索、输入提示和步行规划权限及配额。此 Key 只作为 Cloudflare 的 `AMAP_KEY` Secret 保存，不填入网页，不提交仓库。地图展示另用 **Web端 JS API** Key 及配套 jscode，在网页原有设置中填写，并在高德控制台限定实际网站域名。

高德服务协议对缓存、封装、转供和数据再利用有约束；本实现是本应用专用服务端调用，并非供第三方使用的通用代理。是否符合具体应用及商业使用授权应向高德确认，不能仅凭本实现认定已获授权。Worker 不使用 KV、Cache API 或数据库保存高德响应；浏览器只在页面内存复用查询。用户主动导出含高德数据的方案，分享、长期保存或再利用需另行确认授权。

若 Web 服务 Key 必须绑定固定出口 IP，普通 Workers 的出口不能视为固定 IP，需先与高德确认适用接入方式，不应伪造 IP 或关闭必须的授权检查。

## 2. Cloudflare Workers

在项目根目录的 PowerShell 中执行（需 Node.js、Cloudflare 登录；临时依赖放 E 盘）：

```powershell
New-Item -ItemType Directory -Force 'E:\Codex临时文件\npm-cache' | Out-Null
$env:TEMP='E:\Codex临时文件'
$env:TMP='E:\Codex临时文件'
$env:TMPDIR='E:\Codex临时文件'
$env:npm_config_cache='E:\Codex临时文件\npm-cache'
npx wrangler login
npx wrangler deploy --config worker/wrangler.toml
npx wrangler secret put AMAP_KEY --config worker/wrangler.toml
```

最后一条命令会交互读取 Key，不要把 Key 写在命令行参数中。首次发布至 Secret 设置完成前，业务接口返回503。

控制台 **Workers & Pages → ptal-api → Settings** 核对：

| 项目 | 值 |
| --- | --- |
| Variables and Secrets | `AMAP_KEY`：Secret，填 Web 服务 Key |
| Variables | `ALLOWED_ORIGINS`：逗号分隔的完整来源，如 `https://aaaqwer246.github.io`，不含路径和末尾斜杠 |
| Variables | `DAILY_LIMIT=1000`、`MINUTE_LIMIT=120`：全站上游尝试预算，按实际套餐调整 |
| Bindings | `IP_LIMITER`：每60秒120次，配置见 wrangler.toml |
| Bindings | `BUDGET`：QuotaGate Durable Object，由 Wrangler 的迁移自动创建 |
| Domains & Routes | 启用 HTTPS workers.dev 地址或自定义域名 |

绑定及迁移应通过 Wrangler 创建，仅在网页编辑器粘贴后端代码不足以部署完整服务。以后用 Wrangler 再部署时，以配置文件中的变量为准；更改控制台变量后应同步修改 `wrangler.toml`。真实域名不同时修改白名单，不能使用 `*`。`namespace_id` 如与账户其他限流器冲突，请改为该账户独立编号。

CORS 只限制浏览器，不是身份验证；非浏览器可伪造 Origin。当前服务是公开应用接口，依靠固定路由、参数校验、单 IP 频率、全站预算和日配额熔断保护。攻击者仍可能消耗预算导致正常用户不可用。需要成员专用访问时，应另配身份验证或 Cloudflare Access，并相应设计 GitHub Pages 的登录与跨域流程；不要把所谓代理口令放在公开前端。Cloudflare 请求量和费用另计，预算闸门只限制高德上游次数，不限制攻击请求到达 Cloudflare 的次数。不要开启记录完整上游 URL 或密钥的日志。

## 3. GitHub Pages

1. 将 `src/deployment.js` 的 `workerUrl` 设为部署得到的 HTTPS 地址，如 `https://ptal-api.<你的子域>.workers.dev`（不带 `/api`）。该地址可以公开。配置留空时明确提示未配置，手动计算仍可使用。
2. 将项目文件上传到既有 `aaaqwer246/Ptal-calc` 仓库的 `main` 分支根目录。不要上传 `artifacts/`、`.dev.vars`、`.env`、`.wrangler/`、`node_modules/` 或本地密钥。
3. **Settings → Pages → Deploy from a branch → main → /(root)**。无需前端构建，不需要在 GitHub 添加 `AMAP_KEY` Secret。
4. 使用 Pages 控制台给出的真实网站地址；普通项目地址通常为 `https://aaaqwer246.github.io/Ptal-calc/`，Worker 白名单只填来源 `https://aaaqwer246.github.io`。自定义域名或受限 Pages 的独立域名应按真实地址调整。

私密仓库能否使用 Pages 取决于 GitHub 套餐；GitHub Free 的私密仓库不提供此能力，需要适用的付费套餐。仓库私密不等于部署页面具有访问控制。本次读取该仓库时 `has_pages=false`，尚未检测到 Pages 配置。

## 4. 验收

运行 `node --test tests/*.test.cjs`。本地测试覆盖计算模型、完整分页、取消、Worker 跨域与参数拒绝、限流、全站预算、配额熔断、异常响应及前后端数据转换，全部使用模拟数据。

部署后在网站输入一个地点并选择入口，验证公交及地铁候选、实际步行距离、路径展示、取消、强制刷新、手动修改和导出。开发者工具中业务请求应只到 Worker，只有地图 SDK 请求使用 Web端 JS Key；任何前端文件、浏览器存储及请求中都不应出现 Web 服务 Key。确认没有直接调用 restapi.amap.com。未配置 JS Key 时地点及步行业务仍可使用，地图展示需要另填配置。

直接请求 Worker 但不带 Origin 或带非白名单 Origin 应返回403；非法坐标、未知参数及客户端 Key 返回400。限流与预算返回429；上游异常返回502、超时504、未配置503。不要用真实 Key 故意耗尽配额，配额异常通过自动测试模拟。

参考：[高德 Web 服务文档](https://lbs.amap.com/api/webservice/summary/)、[服务协议](https://lbs.amap.com/pages/terms)、[Cloudflare Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)、[限流绑定](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)、[GitHub Pages 套餐](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)。
