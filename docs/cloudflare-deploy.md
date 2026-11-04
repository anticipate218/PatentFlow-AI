# Cloudflare 公开体验部署

默认部署模式为 **公开访问 + 使用公告 + 全站共享调用配额**。访客无需注册或邀请码，知悉公告后即可进入。私有部署可显式保留邀请模式，但当前公开站不启用。

## 前提

- Node.js 24+、npm 和已授权的 Cloudflare 账号。
- 自己可用的模型 Key、检索 Key；已有站点变更访问模式时，不需要重新填写或覆盖原密钥。
- 模型与搜索调用可能收费。共享请求次数不是金额预算，应同时配置服务商的预算保护。
- 使用 SQLite Durable Object 保存全站配额。该存储类型可用于 Workers Free，但实际平台额度及费用以官方当前政策为准。

## 本地 Worker 验证

~~~sh
npm ci
node scripts/cf-dev-vars.mjs
npm run cf:dev
~~~

开发服务配置来自 .env.local，生成文件 .dev.vars 被 Git 忽略。默认公开模式无需 ACCESS_CODES。只需知悉公告，打开 http://127.0.0.1:8787/ 即可测试。

~~~sh
npm run test:worker
node scripts/live-pipeline.mjs
~~~

这些真实集成测试可能消耗上游额度。完整离线上游验证可使用 npm run test:worker:mock；它同时测试原邀请模式、公开模式、配额耗尽与 Worker 重启后的配额保持。

## 新部署

1. 执行 npx wrangler login，并确认账号、Worker 名称及计划。
2. 在被忽略的 .env.production.local 中配置自己的正式模型与检索 Key、Base URL、模型 ID。
3. 检查 wrangler.jsonc：ACCESS_MODE 为 public；包含 PUBLIC_QUOTA Durable Object 绑定及 public-quota-v1 SQLite migration。
4. 执行 npm run cf:deploy。没有 SESSION_SECRET 时应用会保持关闭，这是预期保护。
5. 执行 npm run cf:secrets 写入服务端密钥和公告会话签名密钥。公开模式不生成邀请码。不需要更改现有签名密钥时，可在正式配置中显式保留 SESSION_SECRET。
6. 用全新浏览器会话验证：公开公告、无需邀请码、确认进入、默认及自带模型、检索、导出、超额提示。

不要把部署成功等同于业务验收通过。模型无额度、网络不可达、供应商限流及平台资源上限必须分别验证。

## 已有部署切换为公开模式

只需更新 wrangler.jsonc 中的公开模式、配额变量和 Durable Object 配置，再部署代码。**不要为了这个切换重新同步整份 .env.production.local**，以免误覆盖现有模型或轮换 SESSION_SECRET。

旧邀请 Cookie 不会被当作公开模式凭据；访客重新知悉公告即可，无需原邀请码。ACCESS_CODES 在公开模式下不参与验证。

## 共享配额

| 配置 | 默认值 | 含义 |
| --- | ---: | --- |
| ACCESS_MODE | public | 公开页面与公告确认；invite 为可选私有模式 |
| PUBLIC_DAILY_MODEL_CALLS | 60 | 全站每日共享模型上游调用次数 |
| PUBLIC_DAILY_SEARCH_CALLS | 300 | 全站每日共享检索上游调用次数，包括网页提取 |
| AGENT_PER_HOUR | 30 | 单 IP 的模型相关请求小时级限流 |
| TOOLS_PER_HOUR | 120 | 单 IP 的独立检索相关请求小时级限流 |
| MAX_OUTPUT_TOKENS | 32000 | 每次模型请求的输出 token 上限 |
| MAX_BODY_BYTES | 2000000 | 单个 API 请求体的字节上限，超出返回 413；邀请码表单另限 16384 字节 |
| SESSION_DAYS | 7 | 公告/邀请会话 Cookie 有效天数，取值限制在 1–30 |

- 日配额由一个固定名称的 Durable Object 事务更新，按北京时间 00:00 重置；普通刷新、换 Cookie、换 Worker isolate 或重启不会重置它。
- 每次实际使用共享 Key 发出的上游请求都计数，包括失败、重试及 Agent 内部的模型/检索工具调用。一键生成不是只消耗一次。
- 使用个人 Key 的模型调用不占共享模型日配额；其使用的共享检索仍计数。
- 日配额设为 0 表示关闭相应共享服务，不表示无限。配额服务无法访问时暂停共享调用，不降级为不计数访问。
- 日配额耗尽不关闭网页、已有材料或本地导出。模型池耗尽时，用户可改用自己的模型 Key；搜索池耗尽时需等待重置。
- 小时级防刷仍是 isolate 内存限流，不应与全站持久化日配额混淆。日配额也不是金额预算，无法阻止密钥在本站之外被使用。

## 公告、密钥与安全

公告内容和版本在 src/site-info.ts。内容变化时更新 NOTICE_VERSION，新旧访客须知悉当前版本；签名 Cookie 是访问状态，不是用户实名身份或法律电子签名。

公开模式的程序化客户端先 GET /api/access 查看模式和版本，再 POST /__notice 提交 notice 字段取得匿名会话 Cookie；不提交邀请码。所有业务接口继续检查公告状态、同源请求和请求大小。

Agnes 作为独立预置服务使用 AGNES_SECONDARY_* secrets，不覆盖默认模型。连续长文验证未通过时保持停用，不能仅凭一次短回复恢复就宣称稳定可用。

不要提交 .env*、.dev.vars、私人附件、测试输出或密钥。浏览器代码开源可见，服务端 Key 不应可见。详见 [安全说明](../SECURITY.md) 与 [自带模型说明](bring-your-own-model.md)。

## 官方参考

- [Durable Objects 计费与免费计划](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [SQLite 存储](https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/)
- [Durable Objects 部署与迁移](https://developers.cloudflare.com/durable-objects/get-started/)
- [Workers 平台限制](https://developers.cloudflare.com/workers/platform/limits/)
- [Worker Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
