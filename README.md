<div align="center">

# PatentFlow AI

**从一个技术主题，到可编辑、可复核的专利申请初稿。**

## 🚀 [立即在线体验 · 无需邀请码](https://patentflow-ai.patentflow-ai.workers.dev/)

**公开访问，无需注册。每次打开均需阅读并确认免责声明，再进入工作台。**

[在线体验](https://patentflow-ai.patentflow-ai.workers.dev/) · [自行部署](docs/cloudflare-deploy.md) · [配置自己的模型](docs/bring-your-own-model.md) · [验证记录](docs/release-validation.md) · [贡献者](#contributors)

[Apache-2.0](LICENSE) · React + TypeScript · Cloudflare Workers · DOCX / ZIP

</div>

![PatentFlow AI 工作流程](docs/assets/readme-banner.svg)

> [!IMPORTANT]
> 本产品生成的是 **AI 辅助初稿，仅供参考**，不是法律意见或授权保证。检索线索、技术事实、公式、实验数据和附图均需核验；正式提交前请进行专业审阅。[阅读使用公告 →](docs/usage-notice.md)

## 在线体验与部署

### 直接体验

**访问：[https://patentflow-ai.patentflow-ai.workers.dev/](https://patentflow-ai.patentflow-ai.workers.dev/)**

- **已取消邀请码**：任何人都能打开页面，知悉使用公告后进入，无需申请账号。
- **可使用站点共享服务**，也可在「设置 → 我的 AI 模型」填写自己的模型与 API Key。
- **共享额度有限**：全站每日最多 60 次共享模型调用、300 次共享检索调用，北京时间零点重置。一键生成会进行多次调用，失败与重试也会占用调用次数。
- **个人模型独立计费**：自己的模型 Key 不占共享模型额度；站点共享检索仍受每日上限约束。额度耗尽后页面、已有案件及导出功能仍可访问。
- 案件主要保存在当前浏览器，换设备不会自动同步；请及时导出所需文件。
- 顶部统计按钮可查看累计/今日浏览量和访客数；从该功能上线开始计数，不回填历史。访客按匿名会话去重，不等同于真实人数。[统计口径与隐私说明](docs/site-traffic.md)

> [!NOTE]
> 这是公开测试站，不提供无限免费 API。共享调用仍使用临时测试配置，可能受服务商额度、网络、限流和站点每日上限影响。调用次数限制不等于金额预算，维护者仍应设置服务商侧预算控制。

### 自行部署

前端、网关、附图和导出代码全部在本仓库，可自行配置服务并部署。

**[Cloudflare 部署指南 →](docs/cloudflare-deploy.md)**

完整产品需要后端：仅把静态文件放到 GitHub Pages，无法运行模型、检索和 Agent API。当前部署将静态页面与 API 放在同一个 Worker 中，并使用 Durable Object 保存全站共享调用计数。

---

## 能做什么

| 能力 | 你可以获得什么 |
| --- | --- |
| 📄 阅读材料 | 读取 PDF、DOCX、PPTX、XLSX、文本等资料，并在后续对话中沿用 |
| 💡 梳理技术主题 | 讨论技术问题、候选发明点、保护主题与技术交底内容 |
| 🔎 检索与对比 | 收集公开专利线索，辅助比较技术特征；不冒充官方查新结论 |
| ✍️ 生成图文初稿 | 撰写说明书、权利要求、摘要，按结构化数据绘制附图 |
| 🛠️ 继续修改 | 针对现有稿件修改、重新核查；失败时保留原稿，并支持撤销 |
| 📦 导出材料 | 分件 Word、合订稿、PNG 附图与整套 ZIP |
| 🗂️ 管理案件 | 浏览器内案件、知识库、技术雷达和检索专题 |
| 🔌 自带模型 | 配置个人 Key、测试连接、获取模型列表、切换与删除配置 |

扫描件或图片没有可读取文字时，系统不会将其冒充成已经完整识别的正文。文件格式、供应商型号和输入内容的支持范围，以实际验证与页面提示为准。

## 三步开始

1. **打开工作台**：阅读使用公告，选择站点默认模型或配置自己的模型。
2. **给出主题或材料**：描述技术问题，或上传论文、交底书、实验记录等可授权使用的资料。
3. **生成、检查、继续修改**：核验内容与附图，提出修改要求，再导出所需文件。

**典型流程：** 技术主题 → 检索与对比 → 大纲与正文 → 附图与自检 → 修改 → Word / ZIP

### 导出包包含哪些内容？

- 发明专利请求书信息表、说明书摘要、摘要附图
- 权利要求书、说明书、说明书附图
- 内部审核单、合订稿、独立附图及提交说明

请求书信息表不替代官方申报表单；内部审核单与正式正文分开。实际文件以本次稿件及核查结果为准。

## 模型与隐私

内置 OpenAI Chat Completions 兼容协议及 Anthropic Messages 接口，提供 DeepSeek、OpenAI、Claude、Gemini 兼容接口、通义千问、Kimi、智谱、硅基流动、OpenRouter 等配置模板。

**模板不等于所有型号都已实测。** 模型权限、上下文容量、输出上限和工具调用能力取决于对应服务商。Agnes 已作为独立站点预置接入，但此前连续长文调用不稳定；当前是否开放生成，以站内状态为准。

- 管理员 Key 保存在服务器，不发送给访客。
- 个人 Key 默认仅保留在当前页面内存；可明确选择非加密的标签页临时存储。
- 使用模型时，相关材料及个人 Key 会经过本站网关，发送给你选择的服务。请确认信任双方，再处理保密内容。
- 自定义服务域名需要管理员批准，不能把共享 Key 转发到任意地址。

[自带模型详细说明](docs/bring-your-own-model.md) · [安全与隐私说明](SECURITY.md)

## 本地运行

需要 **Node.js 24+** 和 npm。

~~~sh
git clone https://github.com/anticipate218/PatentFlow-AI.git
cd PatentFlow-AI
npm ci
cp .env.example .env.local
~~~

只在本机的 `.env.local` 中填写自己的服务配置，然后启动：

~~~sh
npm run dev -- --host localhost --port 5173
~~~

打开 [http://localhost:5173/](http://localhost:5173/)。不要将开发服务器直接暴露到公网。

变量名 `AGNES_*` 为兼容旧配置而保留，并不限于 Agnes。例如 DeepSeek 可使用 `AGNES_BASE_URL=https://api.deepseek.com`，模型 ID 应填写账号实际可用的名称。模型与检索是独立服务，真实联网检索还需要检索服务配置。

## 验证与质量边界

~~~sh
npm test
npm run check:worker
npm run build
npm run verify
~~~

verify 包含自动化测试、lint、Worker 类型检查、构建、模拟上游集成，以及源码和构建产物的敏感信息扫描；公共模式还验证共享配额在 Worker 重启后不会被清空。

可选的真实集成测试会消耗所配置服务的额度：

~~~sh
npm run test:worker
node scripts/live-pipeline.mjs
~~~

测试通过仅表示对应版本和场景通过，不保证所有输入无错误，也不保证发明具有新颖性、创造性或获得授权。[详细验证记录 →](docs/release-validation.md)

推送到 `main` 及每个 Pull Request 都会由 GitHub Actions（[`.github/workflows/ci.yml`](.github/workflows/ci.yml)）在 Node.js 24 上自动运行 `npm ci` 与 `npm run verify`。

## 项目结构

| 目录 | 内容 |
| --- | --- |
| src/ | React 界面、案件状态、材料处理、撰写流程、附图与导出 |
| server/ | 模型协议适配、Agent、检索与本地开发服务 |
| worker/ | 公网入口、公告确认、请求边界和共享配额 |
| scripts/ | 验证、发布扫描和部署辅助 |
| docs/ | 部署、模型接入、使用公告与验证记录 |
| public/ | 页面资源和通用示例材料 |

## 开源与贡献

源码采用 **Apache-2.0**，不包含维护者 API Key、私人发明材料、历史备份或生成文档。第三方依赖、资产和商标保留各自许可与权利。

[贡献指南](CONTRIBUTING.md) · [许可证](LICENSE) · [第三方声明](THIRD_PARTY_NOTICES.md) · [安全报告](SECURITY.md)

<a id="contributors"></a>

## Contributors · 贡献者

感谢以下贡献者对 PatentFlow AI 的参与和支持（按登记顺序排列）：

| 贡献者（邮箱） |
| --- |
| `kprxr.660@qq.com` |
| `thundersark@gmail.com` |
| `1905099627@qq.com` |
| `1795925828@qq.com` |
| `3393205784@qq.com` |

本名单由项目维护者登记；GitHub 侧栏的 Contributors 根据真实提交记录自动统计，与本名单独立。

---

<div align="center">

**把时间留给技术思考，让初稿整理更高效。**

[打开 PatentFlow AI →](https://patentflow-ai.patentflow-ai.workers.dev/)

</div>
