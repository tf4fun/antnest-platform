# 阶段四：Skill 托管、外部渠道与定时任务

> 更新日期：2026-10-01
>
> 状态：Skill Registry、Template 固定引用、RC 交付与 Controller 生命周期消费已落地。隔离的 12 服务 I1 回归已通过发布 v1、创建及真实 ACP Run、发布 v2、重建、禁用/启用和删除清理；Runtime 到 Registry 的服务名和实际 IPv4 出口拒绝也已验证，且确认当前 Registry 网络未启用 IPv6。八库多卷存储恢复及双 Agent 真实 Skill 离线恢复已通过。当前是无旧业务数据的开发部署，Skill Registry 首版按全新部署验收；旧资产迁移和异机导出不属于本轮门槛。
>
> 本文记录服务范围、职责边界和后续交付方式；当前状态见下表。

## 范围与命名

阶段四规划新增 **3 个服务**：

| 服务标识          | 名称            | 核心职责                                                                                       | 当前状态                                                                                                                    |
| ----------------- | --------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `skill-registry`  | Skill Registry  | Skill 托管仓库，管理不可变版本，支持模板引用和 Runtime 只读交付；增加 Agent 来源映射与动态发现 | 首版全新部署门禁通过；动态发现 D1、D2、D3、D4、D4A、D6 通过所属门禁，DI1 真实四步传播集成通过；历史旧资产迁移不纳入当前验收 |
| `channel-manager` | Channel Manager | 外部渠道交互中心，连接外部渠道与平台 Agent 会话                                                | 规划已记录，未实现                                                                                                          |
| `task-scheduler`  | Task Scheduler  | 定时任务调度中心，管理计划并触发 Agent 任务                                                    | 规划已记录，未实现                                                                                                          |

服务标识沿用仓库的小写连字符风格。需求中的 `skill-registy` 按已有
Skill Registry 名称统一拼写为 `skill-registry`。此前文档中的 Channel Gateway
对应本阶段的 Channel Manager，Scheduler 对应 Task Scheduler；它们是同一规划
职责的新名称，不是额外服务。历史验收报告保留当时称呼。

## 服务职责边界

以下延续 [服务所有权约定](service-layout.md)，作为后续设计的范围基线；
Skill Registry 的技术选择见最小方案，其 Registry 自有接口合同已经登记；其他两项
服务的具体接口、数据结构和实现技术待后续设计确定。

### Skill Registry：Skill 托管仓库

[职责拆分与参考分析](skill-registry-responsibilities.md)保留 ClawHub/腾讯 SkillHub
的调研事实；用户已将首版明确收缩为以下三点，详见
[最小版本技术方案](skill-registry-minimal-design.md)：

1. 托管 Skill 包及其不可变版本，提供组织内元数据查询与固定制品下载。
2. Skill 作为 Agent Template 的一部分，引用明确版本，随模板和 AgentSpec 冻结。
3. Runtime Controller 在生命周期变更前准备集合，创建/重建时按目标模板只读交付；系统
   Skill 只读，作为 Agent 基础能力，保留个人 Skill 与工作区。

Registry 只拥有包与版本；模板选择归 Agent Controller，隔离副本/挂载归 Runtime
Controller。首版复用 Runtime 发现和按需读取，ACP 另有封闭旧正文通道的批次，
不做外部导入、搜索推荐、审核评测、社区和热更新。发布新版本不自动改变已有 Agent。

Registry 已按评审实现准备先于 Initialize/Drain/Fence、按 Agent 和集合摘要复用
及暂时故障续作；统一 YAML 样例校验真实类型。当前没有旧业务数据，旧资产迁移
不纳入本轮。独立的 [Skill 学习方案](skill-learning-design.md)在 2026-09-29 调整为
自动生成/更新受管个人 Skill、按策略空闲激活及结果提示，人工保存作为补充。
[Hermes 研究](hermes-skill-learning-research-20260929.md)记录源码及设计输入。
学习 L0–L4、LI1 当前首版功能门禁已通过，包括所属服务、组件和真实 Docker
浏览器回归，证据及范围见 [学习验收核对](skill-learning-acceptance-audit-20260930.md)。
开发阶段沿用已有样式，可进入人类体验验收后再细调。
不增加新服务，也不成为 Registry 依赖。

2026-10-01 用户确定后续四步流程：**Agent Skill 自动投影到 Registry →
检索与当前 Run 临时使用 → 用户提升为正式系统 Skill → Template/rebuild
提供预设能力**。投影只登记已生效受管个人 Skill 的动态元数据和来源引用，
临时使用按需回源，源内容与生命周期仍归 Agent。提升时才把完整包交给 Registry
托管为独立不可变正式版本，模板继续只引用正式版本。详见
[动态发现与传播设计](evolver-technical-analysis.md#112-用户确定的四步产品流程)。
Registry/source 共享合同和 Registry D1 已交付并通过所属门禁，详见
[交付记录](skill-discovery-registry-delivery-20261001.md)。ACP D2 自动生产与当前
来源读取已通过门禁，详见[ACP 交付记录](skill-discovery-acp-delivery-20261001.md)。
[D3 模型搜索/加载](skill-discovery-tools-delivery-20261001.md)已通过所属单元、合同、
HTTP/PostgreSQL 及双 Agent Docker 门禁，并核对 Trace 来源和摘要。
[Runtime D4](skill-discovery-runtime-delivery-20261001.md) 已冻结私有交付合同，
[ACP D4A](skill-discovery-temporary-consumer-delivery-20261001.md) 已消费真实文件
交付并通过普通 read/Bash、持久回收、取消及正常重启门禁。
[Console D6](skill-discovery-console-delivery-20261001.md) 已完成来源搜索/包预览、
显式新建/追加提升并通过所属及桌面/手机 Docker 门禁。
[DI1](skill-propagation-integration-delivery-20261001.md) 已通过真实学习、动态
来源、临时使用、正常登录提升、模板创建/冻结、两 Agent 显式重建及实际 Run 的
完整四步集成，包含 Registry 停机与来源失效。仍不以此替代整个仓库的全面回归。
随后[常规部署接线验收](skill-deployment-delivery-20261001.md)通过 6 项配置/构建检查，
并使用普通 Compose 的认证与维护配置再次跑通完整业务链路。
[部署说明](skill-deployment.md)记录独立来源 bearer 和现有 Runtime 的重建要求。
[DI2 来源生命周期](skill-source-lifecycle-delivery-20261001.md) 已通过真实
Disable/Enable/Delete：来源读取依次不可用、原身份恢复、删除后拒绝并送达墓碑；
已提升制品和预设保持独立，8 个实际预设 Run 及 Trace 父链通过。

[DI3 活动调用方](skill-discovery-caller-integration-delivery-20261001.md)进一步
验证真实 Run 检索正式当前版本及另一 Agent 的来源，排除自身个人映射；普通
Compose 的 8 项配置测试与完整四步回归通过。[Registry D1T](skill-registry-trace-delivery-20261001.md)
补足来源 HTTP Trace，307 个调用方 span 的父链完整，正文采集关闭。用户此前
确认可接受的纯时间告警仍保留，不影响此项验收。

### Channel Manager：外部渠道交互中心

- 管理渠道连接、Agent 绑定、外部会话与 ACP Session 的映射、入站消息回执
  和出站投递记录。
- 将外部消息和 `/` 控制命令转换为已授权的平台操作，并将执行状态和结果
  反馈到对应渠道。
- 不接管平台身份权威、Agent 生命周期、ACP Session/Run 状态或模型执行。
  不依赖浏览器页面、浏览器 Cookie 或 Agent UI 的临时选择状态。
- 待设计：首批支持的渠道、外部身份绑定、渠道凭据与回调校验、去重和投递
  重试、断线恢复、审批交互，以及控制命令的后端复用方式。

[现有命令准备](stage4-command-preparation-20260926.md)已交付 Agent UI 的
11 个控制命令及其语义合同。Channel Manager 是待交付消费者；当前浏览器
私有 HTTP 接口不直接成为渠道集成合同。跨渠道会话与模型配置联动仍需独立验收。

### Task Scheduler：定时任务调度中心

- 管理定时计划、启停状态和触发记录，按计划发起 Agent 使用请求并关联执行结果。
- Agent Controller 继续拥有 Agent 配置和生命周期，ACP Service 继续拥有
  执行准入、Session、Run 和执行审计；调度触发不等于业务执行成功。
- 不建立第二套 Agent 执行循环，不接管 Tool 执行，也不读取其他服务的数据库。
- 待设计：时间规则与时区、执行身份、Session 新建或复用、重叠执行、漏触发、
  去重与失败重试、重启恢复，以及调度引擎是否复用现有 Temporal。

## 与阶段三的关系

[阶段三当前服务验收](stage-3-current-services-closeout.md)和
[阶段四前依赖更新与回归](dependency-refresh-20260926.md)是已记录的基础。
本次规划不改变其验收范围、已审查的 Trace 时间告警处置，以及人工体验、真实
读屏器和非本机环境验收的独立状态。进入阶段四不代表这些人工或外部环境项目已通过。

阶段四的新增服务范围限定为上述三个服务。Kubernetes、多节点/高可用及独立
Audit Service 不因本次规划自动纳入。现有服务可能需要作为消费者适配，但适配
范围和接口必须在后续共享合同中明确，不能将新服务的业务记录放进 Console 或
其他服务的数据库。

## 后续交付方式

遵循仓库 [AGENTS.md](../AGENTS.md)，后续实现按以下方式推进：

1. **共享合同先行**：明确各服务拥有的资源、授权、输入输出、幂等与失败语义、
   依赖就绪条件及跨服务验收路径。本文只记录规划，不是可执行接口合同。
2. **服务独立交付**：三个服务分别建立所属服务批次，先写行为测试，再实现；
   同批维护该服务的文档与测试，其他服务的消费适配单独登记和交付。
3. **显式集成批次**：生产者和消费者各自通过本地门禁后，验证 Skill 使用、
   外部渠道交互和定时任务触发的完整业务链路。
4. **阶段验收**：单元、合同、组件及适用的 Docker E2E 证据通过后，再报告对应
   交付完成；单个服务完成不等于整条业务流程完成。

Skill Registry 采用 Go/PostgreSQL、ZIP 制品、模板固定版本和按 Agent
只读卷；共享合同 B0 和 Registry、Controller、Runtime Controller、Console、ACP
所属批次（B1–B5）已有实现与本地门禁，显式集成 I1 的业务链及当前恢复验收
已通过；未来启用 IPv6 时须补实际地址拒绝测试。学习方案的 L0 合同、所属服务
和自动学习 LI1 的当前功能门禁已通过，人类体验验收尚未进行；人工保存作为
L5a/L5b 及 LI2 的补充；
Channel Manager 和 Task Scheduler 尚未进入
详细技术设计。服务单元测试、根目录集成/E2E 和私有证据继续遵循既有
[测试归属与存储规则](../tests/README.md)。
