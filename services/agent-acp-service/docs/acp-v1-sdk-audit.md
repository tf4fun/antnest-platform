# ACP v1 SDK 反向审计（2026-09-26 更新）

## SDK 1.5.0 更新状态

2026-09-26 依赖升级已将本服务及机器清单切换到正式 SDK 1.5.0，
schema 为 268 个定义，SHA-256 为
`2a920d3c0f76443e07ffa7801443e3cdf008e2a3095e565581a0433fd728ce41`。
42 个方法及 25/17 稳定性分类均未改变；工具名称 `name` 从实验转为稳定可选字段。
新增的 `Notice`、`NoticeSeverity`、`NoticeCapabilities` 均为实验能力：当前不宣告、
不发送 `notice`。`session/fork` 仍为 UNSTABLE。

同包的 v2 接受响应现在要求 `messageId`，本服务返回与用户消息事件一致的持久化 ID。
升级后本地回归已通过：841 单元、162 协议集成、249 PostgreSQL 和 9/9 SDK 审计。
最终生产镜像及跨服务回归仍在执行。以下 GAP 章节保留 9 月 16 日原始审计历史；
本轮结果见[依赖更新与完整回归](../../../docs/dependency-refresh-20260926.md)。

## 结论与口径

9 月 16 日按用户最终确认的口径，以 **当时最新正式 `@agentclientprotocol/sdk@1.4.0`**
发布包为准，使用其 `schema/schema.json`、生成的接口定义及 SDK 实现；官网文档不作为
高于 SDK 的依据。GitHub [SDK v1.4.0](https://github.com/agentclientprotocol/typescript-sdk/releases/tag/v1.4.0)
与 [npm latest](https://registry.npmjs.org/@agentclientprotocol/sdk/latest) 均已核实。
当时项目已经锁定、安装此版本。协商的协议版本仍是 `1`。

**最初复现的 3 个失败均已修复，独立 SDK 审计 9/9 通过。**
修复限定在 ACP 服务；会话元数据一致性覆盖缺口已在后续批次复现并修复，见 COVERAGE-02。
既定的客户端 stdio MCP 偏离、F07 追问延期及实验通知覆盖范围继续披露。
本结论不等于实现了 SDK 的所有可选、实验或架构排除能力。

机器清单：[acp-v1-sdk-audit.json](acp-v1-sdk-audit.json)。它逐一记录 **42 个方法**的
方向、schema 定义名、必需字段、要求、实现路径、测试路径和结论。
其中 **25 个非实验接口、17 个实验接口**；实验属性来自 SDK 自身的 `UNSTABLE`
说明，包括经 `AgentCapabilities.nes` 继承的 NES/document 方法。
不能把 SDK 根入口的所有类型都当成稳定能力，也不能遗漏未实现的方法。

SDK schema 共 265 个定义，SHA-256：
`7f77702b34e0a0558e77220e9007bf8ee161a976bb8ac5021aba1b7e7b2c5708`。
清单保存 npm 查询时间、SDK git commit 与包完整性值。审计的代码基线为 `8c639ce`。
独立的 protocol release schema 只用于前期差异比对，**不作为本报告的准入标准**。

## 已修复的审计失败

以下保留最初失败的原因；GAP 编号继续作为正向回归用例，不使用 expected failure。

### GAP-01：隔离 `refusal` 上下文，保留审计历史

- **SDK 要求**：`StopReason.refusal` 规定被拒绝的用户 Prompt 及随后的内容不进入下一次 Prompt。
- **修复前**：下一轮模型输入仍含 `refused-user-marker` 和 `refused-answer-marker`；仅返回 refusal 值不足以满足要求。
- **修复**：[execution-repository.ts](../src/adapters/postgres/execution-repository.ts) 在提交 refusal
  终态的同一 SQL 语句中标记本 Run 消息 `context_excluded`，并删除覆盖这些消息的 checkpoint。
  [context-repository.ts](../src/adapters/postgres/context-repository.ts) 过滤上下文与最新 plan；
  原始内容、可见性及 ACP 回放不变。fork 复制排除标记。
- **升级**：[0008_refused_context.sql](../migrations/0008_refused_context.sql) 回填历史拒绝 Run、
  已有 fork 及嵌套 fork 的继承消息，清除被污染摘要；不会因 sequence 相同而误排除 fork 自己的后续 Run。
- **证据**：GAP-01、5 条真实 PostgreSQL 上下文路径（原会话、load、resume、fork、重启）、
  历史迁移及提交原子性测试通过。包含用户、回复、思考、工具与 plan，保留拒绝前安全历史及 checkpoint。
  注入标记更新失败时，Run 终态与 checkpoint 一并回滚；重试幂等。

### GAP-02：关闭与删除时释放会话输出订阅

- **SDK 要求**：宣告 close 后，必须取消在途工作并释放会话资源。
- **修复前**：关闭后发布配置，`readSessionOutput` 仍被调用；输出订阅只随连接结束而释放。
- **修复**：[session-output.ts](../src/transport/acp/session-output.ts) 按 Session key 关闭所有连接的
  订阅，并使正在等待的 attach 失效，防止关闭后重新挂接。v1/v2 close 排空最终输出后清理；delete 同步清理。
  活动 Session 删除造成的 `session_not_found` 只关闭该订阅，保留同连接其他 Session。
- **证据**：GAP-02、2 条订阅单元回归、v1/v2 × close/delete 的 4 条数据库回归通过，
  包括跨版本观察者、活动取消、重复操作、无后续读取、其他 Session 可用及 load/resume 后重新订阅。
- **边界**：SDK-03 继续验证普通 Run 在 close 返回时已持久化取消。
  SDK 未要求两个不同请求的响应帧按特定顺序到达，不将该顺序当作缺陷。

### GAP-03：返回取消确认，保留未知工具副作用保护

- **SDK 要求**：收到 `session/cancel` 后，即便底层操作抛错，Prompt 仍返回 `cancelled`。
- **修复前**：工具取消后的未知副作用使 Run 为 unresolved，v1 将其一律映射为 `-32023`。
- **修复**：[v1/agent.ts](../src/transport/acp/v1/agent.ts) 仅将
  `cancelled_tool_outcome_unknown` 映射为 `{ stopReason: "cancelled" }`。
  数据库仍保存 `unresolved` / `tool_effect_state=unknown`、原因及 Runtime 停止证据；不重放工具。
  其他 unresolved 仍为错误，v2 的 `_unresolved` 不变。
- **证据**：GAP-03 和 2 条数据库回归覆盖 Runtime 已停止/未确认停止。
  缺少停止证据时，下一次 Prompt 仍拒绝 `runtime_barrier_required`，工具调用数保持 1。
  生产 Docker 的真实 MCP HTTP 取消也验证了该响应及保护。

### COVERAGE-02：会话元数据跨连接与恢复一致性

- **确认的问题**：原路径只向提交 Prompt 的连接发送接受时的标题/时间；其他观察连接没有
  `session_info_update`，load/resume/fork 也没有当前信息，最终回复后的更新时间与列表可能不一致。
- **修复**：`PostgresSessionRepository.readOutput` 在同一 SQL 快照内读取标题、活动时间、
  transcript 与 cursor；所有已授权且已订阅该 Session 的连接走共享输出流发送当前信息。
  不再从接受请求的临时结果发送第二份通知，不需要新表、迁移或新协议字段。
- **行为**：首次建立订阅发送当前值，后续只发送变化值；替换 Prompt 输出订阅保留比较结果。
  新连接恢复时重新发送当前值；空标题明确为 `null`。load/resume 不改活动时间，fork 使用
  自己持久化的时间和继承标题。字段与 `session/list` 一致，不将历史元数据混入模型上下文。
- **回归**：[acp-session-info.postgres.test.ts](../../../tests/integration/agent-acp-service/e2e/acp-session-info.postgres.test.ts)
  的 8 条场景覆盖 v1/v2 混合观察者、在途及完成、配置/close、跨用户/Agent 拒绝、
  load/resume（含 v2 replay）与应用重启、new/fork；使用 SDK schema 校验。
  输出订阅单元回归覆盖无消息序号变化时的更新、相同值去重、清空标题及重新订阅。
- **部署边界**：Docker 探针新增官方 v1 HTTP 客户端的双观察者、列表、fork 和实际 ACP
  容器重启恢复场景；依赖仍为独立 PostgreSQL、受控模型/MCP。
  后续独立的[平台集成批次](../../../docs/acp-platform-integration.md)已通过真实 Gateway/Runtime/UI
  的 11 项浏览器检查，包含双页面标题/时间与列表、刷新一致性；严格 Trace 仍因已记录时钟告警失败。
  浏览器采用 v1，不将服务级 v2、fork、进程重启场景扩大为浏览器覆盖。

## 25 个非实验接口逐项核对

方向按 SDK 的 `x-side` 解读：`agent` 是客户端调用 Agent；`client` 是 Agent 调用客户端。
客户端反向接口没有服务端 handler 是正常的，不能用向 Agent 发同名请求得到 `-32601` 来证明它已实现。
下表“通过”仅指所列服务级场景；完整定义、具体代码和测试路径见机器清单。

| 接口                         | 官方条件/关键要求                                         | 实现及测试结论                                                                                   |
| ---------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `initialize`                 | 基线；版本协商、能力声明和初始化门禁                      | 已实现；0/1/2/99 协商、重复初始化、初始化前所有已注册 Session 请求拒绝、原始传输测试通过         |
| `authenticate`               | 仅调用已宣告认证方法；terminal auth 另有客户端能力条件    | A2 架构排除，无认证方法；明确拒绝测试通过，不能标为已实现                                        |
| `logout`                     | 由 Agent 宣告 logout 能力                                 | A2 架构排除，不宣告；明确拒绝测试通过                                                            |
| `session/new`                | 基线；cwd、MCP、独立 Session                              | 空 MCP 平台配置通过；客户端 stdio MCP 仍为 PROFILE-01 偏离                                       |
| `session/load`               | 宣告 `loadSession`；完整历史先于响应                      | 顺序、配置、继续使用测试通过；MCP 同 PROFILE-01                                                  |
| `session/list`               | 宣告 list；cwd/cursor、Session 元数据、分页               | 52 条分页、无丢失/重复、身份隔离、空过滤、schema 测试通过                                        |
| `session/delete`             | 宣告 delete；从列表移除                                   | 幂等、所有权、保留审计、活动执行及多连接订阅清理通过                                             |
| `session/resume`             | 宣告 resume；不重放历史，MCP 可省略                       | 无历史回放、重新使用、配置恢复通过；MCP 同 PROFILE-01                                            |
| `session/close`              | 宣告 close；取消在途工作并释放资源                        | 活动取消、跨连接释放、恢复通过；GAP-02 已修复                                                    |
| `session/set_mode`           | 使用 Session 提供的 modeId                                | 实际配置持久化/通知/执行通过；新增 `SDK-02` 验证运行中修改只影响下一 Run                         |
| `session/set_config_option`  | 使用已提供配置；响应完整配置列表                          | model/mode/thinking、非法值、冲突、跨连接通知、恢复和下轮实际效果通过                            |
| `session/prompt`             | 基线；内容门控、更新和终态                                | 基本执行、5 类内容、拒绝上下文及未知效果取消回归通过                                             |
| `session/cancel`             | 基线通知；取消后返回 cancelled                            | 模型/审批/持久化竞态及未知工具效果取消通过；恢复保护保留                                         |
| `session/update`             | 基线反向通知                                              | 11 类非实验更新均有业务路径及 schema 断言；元数据跨观察者/恢复一致性回归通过                     |
| `session/request_permission` | 需要授权时反向请求；有效选项/取消结果                     | once/always 的允许与拒绝、实际工具派发、撤权、超时、HTTP 反向请求通过；不是 elicitation          |
| `fs/write_text_file`         | 客户端 `fs.writeTextFile` 为真才可调用                    | A3 架构排除；不调用，无正向实现/测试；Runtime 写文件不算实现本接口                               |
| `fs/read_text_file`          | 客户端 `fs.readTextFile` 为真才可调用                     | A3 架构排除；不调用，无正向实现/测试                                                             |
| `terminal/create`            | 客户端 terminal 能力                                      | A3 架构排除；无客户端 terminal 创建实现/测试                                                     |
| `terminal/output`            | 同上；输出、截断和退出状态                                | A3 架构排除；无正向实现/测试                                                                     |
| `terminal/release`           | 同上；释放 terminal 资源                                  | A3 架构排除；无正向实现/测试                                                                     |
| `terminal/wait_for_exit`     | 同上；等待退出状态                                        | A3 架构排除；无正向实现/测试                                                                     |
| `terminal/kill`              | 同上；终止执行，区别于 release                            | A3 架构排除；无正向实现/测试                                                                     |
| `elicitation/create`         | 客户端 form/url 能力；结构化追问                          | **非实验但未实现**；F07 已批准延期，无 ACP 正向业务/协议证据                                     |
| `elicitation/complete`       | URL 追问完成后通知                                        | **非实验但未实现**；同 F07，不能因没宣告或缺 SDK 桥而称为不适用                                  |
| `$/cancel_request`           | 协议通知；原请求必须返回合法结果或 `-32800`，可不终止业务 | SDK 管理请求信号；新增 `SDK-04` 验证在途请求正常响应、未知 ID、无重复响应及不误触发 Session 取消 |

`set_config_option` 的 boolean 形式已经存在于 SDK，但当前服务只提供 select 配置。
未提供 boolean 选项不等于必须凭空新增产品开关；未来提供时必须按
`ClientCapabilities.session.configOptions.boolean` 协商。`additionalDirectories`
也是可选能力，目前按 A3 不宣告并明确拒绝，不能称为已实现。
terminal authentication 是新的认证方法形式，仍受 A2 和客户端 `auth.terminal` 条件约束。

### 必须持续披露的范围

- **PROFILE-01**：SDK 的 `McpServer` stdio 分支要求所有 Agent 支持此传输。
  `mcpCapabilities: {}` 只让 HTTP/SSE 等可选能力保持缺省，不能关闭 stdio 的基线要求。
  当前所有非空客户端 MCP 列表均返回 `client_mcp_not_allowed`；现有反例测试证明拒绝有效，
  不证明标准支持。远程 Runtime 的托管 stdio 子进程是不同接口。
- **F07**：现有 [延期决定](protocol-completion-plan.md#f07-官方-sdk-验证与延期决定)
  起于 2026-09-09 的 Runtime rmcp 验证；本次 ACP 审计没有重新核验 MCP SDK。
  后续 [2026-09-17 独立复核](../../../runtimes/antnest-runtime/docs/elicitation.md#latest-sdk-recheck-2026-09-17)
  已在最新官方 rmcp 3.4.0 复现标准 URL 输入缺少旧 `elicitationId` 时的解析失败，继续延期。
  该探针不改变本次 ACP 审计范围，也不提供 ACP 追问的正向业务证据。
- **A2/A3**：身份由 Identity/Gateway 管理，文件与执行归属 Runtime；这两类排除遵循既定架构，
  不因 SDK 提供类型就新增第二套身份或客户端执行权威。

## SDK 内的 17 个实验接口

这些接口也逐项入账；是否需要当前实现由 SDK 稳定性标记、能力声明及已批准范围决定。
缺失实验能力不与稳定基线违规混算。

| 接口                 | SDK 分类依据                     | 实现/测试状态                                                          |
| -------------------- | -------------------------------- | ---------------------------------------------------------------------- |
| `session/fork`       | 请求/能力明确 UNSTABLE           | 已宣告并实现；历史、配置、MCP 边界、独立后续执行和新增 schema 探针通过 |
| `providers/list`     | 请求/Provider 能力 UNSTABLE      | 未宣告；未知方法拒绝有测试                                             |
| `providers/set`      | 同上                             | 未宣告；未知方法拒绝有测试                                             |
| `providers/disable`  | 同上                             | 未宣告；未知方法拒绝有测试                                             |
| `nes/start`          | `AgentCapabilities.nes` UNSTABLE | 未宣告；未知方法拒绝有测试                                             |
| `nes/suggest`        | 同上                             | 未宣告；未知方法拒绝有测试                                             |
| `nes/close`          | 同上                             | 未宣告；未知方法拒绝有测试                                             |
| `nes/accept`         | 同一 NES 能力下的通知            | 未实现；无专门通知回归测试                                             |
| `nes/reject`         | 同上                             | 未实现；无专门通知回归测试                                             |
| `document/didOpen`   | NES document 能力下的通知        | 未实现；无专门通知回归测试                                             |
| `document/didChange` | 同上                             | 未实现；无专门通知回归测试                                             |
| `document/didClose`  | 同上                             | 未实现；无专门通知回归测试                                             |
| `document/didSave`   | 同上                             | 未实现；无专门通知回归测试                                             |
| `document/didFocus`  | 同上                             | 未实现；无专门通知回归测试                                             |
| `mcp/connect`        | 方法明确 UNSTABLE                | 未实现/不调用；MCP 输入拒绝测试不算反向 connect 成功证据               |
| `mcp/message`        | 双向请求/通知均 UNSTABLE         | 未实现；无隧道往返成功证据                                             |
| `mcp/disconnect`     | 方法明确 UNSTABLE                | 未实现/不调用；无资源回收业务证据                                      |

`session/set_model` 不在此版本 SDK schema 的方法集合内；模型选择走
`session/set_config_option`。不按旧文档或其他 Agent 的私有接口增补必需方法。

## 接口内部的覆盖深度

| 联合类型/行为                | 本次反向核对                                                                                                                                   |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| text、resource_link          | SDK 基线；输入、模型上下文与回放有测试；resource_link 不意味着必须任意下载外部 URI                                                             |
| image、audio、resource       | SDK 明示能力门控；当前均宣告；支持模型的原生数据、文本/PDF 资源、非法内容及不支持模型的拒绝见 multimodal/embedded-resource 测试                |
| 11 类非实验 SessionUpdate    | `SDK-01` 一条真实协议/数据库流程生成并校验全部 11 类，见下列映射                                                                               |
| 4 类实验 SessionUpdate       | `plan_update`、`plan_removed`、`compaction_update`、`compaction_summary_chunk`；不当成稳定 v1 必需输出，v2 的 plan 实现单列                    |
| 5 类 StopReason              | end_turn、max_tokens、max_turn_requests、refusal、cancelled 均有实际 wire 值断言；refusal 上下文及未知工具效果 cancelled 语义回归通过          |
| tool_call / tool_call_update | 初始事件早于更新，权限 pending、进度、终态、替换 content、rawInput/rawOutput、locations/diff 有分层证据；未知效果不自动重试                    |
| plan                         | 全量列表替换、清空、非法输入不覆盖、持久化与恢复通过                                                                                           |
| configOptions / modes        | 全量响应、通知和实际下一 Run 选择一致；运行中修改不替换已经冻结的执行快照                                                                      |
| 错误与扩展                   | SDK 解码/默认处理、JSON-RPC ID、parse/invalid params/method-not-found、未知 `_meta` 的边界分别由传输及遥测测试覆盖；不能把扩展字段一概视为非法 |

11 类非实验更新分别为：

| 更新                        | 实际路径与已有专项证据                                                     |
| --------------------------- | -------------------------------------------------------------------------- |
| `user_message_chunk`        | 持久化用户输入、load 回放；lifecycle/streaming/multimodal                  |
| `agent_message_chunk`       | 模型最终及增量输出；streaming/output                                       |
| `agent_thought_chunk`       | 思考输出及持久化；streaming/adapter                                        |
| `tool_call`                 | 调用初始状态与语义字段；permissions/tool-presentation                      |
| `tool_call_update`          | 工具进度、结果、文件事实；tool-progress/tool-presentation/file-observation |
| `plan`                      | update_plan 本地执行及全量替换；plan                                       |
| `available_commands_update` | new/load/resume/fork 后的实际命令目录；commands                            |
| `current_mode_update`       | 模式变更后通知；configuration                                              |
| `config_option_update`      | 选择、回退及配置发布通知；configuration                                    |
| `session_info_update`       | 当前标题/时间来自持久快照；v1/v2 观察者、恢复、fork 及列表一致性回归通过   |
| `usage_update`              | 上下文用量及已知累计费用；cost、usage repository                           |

## 验证、复现与剩余门禁

修复前先运行新增回归得到失败，再实施修复。当前串行验证结果：

| 验证                | 结果                                              |
| ------------------- | ------------------------------------------------- |
| 单元/组件           | 959 项、83 文件通过                               |
| PostgreSQL/协议     | 245 项、33 文件通过，无跳过                       |
| 独立 SDK 审计       | 9 项通过、0 失败，退出码 0；最初为 6 通过、3 失败 |
| ACP 生产 Docker E2E | 4 场景通过，4 次模型请求、1 次工具调用            |

Docker 场景使用正式生产镜像、启动迁移、独立 PostgreSQL 和官方 SDK HTTP 客户端，
模型与 MCP 服务为受控 HTTP 替身。验证拒绝内容排除且回放保留、关闭所有观察者并重新加载、
未知工具取消响应与 Runtime 保护，以及跨观察者/列表/fork 元数据与实际进程重启恢复。
重启后由发布器替身重发同版配置恢复就绪；会话时间保持不变，模型/工具不重放。
专用容器、卷、网络已清理，保留开发栈未变更。
这属于 ACP 所属批次的部署证据，不等于真实 Gateway/Identity/Runtime/UI 的完整业务 E2E。

服务级 `typecheck`、`lint`、`build`、`format:check` 及 `git diff --check` 通过；
集成探针的 8 项 fixture 测试为前一修复批次的通过证据，本次元数据批次未重跑该探针。

新增审计入口不混入通常测试，无 `it.fails`、skip 或反向断言。
`SDK-00` 校验每个 SDK 方法恰有一个清单条目并固定 schema 校验值，升级 SDK 后必须重新审计。
JSON Schema 只校验结构（未启用格式插件），不能替代上下文、生命周期、权限及能力门控断言。

```sh
# 从仓库根目录执行。数据库会 DROP/CREATE public schema，名称必须以 _audit 结尾。
ANTNEST_ACP_AUDIT_DATABASE_URL=postgres://USER:PASSWORD@127.0.0.1:PORT/acp_audit \
  npm --prefix services/agent-acp-service run test:audit:v1

# 生产镜像 + 独立 PostgreSQL + 受控 HTTP 模型/MCP；自动清理。
docker build -f services/agent-acp-service/Dockerfile -t antnest/agent-acp-service:sdk-fixes .
node tests/e2e/agent-acp-service/sdk-regressions-docker.mjs
```

源码：[审计探针](../../../tests/integration/agent-acp-service/audit/acp-v1-sdk.audit.ts)、
[扩展数据库回归](../../../tests/integration/agent-acp-service/e2e/acp-sdk-regressions.postgres.test.ts)、
[生产 Docker 场景](../../../tests/e2e/agent-acp-service/sdk-regressions-docker.mjs)。
日志与标准 JSON 在 `artifacts/verification/acp-v1-release-audit-20260916/fix-*`，它们是本机证据；
正式可复现内容为源码、清单、固定 SDK 依赖及本报告。
元数据批次的对应日志/JSON 使用相同目录下的 `metadata-*` 前缀。

服务批次通过后，同步修订 `tests/e2e/acp-progress` 集成探针对 v1 取消结果的旧断言。
本次未重跑该历史全平台部署套件，不将探针修订算作全平台联调完成。

剩余组合证据包括尚未支持的实验通知兼容性，随 SDK 升级重新评估；本轮 COVERAGE-02 已关闭。
PROFILE-01、F07 和 A2/A3 边界保持原有决定。F07 恢复时仍按 Runtime、ACP、UI
及显式部署集成批次推进；本批修复不自动扩大为这些功能的实施。

## 2026-09-22 最终候选复核

[统一候选回归](../../../docs/final-candidate-regression-20260922.md)重新执行了
961 项服务测试、245 项 PostgreSQL 测试及 9 项官方 SDK 审计，均通过。
生产镜像探针首次启动等待失败，诊断重跑又暴露关闭 Session 后的跨连接计数竞态。
关闭操作会更新会话时间；调用者收到响应时，另一条连接仍可能尚未收到最终元数据。
探针现在先将两条连接收到的标题和时间与数据库核对，再记录后续配置推送的计数起点，
原有「已关闭会话不得继续收到更新」断言保持不变。数据库启动前置检查使用 TCP
监听和指定数据库。失败原始记录保留，修正后的两个独立 Docker 运行均通过四个场景并完成清理。
本项只修订验收脚本，没有修改生产服务行为；全平台集成结果以统一候选报告为准。
