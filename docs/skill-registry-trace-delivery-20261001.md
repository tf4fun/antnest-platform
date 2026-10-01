# Skill Registry D1T：回源 Trace 传播修复

2026-10-01：Registry 所属 10 个门禁已通过；后续部署和 DI3 也已通过各自验收。

DI3 的第三轮真实业务已完成搜索、正式版本加载和另一 Agent 来源加载，
三个持久工具回执均完成，确定性模型没有错误。调用方 Trace 的 284 个
span 父链完整，但只含 ACP、Identity、Gateway、Runtime，没有 Registry
和两次 `skill.source.observe`。修复前 Registry 没有 SDK 初始化、HTTP
SERVER 提取和回源 CLIENT 注入，导致来源核验无法关联到调用方。

本批依据 [HTTP Trace 合同](../contracts/skill-registry/trace-boundaries.md)，
只修改 Registry 实现、服务文档和所属单元/根组件测试。入站 SERVER
使用路由模板；回源 CLIENT 的上下文注入真实 HTTP，响应读完、关闭、
失败或取消后结束。正文、查询及凭证不进入这些普通 HTTP span。
SDK 版本沿用现有 Go 服务的 1.46.0，默认批量导出；服务正常退出后有界
flush。关闭导出仍传播 context。

不变更发现权限、目录或包生命周期，不扩大 SQL/事务和指标/日志导出的
实施范围。普通 Compose 配置属于后续部署批次，生产者通过后才重跑
[DI3](skill-discovery-caller-integration-delivery-20261001.md)。

私有证据：`artifacts/verification/skill-registry-trace-d1t-20261001/`。
`registry-http-trace-red-confirmed` 已在原实现上证明缺少 SERVER 和实际
CLIENT context；初次请求漏传组织的失败作为测试修正记录保留。
依赖整理首次使用了错误的服务目录缓存路径，已改用根编译/模块缓存并
通过离线依赖整理；未更换现有 SDK 版本。误建的服务目录编译/依赖缓存
已清除，没有测试来源或验收证据放在缓存中。

| 门禁                                       | 状态                                                                          |
| ------------------------------------------ | ----------------------------------------------------------------------------- |
| 原实现失败证据                             | 已保留                                                                        |
| Registry 单元/取消/错误/导出配置           | 37 项、73 子项、零跳过通过                                                    |
| 真实 HTTP 组件及 native OTLP flush         | 两条真实回源 HTTP 的 9 个 native span 父链通过；OTLP 组件 6 项、16 子项通过   |
| Registry 所属 lint、合同、格式、链接、存储 | lint 零问题、共享合同 26 项，格式/链接/存储/源码检查通过                      |
| 适用 Docker 与资源清理                     | f4714616 候选镜像，6 组业务检查及 PostgreSQL/HTTP/race 通过，资源完全恢复基线 |
| 普通部署与实际 ACP/Runtime/Jaeger DI3      | 后续集成，不以生产者结果替代                                                  |

Docker 组件合计 37 项、57 子项、零跳过。私有 native OTLP 请求按真实
protobuf 解码，只有路由模板和 HTTP 元数据，打开 RPC 正文开关仍无
包/查询/凭证内容。首次 lint 指出 SDK 的 Value.Emit 已废弃，两个测试
改用当前 Value.String 后通过；失败证据保留。

后续 [DI3](skill-discovery-caller-integration-delivery-20261001.md) 在普通
Compose 配置下通过 307-span 活动调用方 Trace，包含 Registry 的三个
SERVER/两个 CLIENT 及两次实际 ACP 来源核验；部署配置 8 项通过。
D1T 的生产者证据保持独立，不重写首次验收记录。纯时间告警依用户已
确认的时钟策略保留，实际缺失父节点和未知告警仍拒绝。
