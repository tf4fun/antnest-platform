# ACP v1 功能补齐与 Goose 复用方案

> 最新审计与修复（2026-09-16）：按用户确认，以最新正式 SDK `1.4.0` 为准。
> [逐接口反向审计](acp-v1-sdk-audit.md) 已枚举 42 个方法，refusal 上下文、close 订阅释放、
> 未知工具效果取消响应三个失败均已修复。958 项单元/组件、237 项 PostgreSQL、9 项 SDK
> 审计及 3 场景生产 Docker 验证通过；取消线上的确认不修改内部 unresolved 和恢复保护。
> F07、PROFILE-01、A2/A3 及草稿范围决定继续保留，不据此宣告完整平台符合全部 SDK 能力。

> 执行边界更新（2026-09-15）：下文为此前 F01-F10 的历史交付计划和证据，不代表本轮重构已验收。
> `acquire-run`、Controller 固定凭证快照及完成回执不再是当前合同；ACP 本地拥有执行和协议准入，
> Controller 发布管理配置。当前方案与进度见 [执行边界方案](../../../docs/controller-acp-execution-boundary-plan.md)；
> Agent UI 暂缓，不将历史 UI 通过记录套用到本轮。

> 核查日期：2026-09-08
> 代码基线：`325e8ab`；承接未提交的服务端完整性目标修订
> 状态：F01 已通过服务级验收；F02–F06、F08–F10 已通过服务级及 Gateway/Runtime/Jaeger 部署联调；F05/F06 的配置、模式及审批已接入 Agent UI；F07 经用户确认暂缓，等待官方 MCP SDK 支持，不维护本地补丁；F09 原生输入按模型能力限定，不承诺任意格式或真实 Provider 识别质量；F10 的 ACP、Controller、Console/BFF、Agent UI 和部署联调已验收；单节点 C1–C6 总验收仍需逐项收口；W1–W5 实施基线已明确
> 范围：稳定 v1 为主线，保留已实现的 v2/实验性功能；不重开已确认的架构边界

## 1. 判断依据

服务端实现适用的完整协议，客户端按场景裁剪。清单分为：

1. **功能缺口 F**：稳定能力没有完整的输入、执行、输出链路。可选、没有 UI、Goose 未做，都不能豁免。
2. **方案记录 W**：保留原 W1–W5 编号用于追溯。非架构行为优先复用 Goose；W1/W2 的组织模型范围与分层授权已由用户确定，不再作为待决策阻塞项。
3. **已确认边界 A / 等待稳定 S**：已有架构决定或官方提案状态明确允许排除/延期，不与 F 混用。

本次交叉读取官方文档、SDK `1.4.0` 的 `schema/schema.json` 和实际 handler。
v1 schema 含实验性类型；出现类型不等于稳定，叶子类型没有 UNSTABLE 前缀也不证明整个能力稳定。
例如 NES 的能力声明和官方 RFD 仍为草稿。Goose `5e90925` 是流程参考，不是第二套标准。

已核实的关键边界：

- [Elicitation 已稳定](https://agentclientprotocol.com/announcements/elicitation-stabilized)：form、URL、`elicitation/complete` 都进入目标。Goose 仅接通 form 不构成我们的豁免。
- [Session config options](https://agentclientprotocol.com/protocol/v1/session-config-options)：select、协商后的 boolean、配置响应/通知已稳定；与草稿 `providers/*` 管理方法不同。
- [Agent plan](https://agentclientprotocol.com/protocol/v1/agent-plan)：完整列表 `plan` 已稳定；带 ID 的 plan operations 另属草稿。
- [Slash commands](https://agentclientprotocol.com/protocol/v1/slash-commands)：用 `available_commands_update` 发现、普通 `session/prompt` 执行，不新造 `commands/execute`。

## 2. 确定的功能缺口

以下是补齐范围，不再询问是否实现。F01 已通过服务级验收，F02–F06、F08–F10 已完成服务实现及部署联调；F07 经用户明确决定等待官方 SDK。优先级只决定顺序，不将低优先级移出目标。各批次段落保留当批验收范围，当前状态以最新批次和本表为准；这些限定场景不替代单节点整体收尾。

| ID  | 能力与当前缺失链路                                                                                                   | 完成边界                                                                                                                           | 所有者 / 决策依赖                                                                                     |
| --- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| F01 | **模型文本/思考流式输出**。已接通 SSE、ModelPort 增量、批量持久化与 v1/v2 chunk 映射；服务级验收通过。               | 真实增量进入 message/thought chunk；取消/失败的部分输出保留，最终全文不重复；稳定 messageId、回放与上下文归并。                    | Agent ACP Service；无 W 依赖，详见 §7 当前批次。                                                      |
| F02 | **工具进度/连续输出**。Runtime 产出标准 progress，ACP 已消费并接通有界预览、持久化、v1/v2 通知及回放。               | 有进度来源的工具在结束前发 tool_call_update；关联唯一 Tool ID，有输出大小边界、正确终结；无进度不伪造百分比。                      | 两端服务级及 Gateway + 实际 Runtime 的 12 条部署路径验收通过，见 §7。                                 |
| F03 | **工具语义呈现**。基础呈现、Runtime 真实文件事实生产和 ACP 版本化消费/持久化/回放已实现。                            | Runtime read/write/edit/bash 与可提供元数据的 MCP 映射到标准 Tool 数据；普通文件 diff 来自真实执行事实，不伪造客户端 Terminal ID。 | 两端服务级、16 条 Gateway/Runtime 场景与 32 条 Jaeger 链路验收通过。                                  |
| F04 | **结构化计划**。本地 update_plan、完整计划事件、持久化和模型上下文恢复已实现。                                       | v1 plan / v2 items plan_update，真实完整 entries、清空、回放、fork；不解析 Markdown 猜计划。                                       | 服务级与 12 个 Gateway 场景、12 条执行/回放/拒绝 Trace 验收通过。                                     |
| F05 | **会话配置/模式**。Controller 与 ACP 已接通初始化、配置/模式请求、完整通知、恢复和 Run 边界生效。                    | 模型/模式 select、允许值校验、配置依赖、持久化/恢复；两种 v1 模式入口共享语义；不捏造 boolean 设置。                               | 两端及部署联调通过；Agent UI 消费模型/模式选项和通知。                                                |
| F06 | **工具许可交互**。已接通 v1/v2 request_permission、一次/会话规则、执行/拒绝、取消、重连与持久化。                    | once/always、允许/拒绝/cancel 有实际效果；绑定身份、工具和参数；拒绝不执行，关闭/取消无挂起残留。                                  | Smart 额外只读判断、Agent UI 及 26 个 Gateway/Runtime/Jaeger 场景通过。                               |
| F07 | **结构化追问（暂缓）**。2026-09-17 独立探针复现最新官方 rmcp 3.4.0 的 URL 类型缺口；生产仍锁定 3.2.0，继续等待 SDK。 | form/URL、session/tool/request scope、schema 校验、decline/cancel、URL 实际完成通知；同意打开 URL不等于授权完成。                  | 官方 SDK 支持后恢复 Runtime、ACP、UI、部署联调批次；不标为已完成。                                    |
| F08 | **命令发现/执行**。已实现统一目录、`/help` 与 `/帮助`、标准通知和持久回复。                                          | 创建/恢复/fork 发送完整目录；普通 Prompt 保留附件，共用准入和终结，不调用模型或 Runtime。静态目录不伪造变更通知。                  | 服务级及 v1 HTTP、v1/v2 WS 部署联调通过，见 [命令合同](slash-commands.md)。不新增业务命令。           |
| F09 | **标准多模态内容**。原生音频/PDF、模型能力权威、Console 配置和 UI 消费已实现，三种入口联调通过。                     | 按模型能力直通 WAV/MP3/PDF、UTF-8 文档；文本/图片/引用回归；不承诺任意 MIME 或外部模型识别质量。                                   | 四个服务批次、12 次 Run、9 条 Gateway/Runtime/Jaeger 链路验收通过，W4。                               |
| F10 | **会话费用**。ACP、Controller、Console/BFF、Agent UI 及三种入口部署联调已完成。                                      | Provider 返回优先、缺失时估算；保留金额、来源和计价依据，恢复不重复累计，无价格不伪造零费用。                                      | 52 次调用、9 个业务会话恢复及 30 条 Jaeger 链路通过；见 [费用合同](session-cost.md)，不新增结算服务。 |

F06/F07 不依赖客户端 MCP 注入：平台工具也会需要审批或补充信息。
F09 不支持的 MIME 明确拒绝；当前完成边界是已配置模型的原生输入，不包含任意文件转换。
部署补充：全新临时实例已验证 Controller 的 `embeddedContext` 和组织模型音频声明，以及实际 BFF 配置到 ACP 的消费链。保留的开发实例未替换。F08 已更新为允许嵌入文本、继续拒绝 ZIP，不绕过能力校验；完整浏览器与运维收尾仍按单节点清单推进。
F10 不是 usage_update 整体未实现。

### 源码与参考证据

下表 Goose 路径均相对外层 `references/goose/crates/goose/src`；Runtime 路径相对其独立模块 `runtimes/antnest-runtime`。

| 核查点          | Antnest                                                                                                                          | Goose                                                                                                                                                   |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 增量输出        | `src/ports/model.ts`、`src/adapters/model/openai-stream.ts`、`src/application/model-output.ts`、`src/application/turn-runner.ts` | `agents/reply_parts.rs::stream_response_from_provider` -> `agents/agent.rs` -> `acp/server.rs::forward_agent_stream`，边消费边通知，结束后完成 Prompt。 |
| 工具进度/元数据 | `src/adapters/mcp/official-client.ts`、`src/ports/acp-application.ts`、`src/transport/acp/v1/agent.ts`                           | `acp/server/tool_notifications.rs`、`tool_calls/conversion.rs`；部分进度放在私有 `_meta.toolNotification`，不等同于纯标准内容。                         |
| 配置/模式       | `src/application/session-service.ts`、`src/transport/acp/v1/agent.ts`、Controller `internal/domain/spec.go`                      | `acp/server/dispatch.rs` 分发实际配置更新，返回完整选项并通知。                                                                                         |
| 用户交互        | ACP `src/application/tool-permissions.ts` 已接通审批；Runtime 发起的 elicitation 尚未接通                                        | `acp/server.rs::handle_tool_permission_request`、`acp/server/elicitation.rs`；form 有真实回传，URL 尚未接通。                                           |
| 命令/费用       | 命令目录由真实 registry 生成并在会话建立/恢复时通知，不写入 SessionEvent；cost 仍未实现                                          | `acp/response_builder.rs::send_session_setup_notifications`、`acp/server.rs::build_usage_updates`，有目录才宣告、有价格才计算。                         |
| 执行中追加      | `src/application/run-supervisor.ts` 拒绝活动 Run 上的新执行                                                                      | Goose 也拒绝第二个活动 Prompt，另用 `_goose/unstable/session/steer`；不能照抄成稳定 v1 方法。                                                           |

## 3. 决策收敛：优先复用 Goose

**用户已明确：非架构相关的决策优先复用 Goose，避免重复设计。以下是据此收敛的实施基线，不是功能已经实现或通过验收的声明。**

| 原编号 | 优先复用的方案                                        | 已确定的边界与适配                                                                                |
| ------ | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| W1     | 默认配置 + Session 覆盖；配置更新后返回/通知完整选项  | 可切换到组织内可用模型，不限模板/Agent 初始模型；Controller 保持目录、授权与凭证权威。            |
| W2     | Goose 模式语义、默认 Auto、once/always 许可交互       | Agent 提供默认授权行为，Session 可覆盖；会话许可不隐式回写 Agent 默认配置，不跨身份/Agent 扩散。  |
| W3     | 清理失效交互任务，持久待办在恢复时重新请求            | 适配已有持久 Run、Agent 独占和 admission deadline，不照搬连接断开即取消 Run；不另建无限保活机制。 |
| W4     | 显式配置转换后端，检查能力/格式，必要时转换为文本     | 配置与凭证归管理员；未配置不调用额外外部服务。接入标准 ACP 内容链，不复制 Goose 私有听写协议。    |
| W5     | Provider 费用优先，缺失时按模型价格估算；无依据则为空 | 保留费用来源，先按 USD 口径；不新增价格版本系统、计费服务或多币种换算。                           |

用户已确认 W1：组织内可用模型允许切换；W2：Agent 有默认授权行为，单个 Session 可以覆盖。
本清单不再保留待用户选择的 W 项；未实现能力仍是 F 类待办，不能把决策完成标成代码完成。
W3/W4/W5 按既有平台边界做适配，不再把每个内部参数、取消清理或价格公式列为新的产品决策。
复用的是可验证的行为与流程，不是照抄目录结构、全局单例或私有协议；Goose 已知缺口也不一并继承。

以下逐项补充本地 Goose `5e90925` 的实际实现。源码路径除另行注明外，均相对
`references/goose/crates/goose/src`；这些是静态核查结果，不代表本轮运行过 Goose 验收。
Goose 的单用户配置范围、连接生命周期和私有扩展需要映射到已有 Antnest 边界，不能借复用改写架构。

### W1. 会话配置的授权范围

- 复用基线：沿用 Goose 的会话配置覆盖，选择只影响 Session，不改写模板或 Agent 默认配置；更新后返回/通知完整配置列表，模式/思考强度受真实模型能力约束。
- 已确认：可选范围是 Agent 所属组织内可用模型，允许跨该组织中已配置的 Provider 切换，不局限于模板或 Agent 初始模型。不增加一份重复的 Agent 专属模型允许列表。
- 必要适配：Controller 提供组织模型目录及可用性，ACP 保存会话选择；会话未选择时继承 Agent 默认模型。选择使用现有组织模型引用，不接受任意模型名、Base URL 或凭证作为目录替代。
- 每次 admission 校验组织归属、身份访问和模型可用性，解析实际模型版本、凭证及上下文/多模态能力后冻结完整执行快照；不是只替换发给 Provider 的模型字符串。客户端不获得 Provider 密钥。
- 目录变化后不沿用已失效的选择，也不静默换成其他模型：更新可选项，并在无法执行时明确提示重新选择。Session 切换不修改 Agent 默认模型、不重建 Runtime，也不改变已有历史消息。
- 不建议：会话选择改写模板或全局 Agent，或允许任意 base URL/密钥绕过 Controller。
- 配置响应、通知属于必须实现的协议语义，不再决策。活动调用不原地切模型，在明确边界应用新值，不能因正在执行一概拒绝配置请求。

**Goose 的实现**

- `session/set_config_option` 分发 Provider、模型、模式、思考强度的实际更新，随后构建完整配置列表，发送通知并返回响应；`session/set_mode` 进入同一模式更新逻辑。
- Provider 菜单来自本地 Provider 注册目录，并加入当前 Provider 和 `goose` 默认选项；模型菜单来自对应 Provider inventory，思考强度选项结合模型/Provider 能力。选择 `goose` 时解析本地默认 Provider/模型。这不是企业级的 Agent 专属授权清单，也不证明菜单中每个 Provider 都已配置可用凭证。
- 模型/Provider 修改通过 `recreate_provider_for_session` 替换当前 Session 的 Provider 并保存会话配置；模式同样写回 Session。本地全局配置管理是另一条路径，会话选择不等同于修改组织模板或全局默认。

**对 Antnest 的采用方式**：采用“默认配置 + 会话覆盖 + 完整选项通知”的结构，将 Goose 本地模型目录替换为 Controller 的组织可用模型目录。会话选择与模型版本/凭证解析分开，覆盖可恢复，实际执行仍受活动 Run 快照约束。

代码：`acp/server/dispatch.rs::session/set_config_option` 分支、`acp/server.rs::{on_set_model, on_set_mode, update_provider, build_config_update}`、`acp/response_builder.rs::{list_provider_entries, build_session_setup_config}`、`agents/agent.rs::{recreate_provider_for_session, update_goose_mode}`。

### W2. 审批默认模式与授权范围

- 已确认：Agent 配置中有默认授权行为，Session 默认继承，也允许用户为单个 Session 覆盖。不是在 Agent 级与 Session 级之间二选一。
- 复用基线：采用 Goose 的 Auto/Approve/SmartApprove/Chat 模式语义，未另行配置时 Agent 默认 Auto。once/always 的允许、拒绝和取消必须进入实际执行，不另造一套审批工作流。
- 生效模式为 Session 显式模式覆盖，否则取 Agent 默认模式；适用模式需要读取工具规则时，同一工具的 Session 显式规则覆盖 Agent 默认规则。未配置表示继承，不用 false、空字符串或拒绝冒充“未覆盖”，也不为继承增加一个新的执行模式。
- 会话中 once 只解决当前绑定的工具许可请求；always 写入当前 Session 的工具规则覆盖，后续请求按生效模式和规则处理，不暗中改变 Agent 默认授权。跨会话默认行为通过明确的 Agent 配置操作修改，而不是把会话按钮升级为全局授权。
- Session 覆盖随该会话持久化，load/resume 后保留；新 Session 不复制其他会话的覆盖。撤销某项覆盖后恢复继承；Agent 默认值更新只影响仍在继承对应项的会话，已接受的 Run 不被追溯改写。
- 所有权：Agent 默认授权属于 Controller 的 Agent 配置；Session 覆盖、待确认事实和当前请求结果属于 ACP 服务，通过合同读取默认值，不跨服务访问表。工具标识沿用已有 MCP 来源隔离，规则不跨组织、身份、Agent 或工具来源扩散。
- Session 覆盖的是用户执行偏好，不是平台资源权限；不能绕过 Controller 授权、Runtime 隔离、网络策略或用户停用状态。
- 不建议：模型自行取消审批，或客户端缺少交互能力时自动批准本应确认的工具。
- 只读模式必须有真实执行限制，不能给任意 bash 标个 read-only 就宣告；标准 mode 接口不强制任何具体模式名称。

**Goose 的实现**

- 提供 Auto、Approve、SmartApprove、Chat 四种模式，枚举默认值为 Auto；实际会话还会读取保存的配置。Chat 是不调用工具，不是允许只读工具的模式。
- Permission inspector 中 Auto 放行；Approve/SmartApprove 先检查用户显式工具规则；SmartApprove 还结合只读注解和风险判断。Approve 并非无条件“每次都问”，已有显式允许/拒绝仍生效；其他安全 inspector 可以进一步影响最终结果。
- ACP 发出 `request_permission`，包含允许一次、始终允许、拒绝一次、始终拒绝四个选项。回包进入工具确认状态机，请求失败按 Cancel 处理，不默许执行。
- `AlwaysAllow` / `AlwaysDeny` 通过 `ToolInspectionManager` 写入 `PermissionManager` 的用户规则，落在 ACP 服务配置目录的 `permission.yaml`，以工具名而非 Session ID 为键。因此使用同一配置目录的会话会共享规则，不能理解为仅本次会话授权。

**对 Antnest 的采用方式**：沿用 Goose 模式与许可闭环，只把本地配置作用域映射为“Agent 默认 + Session 覆盖”。SmartApprove 参考其显式规则、工具注解和风险判断，不把它当沙箱安全边界，也不新建独立策略服务；Chat 保持“无工具”语义。Agent 默认值与会话决定有明确写入入口，避免一次会话交互改变其他会话的行为。

代码：`references/goose/crates/goose-provider-types/src/goose_mode.rs`、`permission/permission_inspector.rs::inspect`、`acp/server.rs::handle_tool_permission_request`、`agents/state_machine/ops_tool_approval.rs::ToolApprovalOperation`、`tool_inspection.rs::update_permission_manager`、`config/permission.rs::PermissionManager`。

### W3. 用户断线后的等待行为

- 复用基线：按 Goose 的方式区分交互任务、活动执行和持久待办。已经失败的许可请求按取消收敛，不自动批准；尚未解决且仍可恢复的待办通过恢复入口重新发起请求，不原样复用旧协议请求 ID。
- 必要适配：Antnest 已有“断开输出连接不等于取消 Run”的持久执行语义，继续保留。不能把 Goose 的 `ActiveRunDropGuard` 机械绑定到我们的 WebSocket/SSE 断流；只是失去输出订阅的 Run 仍按既有流程执行/恢复。
- 有交互等待的 Run 不继续后续模型/工具，独占遵守现有 admission deadline，不增加无限保活或跨终态自动续跑。超时/显式取消结束等待；恢复未应用的确认前重新取得有效 admission，未知副作用不重放。普通短暂断流不自动作为许可请求失败，已取消的请求也不能在 load 时复活。
- URL 回调和 elicitation/complete 仍遵守原连接/身份绑定；不能向新连接重放旧通知。新请求使用新协议身份，既有业务结果通过恢复流程查询。
- 不建议：自动允许、无限占用，或释放独占后旧 Run 仍继续执行。

**Goose 的实现**

- 同一 ACP Server 的连接共享按 Session 索引的活动 Run 注册表。消费 Agent 输出流的任务被丢弃时，`ActiveRunDropGuard` 取消执行、清理匹配的活动 Run，并丢弃待处理 steer，防止后续连接一直看到忙碌。这是任务生命周期清理，不能推导为每次短暂 HTTP/SSE 断流都立即取消。
- 工具审批请求失败会提交 Cancel。另一方面，`session/load` 会从保存的 Conversation 找出待确认工具并重新发起审批；启用状态机时，还会针对待确认或尚未应用的确认结果恢复对应执行。因此既不是“断线后无限保活”，也不是“所有待办一律丢失”。
- 已确认的恢复入口针对工具审批；不能据此宣称任意 form/URL 追问都能跨连接恢复。Goose 当前 ACP elicitation 只接通 form，不能作为 URL 完成通知恢复的实现证据。

**对 Antnest 的采用方式**：复用任务清理、待办重发和状态机恢复，不增加新的等待/保活产品模式；生命周期适配现有 Run 和 admission 合同。URL 流程按标准协议补齐，是 Goose 的实现缺口而不是可省略的权衡项。验收必须同时覆盖普通断流不取消 Run、失效审批不执行、重连待办不重复应用。

代码：`acp/server.rs::{ActiveRunRegistry, ActiveRunDropGuard, handle_tool_permission_request}`、`acp/server/load_session.rs::{handle_load_session, resend_pending_tool_permissions, start_resumed_state_machine_turn}`、`acp/server/elicitation.rs`。

### W4. 音频/文档的外部转换权限

- 复用基线：沿用 Goose 显式配置转换后端、检查能力/格式、返回可消费内容的流程。原生模型支持时直通；需要转换时使用已经配置的转换链，不另造转写平台。
- 必要适配：后端地址、模型和凭证由管理员配置，配置范围就是允许使用的转换范围；客户端只能使用已授权选项，不能指定任意第三方地址。没有配置不默认向额外外部服务发送用户内容。
- 文档优先通过原生能力或受控环境提取，不把 Base64 当普通文本。本地转写实现、具体格式适配器属于实现选择，不要求照抄 Goose 的全部后端或引入新的推理服务；完整支持的 MIME 以实际链路和测试为准。
- 没有相应链时明确拒绝，不虚假宣告；服务端适配和实际可用路径仍要实现，不以当前测试模型不支持而移除功能。

**Goose 的实现**

- 标准 ACP `convert_acp_prompt_to_message` 处理文本、图片、文本型嵌入 Resource 和可读取的 ResourceLink；Audio 分支不转换，嵌入 blob 也没有在此接入通用文档提取。因此不能用 Goose 的其他音频功能证明标准 Prompt 多模态链已完整。
- Goose 另有私有 dictation 接口：`on_dictation_config` 提供转写配置/可用情况，`on_dictation_transcribe` 根据请求选择本地 Whisper、模型原生转写或已配置的远程转写服务，例如 OpenAI、Groq、ElevenLabs，最终返回文本。
- 本地转写受 `local-inference` 构建特性约束；远程路径使用本地配置中的模型/凭证。入口校验音频格式、Base64 和大小，缺少本地能力时返回错误，不把二进制伪装成普通文字。

**对 Antnest 的采用方式**：复用转换流程，将 Goose 的本地个人配置映射为已有管理员配置权威，不再新设一层转换审批。最终接到标准 ACP 音频/Resource 输入链，不能只做私有 dictation 接口后宣称 F09 完成；Goose 未接通的标准输入与文档路径仍需我们补齐。

代码：`acp/server.rs::convert_acp_prompt_to_message`、`acp/server/dictation.rs::{on_dictation_config, on_dictation_transcribe}`、`dictation/providers.rs`。

### W5. 费用来源与含义

- 复用基线：采用 Goose 的混合来源顺序，Provider 返回费用优先，没有时按已知模型价格估算，无依据则为空。保留 `ProviderReported` / `Estimated` 来源，不把 Provider 返回值或估算冒充已核对账单。
- 价格解析参考 Goose：显式配置覆盖优先，模型目录价格和内置定义补齐；区分普通输入、输出和缓存计价。用户价格覆盖在 Antnest 由 Controller 的管理员配置提供，不让 ACP 客户端提交任意费率。
- 先沿用 USD 输出口径；其他币种不冒充 USD、不混合累计，也不增加汇率服务。无法可靠定价时仍可正常执行，省略相应费用，不当成免费。
- 保存每次调用的已知金额、来源，以及估算使用的单价/用量即可；历史金额不随目录更新重算，恢复不重复累计。不单独建设价格版本系统、计费服务或账单对账流程。

**Goose 的实现**

- 采用混合来源：Provider 已返回 `cost` 时优先采用并标记 `ProviderReported`；否则调用模型价格估算，标记 `Estimated`；无法估算时保留空值。Provider 返回值的标签不等于已经与账单核对。
- 估算价格优先取用户自定义 Provider 配置，再用内置 canonical registry，内置声明式 Provider 定义补齐价格缺口。公式区分普通输入、输出、缓存读取/写入 token；缺少缓存单价时退回输入单价。自定义价格文件实时读取，不是我们的 Controller 版本化价格合同。
- 用量/金额写入会话 usage 记录后累计；`build_usage_updates` 将已有累计金额放进标准 `usage_update.cost`，币种使用 `USD`，没有累计金额则省略。内部保存费用来源，但标准金额/币种本身不能告诉客户端哪些调用是估算、哪些未计价，也不代表完整账单。

**对 Antnest 的采用方式**：直接采用混合来源与已知成本累计，不再保留“只估算/只接受返回费用”的待选方案。持久化沿用本服务用量记录和既有防重复机制，部分调用未计价时不能把累计已知金额称为全部费用。不扩展 ACP 标准字段表达内部计价依据。

代码：`agents/state_machine/usage.rs::{enrich, record}`、`providers/canonical_cost.rs::{estimate_model_cost, resolve_pricing}`、`session/session_manager.rs::record_usage_metrics`、`acp/server.rs::build_usage_updates`；计算公式位于 `references/goose/crates/goose-provider-types/src/canonical/model.rs::Pricing::estimate_cost`。

## 4. 已确认架构边界

以下已有用户决定，不重复列为 W：

| 范围                                                         | 继续保持的边界                                                                                                                           |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| A2：ACP 内独立 authenticate/logout、客户端 Provider 凭证权威 | 认证/退出由 Identity/Gateway 负责，Controller 绑定 Agent。不另建身份系统或泄露密钥；不豁免 F05 的授权配置选择。                          |
| A3：客户端 fs/terminal、本地路径/额外工作区                  | 执行位于远程 Runtime，Session 当前固定 `/workspace`；不把客户端路径解释为 ACP 宿主路径，不伪造客户端 terminal。                          |
| A4：私有 ACP 部署/update_runtime                             | 构建/重建通过 Controller，Run 获取不可变快照；不增加私有 ACP 请求。                                                                      |
| 客户端 MCP 注入                                              | 延续平台/客户端来源隔离，Runtime 管理员配置的 MCP 正常支持；客户端注入继续禁止，等待已确定的 MCP-over-ACP 方向。通用 v1 的限制仍须披露。 |

软删除、保留审计、未知副作用不自动重放是已有实现策略，不是缺少协议功能。
会话删除/关闭、连接关闭、用户退出不能互相冒充。

## 5. 等待协议稳定

| 项目                                       | 依据及处理                                                                                                                                                       |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| v2 新增行为                                | v2 仍为草稿；已有路径继续回归，共享逻辑修改不强套 v1 输出格式。                                                                                                  |
| MCP-over-ACP                               | [RFD](https://agentclientprotocol.com/rfds/mcp-over-acp) 为草稿，保持客户端注入决定。                                                                            |
| providers/list/set/disable                 | [Provider RFD](https://agentclientprotocol.com/rfds/custom-llm-endpoint) 为草稿，与稳定的会话模型选择分开。                                                      |
| NES、document 通知                         | [NES RFD](https://agentclientprotocol.com/rfds/next-edit-suggestions) 为草稿，不是因当前非编辑器而排除。                                                         |
| plan_update/plan_removed                   | [Plan Operations](https://agentclientprotocol.com/rfds/plan-operations) 为草稿，不影响 F04 稳定 plan。                                                           |
| compaction_update/compaction_summary_chunk | [Session Compaction](https://agentclientprotocol.com/rfds/session-compaction) 为草稿，内部压缩继续存在。                                                         |
| Prompt response usage、删除文件 diff 扩展  | 固定 SDK 将 end-turn usage 标为实验性；[deleted diff](https://agentclientprotocol.com/rfds/diff-delete) 仍为草稿。稳定 usage_update.cost、普通 diff 不一起延期。 |
| Auth state query、Session notices          | 官方 RFD 清单仍列为草稿，转正后再核对。                                                                                                                          |

已实现的 fork、HTTP 传输和 Tool name 实验性子集不删除、不回滚，继续承担原验收义务。
Goose 私有 steer/recipes/scheduler 不在标准接口枚举里；不新增另一套协议凑完整性。
执行中追加尚无当前稳定 v1 Prompt 合同内的方案，暂不将拒绝第二个活动 Prompt 列为协议缺陷。
每项等待在 RFD 稳定后重审，不以一张永久排除清单结束。

## 6. 逐接口覆盖归属

| 接口/通知族                                                          | 归属与验收                                                                                         |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| initialize；new/load/list/resume/close/delete；prompt/cancel         | 已有服务级实现/历史测试；新增能力的协商、会话初值、恢复与终态重新回归，fork 继续按实验性功能维护。 |
| 文本/图片/resource_link/resource/audio                               | F01/F09 与已有内容回归；任意 URI 自动下载不是基线要求。                                            |
| tool_call/tool_call_update                                           | F02/F03/F06；不能只看开始/结束两个事件。                                                           |
| plan；available_commands_update                                      | F04/F08，实际数据与行为，不能只发空列表。                                                          |
| set_config_option/set_mode；config_option_update/current_mode_update | F05，涵盖初始化、恢复、响应、通知与执行效果。                                                      |
| request_permission；elicitation/create/complete                      | F06/F07，包括 Server 到 Client 的反向请求、业务回传与生命周期。                                    |
| usage_update；session_info_update                                    | 已有基础用量和元数据；F10 补 cost；跨连接/恢复元数据一致性是回归要求，不另列已证实缺陷。           |
| $/cancel_request、错误与元数据                                       | SDK 已有证据；新增等待/交互补取消、迟到响应和关闭测试，不代替 session/cancel 的业务终态。          |
| authenticate/logout；fs/terminal；额外目录                           | A 类，保持不宣告/明确拒绝，不标成已实现。                                                          |
| providers、NES/document、MCP-over-ACP、其他草稿 update               | S 类，已实现子集继续回归，未实现的不宣告。                                                         |

## 7. 实施与验收约束

### 已完成批次：F01 模型增量输出

仅修改 Agent ACP Service，按测试先行推进，代码已完成并通过服务级验收。

1. ModelPort 保留一次调用一个最终 ModelResult，增加可等待的文本/思考增量回调；最终结果仍负责完整上下文和已验证 Tool 参数。模型适配器请求 SSE，使用现有依赖树中的 `eventsource-parser`，不手写 SSE 协议、不重试有部分输出的请求。
2. 执行层按时间/大小合并增量，先持久化再推送；使用既有 Session sequence 回放。每个模型响应有内部关联标识，同一响应的文本分块在构建上下文时还原为一条 assistant 消息，不重发最终全文、不逐 token 新增审计行，不增加 ACP 私有字段。
3. 完整 Tool 参数只有在正常的 Tool finish reason 后才进入现有 preflight。截断、不完整 JSON、断流或取消不执行半成品 Tool；已输出片段保留，缓冲尾部在失败/取消收敛时处理，所有计时器/流 reader 随请求关闭。
4. 验收覆盖 UTF-8/SSE 分帧、思考/文本交错、Tool 参数增量、末尾 usage、输出早于完成、部分输出后取消/错误、无重复回放和上下文合并。使用确定性的 Provider 流替身和真实 ACP/Postgres 链路，不依赖外部付费模型。

最终结果（2026-09-08）：单元/组件测试 268 项、36 个文件，PostgreSQL 协议/集成测试 72 项、10 个文件全部通过；生产构建、仓库 `make fmt-check`、`make lint` 通过。覆盖映射见 [F01 协议证据](protocol-conformance.md#model-streaming-batch-f01-2026-09-08)。不包含新的外部 Provider、浏览器或 Gateway 到 Runtime 的完整部署验收。

### 已完成批次：F02 Runtime 工具进度生产端

仅修改 `antnest-runtime` 实现及所属文档/测试，未修改 ACP 消费端代码。使用现有 `/mcp` 的标准 `notifications/progress`，不增加端点、数据库表或私有 ACP 字段。

1. Bash 在非 root Executor 内捕获 stdout/stderr 增量，通过有界私有进程帧传回 Supervisor；托管 stdio MCP 使用官方 SDK 解码消息，匹配子请求 token 并映射到外层 token。无 token 不推送，静默工具不伪造百分比。
2. 每次请求最多排队 32 项、转发 256 项，每项文本最多 8 KiB；慢订阅方不阻塞最终结果，超限明确标记预览截断。结束前排空有界尾部，取消不杀死共享 MCP 服务或之前的后台作业，进度内容不进入日志/OTLP。
3. Linux 镜像构建通过格式、Clippy、release 构建、117 项单元/组件测试和 1 项非 root CLI 测试；生产镜像的 9 项 Docker E2E 全部通过，验证真实提前输出、失败/取消、请求关联及后台进程生命周期。测试资源自动清理，未调用外部 Provider。
4. 合同与证据见 [Runtime Tool Progress](../../../runtimes/antnest-runtime/docs/tool-progress.md)。该批次只验收生产者，后续 ACP 消费端批次见下节；不能单独标记 F02 全部完成。

### 已完成批次：F02 ACP 工具进度消费端

仅修改 Agent ACP Service，承接 Runtime 已明确的标准 progress 合同。

1. 官方 MCP SDK 负责 token 分配与请求关联，Tool port 只传递进度值和消息。TurnRunner 关联既有归一化 Tool ID，首条立即输出，后续 100 ms 合并；单工具最多 32 条预览，每条文本不超过 16 KiB，超限明确提示，最终结果不受预览额度影响。
2. 同时最多一笔写入与一个有界快照，不按回调排无限 Promise 队列。沿用 `session_messages`、Session sequence 和现有 Tool attempt；进度不修改副作用状态，不新增数据表。成功、失败、取消均先处理已接受的预览，再写终态；失权停止新写入，写入失败进入现有恢复路径，不重放工具。
3. v1/v2 使用标准 `tool_call_update` 的替换式 content。重连从持久序列恢复；模型上下文只消费最终工具结果。迟到发布只是 invalidation，不能越过序号重发旧预览。只读复核提出的慢写入/失权与迟到发布组合已补定向测试，未增加冗余状态机。
4. 服务内使用真实官方 HTTP MCP SDK、ACP WebSocket 与独立 PostgreSQL 库验证；模型和 Controller 使用确定性替身。Rust Runtime 实例与 Gateway 的跨服务部署联调仍单列，F03 工具语义元数据不包含在本批中。

合同、边界与验收映射见 [ACP Tool Progress](tool-progress.md) 和 [F02 协议证据](protocol-conformance.md#tool-progress-consumer-batch-f02-2026-09-08)。最终结果（2026-09-08）：282 项单元/组件测试（38 文件）、78 项 PostgreSQL 协议/集成测试（11 文件）通过；生产构建、仓库 `make fmt-check`、`make lint` 通过。一名子 agent 完成只读复核后关闭，主 agent 补齐并验证其指出的测试盲点。复用既有 PostgreSQL 实例的独立测试库已删除，未新增或修改其他验收容器。

### 已完成批次：F02 Gateway 与 Runtime 部署联调

F02 部署联调已完成（2026-09-08）。入口为 `make e2e-tool-progress`，可复用合同及脚本见 [部署验收](../../../scripts/acp-progress/README.md)。本批仅补部署驱动、反例断言与文档，没有新增生产端点、表或跨服务 SQL。

1. 通过真实 Gateway / Console BFF 登录、创建用户、模型配置、模板和 Agent。ACP v1/v2 各覆盖原生 Bash 与托管 stdio MCP 的成功、失败、取消，共 12 条路径；使用确定性 SSE 模型，不依赖外部 Provider。
2. 工具先输出预览再等待测试门闩，确保客户端在结束前收到内容；成功路径断线重连后逐项比较首段回放，所有路径完成后重新连接比较完整 Tool 序列与唯一 ID。最终模型输入不包含托管工具预览 canary。
3. 历史记录（2026-09-08；v1 取消响应已于 2026-09-16 改为 `cancelled`，当前无停止证据的 admission 为 `runtime_barrier_required`，见最新审计）：四条取消路径均验证真实执行停止，且保留未确认效果：v1 Tool `failed` / Prompt -32023，v2 Tool `cancelled` / `_unresolved`。后续 admission 仍拒绝 `agent_busy`。Bash 非零退出按合同是完成的调用，其 exit_code 由模型替身严格校验，不错误归类为传输失败。
4. Jaeger 的 12 条链路均具有 Gateway 祖先、ACP 与 Runtime 子调用、每 Run 一次信息/工具目录读取；每条 ACP dispatch 和 Runtime 实际工具调用都恰好一次。20 次模型请求均校验真实工具结果，Trace 不含预览或测试凭证。仅保留聚合结果，不提交原始 Trace / 事件转储。
5. 单次只保留一组 Agent，使用独立 Compose 项目和一套共享 PostgreSQL 实例内的服务自有库；测试及失败重试均清理自有容器、volume、network，最终退出码包含残留审计。既有验收实例未修改。

最终准入：`make fmt-check`、`make lint`、`make test-node`（583 项）通过。两名只读审查 agent 已关闭；补齐命令参数误判预览、首次回放前缀、取消前存活/取消后停止、迟到重复 span 等测试盲点。Jaeger 在 Runtime 停止后要求连续三次 span 集合一致再计数，属于有界收敛检查，不声称排除任意延迟的后续写入。

### 已完成批次：F03 ACP 基础工具呈现

本批只修改 Agent ACP Service，合同详见 [Tool presentation](tool-presentation.md)。

1. 精确匹配平台内置工具身份，映射 read/edit/execute；托管和未知工具归 other。保留可用 MCP title，缺失时使用确定性动作/目标标题，不额外调用模型。
2. 复用当前 Run 已读取的 Runtime workspace，构建目标 locations。不使用会话逻辑 cwd 猜路径，不从 byte offset 猜行号；系统 Skill 根目录信息不足时省略位置。
3. 按 Goose 的来源映射真实 structuredContent 到独立 rawOutput；保持 JSON 形状、64 KiB 边界，传输异常不伪造原始结果。呈现数据进入既有 Session 事件，不增加表，也不重复进入模型上下文。
4. 新增单元、官方 MCP SDK 组件、真实 PostgreSQL + ACP v1/v2 的实时/重连/fork/跨身份/失败/未知结果与大小边界测试；既有工具进度保持同一 Tool ID，不覆盖呈现元数据。
5. 普通 diff 仍必须由 Runtime 产出完整真实 before/after。下一批只修改 Runtime，补执行事实与可用文件位置；再做 ACP 消费和 Gateway 部署验证。禁止用 edit 参数片段或额外 read 调用伪造 diff。

本批服务级验收通过（2026-09-08）：317 项单元/组件测试（41 文件）、85 项 PostgreSQL 协议/集成测试（12 文件）、生产构建、`make fmt-check` 和 `make lint` 通过。只读复核发现并修复 structuredContent 特殊 JSON 值落库失败、重启恢复覆盖标题两项问题；新增真实 PostgreSQL 的特殊值实时/回放/fork 和恢复断言，后续静态复核无剩余阻断项。rawOutput 的 JSON 文本编码仅属于 PostgreSQL adapter，领域模型不感知存储限制。审查 agent 均已关闭，本轮独立测试库清理，既有验收容器不变。不将 F03 整项标记完成。

### 已完成批次：F03 Runtime 文件事实生产端

本批只修改 Runtime 实现，合同见 [File observations](../../../runtimes/antnest-runtime/docs/file-observations.md)。未修改 ACP 消费代码。

1. 内置 read/write/edit 返回实际配置根目录下的路径；write/edit 仅在已有原子替换及 readback 确认成功后，返回完整观察到的 before/after，不使用 edit 参数片段。
2. 完整文本走 MCP `_meta["io.antnest.runtime/file"]`，现有模型输出与 structuredContent 不变。私有 executor codec 和 MCP 边界均限制 JSON 编码大小为 32 KiB；不可读、非 UTF-8、过大时明确省略 diff，不将成功写入改成失败。
3. 目录符号链接创建越界、父目录尾空格导致错误目标两项缺陷均先通过 Linux 回归复现，再修复。只读审查及针对性复核完成；不引入目录事务、成功后的额外读取、并发版本或第二份历史存储。
4. 下一批仅在 ACP 消费端校验并映射标准 `locations`/`diff`、持久化及回放；不能把生产者完成当作 F03 完整闭环。之后再做 Gateway + 实际 Runtime 部署联调与 Trace 验收。

本批服务级验收通过（2026-09-09）：原生 89 项；Linux 126 项模块/合同测试 + 1 项真实 UID 1000 executor 子进程集成测试；Linux release 构建、原生/Linux Clippy、`make fmt-check`、`make lint` 全部通过。只读审查已关闭，未修改既有验收实例，也未宣称完成 ACP 消费或 Gateway/Jaeger 部署验证。

### 已完成批次：F03 ACP 文件事实消费端

本批仅修改 Agent ACP Service，承接 Runtime 的 `_meta["io.antnest.runtime/file"]` 合同。

1. 只接收平台内置 read/write/edit 的成功、已收敛结果。严格校验路径、完整 before/after、互斥字段与 32 KiB JSON envelope；错误、未知效果、Bash、托管 MCP 和非法 metadata 不产生伪造文件事实。
2. 实际路径覆盖初始请求意图位置，支持实际 System Skill 路径。v1 输出标准 oldText/newText diff，v2 输出标准 changes 与有界 git patch；使用成熟 diff 库，保留空文件/创建区别，不伪造文件权限或客户端 Terminal。
3. 文件事实只写入已有 Session Tool 事件，PostgreSQL adapter 使用转义 JSON 文本保存 NUL 等文件内容。不进入模型 context、rawOutput、摘要或可观测性 payload；不新增表，不追加 read、不重放写入。
4. 官方 MCP HTTP SDK、真实 ACP v1/v2 连接与 PostgreSQL 验证实时通知、load/resume、fork、应用重新创建后的恢复、跨身份隔离。SDK schema 校验输出；模型/Controller 是确定性替身，不把该测试称为实际 Runtime 部署验收。
5. 只读复核指出 v2 patch 文件名尾空格不保真，已用回归复现并修复。格式化后再解析校验路径；不能保真、NUL、空文件创建或超预算时省略可选 patch，仍保留准确 changes。工具遥测边界另有不泄漏文件内容的测试。

详细合同与测试映射见 [Tool presentation](tool-presentation.md) 和 [F03 消费端证据](protocol-conformance.md#runtime-file-fact-consumer-f03-2026-09-09)。358 项单元/组件测试（43 文件）、95 项 PostgreSQL 协议/集成测试（13 文件）、生产构建、`make fmt-check` 与 `make lint` 通过。下一批仅做实际 Runtime/Gateway/Jaeger 部署联调，F03 整项仍不标记完成。

### 已完成批次：F03 Gateway 与 Runtime 部署联调

2026-09-09，通过 `make e2e-file-observations` 运行独立 Compose 项目；脚本与合同见 [F03 部署验收](../../../scripts/acp-files/README.md)。本批只补验收驱动、判定器及文档，未改生产服务实现。

1. Gateway 登录、用户/模型/模板/Agent 创建，真实 Runtime 文件 read/write/edit，以及 Agent 删除均通过正常业务入口。v1/v2 各 8 条场景：创建、编辑、读取、空文件创建、空文件替换、无变化、超限省略、失败编辑。验证 Unicode/父目录空格、完整 before/after、SDK schema 和 v2 patch 路径/应用结果。
2. 32 次确定性 SSE 模型请求验证实际返回值；不是外部 Provider，也不伪造 MCP 输出。全文件 metadata 不进入 Tool 模型结果，edit 的上下文短标记不进入任何消息角色。
3. 16 条执行 Trace 验证 Gateway 祖先、每 Run 一次准备、一次 ACP 分发和一次实际 Runtime Tool 后代；另行收集 16 条 replay/fork Trace，要求有效生命周期链路且无模型或 Runtime 执行，不以“未发现 Trace”冒充通过。
4. 每次新连接的 load/resume 与 fork 回放一致，2 次跨用户升级请求拒绝。创建的容器、卷和网络全部清理；未触碰既有验收实例，不保留原始 Trace、凭证或中间结果文件。
5. 两轮只读对抗审查指出回放证据集盲点、错误父链计数、片段泄漏、初始事件伪造 diff 及整栈启动误用短查询超时的验收风险，均已补反例并修复。28 项相关脚本测试通过，修正后真实部署 profile 再次通过；两名审查 agent 均已关闭。F03 的服务和部署链路闭环，下一项为 F04 结构化计划。

最终准入：`make fmt-check`、`make lint`、`make test-node`（671 项，无失败/跳过）通过。Go lint 0 问题、两项 Rust Clippy 及 ACP/前端检查通过。仅保留最终聚合结果；独立复核确认本轮 Compose 容器、数据卷、网络无残留。

### 已完成批次：F04 ACP 结构化计划服务实现

本批仅修改 Agent ACP Service，详见 [Structured plans](structured-plan.md)。

1. 注册独立来源的本地 `update_plan` 模型工具，使用完整 entries 替换，允许空列表清空；schema 限制数量和描述大小。同名 Runtime 工具明确拒绝，不根据 Markdown 或 MCP 私有字段猜计划。
2. v1 使用稳定 `plan`，v2 使用会话内稳定 `current` ID 的 items `plan_update`。本地提交不调用 Runtime、不写远程 ToolAttempt、不产生未知外部副作用，也不新增表或服务接口。
3. 计划与成功工具结果原子写入现有 Session 事件流，沿用 Run/Session 锁；取消先落库则拒绝，已提交结果不会被之后的取消或发布失败撤回。Run/Tool 绑定的确定性事件 ID 拒绝旧调用重放覆盖。
4. 按 Session 恢复最新计划，fork 保留分叉点快照。压缩保留 Run 开始时的 assistant 计划快照，并明确之后成功的更新会覆盖它，不将模型计划提升为 system 指令或永远“当前”的状态。
5. 两名只读 agent 分别复核参考方案和实现。实现复核发现特殊字符串 JSONB 写入失败、旧计划标为当前 system 状态两项问题，均先补失败用例后修复；事件 codec 编码计划及两份参数副本，恢复/回放统一解码，领域模型不感知 PostgreSQL。审查 agent 已关闭。
6. 正确性证据包括标准 schema、真实 ACP v1/v2 + PostgreSQL、跨身份隔离、清空、回放/fork/应用重建、真实锁等待/回滚、真实预算压缩及中断调用恢复。应用重建回放与恢复算法测试不冒充进程强杀 E2E；Gateway/UI/Jaeger 集成尚未在本批重新验收。

最终结果（2026-09-09）：377 项单元/组件测试（46 文件）、106 项 PostgreSQL 协议/集成测试（14 文件，含 F04 专项 11 项）全部通过；生产构建、`make fmt-check`、`make lint` 通过。仅保留最终聚合结果；复用 PostgreSQL 实例中的本轮独立测试库和角色已删除，既有验收实例未修改，未调用外部 Provider。

### 已完成批次：F04 Gateway 部署与 Trace 验收

2026-09-09，入口为 `make e2e-structured-plan`，可复用驱动与证据边界见 [部署验收](../../../scripts/acp-plan/README.md)。本批仅补脚本、判定器和文档，不改生产服务实现。

1. 经 Gateway/Console 登录、创建用户/模型/模板/Agent，v1/v2 各覆盖初建、真实 Runtime 写入后更新、非法更新拒绝、清空、下一 Run 恢复空计划、清空前 fork 保留旧计划，共 12 个场景、22 次确定性 SSE 模型请求。没有调用外部 Provider。
2. 六次计划提交在最终答复的门闩释放前到达；模型逐字段核对 Run-start 快照及有序调用/结果，计划删除项、重排、优先级与状态变化保持准确，不因 Run 结束自动完成剩余步骤。
3. 新连接 load/resume/fork 比较完整计划与工具事件、ID、顺序和 Session 归属。另有两次跨用户握手拒绝、四次跨 Agent 会话操作拒绝；复用既有严格错误合同，不把超时或内部错误当权限拒绝。
4. Jaeger 的 4 条执行 Trace 覆盖 12 个 Run，按 admission 核对每 Run 的准备、模型、数据库与 Controller 调用。远程工具仅两次实际 write，本地计划不调用 Runtime；8 条独立回放/拒绝 Trace 必须存在且无执行。计划/Prompt/凭证哨兵不进入这些 Trace；不扩展声称覆盖所有 stdout 日志、指标或浏览器 UI。
5. 两名只读审查 agent 已关闭。跨工具错序、跨 Run ID 复用、结果先于调用均有反例回归；真实部署暴露的 v2 工具事件形状与权限错误码误判已修正，最终完整重跑通过。此前部分通过不作为验收；自有容器、卷、网络全部清理，既有验收实例未修改。

最终准入：`make test-node` 共 701 项通过（ACP 377、Console 220、Agent UI 13、共享验收判定器 91，含本批 11 项）；`make fmt-check`、`make lint` 通过。生产 ACP 镜像构建通过；Runtime 镜像构建中的 126 项 Linux 模块测试、1 项真实 UID 1000 CLI 测试、Clippy 和 release 构建通过。独立复核三次部署运行均无自有容器、卷、网络残留。

### 后续批次与统一验收

#### F05 Controller 首批

2026-09-09，按 [Controller 合同](../../agent-controller/docs/session-configuration.md)
补齐组织模型目录、Agent 默认授权、Run 会话覆盖的生产者能力；只修改 Controller
实现及其共享合同，不改 ACP 消费端或部署验收实例。

1. `get-session-configuration` 根据当前 Agent owner/Identity 派生组织，提供分页模型目录、固定默认模型及授权默认值，不返回端点或凭证。
2. `acquire-run` 允许同组织跨 Provider 选择；事务内锁定模型 head，冻结完整模型/凭证/能力和授权。未选择仍继承 Agent 固定模型版本，但已禁用模型明确拒绝，无静默 fallback。
3. `set-agent-authorization` 用独立 revision CAS 修改 Agent 默认 mode/rules，不修改 Runtime 或已接受的 Run。Session 规则按工具来源精确覆盖，实际审批执行仍待 F06。
4. 新快照有独立 configuration digest，不冒用 Agent build digest；旧 admission 重放保留，截止时间统一输出 UTC。源规则及凭证不进入新增仓储 Trace/日志。
5. 只读审查指出的缺失规则清空、CAS 重试事件 ID 冲突、目录 int32 溢出均有红灯复现并修复；后续静态复核无残留。HTTP/PostgreSQL 组件测试覆盖目录、授权更新、准入、凭证、重放和父子 Trace；没有借此声称 Gateway/Jaeger 部署已完成。

Run 机器合同升为 revision 10，管理事件合同为 revision 13。该批结束时 ACP adapter 尚只接受旧形状，
因此未单独部署生产者。消费者适配见下一批；两端必须共同升级，再单独跨服务联调。

最终服务级准入：Controller 13 个 Go 包普通及 race 测试通过，均启用专用 PostgreSQL
数据库的集成测试；`make fmt-check`、`make lint`（Go 0 issues、Rust Clippy、TS 检查）
及 `git diff --check` 通过。专用测试数据库与角色清理，不删除既有验收栈。

#### F05 ACP 消费端批次

2026-09-09，仅修改 Agent ACP Service，详细合同见 [Session configuration](session-configuration.md)。

1. 经 Controller 获取完整分页的组织模型目录、Agent 固定默认模型及默认授权，不读取其他服务数据库。模型 ID 与“继承 Agent 默认”分离，失效选择可以呈现但不得准入执行。
2. v1/v2 new/load/resume/fork 按版本返回完整配置；v1 `session/set_mode` 与标准 `session/set_config_option` 共用领域命令。两项真实 select 为 model/mode；不发明 `session/set_model` 或无业务含义的 boolean 开关。
3. Session 覆盖、revision CAS 和有序 configuration 事件同事务提交。配置不进入模型历史；load/resume 返回最新值，fork 保留覆盖，新 Session 不继承其他 Session 的选择。
4. 创建 Run intent 时冻结覆盖，admission 恢复不重新读取后来的选择；已接受 Run 不换模型/凭证/Runtime，下一 Run 使用新配置。新 admission 缺失配置必须失败，不降级成隐式 Auto；历史请求保持原 payload。
5. Chat 不暴露任何工具，包含本地计划工具；Auto 正常执行。Approve/SmartApprove 按精确来源规则允许或拒绝，无许可规则时先拒绝；F06 的用户确认和风险评估仍未实现，不能宣称完整审批闭环。
6. 本批补齐官方 SDK schema、真实 ACP 双版本连接与独立 PostgreSQL、跨身份隔离、CAS/恢复、Run 边界、订阅 cursor 和可观测性边界测试。配置写入有数据库锁等待上限，不把配置通知混入模型历史；通知按提交 sequence 交付，RPC 响应属于各自操作的快照，不能按并发/批请求响应的到达顺序判断最新状态。

当批剩余交付：F05 Gateway/Runtime/Jaeger 联调；随后按用户安排先进入 F06 审批服务批次（见下节）。既有人类验收部署未更新；服务级结果不代替部署证据。

#### F06 ACP 审批服务批次

范围仅 `services/agent-acp-service`。沿用 F05 Controller 的冻结授权合同，不修改 Runtime、Controller、Gateway 或 Web UI。

1. v1 WebSocket/Streamable HTTP 与 v2 WebSocket 均使用官方 ACP SDK 的 `session/request_permission`，分别遵守两版请求结构；四种 once/always 允许/拒绝选项、cancel 和无 handler 均有实际执行效果，不新增私有审批 API。
2. 请求在 Tool attempt 前持久化，绑定 Run、Session、调用 ID、完整参数及精确来源。回包前后检查身份；不支持、未知选项、取消、失权和超时均不触发 Runtime。审批中取消为当前及同批剩余工具补齐未执行结果。
3. 新增服务自有 `tool_permissions`，决策和 Session always 规则同事务提交。取得 Session/Run 锁后按实际时间和取消状态复查；重复/迟到回答不能覆盖已有决定。Always 不改 Agent、不导入无关的并发配置；Fork 清除审批规则，模型/模式仍可复制。
4. 同身份/Agent/access revision/Session 重连可重新询问尚有效的请求；沿用原 admission deadline，不轮询、不延长。close/delete 释放连接登记，取消不配合者在清理宽限后关闭逻辑连接。启动恢复及 Run 终结会取消遗留待决记录，不恢复旧 Run 执行。
5. Smart Approve 已支持精确规则与平台工具非冲突只读注解；未知风险保守询问。本批不包含 Goose 的额外 LLM 只读判定，仍作为 F06 后续工作，不宣称整个 F06 完成。
6. 文档与证据入口：[Tool permissions](tool-permissions.md)。独立只读审查的等锁超时授权、Fork 规则泄漏、Session 登记释放三项均已补测试并修复；最终门禁结果见 [协议验收](protocol-conformance.md)。

最终测试结果：`make test-node` 725 项通过（ACP 401、Console 220、Agent UI 13、共享判定器 91）；独立 PostgreSQL 套件 114 项通过（15 文件），包含真实配置行锁超时与回滚验证。审批交互、外部 Provider、浏览器及新的 Gateway/Jaeger 部署不在本批验收范围内。只读子 agent 已关闭，不保留过程证据或 Trace 原文。

最终准入：生产 `npm run build`、`make fmt-check`、`make lint`、`git diff --check` 通过。Go lint 0 issues，两项 Rust Clippy、ACP ESLint/类型检查及两项前端类型检查通过；专用测试库与角色已删除，核对无测试/构建/lint 子进程残留，既有验收容器和数据卷未修改。

#### F06 Smart 判断、Agent UI 与 F05/F06 部署收尾

2026-09-09，按 ACP、Agent UI、集成三个批次完成剩余范围，没有开启 F07–F10。

1. Smart 对无注解的平台工具做严格只读分类，使用冻结模型和凭证，无工具、无对话历史，不把判断文本注入聊天。精确绑定调用及参数；显式拒绝或冲突注解不被覆盖，未知或失败则询问用户。判断共享 Run 请求预算，保留一次正常答复额度，已返回用量正常计入。
2. 只读审查暴露的用量持久化错误被吞、`update_plan` 缺少非只读注解均已修复并增加回归；判断不是安全边界，也不凭确定性模型测试声称生产分类准确率。
3. Agent UI 呈现完整服务端模型/模式选项，消费配置与模式通知；配置写入中禁发 Prompt，较迟响应不覆盖更新通知。审批独立于消息，显示会话及参数，四种决策只使用服务端提供的选项；取消、换连接和迟到回答清理有可复用测试。
4. `make e2e-tool-permissions` 复用当前 Docker 栈，经 Gateway/Console/Controller 创建两名用户、模型、模板和真实 Runtime。v1/v2 共 26 个场景：once/always 允许拒绝、取消、重连、Chat、只读注解及额外判断；实际验证模型覆盖生效和两次跨用户拒绝。
5. Jaeger 两条执行 Trace 精确覆盖 26 Run、52 模型请求（含四次判断）、16 审批等待、16 Runtime 调用；每次调用有 Gateway 祖先、Run 关联及 Runtime 子 Span，审批完成先于执行。拒绝/取消/Chat 的零执行有负向断言。Trace 不含凭证、参数或判断文本。
6. 浏览器验证允许一次、拒绝一次、Chat 模式、完成后输入恢复及默认折叠；390px 移动端审批面板可用、无横向溢出。手工验收等待脚本曾触发 HTTP 长等待超时，已改短请求等待；自动部署套件独立完整重跑成功，不将超时运行冒充全套通过。

最终准入指标统一记录在 [协议验收](protocol-conformance.md)，不保存逐轮过程文件。此部署复用了既有验收栈并升级相关服务镜像；专用测试客户端、模型容器和两套测试 Runtime 在结束后清理。外部真实 Provider 未使用。

#### F07 官方 SDK 验证与延期决定

2026-09-17 复核：最新官方 rmcp 3.4.0 仍不能解析不带旧 `elicitationId` 的标准 URL 追问。
独立锁定的 SDK 探针三项通过，分别验证基础表单往返、URL 缺口和仅补旧 ID 后的往返；
这三项通过表示缺口已复现，不表示 F07 完成。生产 Runtime 依赖与实现未改动，继续按既定决定等待上游。
命令、上游版本和验收边界见 [最新 SDK 复核](../../../runtimes/antnest-runtime/docs/elicitation.md#latest-sdk-recheck-2026-09-17)。

2026-09-09，本批仅修改 Runtime 实现及其文档、测试，未修改 ACP、Controller 或 UI 的实现。

1. 决策见 [Managed Tool Elicitation](../../../runtimes/antnest-runtime/docs/elicitation.md)：优先验证最新官方 SDK；仍有缺口则暂不支持，等待上游，不 vendor、不维护补丁、不自写协议桥。该项保留为待恢复能力，不影响已完成的 F06 工具许可。
2. Runtime 实际升级并锁定 rmcp 3.2.0，新版依然不能解析没有旧 `elicitationId` 字段的标准 URL 追问。基础标准表单可无损往返；此前扩展 JSON Schema `pattern` 的丢失不作为标准能力缺陷的依据。
3. 撤掉实验性的 raw JSON 结果透传和多轮交互适配。Runtime 不向子 MCP 宣告追问能力，不接收继续请求，不产生自动同意或重试；子 MCP 意外索取输入时保留未知副作用错误，普通工具和进度不受影响。
4. 保留 SDK 缺口探针、现代/旧版连接协商及显式不支持行为的回归测试。下次 SDK 升级优先复测标准 URL 和表单边界，再按 Runtime、ACP、UI、部署联调分别恢复；当前没有 F07 Docker、浏览器或 Gateway/Jaeger 完成证据。

#### F08 命令发现与执行服务批次

F08 服务批次只修改 ACP：最小命令目录、双版本通知、Prompt 内执行与既有持久化复用。
具体合同与验收边界见 [Slash commands](slash-commands.md)，量化结果统一写入
[协议验收](protocol-conformance.md)。本批不修改 Runtime、Controller、Gateway 或 UI，
也不将本地协议测试作为新的 Gateway/Jaeger 部署证据。

#### F08 Gateway 部署联调收尾

2026-09-09，通过独立 Compose 项目的 `make e2e-slash-commands` 完成三种传输入口的命令、目录、历史/文件引用、fork、身份隔离及后续真实工具执行验证。流程与可复用判定器见 [部署合同](../../../scripts/acp-commands/README.md)，最终量化结果统一记录在 [协议验收](protocol-conformance.md#slash-commands-f08-2026-09-09)。

联调暴露 Gateway 的 HTTP handler 异常退出不结束入口 span：按 Gateway 独立批次先补回归测试，再改为 deferred 收尾，保留 panic 和已提交响应的原语义，未改 ACP 或 Controller。修正后完整部署验收通过，测试自有容器、卷和网络已回收，既有验收实例未修改。生产未宣告 `embeddedContext` 的缺口归入 F09；本批明确验证拒绝，不以单服务替身配置冒充生产支持。

#### 后续实施顺序

F09 按 [多模态输入合同](multimodal-content.md) 继续分批：本次仅 ACP 服务，消费
`supports_audio` / `supports_pdf` 和连接 audio 的可选字段，缺省不启用；字段的
该 ACP 批结束时 Controller 生产实现与正式共享 JSON 合同仍待下一批，见下方最新进度。
本批不增加转写服务，不推测第三方地址；原生内容只发给已准入的模型 Provider。
新增输入校验、原生请求字节/顺序、能力不足、快照解码和协议/持久化测试，最终量化
结果归入 [协议验收](protocol-conformance.md)。完整 F09 尚未完成。

**F09 Controller 批次（2026-09-09）**：已接通管理员模型的 `supports_audio`、
`supports_pdf`、内置目录权威、revision 与 Run 冻结快照；`embedded_context` 为内置
文本能力，音频/图片声明只合并同组织启用模型的当前版本与 Agent 固定默认版本。
已修复旧访问绑定标记在模型停用后仍宣告能力的问题。共享管理合同 revision 14、
Run 合同 revision 11；ACP 仅同步合同测试版本，不改消费者业务实现。
13 个 Controller 包的普通/race（含真实 PostgreSQL）及 6 个 ACP 合同测试通过，
完整门禁与边界见 [Controller 验收](../../agent-controller/docs/multimodal-input.md#verification)。
该批之后的 Console 进度见下方；接续 Agent UI 输入，最后 Gateway 联调。

**F09 Console/BFF 批次（2026-09-09）**：共享 Console 合同 revision 34，已接通
目录、模型列表/详情/历史版本及 Agent 配置投影的音频/PDF 能力字段；输入沿用原始
命令交给 Controller 校验，输出改为显式字段白名单，避免模型内部字段透传。
已知模型只读展示官方目录能力，自定义 API 独立配置 Image/Audio/PDF；发布、重试、
显式关闭与历史版本回看均保留原始配置。未修改 Controller/ACP 或 Agent UI 业务实现。
服务测试、构建、根门禁及桌面/手机合成浏览器验收通过，最终量化结果集中记录于
[Console 验收](../../admin-console/docs/multimodal-models.md#verification)。
下一批为 Agent UI 附件输入，之后执行真实 Gateway/Controller/BFF/ACP/Jaeger 联调；
本批没有重建既有部署，不宣称完整 F09 已验收。

**F09 Agent UI 批次（2026-09-09）**：已按连接协商能力提供文件选择，WAV/MP3 使用
标准 audio、PDF 使用 resource blob、UTF-8 文档使用资源或普通文本回退。大小与数量
校验在选择和发送时执行，未知二进制明确拒绝；回放保留音频/PDF，图片/音频提供有界
内联预览，不下载外部 URI。未修改其他服务业务实现。
只读审查发现的当前 Agent 重选卡死和预览资源滞留均已补失败回归并修复，补充了
App 组件测试而不是仅依赖浏览器。最终门禁与量化结果见
[Agent UI 验收](../../agent-ui/docs/multimodal-input.md#final-service-evidence)。
当批后续为实际 Gateway/Controller/BFF/ACP/Jaeger 联调，结果见下；不能把合成
浏览器对端算成部署验收。F10 和单节点阶段的最终收尾仍在目标内。

**F09 联调批次（2026-09-09）**：新建一次性 Compose 项目，所有配置与 Agent
从 Gateway/BFF 创建，v1 HTTP、v1/v2 WS 原生输入、带附件上下文续聊、加载/fork、
能力不匹配后的释放和切回均通过。12 次 Run、9 次确定性 Provider 请求、9 条完整
Jaeger 链路；非法输入和跨身份拒绝单独断言。只读复审发现的终态、通知时序和
引用抓取判据已补强并验证。F08 也在新镜像上复跑通过，新增嵌入文本而保留 ZIP
拒绝与实际 Runtime Bash 正向回归。量化结果统一见
[部署验收](protocol-conformance.md#multimodal-deployment-f09-2026-09-09)。
测试自有资源均已清理，不替换保留的开发实例，也不宣称真实 Provider 识别质量。

建议顺序：ACP 模型增量 -> Runtime 进度/交互产出 -> ACP 工具进度/呈现 -> ACP 计划/命令 -> Controller 授权配置 -> ACP 配置/用户交互 -> 内容/成本配置和消费 -> 联调。
按服务分批 `doc -> test -> code`，再统一串行验收；生产者完成不代表消费者已经接通。
实施时以 §3 的 Goose 复用基线与已确认 W1/W2 为准，不再等待模型范围或授权作用域选择。涉及 Controller 的组织模型目录、admission 和 Agent 默认授权先定义合同，按 Controller、ACP 消费者、联调分别交付，不能由 ACP adapter 接管配置权威。
当前 F01 已完成服务级批次，F02–F06、F08–F10 已完成服务批次和部署联调，F05/F06 Agent UI 已接通。F07 等待官方 SDK 支持。以下记录保留各批次边界，不能由限定部署验收推导为不受限的协议完整性。

**F10 ACP 消费批次（2026-09-09）**：模型快照可消费可选 USD 单价；Provider 返回金额优先，没有时按普通输入、输出、缓存读写分别估算；无依据不伪造零费用。既有 usage 事件保存计量依据及累计已知金额，Session 锁内追加和同 ID 重试去重；恢复不重算，fork 继承历史基线后独立累计。有效用量与输出成功独立，模型回复无效、流式中断、审批判定回退或最终文本刷写失败时仍保存已收到的用量，丢失执行权时禁止继续写入。

协议只发送标准 `usage_update.cost`，不泄露内部计价字段。没有新增表、计费服务或跨服务写库。最终服务级证据见 [协议验收](protocol-conformance.md#session-cost-f10-acp-consumer-2026-09-09)。本批不包含 Controller 生产该价格字段、Console 编辑、UI 展示及 Gateway/Jaeger 部署联调；下一批先完成 Controller 权威配置和共享生产者合同。

**F10 Controller 批次（2026-09-09）**：Model Profile 创建及修订支持可选 USD 单价，管理员完整覆盖优先，官方端点与型号匹配后才使用目录默认值；未知价格不视作免费。单价沿现有模型 revision、Agent spec 和 Run 准入快照保存，无新表、无新增内部鉴权层。保留旧的元数据规范化，但价格默认值不参与请求幂等指纹；已完成请求、历史模型与已有 Run 不重新计价。显式 Session 选择取下一次准入时的当前模型 revision，继承默认仍保持 Agent 的旧 pin，调价不重建 Runtime。共享 control/run 合同升级至 15/12，ACP 消费合同已对齐。最终测试及只读复审证据见 [Controller 计价文档](../../agent-controller/docs/model-pricing.md)。下一批为 Admin Console/BFF 价格编辑与 revision 展示，然后 Agent UI 与部署联调；F10 尚未整体完成。

**F10 Console/BFF 批次（2026-09-09）**：共享 Console 合同 revision 35。模型创建及修订支持可选 USD 单价；默认预览目录价，手工设置后明确提交，历史详情只读保存的 revision。未知不等于免费，空缓存单价不补零，非法/下溢数值被拒绝，私有上游字段不进入浏览器。修复成功响应损坏时丢失重试标识的问题，并锁定发布中的表单、隔离跨模型页面草稿。245 项前端测试、Console 全模块 race、构建及全仓 fmt/lint 准入通过；Chrome 桌面与 320px 窄屏通过合成数据验收。完整指标见 [Console 计价文档](../../admin-console/docs/model-pricing.md#verification)。下一批是 Agent UI 费用消费，之后执行 Gateway/Controller/ACP/Jaeger 部署联调；本批没有改其他服务实现，F10 尚未整体完成。

**F10 Agent UI 批次（2026-09-10）**：消费标准 `usage_update`，分离当前上下文与会话累计已知费用，不在浏览器计价或累加。未知不显示为免费，完整数值直接可读；成功回放重建投影，失败回放保留已知值并标记上次接收，同会话加载合并，Agent/Session 双重标识隔离显示。56 项服务测试、构建与全仓 fmt/lint 通过；两轮只读复审及桌面/320px 合成浏览器验收完成。指标与边界见 [Session usage](../../agent-ui/docs/session-usage.md#verification)。下一批为 Gateway/Controller/ACP/Jaeger 部署联调；F10 尚未整体完成。

**F10 部署联调批次（2026-09-10）**：临时 Docker 空白实例、单 PostgreSQL 实例分服务数据库、本地确定性模型，通过官方 SDK 验证 v1 HTTP、v1/v2 WebSocket。52 次调用覆盖返回费用优先、零值与未知、缓存估算、旧默认 pin、准入时新价格及执行中调价不影响已冻结快照、fork 独立累计；真实重启 ACP 后恢复 9 个业务会话，未重新选择模型也保持原配置，返回选项与实际执行均核对，另一用户的在线观察会话不串流。SDK 解析前检查完整原始帧，9 次跨 Agent 和 3 次跨用户访问被拒绝。11 条执行/恢复/拒绝 Trace 与 19 条价格管理 Trace 通过因果校验，临时资源全部清理。最终指标与范围见 [部署验收](protocol-conformance.md#session-cost-f10-deployed-integration-2026-09-10)。F10 完成，F07 继续按用户决定暂缓；后续回到单节点 C1–C6 汇总，不开启横向扩展。

验收必须覆盖：

1. 单元/集成证明实际业务效果，wire 测试证明内容/进度先于调用结束到达客户端，不只断言通知被构造。
2. Postgres 下的恢复、取消/失败、部分输出、配置/审批范围、跨身份隔离；完成响应不能越过先前输出，最终内容不重复。
3. 无交互客户端、模型能力不足、无价格、不支持 MIME 等组合明确拒绝或标准降级，不制造假成功。
4. 新交互重连重新核验身份；URL 完成不得泄露到另一连接。所有终态关闭对应等待，不能遗留后台执行。
5. 持久化必要业务事实，不逐 token 新建审计记录或永久保留所有传输包；批量/分块不能牺牲已承诺的恢复语义。
6. 服务准入后，以 Gateway 为入口验证 HTTP/WebSocket、Runtime MCP、持久恢复；UI 按其选择呈现，不补 Server 的语义漏洞。
7. W1：切换同组织不同 Provider 的可用模型，验证实际凭证、上下文窗口和多模态能力同步切换；跨组织与停用模型拒绝；选择至 admission 之间失效不静默回退；已有 Run 不换模型，Session 恢复保留选择，不重建 Runtime。
8. W2：无覆盖继承 Agent 默认；模式/工具规则覆盖仅影响当前 Session；once 不持久化为未来授权，always 不回写 Agent 默认；load/resume 保留覆盖，撤销覆盖恢复继承，新 Session 不带入其他会话的覆盖。
9. W2：Agent 默认更新影响后续 admission 中仍继承的项，不覆盖显式 Session 配置或改写活动 Run；不同组织/身份/Agent/工具来源的许可隔离，任何会话覆盖都不能突破平台资源权限。

前期方案研究仅做静态核查；后续使用确定性 Provider 流、真实 ACP 连接、本服务专用 PostgreSQL 测试库及具名 Gateway/Runtime/Jaeger 场景验证；F05/F06 已补浏览器验收。未调用外部 Provider；其他 F 项的决策完成不等于验收完成。
