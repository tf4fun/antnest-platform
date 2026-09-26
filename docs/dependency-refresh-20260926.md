# 阶段四前依赖更新与完整回归（2026-09-26）

状态：当前服务范围的依赖更新与完整自动化回归已完成。
阶段四新服务不在本轮范围内；人类样式确认、真实读屏器和非本机部署验收仍单列。

本轮以新声明、锁文件和候选镜像重新验证，包含原有 UI、控制命令及资源 ID 修改。
服务单元/合同/组件、真实数据库、构建与质量门禁通过；32 个既有 Docker 队列入口
完成业务与适用结构/隐私验收。原始非零严格 Trace 退出码保留：只接受逐项复核的
时钟/SDK 计时例外和明确的拒绝、取消、故障注入预期结果，SIGKILL 诊断单列。

实际修复包括 ACP v2 接受响应补齐 SDK 1.5.0 要求的持久化 `messageId`、Controller
撤权期间重复调度，以及 Temporal 单节点正常重启的内部广播地址漂移。
回归工具同步 Jaeger 2.21 的查询接口/属性、统一资源 ID 和持续可用的控制命令输入。
未通过放宽业务断言或改写原始 Trace 来完成本轮验收。

## 更新规则与共享边界

- 以官方 registry 和正式 release 为准，使用当前稳定且相互兼容的版本；不安装 beta/RC，不强制忽略 peer dependencies。
- ACP 消费方与服务方统一到 SDK 1.5.0，继续使用包内 v1 schema 作为合同依据；`session/fork` 仍按 UNSTABLE 能力处理，不增加 F07 elicitation 功能。
- TypeScript 暂用 6.0.3：最新 typescript-eslint 8.70.1 的 peer 范围是 `<6.1.0`，尚不支持 TypeScript 7.0.2。
- Node 生产镜像采用 24.21.0 LTS；Go 1.27.1，Rust 1.98.1。OpenTelemetry 的稳定包和实验包按各语言官方配套版本更新。
- Debian Bookworm / distroless Debian 12 保留原受支持的系统系列，通过 `--pull` 刷新基础镜像；不将操作系统主版本迁移混入本轮依赖适配。
- 保留当前人类验收环境及数据。PostgreSQL 本轮为 17.11，18 主版本迁移另行安排；数据库、Temporal 和跨服务测试使用独立 Compose 项目及一次性卷。
- 单元测试留在所属服务，集成/E2E 源码留在根 `tests/`；原始日志、版本查询结果、工作区备份保存在 Git 忽略的 `artifacts/verification/dependency-refresh-20260926/`。
- 所有验证串行执行。时钟相关 Trace 告警沿用已批准的验收边界；新增业务、结构、隐私和错误 span 失败必须处理。SIGKILL 故障诊断单列。

## 服务交付批次

每批先更新所属服务的声明、锁文件、必要适配、文档和测试，再通过本地门禁。消费者未升级前不宣称整体功能完成。

| 批次 | 所属范围 | 本地门禁 | 状态 |
| --- | --- | --- | --- |
| 1 | agent-acp-service：ACP/MCP/OTel/HTTP 与 TS 工具 | 类型、lint、构建、841 单元、162 合同集成、249 PostgreSQL、9 v1 审计 | 所属门禁与最终集成通过 |
| 2 | agent-ui：SDK、React、Vite、Vitest、Playwright | 242 服务端、159 前端单元、134 组件＋2 个新增生命周期输入用例、16 HTTP/SSE、2 内存、5 浏览器/SSR | 所属门禁与最终集成通过 |
| 3 | admin-console：Go、React、Tailwind、构建工具 | 138 Go/race、lint、构建；113 前端单元、280 组件、桌面/手机目录和审计浏览器 | 所属门禁与最终集成通过 |
| 4 | identity-service | 本地 race/构建/lint；真实数据库 144 测试、无跳过 | 所属门禁与最终集成通过 |
| 5 | runtime-controller | 本地 race/构建/lint；真实数据库与已安装镜像合同 | 所属门禁与最终集成通过 |
| 6 | agent-controller：Temporal SDK/OTel | 本地 race/构建/lint；真实数据库与 Temporal 551 测试、无跳过 | 所属门禁与最终集成通过 |
| 7 | edge-gateway | 108 Go 测试、race、构建、lint，无跳过 | 所属门禁与最终集成通过 |
| 8 | antnest-runtime：Rust/MCP/OTel | 宿主 fmt/clippy、104 单元/合同、1 fixture；Linux 143 测试、1 CLI、1 fixture | 所属门禁与最终集成通过 |
| 9 | runtime-egress：Rust/TLS/PG/OTel | 宿主 fmt/clippy、111 测试；Linux 112 测试；10 数据库测试 | 所属门禁与最终集成通过 |
| 10 | 平台镜像、数据库、Temporal、Jaeger、共享工具 | 全量构建、隔离数据库、部署合同、候选冻结 | 通过 |
| 11 | 显式跨服务集成批次 | 全仓质量门禁、数据库、完整 Docker 矩阵、UI 命令和页面联动 | 按上述 Trace 边界通过 |

## 官方版本依据

- [ACP SDK 1.5.0](https://github.com/agentclientprotocol/typescript-sdk/releases/tag/v1.5.0)，其余 npm 版本及 peer 约束来自 npm registry。
- [Go 正式发布](https://go.dev/doc/devel/release)、[Rust stable 发布元数据](https://static.rust-lang.org/dist/channel-rust-stable.toml)、[Node 官方发布](https://nodejs.org/en/blog)。
- [PostgreSQL 支持版本](https://www.postgresql.org/support/versioning/)：18.6 为最新稳定版，19 仍为预发布；17.11 为当前 17 系列补丁版。
- [Temporal 1.32.0](https://github.com/temporalio/temporal/releases/tag/v1.32.0)、[Jaeger 2.21.0](https://github.com/jaegertracing/jaeger/releases/tag/v2.21.0)、[Python 正式发布](https://www.python.org/downloads/)（3.14.7）。
- [Vite 升级指南](https://vite.dev/guide/migration)、[Vitest 升级指南](https://vitest.dev/guide/migration/)、[Tailwind 升级指南](https://tailwindcss.com/docs/upgrade-guide)。

## 分批执行记录（保留过程与失败历史）

当前工作区原有未提交修改已单独备份，继续纳入本轮回归。

### ACP 服务批次

SDK 1.5.0、MCP client/server 2.1.0、OTel 0.222.0/2.11.0、eventsource-parser 4.1.1、
ipaddr.js 2.5.0、undici 8.11.2、zod 4.6.5、Vitest 5.0.2，其他直接开发依赖也已更新。
TypeScript 保留兼容的 6.0.3。生产基础镜像锁定 Node 24.21.0 LTS。

升级首先复现 v2 `PromptResponse.messageId` 缺失：SDK 1.5.0 不再接受空对象。
修复返回已接受、已持久化的 `userMessageId`，回归同时验证接受响应、实时用户消息及
尚未结束的异步 Run；没有等待 Run 完成才返回。v1 方法保持 42 个，268 个 schema 定义。
新增 notice 继续按未协商的实验能力处理，tool name 的稳定性标注跟随 SDK 更新。

`acp-local-02`、`acp-contract-02`、`acp-database-01` 合计覆盖类型、lint、构建、841 单元、
162 协议集成、249 真实 PostgreSQL 和 9 SDK 审计，均通过。最初失败日志保留在
`acp-local-01`、`acp-local-02` 和 `acp-contract/acp-v2-message-id-red.log`。
数据库测试项目已清理，环境比较无变化。这里的宿主本地测试使用 Node 26.8.2；
最终生产 Docker 验证使用 Node 24.21.0，后续本地批次也切换到该 LTS。

### Agent UI 批次

SDK/OTel 与 ACP 服务对齐，React/React DOM 19.3.0、lucide-react 1.48.0、
Vite 8.3.1、React Vite 插件 6.1.1、Vitest 5.0.2、Playwright 1.63.0、
jsdom 30.1.1，TypeScript 6.0.3。声明均使用精确版本并更新锁文件。
TS 6 要求 SSR 使用的 Node 类型显式声明；客户端构建入口迁移到 Vite 8 的
`rolldownOptions`。侧边栏旧断言改为打开工作环境菜单后检查当前 Agent 的实时状态，
保留其他 Agent 只显示管理状态的原意。

Node 24.21.0 上的 `ui-local-02`、`ui-local-03` 和 `ui-browser-01` 通过表中全部门禁。
Chromium 153 覆盖 HTTP/SSE、刷新、Session/工作环境切换、SSR hydration、身份隔离、
层级路径及前进后退。原失败（显式类型、旧状态定位）保存在 `ui-local-01/02`。
内存测试继续包含大对象负对照，未放宽阈值。真实 Docker、控制命令浏览器联动与
跨服务组合留在最后显式集成批次。

### Admin Console 批次

前端与 Agent UI 对齐 React/Vite/Vitest/Playwright/TypeScript，Radix Dialog 1.1.23、
Slot 1.3.3、tailwind-merge 3.7.0。Tailwind 4.3.3 使用同版本官方 Vite 插件；
移除旧 PostCSS/autoprefixer 声明及配置，颜色转为 CSS theme，基础样式放回 base layer，
迁移改名的阴影、圆角、模糊和 outline 类以保留表现。先保留了旧 PostCSS 构建失败证据。

Go 模块最低版本 1.27.0、工具链/镜像 1.27.1；OTel 已是最新 1.46.0，
grpc、grpc-gateway、x/net、x/sys、x/text 及相关间接依赖更新到本轮解析的稳定版本。
根 go.work 同步工具链要求，lint 使用官方 2.14.0。

`console-local-02`：类型、113 单元、280 组件、构建和两套桌面/手机浏览器检查通过，
无溢出、浏览器错误或意外审计请求；截图另存 `console-browser/`。
`console-go-01`：138 顶层 Go 测试（161 子用例）、race、构建和 lint 通过，无跳过。
数据库/实际栈仍由最终批次验证，不以合成浏览器 fixture 代替。

### Identity 批次

Go 1.27.1、go-oidc 3.21.0、pgx 5.11.0、OTel 1.46.0 / log 0.22.0、
otelslog 0.20.1、otelhttp 0.71.0、x/crypto 0.57.0、x/oauth2 0.37.0。
`identity-local-01` 的 race、构建、lint 通过；132 个顶层测试中 22 个数据库相关用例
因未配置 PostgreSQL 跳过，必须在最终隔离数据库批次补齐，不能算作完整服务验收。

### Runtime Controller 批次

Go 1.27.1、pgx 5.11.0、OTel 1.46.0 / log 0.22.0。
`runtime-controller-local-01` 的 194 个顶层测试（183 子用例）、race、构建、lint 通过。
32 个跳过项包括 PostgreSQL、已安装镜像合同和显式进程故障诊断；前两类在最终批次补齐，
SIGKILL 诊断继续与稳定回归分开记录。

### Agent Controller 批次

Go 1.27.1、Temporal SDK 1.49.0 / API 1.63.6、pgx 5.11.0；OTel 保持当前最新的
1.46.0 / log 0.22.0，间接依赖同步更新。
`agent-controller-local-01` 的 429 个顶层测试（486 子用例）、race、构建、lint 通过。
201 个环境相关跳过项仍需数据库和真实 Temporal；此处不宣称 Workflow 完整验收。
已对照 [SDK 发布说明](https://github.com/temporalio/sdk-go/releases/tag/v1.49.0)：
当前未使用受序列化上下文变更影响的自定义 DataConverter，也未使用实验随机流。

### Gateway 批次

Go 1.27.1、OTel 1.46.0，更新 grpc / x/net / x/sys / x/text 等间接依赖。
`edge-gateway-local-01`：108 顶层测试（127 子用例）、race、构建、lint 通过，无跳过。

### Runtime 批次

Rust 1.98.1、rmcp 3.4.1、OTel 0.33.0、tracing-opentelemetry 0.34.0，其他 Rust
直接依赖及锁文件更新。MCP 迁移到 ServerConfig/ClientConfig 类型别名；SHA2 0.11
改为逐字节十六进制输出，并用固定向量保护原有 16 字符工具名称后缀。
Rust 1.98 clippy 要求的定长分块迁移保留奇数字节余数处理。

`runtime-local-03` 的 fmt、clippy、104 测试、1 fixture 测试通过；早期编译失败保留于
`runtime-local-01/02` 和 `runtime-hash-red.log`。macOS 不编译的 Linux Executor
合同必须继续在镜像内执行。生产镜像更新为 Python 3.14.7 + 官方 Node 24.21.0，
替换原 Debian 发行版 Node；其运行效果仍待实际容器验证。

### Egress 批次

Rust/OTel 与 Runtime 对齐；rustls 0.23.45、tokio-postgres 0.7.18、
tokio-postgres-rustls 0.14.0，其他直接依赖及锁文件更新。SHA2 适配复用服务内的
摘要编码函数，固定向量验证两种已发布策略和两个数据库迁移文件的历史校验值。
新 clippy 要求的数组分块调整保留校验和余数字节；移除一个不再需要的测试导入。

`egress-local-04` 的 fmt、clippy、111 测试通过，10 个真实数据库测试显式忽略，
留到数据库批次；Linux 命令进程和数据平面留到镜像/实际栈验证。原始失败日志保留于
`egress-local-01/02/03`，没有放宽 lint 或测试要求。
`build-02/build-egress` 随后通过 Linux fmt/clippy、112 测试和 release 镜像构建；
10 个 PostgreSQL 用例仍由最终数据库批次补齐。

### 共享合同与最终集成批次

PostgreSQL 17.11、Temporal Server/admin-tools 1.32.0、Jaeger 2.21.0，
共享 Node 夹具更新为 24.21.0。`platform-local-01` 的 19 个部署/就绪合同通过，
旧镜像断言的失败另存 `temporal-image-red.log`。历史回放目录保留原始版本。

根 E2E 的 managed MCP、persistence、restart 和 Stage 2 消费方统一验证 v2
`messageId` 非空且对应同一 Session 的持久化用户消息；接受响应不代表 Run 结束。
先保留 `sdk-consumers-red` 的 7 项失败，再通过 `sdk-consumers-01` 的 27 项合同。

`build-01` 完成三项基础镜像拉取及 Runtime Linux 候选构建；Linux fmt/clippy、
143 个测试、1 个 Executor CLI 合同、1 个 MCP fixture 测试通过。
队列在下一镜像开始前主动暂停，原始退出码 125 保留；剩余九项构建由
`build-continuation.json` 接续，不将暂停记成失败通过。

全仓质量检查中，旧根 UI 夹具格式与新版 Vitest matcher 的 unsafe-any 类型问题
已修正；原始失败保留在 `quality-01/02`。`quality-03` 的格式、lint、`make test`
全部通过（全仓测试 533 秒）。实际浏览器控制命令联动的真实栈结果见下文。

`build-02` 的剩余九份候选镜像全部成功；`fixture-build-01` 和
`managed-image-build-01` 生成独立 MCP 测试镜像。基线冻结时发现 Node 夹具仅在
BuildKit 缓存中，已通过 `build-03/pull-node-fixture` 显式安装，并补入构建清单。
`candidate-environment.json` 固定 48 个镜像引用；原有 24 个容器、290 个卷、25 个
网络均未改变。`:local` 测试别名已指向新候选，原标签映射另存，保留环境没有重启。

`database-01` 四项门禁全部通过：SDK 9 项真实数据库审计、各服务 PostgreSQL/
Temporal 回归、持久化专项、Runtime 已安装镜像合同。Egress 10 项、ACP 249 项、
Identity 144 项、Agent Controller 551 项（571 子用例）通过；Runtime Controller
数据库批次 202 项中的两个镜像用例在最后独立执行通过。每项结束后资源和镜像比较
均无变化。该批原始子进程日志还包括
`artifacts/verification/dependencies/postgres-1790398998-23879.log`。

`additional-docker-01`：Runtime PID 1/MCP 的 10 项真实容器检查（包括官方 JS
客户端关闭后的成功/失败 Trace）、Gateway 和 Console 正常信号/重启检查通过。
UI 容器负载的 180 轮观察者检查通过，采样峰值约 92 MiB（原阈值 384 MiB），
但后续 17 MiB 输出检查失败，整个 UI 容器门禁仍记失败。诊断发现夹具宣告水位 38，
重放却始终只返回初始水位 9，导致 278 次加载也无法恢复；原始日志和报告已归档。
修正夹具为先保存事件再公开水位，重放使用完整历史及对应切点；未改生产 Bridge，
未删断言或提高时间/内存阈值。`additional-docker-02/ui-container-soak` 按相同条件
复测通过（391 秒），覆盖完整输出、容量回收和正常退出，资源比较无变化；该轮内存
及退出报告已单独归档。随后新增浏览器脚本误用普通消息的 `Send message` 定位，
控制命令实际使用 `Run command`，因此未发出请求并超时。该失败保留；修正定位后
`additional-docker-03` 的命令/页面联动和完整历史两项通过，资源比较无变化。
`ui-controls-final-01` 进一步验证刷新后历史文本已完整恢复，再保存稳定界面截图，
也通过。11 个后端命令、配置 CAS、定向 Stop、fork、权限/CSRF/撤权均有实际栈证据；
浏览器实际输入 `/model`、`/thinking`、`/mode`、`/new`、`/resume`、`/fork`，检查双页
SSE 同步、控件、URL、侧边栏、刷新及模型请求数未增加。

`recovery-docker-01` 发现一条旧运行提示文案断言；更新为当前“运行中仍可使用命令”
提示后，`recovery-docker-02` 两项全部通过。真实栈覆盖 80 次固定执行负载、Bridge/
Gateway 重启、权限等待、超时、注销、身份过期和撤权；另有独立的转发前及到达未提交
窗口崩溃对账。故障注入仅检查业务恢复，不要求被强杀进程导出完整 Trace。
本机固定负载采样：浏览器 JS 堆峰值 31.33 MiB、Bridge 234.8 MiB，交互就绪 1.78 秒；
温热 HTML 响应头 p90 重启前后约 16.3/15.0 毫秒，原性能与内存阈值全部通过。
两项资源比较均无变化；当前固定负载不替代更高容量或非本机部署验收。

`matrix-01` 的 SDK Docker 和 Stage 1 通过。Stage 2 的 249 项数据库测试、9 个业务
场景和凭据隐私检查通过，但 Trace 读取器产生状态码及生命周期祖先误报，队列按原始
退出码 1 停止，环境比较无变化。原始 span 的父子链完整，HTTP 状态已被 Jaeger 的
v1 查询转换器从 `http.response.status_code` 显示为 `http.status_code`。
已对照 [Jaeger 2.21 的适配器](https://github.com/jaegertracing/jaeger/blob/v2.21.0/internal/storage/v2/v1adapter/translator.go)
和其依赖的 [Collector 转换实现](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/v0.160.0/pkg/translator/jaeger/traces_to_jaegerproto.go)：
本轮修正共享读取器及三个独立读取入口，接受两种属性名但拒绝冲突值，不修改原始
Trace、不改变状态码、父子关系或隐私要求。先复现 3 个失败，再通过 1,055 项相关
合同；证据在 `trace-adapter-red` 和 `trace-adapter-01`。生产服务与候选镜像未改变。

`matrix-stage2-02` 复测的 249 项数据库和 9 个业务场景通过；48 条审计、6 条执行、
2 条生命周期和 4 条 Gateway 连接证据通过，结构失败为零，隐私检查通过。
严格 Trace 的 39 项失败只包含已批准边界内的 clock-skew 告警（44 种实际告警值），
原始退出码 1 不改写；独立 `review.json` 记录分类，资源/镜像比较无变化。

Jaeger 2.21 还[移除了旧搜索接口](https://github.com/jaegertracing/jaeger/pull/9260)。
11 处验收/诊断采集入口改用共享 `tests/support/jaeger-search.mjs`：通过 v3 summary
搜索保留原服务、方法、标签、数量和时间范围，再按 ID 读取完整原始 Trace。
覆盖多条结果、无结果、HTTP/响应错误、取消、重复/非法 ID、详情不匹配和未读
分页；不会通过丢弃 warnings 或父 span 来通过验收。首次 819 项消费者检查中
818 项通过，唯一失败为“重复 publication”更早被新读取器拒绝后的旧错误文案断言；
更新精确断言后，55 项相关检查通过。原始失败及空流的先失败后通过证据分别保留在
`jaeger-search-consumers-01/02`、`jaeger-empty-stream-red`，接口缺失的最初失败在
`jaeger-search-red`。历史诊断报告的严格失败和原始 Trace 均未修改。

`matrix-02` 的 Runtime Controller E2E 和 Identity 核心（本地、SCIM、OIDC）通过，
后者严格 Trace 也通过。Stage 3 业务通过，但搜索读取器最初使用了 IDL 中的 POST/
流式约定，实际镜像只提供 GET 和直接 JSON，导致采集失败。队列在 Identity 清理后
主动停止（125），没有把该失败计入时钟例外。已对照
[发行版 HTTP 路由实现](https://github.com/jaegertracing/jaeger/blob/v2.21.0/cmd/jaeger/internal/extension/jaegerquery/internal/apiv3/http_gateway.go)
修正读取器和夹具；该轮失败保留，最终方式以实际发行版 HTTP 行为为准。

`jaeger-http-01` 的 111 项最终 HTTP 合同/本地 CLI 检查通过；前述 POST/流式试验
记录仅作为失败历史，最终实现为 GET 和直接 JSON。`matrix-stage3-03` 的 Stage 3
复测通过业务及 5 条生命周期、29 条 Session 调用链检查，只余已批准时钟告警，
原始退出码 2 与独立分类记录均保留。资源和镜像比较无变化。

`matrix-03` 的 Identity/Agent 访问控制及 ACP Session 业务、结构检查通过。
授权拒绝、过期、撤权和显式 Identity 停机用例的预期错误 Trace 单独记录；正常
执行的 Run 没有错误，其他告警均为时钟偏差。Managed MCP v1 的 6 个 Run、
重建 drain、历史保留和删除清理通过，调用链仅有时钟告警。

ACP closeout 则发现真实 Controller 调度问题，不能归入时钟例外：自动 Disable
尚未结束时，轮询再次选择同一 Agent，用更新的 aggregate sequence 派生新请求，
产生被生命周期冲突/已停用状态拒绝的额外 Temporal Workflow。原始失败保留在
`matrix-03/acp-closeout`。队列在 MCP v1 清理后主动停止（125）。新增真实数据库
组件断言在 `controller-offboarding-red` 复现一次活动 Disable 被提交三次；修复
仅在 Controller 待处理查询排除已有 lifecycle owner 的 Agent。失败重试、冷却和
查询后的并发准入检查继续保留，所属服务门禁结果如下。

`controller-offboarding-01` 的 551 项测试（571 子用例）及 race 全部通过，无跳过，
包含新重复准入断言、失败后的冷却重试、身份恢复后必须显式 Enable。
`controller-offboarding-03` 的 21 项队列合同、Controller lint、构建与镜像构建
通过；新镜像为 `antnest/agent-controller:dependency-refresh-20260926-offboarding`
（`sha256:a9516efa0de81bbe51b9fd0fd3cb090538cff4b9c4e376acf837ae26e7fe505f`）。
原候选标签保留，仅更新隔离测试使用的 Controller `:local` 别名。
`candidate-controller-environment.json` 重新冻结 48 个引用；24 个原有容器、290 个卷、
25 个网络及其运行状态均未改变。

同时修复验收队列只识别部分失败文案的问题：任意顶层 `status: failed` 或明确
`business/topology failed` 都会停止后续用例，即使 Make 将子进程退出码映射为 2。
`suite-failure-red` 保留三项先失败证据；严格 Trace 的非零诊断仍保留并逐项复核。
初次宽泛文案匹配误识别了通过的测试标题，已由独立负对照复现并收紧为行首真实
报告；该次门禁停止记录和修复证据也保留，不改写为通过。

`matrix-stage2-04` 的新候选复测在 ACP 数据库门禁停止：248/249 项通过，唯一失败
是审批用例用默认 1 秒轮询等待“1 秒 Run 超时后”的持久化收尾。业务超时必须先到达，
再完成取消和数据库提交，原等待窗口与被测截止时间竞争。该用例单独改为 5 秒收尾
等待，生产 Run 截止时间仍为 1 秒，取消结果、无 Tool 副作用等断言全部保留；
不会以重试原用例代替修复。失败日志及资源核对保留。
`permission-deadline-01` 的 19 项真实数据库审批协议检查全部通过，随后恢复 Stage 2
完整门禁。
`matrix-stage2-05` 随后通过 249 项数据库测试、9 个业务场景、48 条审计、6 条执行、
2 条生命周期及 4 条 Gateway 连接的结构和隐私门禁；37 项严格失败均为已批准的
时钟告警，原始退出码 1 保留，资源核对无变化。`matrix-04` 开始新 Controller
候选的其余 28 项平台回归。

`matrix-04` 已通过基础流程、Identity 核心/访问控制、Agent 访问控制和 ACP Session。
原失败的 ACP closeout 复测也通过：8 次正常执行、14 次私有历史回放、4 次自动
停用、8 次 Agent 拒绝及 40 次 Session 隔离拒绝，90 条请求 Trace 的结构检查完成。
未再出现多余的生命周期错误 Workflow；4 条撤权拒绝 Trace 和其他显式负例仍保留
严格错误，45 种时钟告警值另行分类，原始退出码 2 不改写。各项资源比较无变化。

历史矩阵中的 `acp-restart` 是显式 SIGKILL 的中断恢复诊断，与正常关停门禁分开
记录；它验证持久化状态、回放、重复副作用和恢复后的执行，不把被强杀进程未导出
Span 当作稳定运行回归失败。正常信号退出使用此前独立通过的正常关停专项。

`matrix-04` 的 MCP v1/v2、RPC 响应丢失、ACP 持久化/中断恢复及工具进度通过。
文件观察的 16 个业务场景和调用链也通过，但旧用例将预期 Tool 失败写作顶层
`status: failed`，被新队列的严格失败识别拦下。报告改用 `status: file_case_passed`
和独立 `tool_status`，继续保留预期失败及最终严格 Trace 结果；生产代码不变。
14 项文件观察合同/组件检查通过；队列原始停止记录保留，文件观察将连同后续
15 项在 `matrix-05` 复测/接续。

`matrix-05` 的文件观察、结构化计划、工具审批、原生斜杠命令、多模态、Session
用量成本、生命周期基础和网络更新均通过业务及结构门禁。文件观察预期的失败编辑、
不支持的多模态输入和运行中生命周期拒绝继续保留错误 Trace，不计作正常执行错误。
多模态两条本地拒绝路径保留 -318 / -161 微秒的模型结束至收尾时间差；代码的
`await`/`finally` 顺序保证模型 Span 已结束后才进入收尾。
`final-quality-01/sdk-timing-diagnostic.log` 用实际安装的 OTel 2.11.0、Node 24.21.0
独立顺序调用 10,000 对 Span，每次确认前一个已结束再创建后一个，9,924 对仍有
负时间差，最小 -802,519 ns。诊断不加载业务代码、不修改时间戳，不将随机重叠率
作为稳定测试断言；两处微秒计时结果纳入既有 SDK 计时例外。

正常关停的首轮在 Temporal 成员发现 bootstrap 时退出，健康检查阻止继续启动，
属于真实部署恢复失败，不能作为 Trace 时钟例外。证据保留在 `matrix-05` 和
`lifecycle-shutdown/antnest-lifecycle-33a6cc44`。增加失败启动日志保留上限并显示
恢复阶段后，`shutdown-diagnostic-01` 完成 10 个服务正常退出/同容器恢复、两条
SSE 远端结束、ACP 1001、同 Session/Runtime/工作区保留、无模型调用及删除。
6 条调用链结构通过，仅有已声明的关停取消错误和时钟告警；首次 bootstrap
失败根因尚未证实，继续复测，不能以这一轮通过宣称已修复。

后续 `matrix-06` 捕获 Temporal 同一容器重启后广播地址 `.7 → .4`，bootstrap
仍选中旧地址并发生 30 秒加入超时；本轮重试恢复成功，但不能作为无问题通过。
随后完成[单节点广播地址批次](temporal-membership-revalidation-20260926.md)：
只将同容器四角色的内部广播地址固定为 loopback，frontend 继续监听 wildcard。
部署合同先失败后通过，20 项部署/就绪合同通过，70 项关停证据合同/组件通过。
组件首次运行的回环端口被沙盒 EPERM 拒绝，切换到允许本地网络的执行环境后通过；
该环境失败仍保留，不改业务断言。镜像不变，Compose 配置随后进入 `matrix-07`
全栈正常关停、备份恢复、丢失重建、中断恢复和浏览器集成。

`matrix-06` 的 Runtime 健康验收通过：连续三次失败进入 unhealthy 并阻止 ACP
访问，同进程恢复保留绑定，正常 Runtime 重启要求显式重建，工作区保持完整。
两次 60 秒空闲容器 CPU 分别约 0.49% / 0.47%，校准负载明显可分辨，无模型调用。
仅余 4 种时钟告警值；此项不因 Temporal 广播地址调整重复执行 CPU 校准。
队列在该项清理后按预设暂停文件退出 125，未开始备份恢复。

`final-quality-01` 的 SDK 计时诊断、全仓格式、Node lint/类型、测试存储规则和
差异空白检查全部通过。Temporal 新增文件将补做相关最终静态核对。

`matrix-07` 的正常关停通过新增实际广播地址/零 bootstrap 重试断言，备份恢复
也通过七数据库、双持久卷、三密钥及密文读取、文件元数据、会话/审计历史与恢复后
真实工具执行；历史回放未调用模型。两项仅有已声明的关停取消错误/时钟告警。

Runtime 丢失流程发现过时验收断言：统一 ID 合同已经使用 `event_<32 hex>`，
旧读取器仍要求 `runtime-condition-loss-`。实际事件类型、失效状态与公共/私有
记录已一致，失败停在格式检查。先用当前格式夹具复现旧检查失败，再修正格式并
增加旧前缀/截断 ID 的负例；事件类型、稳定派生、序号、归属和恢复检查未放宽。
13 项相关合同通过，生产代码/镜像不变，原 Docker 失败保留；最后五项从 `matrix-08`
继续，前两项通过结果不重写。

`matrix-08` 的在线/停机丢失恢复通过四次正常执行、两次预期不可用拒绝，
原会话和精确工作区字节保留、历史回放零执行副作用，再次 Controller 重启稳定。
已提交重建响应丢失后的正常双 Controller 重启也通过：均退出 0，终态子请求与
目标复用，重建事件仅一次，工作区保留；没有新的 Trace 结构或正常执行错误。

工作区协议随后通过跨连接取消、未决 Tool 事实保留、显式重建、离线回放与撤权
自动停用。错误 Trace 仅对应明确的取消、busy、Runtime barrier 和观察流撤权/结束。

浏览器前八项通过后，旧断言在重建期间等待整个输入框禁用而超时；当前控制命令
合同要求保留输入入口，普通 Prompt 仍必须阻止。组件补充 busy/offline 下普通发送
禁用、Enter 不提交、控制命令可用两例，22 项 Composer 检查通过。实际浏览器改为
先保留非空普通草稿，再验证重建时 Send 禁用、输入可编辑、草稿不丢、模型请求数
不增加，最后完成重建后的真实读工具执行。生产 UI/镜像不变，失败证据保留；两种
C4 入口通过 `matrix-09` 复测。历史 workspace-browser 名称现在是当前 C4 HTTP/SSE
入口的别名，不代表另一套 WebSocket UI。

## 最终验收与交付状态

`matrix-09` 两个 C4 入口均完成 12 项业务/页面/隐私检查，浏览器错误为零，分别
检查 63 / 65 个有限响应载荷。每轮 9 条正常执行 Trace 的完整结构和隐私检查通过，
覆盖 4 次真实 Runtime 工具调用，无错误 Span；显式取消另作业务结果记录，不按
正常完成 Trace 断言。严格结果仅剩 16 / 17 种时钟告警值，Make / 直接入口原始退出
码分别为 2 / 1。两个入口对应同一 HTTP/SSE 实现，属于入口与重复稳定性验证。
桌面审批和手机会话截图已检查；它们不代替用户的人类体验确认。

完整 32 项证据映射保存在私有 `final-matrix-review.json`，不覆盖此前失败：

| 范围 | 最终证据批次 | 项数 |
| --- | --- | --- |
| SDK Docker、Stage 1、Stage 2、Runtime Controller | `matrix-01`、`matrix-stage2-05`、`matrix-02` | 4 |
| Stage 3、身份/访问、ACP Session/closeout、MCP、故障恢复、工具进度 | `matrix-04` | 12 |
| 文件、计划、审批、命令、多模态、成本、生命周期与网络 | `matrix-05` | 8 |
| Runtime 健康、空闲 CPU 与恢复 | `matrix-06` | 1 |
| 修复后的正常关停、七数据库/双卷恢复 | `matrix-07` | 2 |
| 在线/停机 Runtime 丢失、提交后中断、工作区协议 | `matrix-08` | 3 |
| 当前 C4 及历史名称入口 | `matrix-09` | 2 |

此前 `quality-03` 的全仓 fmt/lint/test、`database-01` 的数据库与镜像合同、各服务
门禁和额外 UI 负载/命令/恢复专项一起构成完整证据。晚发现的 Controller 修改重新
通过全服务真实 PostgreSQL/Temporal/race、lint/构建并重建镜像；Temporal 配置经过
部署合同和实际全栈重启验证。新增验收代码经过针对性先失败后通过检查。
`final-quality-01` 与收尾 `final-admission-01` 的格式、lint/类型、存储规则和差异
空白门禁全部通过；没有用旧依赖结果替代新依赖回归。

最终 `final-retained-comparison.json` 与 `final-candidate-environment.json.comparison.json`
均为 unchanged：24 个保留容器、290 个卷、25 个网络，原环境镜像/启动时间/挂载/
状态未变，48 个候选镜像引用一致。`final-process-review.json` 无残留验证或
Playwright 进程。运行中的人类验收环境未重新部署；候选镜像与测试用本地别名
已更新，旧镜像和原别名映射保留。工作区原有修改未丢弃，与本轮更新一并保存。

本轮自动化范围没有未完成项。延后项仍为 PostgreSQL 18/系统主版本迁移、
不受当前 lint peer 支持的 TypeScript 7、NTP/专门计时治理、上游 F07 能力，以及
已约定的人工/外部环境验收。阶段四新服务应另开所属服务交付与显式集成批次。
