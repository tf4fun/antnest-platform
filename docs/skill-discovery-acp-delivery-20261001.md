# Skill 动态来源：ACP D2 交付

日期：2026-10-01。所属服务是 Agent ACP Service，承接
[Registry D1](skill-discovery-registry-delivery-20261001.md)与
[四步方案](evolver-technical-analysis.md#112-用户确定的四步产品流程)。
本批完成真实来源生产与读取；模型工具、Runtime 临时交付和用户提升页面
仍待所属批次交付，不能将本批描述为完整四步流程完成。

## 实现

- 已确认生效的自动学习结果，在学习变更和受管身份的同一事务中登记来源头。
  只新增元数据、候选身份引用和发送状态，不另存正文或 ZIP。
- 后台工作器持久记录退避和确认序号。补扫只读取已确认生效的受管学习记录，
  不扫描或接管普通工作区文件，不重新调用模型。
- 来源变更按键递增序号。撤销访问、受管状态失效和内容变化保留墓碑，旧回执
  不能确认新状态。配置尚未恢复时延后发送，不误删来源。
- 专用来源令牌只接受 inspect/artifact 两条私有读取接口。跨所有者读取不可见，
  不因同组织而放行；请求大小、序号、摘要和错误遵守冻结合同。
- 复用 Runtime 只读 observe 核验整个目录清单，包括新增文件和文件模式。
  仅当前清单与已生效受管包一致时返回确切包。离线、繁忙或核验不确定返回
  不可用，禁止用保留候选作为离线副本兜底。
- 读取后再次核对身份、访问和 Runtime 绑定。只读核验与学习共享空闲准入；
  前景抢占取消交付，等待已派发读取结束后继续。目录刷新也遵守同一准入。
- 投影发送与来源核验 Trace 保留有界身份和摘要，不记录正文、包、对话或令牌。

配置默认关闭，需配对 ACP/Registry 设置；见
[ACP README](../services/agent-acp-service/README.md#dynamic-skill-sources-d2)和
[接口合同](../contracts/skill-registry/discovery-api.md)。本批没有启动旧验收环境，
也没有改共享开发部署配置。

## 验证

| 门禁                | 结果                                                                                                  |
| ------------------- | ----------------------------------------------------------------------------------------------------- |
| ACP 全量单元        | 115 份文件、1049 项通过，含输入合同、来源错误、前景抢占和目录读取并发                                 |
| PostgreSQL 全量组件 | 35 份文件、311 项通过，零跳过；含登记事务、补扫、墓碑、退避与旧回执竞争                               |
| 真实 HTTP           | 专用鉴权、字段/体积限制、ZIP/摘要响应头、状态映射和错误脱敏通过                                       |
| 静态检查            | 服务 lint/typecheck 与根集成源码 lint 通过                                                            |
| 隔离 Docker         | 真实学习创建/更新、自动投影、停机后学习继续、ACP 重启后补发、当前取包、变化失效与正式版本独立读取通过 |

最终项目 antnest-lifecycle-4cc5cd54 的来源序号由 1 变为 2；增加真实 extra.txt
后失效墓碑序号为 3。正式版本和其幂等提升回执在来源变化后继续独立获取。
使用确定性模型，没有调用付费 Provider。测试源保存在服务及根测试目录，
没有使用 .cache 保存测试或证据。

证据位于 artifacts/verification/skill-discovery-d2-20261001/，最终业务记录位于
artifacts/verification/skill-learning/antnest-lifecycle-4cc5cd54.json，均为忽略 Git
和 Docker 上下文的私有证据。项目容器、网络、卷及候选镜像已由清理回收；
原有停止资产保留。

此前失败均保留：迁移清单漏列 0016，修正后组件通过；旧脚本在提升后重复上传
同名包，已移除重复步骤；命令目录读取绕过空闲准入，与候选清理争用 Runtime，
已补失败/通过回归并统一准入。最终 Docker 包含随后的前景 Run 验证通过。

## 后续消费者

[D3](skill-discovery-tools-delivery-20261001.md)现已交付实际 find_skill/load_skill
目录、dispatch、权限、预算及正文加载。
[D4](skill-discovery-runtime-delivery-20261001.md) 已冻结私有交付 wire schema，
[D4A](skill-discovery-temporary-consumer-delivery-20261001.md) 已完成真实文件、
持久回收与重启恢复，[D6](skill-discovery-console-delivery-20261001.md) 已完成
提升入口。最后 [DI1](skill-propagation-integration-delivery-20261001.md) 已通过
双 Agent 临时使用、正常登录提升、模板创建及 rebuild/Run 集成。本批原有
后端 API 证据范围保持不变，组合业务由后续独立门禁证明。
[DI2](skill-source-lifecycle-delivery-20261001.md)另行完成正常来源
Disable/Enable/Delete、原内容身份恢复和删除墓碑的直接业务验收，同时验证
已提升版本与预设独立可用；本批历史生产者门禁范围不变。
