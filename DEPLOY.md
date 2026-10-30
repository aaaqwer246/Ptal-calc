微信公众号：Guillaume的工作间

# 部署说明

本项目由网页和默认查询服务两部分组成。网页可部署到 GitHub Pages，也可本地运行；默认服务部署到 Cloudflare Workers。日常使用见 [README.md](README.md)。

网页填写了个人高德 Key 和配套安全密钥时，地图与查询全部优先使用个人配置，不调用默认服务。两项清空并保存后，才使用下面的默认服务配置。个人配置出错时不会自动切换。

## 一、准备高德配置

在高德开放平台为本应用准备两种 Key，不能用同一串 Key 跨平台调用。

| 用途 | 高德平台类型 | Cloudflare 中的名称 |
| --- | --- | --- |
| 地点、站点和步行查询 | Web 服务 API | `AMAP_KEY` |
| 地图展示 | Web端（JS API） | `AMAP_JS_KEY` |
| 地图 Key 配套的安全密钥 jscode | 与上一项对应 | `AMAP_JS_SECRET` |

这三项都在 Cloudflare 中保存为 **Secret**，不要写入源码或提交到仓库。

地图用的 JS Key 在加载地图时仍会被浏览器看到，应在高德控制台限制允许使用的域名。默认服务的 Web 服务 Key 和 jscode 保留在服务器，不发给浏览器。若 Web 服务 Key 必须绑定固定出口 IP，需先确认接入方式；普通 Workers 不提供可据此假定的固定出口 IP。

## 二、部署默认服务

### 连接仓库

1. 在 Cloudflare 的 **Workers & Pages** 中创建应用，连接 GitHub。
2. 选择本项目仓库；私密仓库需要单独授权 Cloudflare 访问。
3. 按下表填写后部署：

| 设置项 | 内容 |
| --- | --- |
| Worker 名称 | `ptal-api` |
| 分支 | `main` |
| 根目录／Path | `/worker` |
| 构建命令 | 留空 |
| 部署命令 | `npx wrangler deploy --config wrangler.toml` |

`worker/wrangler.toml` 已包含运行入口、限流和配额存储配置。不要只上传网页文件或在网页编辑器里粘贴部分后端代码。

### 添加密钥

部署完成后，进入 **ptal-api → Settings → Variables and secrets**，添加上一节的三个 Secret，保存并部署。

已有 Secret 不需要随每次代码更新重新填写。Secret 尚未设置完整时，对应的默认查询或地图功能会提示暂不可用。

### 核对变量和绑定

以下默认值已写入 `worker/wrangler.toml`：

| 名称 | 默认值／作用 |
| --- | --- |
| `ALLOWED_ORIGINS` | 允许访问服务的网页来源 |
| `DAILY_LIMIT` | 查询代理每日最多尝试 1000 次上游请求 |
| `MAP_DAILY_LIMIT` | 地图代理每日最多尝试 1000 次上游请求 |
| `MINUTE_LIMIT` | 查询和地图代理分别每分钟最多尝试 120 次 |
| `IP_LIMITER` | 单 IP 每 60 秒最多 120 次请求，属于边缘近似限流 |
| `BUDGET` | 绑定 `QuotaGate`，统一记录预算和查询熔断状态 |

两个绑定由部署配置自动创建。全站预算按北京时间换日，已发出的失败请求也计数；这些是站点保护上限，不代表高德实际配额或账单。地图加载的其他请求不一定经过代理，也不能用地图代理计数代替完整用量统计。

修改控制台中的普通变量后，也应同步修改配置文件，避免下次部署覆盖。不要删除已有的 `QuotaGate` 对象来处理部署错误。

## 三、设置允许访问的来源

`ALLOWED_ORIGINS` 用英文逗号分隔。每项只写协议、域名和端口，不带页面路径或末尾斜杠。

例如，网页地址是 `https://aaaqwer246.github.io/Ptal-calc/`，对应的来源应写为 `https://aaaqwer246.github.io`。

当前配置已包含：

- `https://aaaqwer246.github.io`
- `https://ptal-calc.zhouguillaume111750.workers.dev`
- `http://127.0.0.1:8765`
- `http://localhost:8765`

更换网站域名或本地端口后，需要修改白名单并重新部署。不要使用 `*`，也不要为了允许直接打开 HTML 文件而添加 `null` 来源。

来源白名单不是身份验证。公开接口仍可能被非浏览器请求滥用；限流、全站预算和配额熔断用于限制上游消耗，不能阻止所有请求到达 Cloudflare，也不能保证服务不被占满。

## 四、发布网页

1. 将 `src/deployment.js` 中的 `workerUrl` 填为控制台给出的 HTTPS 服务地址，不带 `/api`。该地址可以公开，不要在这个文件中填写密钥。
2. 将前端及配套文件提交到 GitHub 仓库的 `main` 分支根目录。
3. 进入仓库 **Settings → Pages → Deploy from a branch**，选择 `main` 和 `/(root)`。
4. 部署完成后，以 Pages 控制台给出的地址访问，并确认该地址的来源已加入白名单。

前端无需构建，也不需要在 GitHub 中添加高德 Secret。使用既有静态托管项目时，同样要更新网页文件，并将实际来源加入白名单。`ptal-api` 提供后台服务，不替代网页托管。

私密仓库能否使用 GitHub Pages 取决于账号套餐。仓库私密不等于网站具有访问控制。不要上传 `.env`、`.dev.vars`、`.wrangler/`、`node_modules/`、临时文件或真实密钥。

## 五、本地运行

安装 Python 3 后，双击 `启动本地计算器.cmd`，或在项目目录运行：

```sh
python serve.py
```

浏览器会打开 `http://127.0.0.1:8765/`。使用期间保持启动窗口打开，关闭窗口即可停止。服务仅监听本机并提供前端文件，不保存密钥或转发业务请求。

直接双击 `index.html` 仅支持手动计算。个人配置保存在当前浏览器、当前网址下，正常关闭后仍保留；本地网页和线上网页的配置分别独立。

## 六、更新与检查

更新代码后，确认网页托管和 `ptal-api` 都部署了所需的新版本，再刷新网页。只更新后台，不会自动替换另一处托管的网页文件。

部署后的检查：

1. 填写个人配置，确认地图、地点和步行查询使用个人 JS API，没有调用默认服务。
2. 清空两项并保存，确认切回默认服务；更换配置后原有分析能够恢复。
3. 查询一个地点，检查公交、地铁候选、实际步行距离及路径显示，再验证取消、手动修改、方案导入导出。
4. 关闭并重新打开同一浏览器，确认个人配置仍在。不要在无痕窗口中测试长期保存。
5. 使用默认服务时，确认服务器的 `AMAP_KEY`、`AMAP_JS_SECRET` 实际值没有下发给浏览器或写入源码；地图 JS Key 可见是正常现象。

自动测试运行 `node --test tests/*.test.cjs`；浏览器回归运行 `node tests/browser.cjs` 和 `node tests/priority-browser.cjs`，后两项需要 Playwright 和可用浏览器。测试使用模拟数据，不能代替真实接口验证。

配额耗尽或请求过频时应保留错误提示，不要反复重试、轮换 Key 或重置预算来规避高德限制。服务不会增加高德配额，也不保证第二天一定恢复。接口数据仅在当前页面内存中复用；导出、分享及其他使用仍需符合高德授权。

参考：[高德 Web 服务文档](https://lbs.amap.com/api/webservice/summary/)、[地图安全密钥接入](https://lbs.amap.com/api/javascript-api-v2/guide/abc/jscode)、[高德服务协议](https://lbs.amap.com/pages/terms)、[Cloudflare Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)、[限流绑定](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)、[GitHub Pages 说明](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)。
