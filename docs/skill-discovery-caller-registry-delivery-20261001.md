# Skill 前景搜索：D1A Registry 调用方过滤

2026-10-01：Registry 的调用方过滤已通过所属门禁。ACP 派生调用方与真实
活动 Run 集成仍需 D3A；本批不是完整前景修复。
本批修改共享合同、Skill Registry 实现及其服务/根测试，没有修改 ACP 实现。

## 问题与规则

当前 `find_skill` 可能同时命中调用方自己的个人投影及其他来源。来源读取
使用空闲维护准入，而调用方正在执行 Run，核验自己的投影会返回
`source_unavailable`，使整次搜索失败。Registry HTTP 单元复现保留了此失败，
共享合同的新字段也先失败后实现。

[发现合同](../contracts/skill-registry/discovery-api.md)新增内部搜索上下文
`requesting_agent_id`。ACP 将从已授权的持久 Run 派生该值；模型的
`find_skill_input` 不接受它。Registry 在候选上限之前排除该 Agent 的个人
投影，也不对其发起来源核验。正式版本继续参与搜索，包括原本提升自调用方
的版本。字段不改变组织/所有者授权，界面预览不传此值，继续可以提升自己的来源。

实现只有一个附加查询条件和对应输入/回源检查，没有新增表、后台监听或
Runtime 接口。明确提供 null、空串或非规范 ID 时返回 400。

## 验证

复现入口：`make e2e-skill-discovery-caller-registry`。
[Registry 单元](../services/skill-registry/internal/registry/discovery_http_test.go)
验证忙碌调用方、正式结果及非法 ID；
[真实 PostgreSQL](../tests/integration/go/skill-registry/internal/registry/discovery_postgres_integration_test.go)
验证 `limit=1` 前过滤及读取范围；
[部署流程](../tests/e2e/skill-registry/discovery-docker.mjs)采用明确来源测试桩，
验证来源停机后的正式搜索并保留原先的错误语义。

| 门禁                      | 结果                                                                           |
| ------------------------- | ------------------------------------------------------------------------------ |
| Registry 单元             | 28 项、55 子例通过                                                             |
| 共享发现合同              | 8 项通过，模型不能提供调用方字段                                               |
| HTTP/PostgreSQL/race 组件 | 32 项、55 子例通过，无跳过                                                     |
| Go lint                   | 0 问题，临时根集成测试源映射已清理                                             |
| 独立部署                  | `antnest-skill-discovery-bb35eeb3` 通过，约 34 秒，6 组检查                    |
| 清理                      | 原有 17 个停止容器、0 个运行容器、15 个网络、11 个卷保持相同，本批候选镜像移除 |

私有证据位于 `artifacts/verification/skill-discovery-caller-d1a-20261001/`，
最终索引为 `admission.json`。组件和部署证据在 `docker-bb35eeb3/`；单元/合同
失败记录保留。测试源和证据不放在 `.cache/`，不读取实际模型凭据。

## 待交付消费者

D3A 只改 ACP：从持久 Run 发送调用方 ID，模型不能覆盖，保持预算/取消和
当前授权检查，再单独完成真实活动 Run 搜索正式版本及其他 Agent 来源的集成。
此前 [DI1](skill-propagation-integration-delivery-20261001.md) 和
[DI2](skill-source-lifecycle-delivery-20261001.md) 的范围和证据保留；两者没有
直接覆盖调用方自身已有同名投影的活动 Run 搜索，不能替代这个消费者门禁。
