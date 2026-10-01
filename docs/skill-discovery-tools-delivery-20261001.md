# Skill 动态发现：ACP D3 模型工具交付

日期：2026-10-01。所属服务是 Agent ACP Service，承接
[D2 自动投影/当前来源](skill-discovery-acp-delivery-20261001.md)和
[四步传播方案](evolver-technical-analysis.md#112-用户确定的四步产品流程)。
本批交付真实模型搜索和确定正文加载；Runtime 临时文件、用户提升页面和
Template/rebuild 完整传播仍待后续批次，不能将正文加载描述为完整包已安装。

## 行为与边界

- 按[平台工具合同](../contracts/agent-acp/skill-discovery-tools.md)增加
  `find_skill`、`load_skill`。两者使用 `source=agent`、`sourceId=skill_registry`，
  不伪装为 Runtime MCP 或已有 plan 工具。模型名称冲突明确拒绝。
- 组织、用户、Agent 和执行身份由持久化的活动 Run/Session 推导；请求中没有
  身份、服务 URL 或任意下载路径。调用前后重新核对当前访问权和 Runtime 绑定。
  沿用 Session 模式、工具规则及普通 ACP 审批，不授予发布或持久安装能力。
- 每个 Run 最多八次搜索、四次加载，按已派发的持久工具尝试计数，失败和恢复
  也计入。空搜索与仓库故障分开返回；错误不透传上游正文或凭据。
- 加载严格绑定选择的引用和内容摘要，校验 ZIP 响应头、实际长度、制品摘要、
  完整内容清单、执行位、CRC、路径、条目及大小限制，再返回 UTF-8 正文。
  解包只在内存中校验，不保存发现包缓存，正文沿用既有对话/工具结果保留规则。
- 当前 `temporary_files=null`。多文件包显式提示额外文件不可读取/执行；真实
  文件交付及 Run 完成/取消后的清理由 D4 和后续 ACP 消费批次承担。
- 只读尝试的效果为 `none`。取消或 ACP 进程恢复不会因此建立 Runtime 写屏障；
  普通 Runtime/client 工具的不确定效果处理保持原语义。
- `skill.discovery.search/load` 与普通 Tool span 相连，保存 Run、来源、版本/
  序号和摘要，不捕获查询、Skill 正文、包、对话或令牌。

配置沿用 D2 的成对 opt-in 设置；见
[ACP README](../services/agent-acp-service/README.md#dynamic-skill-model-tools-d3)。
本批没有修改 Runtime、Controller 或界面实现，也没有启用旧验收部署。

## 验证

| 门禁                | 结果                                                                                                                    |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| ACP 全量单元        | 120 份文件、1089 项通过；含输入/包合同、权限、重复身份校验、预算接口、取消及普通工具分派                                |
| PostgreSQL 全量组件 | 36 份文件、316 项通过，零跳过；含真实 Run 权威、持久预算、访问撤销及只读中断恢复                                        |
| 真实 HTTP           | 回环服务验证认证与推导身份、精确 ZIP、响应限制及取消后连接关闭通过                                                      |
| 静态检查            | 服务和根集成源码 lint、typecheck、格式及链接检查通过                                                                    |
| 双 Agent Docker     | A 自动学习/更新并投影，B 的真实前景模型依次搜索/加载同一来源摘要并完成；数据库回执与实际 Jaeger Trace 来源/父 span 通过 |

最终依赖修复后项目 antnest-lifecycle-4f6843f1 的 B 调用记录为 Find Skill / Load Skill，
持久尝试均是 agent/skill_registry、completed、none。实际 Trace
66430d8d94dbd550bb1d4d01ce2674fa 同时包含搜索与加载，加载绑定 A 的序号 2
及当前内容摘要。没有使用付费 Provider，使用确定性模型和真实服务/SDK。

包解析使用 yauzl 3.4.0，并补充它未提供的 CRC 校验。新增依赖审计时发现原有
锁文件中的 brace-expansion 5.0.9 和 fast-uri 3.1.6 存在漏洞；仅将这两个传递
依赖更新至 5.0.12 和 3.1.8，复查零漏洞。更新后重新执行单元、数据库与 Docker。

私有证据位于 artifacts/verification/skill-discovery-d3-20261001/ 和
artifacts/verification/skill-learning/，均不进入 Git 或 Docker 构建上下文。
此前失败保留：平台工具被误判为 plan、迁移约束及测试行状态字段问题已按失败/
通过证据处理；首轮 Docker 的业务调用已完成，但脚本将人类标题错当函数名，
修正断言后重跑通过。本次所有候选项目资源与镜像清理，原有停止资产保留。

## 后续消费者

[Runtime D4](skill-discovery-runtime-delivery-20261001.md) 已冻结签名且绑定
执行/Run 的私有交付合同，真实文件、配额、普通 read/Bash 及清理通过所属门禁。
[ACP D4A](skill-discovery-temporary-consumer-delivery-20261001.md) 文件交付/持久
回收与 [Console D6](skill-discovery-console-delivery-20261001.md) 提升入口也已
分别通过门禁。[DI1](skill-propagation-integration-delivery-20261001.md) 已证明
真实自动学习来源、临时使用、登录提升、模板创建及显式 rebuild/Run 的完整四步。
上述 D3 结果仍为正文，不以只读回执替代后续真实文件写入/回收的独立证据。
