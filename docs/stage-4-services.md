# 阶段四：Skill 托管、外部渠道与定时任务

> 更新日期：2026-09-28
>
> 状态：Skill Registry、Template 固定引用、RC 交付与 Controller 生命周期消费已落地。隔离的 12 服务 I1 回归已通过发布 v1、创建及真实 ACP Run、发布 v2、重建、禁用/启用和删除清理；Runtime 到 Registry 的服务名和实际 IPv4 出口拒绝也已验证，且确认当前 Registry 网络未启用 IPv6。八库多卷存储恢复及双 Agent 真实 Skill 离线恢复已通过。当前是无旧业务数据的开发部署，Skill Registry 首版按全新部署验收；旧资产迁移和异机导出不属于本轮门槛。
>
> 本文记录服务范围、职责边界和后续交付方式；当前状态见下表。

## 范围与命名

阶段四规划新增 **3 个服务**：

| 服务标识 | 名称 | 核心职责 | 当前状态 |
| --- | --- | --- | --- |
| `skill-registry` | Skill Registry | Skill 托管仓库，管理不可变版本，支持模板引用和 Runtime 只读交付 | 首版全新部署范围已通过本地、组件、浏览器及 Docker 业务/恢复回归；历史旧资产迁移不纳入当前验收 |
| `channel-manager` | Channel Manager | 外部渠道交互中心，连接外部渠道与平台 Agent 会话 | 规划已记录，未实现 |
| `task-scheduler` | Task Scheduler | 定时任务调度中心，管理计划并触发 Agent 任务 | 规划已记录，未实现 |

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

2026-09-27 评审明确：准备先于 Initialize/Drain/Fence，卷按 Agent 和集合摘要
复用，暂时故障可续作；统一 YAML 样例校验真实类型；旧共享资产先盘点、备份、
显式迁移。另有 [Skill 学习草案](skill-learning-design.md)，首版为候选、展示确认、
空闲激活，后台只生成建议；不增加新服务，也不成为 Registry 首版依赖。

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
所属批次（B1–B5）已有实现与本地门禁，显式集成 I1 的基础业务链已通过，
恢复与迁移验收继续推进；未来启用 IPv6 时须补实际地址拒绝测试。学习方案
独立安排 L0 合同、所属服务及
用户确认/后台候选的两次集成；Channel Manager 和 Task Scheduler 尚未进入
详细技术设计。服务单元测试、根目录集成/E2E 和私有证据继续遵循既有
[测试归属与存储规则](../tests/README.md)。
