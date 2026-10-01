# Skill 动态发现与提升：Registry D1 交付

日期：2026-10-01。范围是[四步方案](evolver-technical-analysis.md#112-用户确定的四步产品流程)
中的共享 Registry/source 合同和 Registry 自有 D1。本批通过所属服务门禁，
不代表自动学习 → 动态使用 → 用户提升 → Template/rebuild 全流程完成。

## 实现结果

- 动态投影只保存来源 Agent、所有者、名称、描述、序号、摘要及活动状态。
  不保存投影包、正文或文件清单，源内容和生命周期仍归 Agent。
- 同一来源键按序更新、同输入重放、旧序号拒绝覆盖；移除保留元数据墓碑，
  延迟更新不能恢复已移除的映射。
- 检索合并正式版本与个人来源，按当前来源读取权限核验候选。个人来源首批
  限同一所有者；不新增组织共享配置或向量服务。
- 临时读取按选定序号及摘要回源，校验完整包后返回。来源失效、不在线和内容
  变化分别处理，不在 Registry 落盘或使用旧副本兜底。
- 提升按需取包，通过相同包规则后原子保存正式版本、来源追溯和幂等回执。
  正式版本随后不再依赖来源；相同请求在来源删除/停机后仍重放原结果。
- 模板引用合同保持精确 skill_id/version。包的只读卷交付、模板修订和显式
  rebuild 沿用已有实现。本批没有修改 Controller/ACP/Runtime/UI 实现。

接口与配置见[共享合同](../contracts/skill-registry/discovery-api.md)、
[schema](../contracts/skill-registry/discovery-api.schema.json)和
[服务说明](../services/skill-registry/README.md)。现有生产配置不自动启用
ACP 来源适配；需要 D2 先交付受保护来源接口。

## 验证与证据

开发先写合同与服务行为测试，保留预期失败记录，再实现并验证：

| 门禁                                      | 结果                                                                                               |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------- |
| JSON schema、工具输入与 Template 固定引用 | 7 项合同测试通过                                                                                   |
| Registry 全模块 Go 单元测试和 race        | 通过，含 CLI 配置与原有包规则回归                                                                  |
| 真实 HTTP 来源协议                        | 检索/取包、摘要、状态映射、拒绝重定向及取消关闭通过                                                |
| PostgreSQL 组件及内部包完整回归           | 30 项测试、55 项子测试通过，零跳过；含原版本升级、并发映射排序、CAS 失败回滚、回执与来源追溯原子性 |
| Registry 隔离 Docker                      | 五组流程通过：不接管投影、权限隔离、实时来源与故障、正式提升、重启后脱离来源                       |
| Go lint                                   | 所属服务及根目录集成源通过，0 issues                                                               |

最终 Docker 项目为 antnest-skill-discovery-fd18db88，证据目录为
artifacts/verification/skill-discovery-d1-20261001/docker-fd18db88/。
全部证据私有、排除 Git 和 Docker 上下文；测试源分别位于服务内、
tests/integration/ 和 tests/e2e/。

最初 HTTP 取消测试未读取请求体，测试端因而未观察断连；已中断并回收该次
子进程，修正测试端并加入时间上限，重新验证通过。此前沙箱禁止监听的失败
保留，不作为业务失败。Docker 脚本也修正了两项测试环境问题：PostgreSQL
临时初始化实例误报健康，以及容器重启后仍使用旧随机端口。最终记录显示
Registry 端口由 32787 变为 32788；脚本重读绑定并使用新连接完成后续用例。
各次隔离项目均清理至启动前基线，不覆盖此前失败记录。

最终容器、项目网络、卷及候选镜像已删除，原有停止的开发/验收资产保持不变。
未重新启动旧验收环境，没有调用真实模型或发送业务数据。

## 后续消费者

D0 冻结 Registry/source 边界和模型工具输入；后续完整 Runtime 私有临时交付
wire schema 已由 [D4](skill-discovery-runtime-delivery-20261001.md) 冻结并实现，
不将本批原有语义说明当作 Runtime 接口实现证据。

后续 [D2](skill-discovery-acp-delivery-20261001.md) 已完成真实学习投影、持久
补送/失效和当前来源接口；以下消费者也已分别交付：

- D3：实际模型工具目录、dispatch、前景授权/预算与 Trace。
- D4：真实临时文件交付和 Run 完成/取消清理，先补齐其私有合同。
- Console 用户提升页面；Controller 配置/生命周期及 Agent UI 提示经 DI1 确认可复用现有实现。
- DI1：双 Agent 真实学习、动态使用、提升和 Template/rebuild/Run 集成。

完整四步业务由 [DI1](skill-propagation-integration-delivery-20261001.md) 独立
验收通过；原有服务权限和 UI 工具/通知复用现有实现，没有额外条件适配批次。

本批来源是显式 HTTP 测试桩，不能作为真实 ACP 自动投影或 Runtime 使用证据。
