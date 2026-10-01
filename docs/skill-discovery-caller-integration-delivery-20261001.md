# Skill 前景搜索：DI3 活动调用方集成

2026-10-01：DI3 完整部署、业务及来源 Trace 已通过。本批修改根部署配置、集成验收资产、入口与文档，承接
[D1A Registry](skill-discovery-caller-registry-delivery-20261001.md)和
[D3A ACP](skill-discovery-caller-acp-delivery-20261001.md)及
[D1T Registry Trace](skill-registry-trace-delivery-20261001.md)已通过的所属门禁。

## 真实场景与断言

复现入口：`make e2e-skill-discovery-caller`。复用普通 Compose 配置和
[DI1 四步传播](skill-propagation-integration-delivery-20261001.md)，保留实际
自动学习/更新、临时包安装及完成/取消/正常重启回收、真实浏览器提升、冻结
Template 创建/重建及预设 Run。

在同一组织/所有者下，用普通 Controller API 新建第二个 Agent，让它执行
正常前景任务并自动学习。其个人 Skill 只投影元数据，名称与原 Agent 相同。
调用方的个人投影保持序号 2、另一来源序号 1；两者在回归前后都必须保持
active 并已被 Registry 确认。

测试通过正常所有者配置暂时关闭调用方的后续复盘，已应用的个人内容及
映射继续存在。普通无调用方上下文的搜索必须同时读到两个个人映射和当前
正式 v2；v1 继续按固定引用读取，不作为另一个搜索结果。随后原 Agent 的
真实活动 Run 只向模型开放查询/上限，连续完成
`find_skill`、加载提升自自身的正式 v2、加载另一 Agent 的个人 Skill。
自身本地 Skill 的命令仍然存在。模型核对精确引用、摘要、不同版本正文，
不能用错误或任意候选报告成功。

数据库回执核对实际 Session/Agent/Run 与三个完成的 `agent/skill_registry`
调用；实际 Trace 应包含一次搜索、两次加载、两次另一来源的核验，以及
零次调用方来源核验，全部父 span 完整且不捕获查询/正文。第二个来源的
学习 Trace 必须是非 debug、一次复盘推理，含真实 Runtime 应用。

第二个 Agent 在完成后走普通 Delete 并交付序号 2 tombstone，再继续原有
源内容变化与正式版本/预设独立性检查。测试不手写映射、不代用停机包、不
新增 Runtime 方法，不执行付费模型。

## 当前门禁

| 门禁                   | 结果                                                         |
| ---------------------- | ------------------------------------------------------------ |
| 确定性模型场景         | 10 项通过，新场景先失败再实现；保留全局重复请求保护          |
| 共享发现/临时/学习合同 | 26 项通过                                                    |
| 根验收源码             | 10 份 JavaScript 语法、Make 入口、格式/链接/diff 检查通过    |
| 完整部署/Trace/清理    | 第四轮 dc94dcb1 完整通过，前三轮失败保留；资源均恢复同一基线 |

私有证据位于 `artifacts/verification/skill-discovery-caller-di3-20261001/`。
每次部署使用独立项目、七个候选服务/Runtime 镜像；旧验收环境保持停止。
完成前不以所属服务的单元结果替代业务回归。

首轮部署 `antnest-lifecycle-7d74f043` 的旧流程及第二个 Agent 自动学习通过，
新脚本在活动 Run 之前错误预期搜索同时列出两个正式版本，按现有“每个
Skill 只搜索当前版本”的合同修正为三个空闲候选、两个前景候选并保留
精确 v2/来源断言。失败证据与相同资源基线的清理记录保留。

第二轮 `antnest-lifecycle-9ef83576` 已完成真实前景搜索和两次精确加载，
持久回执通过；完整 Trace 等待未通过。此场景的未插桩 SDK 验收客户端
不应注入既有测试工具的模拟外部父节点，已增加只供本场景关闭该模拟头的
选项；原有身份场景保持默认行为，完整父链断言不放宽，并保存每次实际
Trace 观察便于定位。正式以重跑结果判定。

第三轮 `antnest-lifecycle-8dcf597f` 的搜索、两次加载和持久回执通过。
保存的调用方 Trace 有 284 个 span，父链完整，但没有 Registry 或两次
来源核验。定位为 Registry 未安装 SERVER/CLIENT Trace 边界与 SDK，
回源请求未传播 context；进入 [Registry D1T](skill-registry-trace-delivery-20261001.md)
独立修复批次。三个失败项目的资源均回到同一基线：17 个停止容器、
零运行容器、15 个网络、11 个卷；候选镜像由各次回归回收。截至第三轮
DI3 尚未通过；随后第四轮才取得完整链路验收，不能用早期业务结果替代。

Registry 的 D1T 已完成 10 个所属门禁，普通 Compose 的 8 个配置测试
也通过。第四轮使用共享部署配置，完整来源链按实际 SERVER → CLIENT →
SERVER 与调用方 find/load 的直接 parent ID 核对；业务完成后先等 6 秒，
再读取一次完整 Trace，不用提前详情轮询消除缺口。第四轮部署 `antnest-lifecycle-dc94dcb1` 已通过（325.7 秒），
独立证据及最终资源基线核对记录其实际结果。

第四轮有 10 组传播/浏览器检查、6 个预设 Run、3 组临时使用的正常完成/
取消/正常重启回收。新增活动调用方 Run 的三个持久工具调用均完成且无
可变效果；原 Agent 个人投影保持序号 2 active，本地 Skill 命令仍可用，
另一 Agent 投影序号 1 active，正常 Delete 后交付序号 2 tombstone。

调用方实际 Trace 为 307 个 span，其中 Registry 5、ACP 279、Runtime 18、
Gateway 3、Identity 2；搜索 1、加载 2、来源核验 2，零次核验活动调用方。
核验 → ACP SERVER → Registry CLIENT → Registry SERVER → ACP CLIENT →
对应 find/load 操作的直接 parent ID 全部通过，正文采集关闭。
另一 Agent 的学习 Trace 有 186 个 span，非 debug、一次模型推理、无
证据截断，真实 Runtime 应用成功。原 Agent 两次学习 Trace 为 205/185
个 span；临时使用 6 次 native install/release 边界及预设父链继续通过。

原始时间告警保留：调用方 273 条仅来自三种 SDK/Jaeger 时间差（110.678µs、
383.026µs、-1.143683ms），同一子树的告警会重复标在其 span 上。
学习链路另有三处纯时间告警。没有缺失父节点或其他类型的告警；按已确认
的时钟策略，这些时间告警不阻塞业务验收，不修改 SDK 时间戳或平台时钟。
最终检查继续逐条拒绝其他告警，不把全部 warnings 泛化为可忽略。

完整回归使用本机确定性模型，证明系统调用、鉴权、交付和生命周期，未新增
真实 Provider 推理评估。旧停止环境保持停止，七个候选镜像及本项目的
容器/网络/卷均回收；最终仍为 17 个停止容器、零运行、15 个网络、11 个卷。
本轮未提交。
