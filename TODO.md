# Antnest Platform 全局 TODO

本清单保存全部开放 issue 的推进顺序、依赖、当前批次和验收记录。
按回归基线、共享契约、入口与身份安全、执行可靠性、产品能力、非交互执行与调度推进。
Issue 状态最后核对于 2026-10-13：136 个 issue，76 个已关闭，60 个开放；开放项包含 5 个 Epic 和 55 个执行项。下列队列保留 70 个执行项，其中 15 个已交付。

## 执行约定

- 协调者选择批次、定义契约和测试、review 所有修改，独占 Git、网络、Docker、浏览器、验证与合并操作。
- 子 agent 使用 `gpt-6.1-sol`、`max` reasoning、独立上下文；任务只传必要的 issue、文件与约束，返回简短交接。
- 子 agent 可以只读调查。写入任务必须只有一个明确且互不重叠的写集合、一个机械变换；不运行测试、构建、生成器、Docker、网络或 Git。
- 每批遵循共享契约、单个服务的测试/实现/文档、消费方批次、显式集成验收的顺序。新行为先有失败测试。
- 协调者串行执行适用的 unit、contract、component、Docker E2E；检查资源清理。通过 review 和必需 CI 后才合并。
- 合并后记录 PR、commit、验证证据并更新复选框。生产方完成但消费方或集成待交付时，issue 保持开放。
- 验证证据保存在忽略的 `artifacts/verification/`；测试源、fixtures 和清单遵循 [AGENTS.md](AGENTS.md)，不存放在 `.cache/`。
- 开始下一项前读取本文件的当前批次、相关阶段和依赖，并重新核对该 issue 的正文、讨论与当前代码。

## 当前批次

- 当前按用户指定顺序推进 Epic [#81](https://github.com/tf4fun/antnest-platform/issues/81)：**#10 → #62 → #63 → #58 → #61 → #59 → #60 → #2 → #66 → #64**。本顺序优先于下方按主题组织的队列；#67 保留为后续共享契约工作。
- 当前执行 [#2](https://github.com/tf4fun/antnest-platform/issues/2)：共享 admission 契约已随 `8c2f016a` 推送到 [Draft PR #258](https://github.com/tf4fun/antnest-platform/pull/258)，121 项共享契约测试通过。Gateway revision 23 实现三表限流、FIFO 淘汰、IPv6 /64、配置和指标；先复现 12 类行为失败，完整服务 race 为 311 项测试/1,860 个子测试通过，组件回归为 334/1,955 通过，新增真实启动配置接线用例另行通过。服务容器 191 项检查通过，其中新增 16 步在 9.09 秒内验证真实双来源、独立预算、拒绝零 RPC 和淘汰；临时资源清理后 Docker 库存与基线一致。消费方版本引用、真实双客户端容器 HTTPS/OIDC 集成和最终 CI 仍待验收，issue 保持开放。证据位于 `artifacts/verification/issue-2/`，继续保留 #60 的规范密码错误、Retry-After、no-store 与 Cookie 边界。
- 已完成：[#60](https://github.com/tf4fun/antnest-platform/issues/60) 随 [PR #256](https://github.com/tf4fun/antnest-platform/pull/256) 合并并关闭，merge commit `85f6a65f`，验收 head `dbba6a2d`。Identity/Gateway/Console revision 为 17/22/53，main 的代码树与验收候选一致。
- #60 行为与验收：单进程密码 Engine 按配置限制工作内存、执行并发和最多 32 个排队请求，等待预算为 2 秒；取消与停机等待已运行 KDF 排空。迁移 `0009` 提供持久失败计数，登录 rehash、改密轮换/撤销及计数原子提交。双 Identity 的真实 PostgreSQL 锁链验证第五次提交后第六次在 KDF 前受限；HTTPS 登录、改密与 Console 创建用户规范消费 429/503，不重放、不改失败 Cookie，恢复通过。验收配置为 128 MiB 工作预算、最多 2 个执行；200 个独立并发请求得到 169 个 KDF busy、31 个认证拒绝，RSS 基线 90.1 MiB、峰值 367.5 MiB，通过原 128/512 MiB 门槛，同进程排空和恢复完成，仅证明该部署与配置，不宣称普遍内存上界。
- #60 最终 CI：[run 38363597949](https://github.com/tf4fun/antnest-platform/actions/runs/38363597949) 的 21 分片/84 套件为 72 passed、12 已复核 warning，零失败/缺失/超时/中断；56 项 PR 检查通过。本地 4,715 项 Node、61 项 Python 通过；5 项既有 PostgreSQL 条件跳过不计作通过，Identity 真实 PostgreSQL 为 421 项测试、851 项子测试通过。原始产物已逐文件校验，证据与复核记录位于 `artifacts/verification/issue-60/final-ci/38363597949/`。
- #60 证据边界：历史失败及原始 strict ERROR/warning 保留，业务通过不代表全部 raw Trace 闭包完整。工具等分片的 raw 缺档、故意 SIGKILL 的缺父诊断与已完成恢复轨迹分别记录；≥1ms 和非时钟项不纳入暂缓的 Node SDK 亚毫秒调查。历史失败的归因限制保留，#246/#247/#252 继续开放。
- 已完成：[#59](https://github.com/tf4fun/antnest-platform/issues/59) 随 [PR #254](https://github.com/tf4fun/antnest-platform/pull/254) 合并并关闭，merge commit `1fcf37ab`，验收 head `6c44381c`。七项验收及 Epic #81 的身份缓存停机条件均完成。
- #59 行为：Gateway 按 token hash、服务端 profile 与 Agent 隔离完整 Principal；TTL、idle、absolute 与原 CCT 均为硬上限，命中不续期。共享 miss 有独立等待者取消与最后拥有者 join；复用 Identity 撤销 feed，并处理本地失效、后台刷新和静默流退役。Gateway session revision 21、Identity revision 16、cache policy revision 2；TTL=0 保留逐次 Resolve。
- #59 本地准入：服务与消费者分批完成失败先行、unit/contract/component、适用 Docker 和独立 review。最终 Gateway 完整 race、298 项/1,722 子项 Go 集成、200 项相关 Node/契约/Trace 回归通过；真实 HTTP Activity 与被阻塞 bootstrap 的两个首次响应均为 200，无请求重试。周期 guard 的缓存交付跨 TTL 竞争已确定性复现并修复，只能在原 probe context/deadline 内重查一次，不延长权限或硬期限。最终新镜像 caller 与缓存停机 Docker 通过准入，3,495 个源码输入运行后立即核对未变，资源清理通过。
- #59 最终 CI：[集成 run 38271527690](https://github.com/tf4fun/antnest-platform/actions/runs/38271527690) 的 34 个 job 全部成功，21 分片/84 套件为 72 passed、12 已复核 warning，零失败、缺失、超时或中断；61 项 PR 检查全部成功。[仓库检查](https://github.com/tf4fun/antnest-platform/actions/runs/38271527235) 通过 4,419 Node 与 61 Python，保留 5 个既有 PostgreSQL 条件跳过。此前失败的 Skill discovery caller 在最终提交通过。
- #59 最终业务证据：100 次 ACP exchange 用时 5.635 秒，含握手实际 Resolve CLIENT/SERVER 各 2 次；Identity 停止 5.020 秒期间，新输出 112 ms、取消并 quiescent 193 ms。八个 owning 门禁通过；148 条原始 Trace 的 80 个错误均有归属、零未归属。真实 HTTPS self-all 的独立 SSE/WSS、旧 Cookie 拒绝与私有 UI 退役，以及组织显示 8 项检查均通过。
- #59 证据与限制：最终 CI 的 1,686 个文件已按 SHA-256 校验归档至主工作区，清单位于 `artifacts/verification/issue-59/sixth-ci-preservation.json`；本地诊断与 Docker 的 407 个文件另有 `skill-notice-local-preservation.json`。历轮原始失败和 strict warning 保留；第五轮 WSS 通知失败缺少原 Resolve Trace，其历史根因仍未知，后续独立复现的竞争修复与最终通过不追溯改写该失败。Node SDK 亚毫秒调查继续暂缓，#246/#247 的既有证据限制保留。
- 已完成：[#61](https://github.com/tf4fun/antnest-platform/issues/61) 随 [PR #251](https://github.com/tf4fun/antnest-platform/pull/251) 合并并关闭，merge commit `af0ac319`，验收 head `d1f943b9`。六项 admission 和 Epic #81 的 #61 已勾选。共享契约之后依次交付 Identity、Gateway、Console、Agent UI 与 Controller 消费方，再完成显式跨服务 HTTPS 集成；Identity/Gateway/Console revision 为 16/20/52。
- #61 行为与升级：新 Provider 默认 `none`；非 authoritative Provider 不自动绑定组织管理员。管理员预绑定与不可变 SCIM Provider 配对使无 email/password/Agent 的账户也可使用；双浏览器提供持久 notice、逐 ID 确认和解绑，最后登录方式需要明确确认。解绑与目标 Membership 会话撤销原子提交，保留 subject tombstone，普通回调/SCIM 重试不能恢复；已接受 Run 保持执行。迁移 `0006`–`0008` 保留历史 Provider 策略并标记待复核，历史 binding 保留，旧 SCIM 不自动配对；需协调部署，未宣称邮件通知或自动识别历史恶意绑定。
- #61 本地准入：各服务批次具备失败先行、unit/contract/component、适用 Docker 和独立 review。最终 Identity PostgreSQL/race 为 343 项/688 子测试，Gateway race 为 220/1,512，Console race 为 200/386，Controller 消费方为 519/1,140，均无失败/跳过。真实 Identity Docker 279 项检查、53 次 SCIM HTTP、23 次签名回调通过；Console 八个浏览器入口、Agent UI 十项浏览器测试和各自服务容器验收通过。完整仓库回归为 2,503 Node/61 Python 通过、5 项既有条件跳过；格式、lint/类型、链接与存储门禁通过，本地 Docker 库存恢复 0 容器、3 网络、0 卷、33 镜像。
- #61 CI 修正与最终验收：首轮真实 PostgreSQL 暴露 SCIM 响应纳秒与存储微秒差异，创建事务现返回持久结果，固定 +123ns 反例保留合法替换/旧版本拒绝；第二轮暴露浏览器 fixture 把消费解绑响应前的活动计为退役后访问，确定性重叠/取消和五类消费后请求反例已修正证据边界，网络跟踪持续至 context 关闭。最终 [集成 CI](https://github.com/tf4fun/antnest-platform/actions/runs/38138773986) 的 32 个 job、21 个分片、83 个套件全部完成：73 个通过、10 个保留已复核诊断告警，无失败、缺失、超时或中断；56 项 PR 检查成功。最终 HTTPS 有 11 次签名回调、17 个无 Cookie 写入的外部身份响应；真实 SSE/WSS 在 940/1,108 ms 远端关闭，同一已接受 Run 完成。Agent UI 所属服务 Docker 为最终源码的本地门禁，不计入这 83 个 CI 套件。
- #61 证据收口：14 份原始复核覆盖全部 21 个分片；最终 CI 的 1,330 个文件已复制到主工作区并逐份验证 SHA-256，前两轮失败及各服务阶段证据也已独立保留。准入与清单位于 `artifacts/verification/issue-61/ci-third-admission-d1f943b9.json`、`ci-third-attempt-d1f943b9-preservation.json`。预期拒绝/取消/重启错误与 clock 告警分别记录；部分只存报告、未归档的外部 Trace 和声明中断场景不宣称完整。
- #61 后续项：[#246](https://github.com/tf4fun/antnest-platform/issues/246) 的匿名卷清理范围与 [#247](https://github.com/tf4fun/antnest-platform/issues/247) 的 D3 缺父 Trace 均仍复现并保留限制。新登记 [#252](https://github.com/tf4fun/antnest-platform/issues/252)：三轮 CI 正常 Compose 停机均记录 Egress metrics shutdown failure，进程仍正常退出；Egress 源码未被 #61 修改，根因及最终指标丢失未确认。#252 随 #69 的观测工作推进，不改变用户指定的 #81 顺序。
- 已完成：[#58](https://github.com/tf4fun/antnest-platform/issues/58) 随 [PR #249](https://github.com/tf4fun/antnest-platform/pull/249) 合并并关闭，merge commit `8f854c76`，验收 head `4fcafe49`；16 个共享、服务与集成提交的历史保留。七项 admission、Epic #81 的 #58 和会话撤销退出条件已完成。Identity 提供双期限、显式活动、事务改密/轮换和会话撤销；Gateway 限制 Cookie 写入并在 30 秒 stale bound 内退役静默流，已接受 Run 保持执行；Console 与 Workspace 提供账户/会话操作，管理员操作限定签名组织。
- #58 服务准入：共享 Identity/Gateway/Console revision 为 15/19/51，服务批次均有失败先行、unit/contract/component/Docker 及独立 review。最终 Identity race/PostgreSQL 为 17 包、262 项/331 个子测试，Gateway 为 9 个有测试包、206 项/1,285 个子测试；没有失败或跳过。Console、Agent UI 与脚本消费者的门禁通过，真实 Agent UI Run 静默 95 秒并续连后仍只有一次 Prompt/模型调用。最终仓库门禁为 2,474 Node / 61 Python 通过、5 个条件跳过，格式、226 份 Markdown 链接、存储、lint/语法/类型均通过。各阶段证据及最终 `final-pr-admission.json` 保存在 `artifacts/verification/issue-58/`。
- #58 HTTPS 验收：真实双浏览器通过改密、self others/all、组织管理员撤销和 5 秒 idle 五组流程；静默 SSE/WSS 在 817–1,124 ms 关闭，早于自然 CCT 到期。30 次静默读取不续期，8 次真实输入活动使 Console 持续 12.22 秒，absolute deadline/Cookie 不变，94 个普通响应均未写 Cookie。CI 修正保留真实 Gateway Trace、远端关闭与初始 Identity SQL 证据；Workspace 以实际 HTTP Date 往返界定宿主机/服务时钟区间。最终本地 203 项会话消费者、123 项 Workspace fixture 及四个真实 Docker profile 通过业务/拓扑；193 份原始 Trace 无缺父，预期故障和时钟告警保留严格退出码 2。所有本地临时项目、10 个别名与 4 个候选镜像已清理，33 个基线镜像及原有资源库存不变。
- #58 [最终集成 CI](https://github.com/tf4fun/antnest-platform/actions/runs/38108699799) 用时 30 分 53 秒：33 个 job、21 个分片、全部 83 个选中套件完成，73 个正常退出、10 个保留已审查的严格告警，无漏跑、超时或中断；58 项 PR 检查及两个必需门禁全部成功。Workspace 28 份、ACP closeout/Stage3 97 份、lifecycle/operations 131 份原始 Trace 的同步父链完整，关闭、拒绝、重试和取消均对应声明场景；1,279 个 artifact 文件已保存并记录 SHA-256。
- #58 CI 证据限制：[#247](https://github.com/tf4fun/antnest-platform/issues/247) 在 D3 再现 1 份缺 Gateway 父节点的 Trace（`23b5b0de336379180d65b98308987baa`），原始记录保留，不能归为时钟告警。ACP tool permission/progress 仅归档报告，部分请求和外部 `FOLLOWS_FROM` 目标没有独立原始 Trace；当前 suite 清理范围也不能证明全局匿名卷无残留，[#246](https://github.com/tf4fun/antnest-platform/issues/246) 保持开放。具体范围见最终 admission 和各 raw review，未宣称这些缺口已修复。
- 已完成：[#63](https://github.com/tf4fun/antnest-platform/issues/63) 随 [PR #245](https://github.com/tf4fun/antnest-platform/pull/245) 合并并关闭，commit `c40b6b47`；五项 admission、Epic #81 的 #63 及 HTTPS 集成条件已完成。共享契约 revision 18 与 Gateway 按路由白名单生效：从 hop-by-hop 过滤后的 Header 复制允许字段，另行注入已验证身份与 CAS，丢弃 Trailer，并移除两个保留前缀的未知字段。
- #63 本地证据：28 项共享词汇/契约测试、20 项 Workspace 契约测试、Gateway race 173 个测试和 1,064 个子测试均通过；lint、链接和独立 review 无阻塞。HTTPS Docker 的 23 项流程、21 项 Origin/CSRF 与 8 项会话检查通过，普通成员在两个入口实际发送的 48 个伪造 Header 值均已核对（22 个注册名加 2 个未知名）；Workspace 身份不变、Console 403。认证 Docker 61 项、HTTP 浏览器 10 项通过并清理资源。仓库 2,371 Node / 61 Python 测试通过（5 个条件跳过），格式、语法、225 份 Markdown 链接与存储策略通过；词汇检查覆盖 829 份生产源文件。证据已保留在主工作区的 `artifacts/verification/issue-63/`。
- #63 CI 补充：完整 CI 的 caller 套件暴露 Controller ready 不能代表 ACP 已应用绑定的前置条件缺口；历史日志不足以定位确切请求阶段。测试现以同一成员限时读取目标执行状态，仅等待 `offline/agent_unavailable`，会话创建和 Prompt 的后续失败仍直接失败；#44 产品问题保持开放。14 个反例先 red 后 green，最终 15 项定向测试通过；补充后的仓库门禁为 2,385 Node / 61 Python 通过（5 个条件跳过，最后新增的超时裁剪用例另行通过）。完整 Skill caller Docker 用时 295 秒，真实调用、Trace、浏览器与资源清理通过。
- #63 [最终集成 CI](https://github.com/tf4fun/antnest-platform/actions/runs/38077614323) 的 21 个分片、82 个套件全部完成并逐项复审：72 个正常通过、10 个保留已审查的严格告警，无漏跑、超时或中断；52 项 PR 检查和两个必需门禁成功。一次 GHCR 拉取超时发生在认证矩阵测试前，同一提交重跑后 568 项网络和 30 项真实认证检查通过。非必需 AI 安全工作流因 402 额度限制失败，原始记录保留。
- #63 扩展复审发现两项独立缺口：[#246](https://github.com/tf4fun/antnest-platform/issues/246) 记录 RC helper/测试脚本的匿名卷清理风险及证据不足，随 #165 的服务批次处理；[#247](https://github.com/tf4fun/antnest-platform/issues/247) 记录 D3 collector 接受首次可见但父链不完整的 Trace。三份缺父原始记录保留，不能称为仅时钟告警；两项均保持开放，不改变用户指定的 #81 顺序。
- 已完成：[#62](https://github.com/tf4fun/antnest-platform/issues/62) 随 [PR #243](https://github.com/tf4fun/antnest-platform/pull/243) 合并并关闭，commit `219a4758`；五项 admission 和 Epic #81 复选框已完成。契约 revision 17 使用 Secure 模式的 `__Host-` Cookie、独立 32-byte 文件密钥和绑定稳定 Identity token ID 的 HMAC CSRF。Console、Agent UI 和脚本客户端已迁移；Admin 独立 Origin 仍是文档化的第二阶段计划。
- #62 验收：Gateway race 164 个测试和 999 个子测试无跳过；Console、Agent UI 的 unit/component/typecheck 通过；重复 Cookie、注销 401 私有页面保留及 CDP Secure Cookie 注入问题均先 red 后 green 并独立复审。HTTPS Docker 的 22 项流程、21 项 Origin/CSRF 和 8 项会话检查，HTTP 浏览器 10 项、Gateway 认证 61 项、默认部署 54 项及 SIGTERM/SIGINT 停机回归均通过并清理资源；仓库 2,343 Node/61 Python 测试通过（5 个条件跳过）。
- #62 [完整集成 CI](https://github.com/tf4fun/antnest-platform/actions/runs/38067368076) 用时 30 分 33 秒，31 个 job、21 个分片和全部 82 个选中套件已归档核对：72 个正常通过、10 个保留已审查的严格 Trace 告警，无漏跑、超时或中断；56 项当前 PR 检查通过。GitHub AI 安全审查因月度额度耗尽（402）在分析前失败，非必需门禁；常规 CodeQL 和必需门禁均通过。证据在 `artifacts/verification/issue-62/ci-evidence-admission.json`。
- 已完成：[#10](https://github.com/tf4fun/antnest-platform/issues/10) 随 [PR #241](https://github.com/tf4fun/antnest-platform/pull/241) 合并并关闭，commit `9f96d753`。统一所有 `/api/*` 的 Origin/Fetch Metadata admission，默认拒绝缺少两种证据的写入，显式兼容开关保留独立 CSRF 和 WebSocket Origin 检查；六项 admission 和 Epic #81 复选框已完成。
- #10 验收：Gateway race 153 个测试、913 个子测试无跳过，契约 20 项测试及仓库 2,319 Node/61 Python 测试通过（5 个条件跳过）。HTTPS 浏览器及 21 项 Origin/CSRF 检查、HTTP 浏览器 10 项、Gateway 认证 61 项和默认部署 54 项全部通过并清理资源。独立 review、lint、格式、链接与存储检查通过。
- #10 [完整集成 CI](https://github.com/tf4fun/antnest-platform/actions/runs/38061166812) 用时 30 分 28 秒，28 个 job、21 个分片和全部 82 个选中套件已核对归档：72 个正常通过、10 个保留已审查的严格 Trace 告警，无漏跑、超时或中断；53 项当前 PR 检查通过。旧 draft run 的两个跳过矩阵占位项不计作准入。GitHub AI 安全审查因月度额度耗尽（402）在分析前失败，非必需门禁，保留原始记录。证据在 `artifacts/verification/issue-10/ci-evidence-admission.json`。
- #165–#169 仅在当前服务批次确有相关改动时安排相应测试迁移，不能以兼容性回归代替交付。#10 涉及 Gateway 与测试客户端，不包含 Runtime、Controller、ACP learning 或学习 UI 的这些独立迁移。
- 最近完成：按用户指定优先处理的 [#57](https://github.com/tf4fun/antnest-platform/issues/57) 已随 [PR #239](https://github.com/tf4fun/antnest-platform/pull/239) 合并并关闭，commit `fdcded30`。交付 Gateway 原生 TLS 1.2+、SIGHUP 证书轮换、明确的公共 Origin 与可信代理边界、独立客户端登录限流、HSTS，以及原生和 Caddy 两种 Compose 部署。六项 admission 已完成，Epic #81 的 #57 已勾选；合并时 #10、#62、#2 及 Epic #81 保持开放。
- #57 本地验收：Gateway race 门禁通过 147 个测试及 285 个子测试，无失败或跳过；覆盖真实入口、证书/主机名校验、轮换时保持 WebSocket、无效替换保留旧证书与 HTTP 101 HSTS。HTTPS Docker/浏览器的 11 项检查、原有 HTTP 安全头的 10 项检查、完整 Skill caller、独立 Registry/Console discovery 及资源清理均通过。最终 `make test-repo` 为 2,319 Node 通过、5 个条件跳过、61 Python 通过；格式、lint、语法、链接、存储策略与独立 review 通过。
- #57 集成适配：容器测试客户端传递部署的公共 Origin；Playwright API 请求在 literal loopback HTTP 上桥接 Chromium 的 Secure-cookie 会话，保留 Cookie 属性、域/路径过滤、显式负例 Header 和禁止重定向；独立 Registry fixture 补齐只读模块挂载。失败/通过证据保存在 `artifacts/verification/issue-57/`。
- #57 最终 CI：52 项 PR 检查全部成功，包括两个必需门禁及五种 CodeQL；[完整集成 CI](https://github.com/tf4fun/antnest-platform/actions/runs/38055483329) 用时 30 分 30 秒，覆盖 28 个 job、21 个分片和全部 82 个选中套件（72 个正常退出、10 个保留已审查的严格 Trace 告警），无漏跑、超时或中断。完整归档已核对，汇总在 `artifacts/verification/issue-57/ci-evidence-admission.json`。
- #57 外部限制：[GitHub AI 安全审查](https://github.com/tf4fun/antnest-platform/actions/runs/38055483261) 因月度额度耗尽（402）在分析前失败。该项不是分支必需检查，原始失败记录保留；必需门禁和常规 CodeQL 全部通过后合并。
- 已完成：#233 已随 [PR #237](https://github.com/tf4fun/antnest-platform/pull/237) 合并并关闭，commit `de419be1`。独立测试先固定无 subscriber 线程注册 callsite 导致事件捕获为 0 的反例；复用测试专用持久 dispatcher 和 provider-drop 预热后，event/span 各精确捕获 1 条，过滤器仍捕获 0 条。14 个构造入口覆盖 16 处 scoped 使用，保留默认并行测试和严格权限断言。
- #233 验收：格式、Clippy、195 个本地 Rust 测试、12 个 PostgreSQL 组件、Linux 镜像内 196 个测试均通过；本地与 CI 的 `auth-egress` 均完成 189 项检查及资源清理。独立 review、仓库门禁、五种 CodeQL 及 [最终集成 CI](https://github.com/tf4fun/antnest-platform/actions/runs/38043501755) 通过；后者用时 31 分 12 秒，覆盖 26 个 job、19 个分片和全部 58 个选中套件（48 个正常退出，10 个保留已审查的严格 trace 告警）。证据在 `artifacts/verification/issue-233/`。
- #233 外部限制：[GitHub AI 安全审查](https://github.com/tf4fun/antnest-platform/actions/runs/38043504349) 因月度额度耗尽（402）在分析前失败。该项不是分支必需检查，失败记录保留；两项分支必需检查 Repository checks、Integration checks 均通过，五种常规 CodeQL 也通过后合并。
- 已完成：#112 与前置 #235 已随 [PR #234](https://github.com/tf4fun/antnest-platform/pull/234) 合并并关闭，commit `dec230dc`。所有选中的 A/B/C 分片纳入必需门禁，部分手动运行使用独立检查名称；严格退出需要真实业务终态，套件日志、结果与耗时均归档。
- 最近插入批次：镜像发布范围已随 [PR #229](https://github.com/tf4fun/antnest-platform/pull/229) 合并，commit `47a80f1c`。仅发布十个已实现的服务/Runtime 镜像；Temporal 依赖和三个 Runtime 测试变体保留本地构建，以同次 CI artifact 传递。
- 镜像批次验收：53 个相关测试、完整 `make test-repo`、格式/语法/链接检查、独立 review、最终提交的必需 CI 和全部 Tier A/B Docker 分片通过。main [run 38026470361](https://github.com/tf4fun/antnest-platform/actions/runs/38026470361) 的四个镜像均构建成功，registry 登录与发布步骤均跳过。
- 已按用户授权删除 `antnest-temporal`、`antnest-runtime-skill-gate`、`antnest-runtime-fixture`、`antnest-runtime-managed` 四个 GHCR package；浏览器确认 [Packages 列表](https://github.com/tf4fun/antnest-platform/packages) 从 14 项降为 10 项，仅保留计划内镜像。验证记录和截图在 `artifacts/verification/ci-package-scope/`；更广泛的 #112 随后由 PR #234 完成。
- #112 准入前稳定性审计覆盖 41 次已完成 CI、319 个实际 Tier C job；最后 12 轮的 132 个 Tier C 分片均成功（其中一轮 Tier B 认证失败），最后 7 次全流程全部通过，约 24–32 分钟。首次必需门禁真实阻止了 #235 的 lifecycle 失败；修复后 [最终 CI](https://github.com/tf4fun/antnest-platform/actions/runs/38040208584) 在 30 分 35 秒内通过全部 27 个 job、21 个分片和 81 个套件，全部 47 项 PR 检查通过后合并。71 个套件正常退出，10 个按已审查的严格 trace 告警规则通过；原始严格结论保留。
- #112 覆盖已有平台加密密钥轮换、Gateway shutdown、Runtime Controller archive Docker 入口。最终 `make test-repo` 通过（2,307 Node 通过、5 个条件跳过，61 Python 通过），69 个 archive 包测试通过 race 检查且无跳过；适用 Docker、清理、静态检查和独立 review 均通过。[部分手动运行](https://github.com/tf4fun/antnest-platform/actions/runs/38036575652) 只产生 `Integration checks (partial)`。证据在 `artifacts/verification/issue-112/`；#165–#169 的 23 项服务测试迁移仍保持开放。
- #112 审计发现的独立回归 [#233](https://github.com/tf4fun/antnest-platform/issues/233) 已按 Runtime Egress 所有权修复。原始权限日志空输出发生在镜像构建阶段，Docker 业务场景尚未启动；确定性反例验证了 tracing callsite 竞争路径，但历史日志仍不能确认当次线程顺序。修复没有引入重试或串行化普通测试。
- #235 已修复失败 Runtime 的独立观察事件与整页重放断言竞争，限定共享 lifecycle 测试工具：保留旧历史前缀，核对持久事件目标、独立观察 trace，以及重放的只读事务。测试先 red 后 green；本地 Docker 验证 9 次操作、3 条观察事件及清理，最终 CI 也验证 9 次操作、2 条观察事件与只读重放。原始失败缺少当次观察 trace，不推断具体观察分支；服务实现未变。
- 已完成：#197 已随 [PR #231](https://github.com/tf4fun/antnest-platform/pull/231) 合并并关闭，commit `e8cf8f15`。已用真实 gate 固定 catalog→artifact、inspect→artifact 两个健康读取竞争反例；ACP 改为只在 source/catalog 读取间限时等待 2 秒，派发前重新校验，前台/lifecycle 取消等待者。
- #197 验收：1,706 个 ACP 单元测试、202 个协议/HTTP 集成测试、完整 `make test-repo`、格式/lint/类型/链接检查、独立 review、修复镜像的完整 Docker lifecycle 流程及清理均通过。最终提交的必需 CI 和 Skill discovery/deployment、Skill learning、Skill learning install/lifecycle 分片在 [run 38031415735](https://github.com/tf4fun/antnest-platform/actions/runs/38031415735) 通过后合并。
- #197 的原始失败缺少同次 trace，不能回溯确认原因。#198 后 67 次 CI 的 50 个实际 discovery 分片中未见 preview 503；当前原版 Docker lifecycle 也通过。本批修复确定性读取竞争，保留 HTTP 200 断言、写入/cleanup/前台忙时的拒绝，不重试 HTTP 或 digest。证据在 `artifacts/verification/issue-197/findings.json`。
- 跨批次精简交接：`artifacts/verification/issue-planning-20261010/next-investigations.json`。开始前重新核对 issue 讨论、当前代码和最近 CI artifact。
- 已完成：#193 已随 [PR #227](https://github.com/tf4fun/antnest-platform/pull/227) 合并并关闭，commit `45752015`。后续失败 run `37731909405` / `37719450273` 证明源投影仍 active、sequence=2、sent_sequence=1，managed candidate/digest 一致，而 peer 已为 1/1；peer ACK 和 live discovery 都不能代表源投影已经确认。
- #193 修复：caller Run 前仅对有效源投影等待 ACK，期限 90 秒；撤销、身份或序号变化、查询失败、取消及超时仍失败，Run 后检查仍立即断言。未修改服务实现。
- #193 验收：37 个相关 fixture/契约测试、完整 `make test-repo`、格式/语法/链接检查、完整 Docker caller 流程和资源清理通过；独立 review、最终提交的必需 CI 和 Skill discovery/deployment CI 分片通过后合并。原始失败、red/green、Docker 与 CI 证据在 `artifacts/verification/issue-193/`。
- #193 合并时尚在运行的非必需 Tier C 分片，后续已在 [CI run](https://github.com/tf4fun/antnest-platform/actions/runs/38023201384) 全部通过。

## 推进队列

以下每个阶段均拆为单个服务或共享测试工具的交付批次。#67、#68、#48 先交付公共定义与工具，服务迁移随后逐批完成；#112 从第一阶段持续推进。

### 1 回归基线与CI准入

- [x] [#109](https://github.com/tf4fun/antnest-platform/issues/109) test(e2e): consolidate ACP/managed-MCP Compose overlays and stop fixed diagnostic port binds
- [x] [#215](https://github.com/tf4fun/antnest-platform/issues/215) rpc-response-loss: delete lifecycle trace intermittently misses the Admin Console parent span
- [x] [#193](https://github.com/tf4fun/antnest-platform/issues/193) skill-discovery-caller: source Agent projection is intermittently not active and acknowledged after propagation
- [x] [#197](https://github.com/tf4fun/antnest-platform/issues/197) skill-source-lifecycle: Skill source preview intermittently returns 503 during promote
- [x] [#112](https://github.com/tf4fun/antnest-platform/issues/112) ci: run component, browser and Docker E2E suites in GitHub Actions
- [x] [#235](https://github.com/tf4fun/antnest-platform/issues/235) test(lifecycle): replay history assertion races independent Runtime observations（#112 前置批次）
- [x] [#233](https://github.com/tf4fun/antnest-platform/issues/233) test(runtime-egress): scoped privilege logging intermittently captures no event during image builds
- [ ] [#247](https://github.com/tf4fun/antnest-platform/issues/247) Skill discovery trace collection admits traces with missing Gateway parent spans

### 2 共享契约与依赖清单

- [ ] [#67](https://github.com/tf4fun/antnest-platform/issues/67) Error responses use at least four envelope shapes and overlapping code vocabularies across services
- [ ] [#68](https://github.com/tf4fun/antnest-platform/issues/68) Contract conventions drift: pagination, idempotency and optimistic-concurrency fields have several names; schema dialect and $id bases are mixed
- [ ] [#16](https://github.com/tf4fun/antnest-platform/issues/16) contracts: Agent, Organization and User ID grammars differ across services and contradict the opaque-ID rule
- [ ] [#48](https://github.com/tf4fun/antnest-platform/issues/48) Contract tests validate hand-written literals, not real output; no schema_version or N-1 compatibility, so services must deploy in lockstep
- [ ] [#73](https://github.com/tf4fun/antnest-platform/issues/73) P2: docs/service-layout.md dependency graph omits seven live service edges, including an ACP ↔ Skill Registry cycle

### 3 Edge入口安全与旧入口收敛

- [x] [#57](https://github.com/tf4fun/antnest-platform/issues/57) Edge Gateway has no supported HTTPS deployment: no TLS listener and no trusted-proxy model for Origin, cookies and login rate limits
- [x] [#63](https://github.com/tf4fun/antnest-platform/issues/63) Edge Gateway strips a fixed list of identity headers instead of all X-Antnest-*; the list already misses headers that services read
- [x] [#10](https://github.com/tf4fun/antnest-platform/issues/10) Edge Gateway accepts state-changing requests without Origin, and admin and session routes have no Origin check
- [x] [#62](https://github.com/tf4fun/antnest-platform/issues/62) Browser session hardening: cookies lack the __Host- prefix, CSRF token is not bound to the session, Admin and Agent workspace share one origin
- [ ] [#2](https://github.com/tf4fun/antnest-platform/issues/2) Login admission allows unauthenticated lockout: OIDC start shares one per-organization counter, and full key tables refuse all new logins
- [ ] [#64](https://github.com/tf4fun/antnest-platform/issues/64) Edge Gateway keeps a second browser workspace stack that no shipped UI uses; its ACP relay shares 4 message slots across all users

### 4 Identity安全与管理接口

- [x] [#61](https://github.com/tf4fun/antnest-platform/issues/61) OIDC first login auto-binds any Membership with a matching email, including organization administrators, trusting every Provider's email claim
- [x] [#60](https://github.com/tf4fun/antnest-platform/issues/60) Password verification: no limit inside Identity, unbounded concurrent Argon2 work, and hash parameters that can never change
- [x] [#58](https://github.com/tf4fun/antnest-platform/issues/58) Browser sessions: fixed 12h tokens with no idle timeout or rotation, password change keeps other sessions, no sign-out-everywhere, admin streams revalidated only every 5 minutes
- [x] [#59](https://github.com/tf4fun/antnest-platform/issues/59) Identity is a synchronous dependency of every request and every ACP message, with no resolve cache
- [ ] [#66](https://github.com/tf4fun/antnest-platform/issues/66) SCIM tokens never expire, survive the issuing administrator's removal, and SCIM writes have no client-visible version (ETag unsupported)
- [ ] [#65](https://github.com/tf4fun/antnest-platform/issues/65) Admin Console contract: 56 of 59 routes have no request or response schema, no error-code list, and the directory route returns every member unpaginated

### 5 Runtime平面正确性

- [ ] [#38](https://github.com/tf4fun/antnest-platform/issues/38) Runtime-plane contracts are incomplete: Egress lacks request/response schemas, Runtime omits maintenance routes, RC contract lives outside contracts/
- [ ] [#165](https://github.com/tf4fun/antnest-platform/issues/165) test(runtime-controller): cover Skill volume ready, drift and mount faults as component tests
- [ ] [#246](https://github.com/tf4fun/antnest-platform/issues/246) Runtime Controller helper removal and Skill test cleanup can leave anonymous Docker volumes
- [ ] [#168](https://github.com/tf4fun/antnest-platform/issues/168) test(runtime): move packet-path egress and health probe checks out of the platform lifecycle suites
- [ ] [#33](https://github.com/tf4fun/antnest-platform/issues/33) Runtime observation journal can permanently skip facts: BIGSERIAL order is not commit order
- [ ] [#39](https://github.com/tf4fun/antnest-platform/issues/39) RC observation journal: prune runs inside every append transaction, retention docs disagree, and leader writes are not fenced
- [ ] [#35](https://github.com/tf4fun/antnest-platform/issues/35) Harden Runtime containers: stop grace shorter than shutdown budget, no CPU or disk limits, exec /tmp, writable rootfs
- [ ] [#15](https://github.com/tf4fun/antnest-platform/issues/15) runtime-egress: out-of-range revisions return retryable 503 and path rejections are inconsistent
- [ ] [#6](https://github.com/tf4fun/antnest-platform/issues/6) Runtime internal Skill maintenance tool error codes are not filtered from MCP results, and mcp-contract.md overstates the closed tool_errors list
- [ ] [#18](https://github.com/tf4fun/antnest-platform/issues/18) contracts: shared maintenance ticket schema omits the temporary_install and temporary_release actions

### 6 Controller发布与生命周期

- [ ] [#47](https://github.com/tf4fun/antnest-platform/issues/47) Agent Controller contract hygiene: routes outside the catalog, an orphan RPC, a retired doc, and schema/handler mismatches
- [ ] [#166](https://github.com/tf4fun/antnest-platform/issues/166) test(agent-controller): cover fenced Skill invalidation and interrupted Runtime Update receipts as component tests
- [ ] [#43](https://github.com/tf4fun/antnest-platform/issues/43) Execution snapshot: full per-org payload with decrypted credentials on every mutation and every 30s; publication gate is in-process only
- [ ] [#53](https://github.com/tf4fun/antnest-platform/issues/53) ACP maps every DomainError to JSON-RPC -32020 with retryable:false; clients cannot tell busy or not-ready from denied
- [ ] [#44](https://github.com/tf4fun/antnest-platform/issues/44) agent_ready is emitted before ACP has the binding; not-yet-published Agents fail with access_denied instead of a typed pending state
- [ ] [#45](https://github.com/tf4fun/antnest-platform/issues/45) Agent lifecycle workflows: unbounded retries, no versioning, quarantine has no repair path, failed creates are never collected

### 7 ACP恢复、所有权与保留策略

- [ ] [#167](https://github.com/tf4fun/antnest-platform/issues/167) test(agent-acp-service): cover Skill learning admission rules and persistence faults as component tests
- [ ] [#71](https://github.com/tf4fun/antnest-platform/issues/71) P2: Give skill learning its own bounded context inside Agent ACP Service (modules, persistence, worker ownership)
- [ ] [#50](https://github.com/tf4fun/antnest-platform/issues/50) ACP failure handling has a platform-wide blast radius: one persistence error restarts the process, cold start waits for resync, and a crash mid-tool needs a manual Rebuild
- [ ] [#49](https://github.com/tf4fun/antnest-platform/issues/49) Agent ACP Service can run only one instance: database-wide worker lock, in-memory Run slots and per-org serialization
- [ ] [#19](https://github.com/tf4fun/antnest-platform/issues/19) agent-acp-service: intent receipt lookup has no intent_receipt_expired outcome required by the Bridge contract
- [ ] [#55](https://github.com/tf4fun/antnest-platform/issues/55) Agent ACP Service persistence: 15 of 23 tables are undocumented, and deleted Sessions keep all content with no retention policy

### 8 ACP协议与连接活性

- [ ] [#56](https://github.com/tf4fun/antnest-platform/issues/56) Production paths depend on experimental ACP SDK surfaces pinned separately in two packages, with no upgrade gate
- [ ] [#54](https://github.com/tf4fun/antnest-platform/issues/54) Real-time path liveness: no WebSocket ping/pong in ACP or Gateway relay; permission approvals wait on possibly-dead connections; Agent UI bridge state is single-instance
- [ ] 待独立复现与登记：Agent UI 在所有浏览器离开、最后 execution 仍 active 时，CCT 到期会阻止终态查询，`activeRunWork` 可持续占用 owner。#58 的只读审计确认现有释放路径缺少年龄上限；先补真实 CCT 过期反例，再定义有界本地退休，不能延长旧凭据或取消已接受 Run。与 #54 生命周期工作相关，尚未计入任何 issue 的交付；详见私有 `issue-58/agent-ui-headless-retention-review.json`。

### 9 模型目录、预算与上下文

- [ ] [#72](https://github.com/tf4fun/antnest-platform/issues/72) P2: Move domain defaults, the built-in model catalog and pricing out of Admin Console into Agent Controller
- [ ] [#46](https://github.com/tf4fun/antnest-platform/issues/46) Agents pin Template revisions but follow live Model Profiles and Provider connections; the mixed semantics are undocumented to users
- [ ] [#52](https://github.com/tf4fun/antnest-platform/issues/52) Model calls have no retry or failover on 429/5xx, and normal Runs have no token or cost budget
- [ ] [#51](https://github.com/tf4fun/antnest-platform/issues/51) Context management: length/4 token estimate is wrong for CJK and images; compaction is mechanical truncation, not summarization
- [ ] [#23](https://github.com/tf4fun/antnest-platform/issues/23) Support generic OpenAI-compatible model providers (openai_compatible is half-wired)

### 10 网络策略与Runtime扩展边界

- [ ] [#40](https://github.com/tf4fun/antnest-platform/issues/40) Egress policy model is allow-all/deny-all only; planned enterprise-internal destinations conflict with the private-address baseline
- [ ] [#74](https://github.com/tf4fun/antnest-platform/issues/74) P2: Kubernetes adapter readiness: Docker types leak through the Runtime Controller platform port, and Runtime requirements (TUN, NET_ADMIN, management network, Skill volumes) have no platform-neutral model
- [ ] [#41](https://github.com/tf4fun/antnest-platform/issues/41) Runtime plane is single-node: /24 management subnet, single Egress instance, Docker resource names not scoped by controller

### 11 Skill产品闭环

- [ ] [#24](https://github.com/tf4fun/antnest-platform/issues/24) i18n: Skill learning notices and change summaries are hard-coded in Chinese
- [ ] [#20](https://github.com/tf4fun/antnest-platform/issues/20) agent-acp-service: draft ACP v2 endpoint has no Skill commands or Skill learning notices
- [ ] [#21](https://github.com/tf4fun/antnest-platform/issues/21) skill-learning: implement the manual "Save as Skill" path (apply_basis=user_action)
- [ ] [#169](https://github.com/tf4fun/antnest-platform/issues/169) test(skill-learning): re-admit UI outage and diagnostics browser journeys once the learning UI settles

### 12 观测、工具及命名收口

- [ ] [#69](https://github.com/tf4fun/antnest-platform/issues/69) Observability: 228 span/metric attribute names with no registry and conflicting synonyms; six diverged copies of the Go telemetry package
- [ ] [#252](https://github.com/tf4fun/antnest-platform/issues/252) runtime-egress: normal Compose stop reports metrics shutdown failure despite successful process exit
- [ ] [#70](https://github.com/tf4fun/antnest-platform/issues/70) Test and dev hygiene: root tests depend on service node_modules and dist internals; the production-shaped Compose override still publishes PostgreSQL, Temporal and Jaeger
- [ ] [#22](https://github.com/tf4fun/antnest-platform/issues/22) Replace internal milestone names (stage1-4, L0, Proposed) in Make targets, Compose profiles, test and doc files, and schema titles

### 13 非交互执行与调度

- [ ] [#77](https://github.com/tf4fun/antnest-platform/issues/77) P3 prerequisite: Identity has no service principals, no delegation, and no binding of external channel accounts to platform users
- [ ] [#78](https://github.com/tf4fun/antnest-platform/issues/78) P3 prerequisite: Agent Controller has no cross-organization event feed and no way for dependent services to register against an Agent before it is deleted
- [ ] [#75](https://github.com/tf4fun/antnest-platform/issues/75) P3 prerequisite: Agent ACP Service has no service-to-service intake API; only an interactive ACP client bound to a human principal can start a Run
- [ ] [#76](https://github.com/tf4fun/antnest-platform/issues/76) P3 prerequisite: one Run per Agent with immediate agent_busy rejection, and approvals that wait up to 30 minutes for a human; define queueing and an unattended execution mode
- [ ] [#79](https://github.com/tf4fun/antnest-platform/issues/79) P3 design: Task Scheduler on Temporal Schedules (time rules, execution identity, Session reuse, overlap, missed fires, recovery)

## 必须保持的依赖

- #57 → #10/#62/#2：外部地址与可信代理先于 Origin、Cookie 和客户端限流。
- #58 → #59：会话撤销和失效边界先于身份缓存。
- #43/#53 → #44 → #45/#50 → #49：发布、就绪、恢复语义先于多副本。
- #19 → #55：先区分回执未知和已过期，再清理历史数据；清理 worker 使用 #49 的所有权规则。
- #73 → #71：明确服务依赖后收敛学习模块；#167 为后续重构提供组件证据。
- #72 → #46/#52 → #51/#23：目录和定价归属先于预算及后续模型能力；摘要与重试计入预算。
- #64 → #54：先决定旧 Gateway relay 的去留，再完善存续连接的活性。
- #35/#74 → #41 的平台扩展部分：先明确资源和平台接口。#74 本身不等同于完成 Kubernetes 部署。
- #24/#71 → #169：学习 UI 语义和文案稳定后完成浏览器验收。
- #49/#52/#53 与 #77/#78 → #75/#76 → #79：持久所有权、预算、错误分类、委托身份和生命周期事件先于无人执行与调度。

## 基线校正与范围说明

- #80 已关闭；#219 等已关闭问题保留回归覆盖，不重新实现。
- #83 的 #38、#47、#48、#53 存在 Epic 已勾选而 issue 仍开放的历史不一致；逐项按 admission 校正。#81 的 #57、#10、#62、#63、#58、#61、#59、#60 已实际交付，HTTPS、会话撤销与身份缓存条件完成；#2、#66、#64 仍待交付，Epic 保持开放。
- #193 利用 PR #194 的后续失败诊断确认 ACK 延迟，并由 PR #227 修复。#197 在 PR #198 诊断后未再出现同类 CI 失败；本批以真实 gate 固定健康读取竞争并修复，历史单次 503 的归因限制保留在验收记录中。
- #112 已把当前 Tier C 纳入 `Integration checks` 并补齐现有入口和证据；#165–#168 仍随服务补齐替代测试，#169 随 UI 收口。移出 CI 或门禁完成均不代表这些替代测试已交付。
- #18 的旧八动作设计已过时，当前 signer 为 `install`、`digest`、`temporary_install`、`temporary_release`，契约应与当前行为一致。
- #167 以 2026-10-08 的更新为准：前台 Run 不取消 review；Runtime install 等待空闲窗口并可被前台抢占。旧 cleanup release 场景已删除，不恢复它。
- #168 的旧网络失败假设需结合 PR #217 的后续证据重新核对；#70 的端口说明也需按当前 Compose 重定范围。
- #64 先记录移除旧入口或保留外部 ACP 接口的决定，随后只完善保留的路径。
- #79 虽然标题含 design，验收还包括 Scheduler 的 component 与 Docker E2E 行为。

## Epic 收口

- [x] [#80](https://github.com/tf4fun/antnest-platform/issues/80) P0 服务信任与秘密。已完成；后续批次保持安全回归。
- [ ] [#81](https://github.com/tf4fun/antnest-platform/issues/81) HTTPS 浏览器工作流、会话撤销时限与身份缓存失效边界已通过集成验收；#2、#66、#64 仍待交付。
- [ ] [#82](https://github.com/tf4fun/antnest-platform/issues/82) 瞬态故障不丢事实；双 ACP 副本恢复通过 E2E；资源、预算和重试有明确上限。
- [ ] [#83](https://github.com/tf4fun/antnest-platform/issues/83) 所有服务采用共同契约；真实生产/消费响应、N-1 兼容和 router parity 纳入 CI。
- [ ] [#84](https://github.com/tf4fun/antnest-platform/issues/84) 服务依赖准确，领域默认值归属 Controller，平台接口中立，产品子项验收完成。
- [ ] [#85](https://github.com/tf4fun/antnest-platform/issues/85) 委托、接入、排队、无人审批、删除依赖和 Scheduler 集成完成。
- [ ] 补齐 #85 的 Channel Manager 设计与契约交付项；#79 仅覆盖 Task Scheduler。

## 交付记录

| 日期       | Issue      | PR 或 commit                                                               | 验证与结果                                                                                                                                                                                                                                  |
| ---------- | ---------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-10 | 全局队列   | 基线 `814d5041`                                                            | 65 个开放执行项已分配，未遗漏、未重复；#109 开始调查                                                                                                                                                                                        |
| 2026-10-10 | #109       | [PR #223](https://github.com/tf4fun/antnest-platform/pull/223)、`70140fc1` | 22 个 Compose 场景等价；端口反向回归、仓库/部署检查、45 个 managed fixture 通过；保留开发栈时 ACP v1/v2 WebSocket、v1 HTTP 通过，Stage3a managed MCP 业务/拓扑/删除/清理通过；独立 review 与必需 CI 通过后合并                              |
| 2026-10-10 | #215       | [PR #225](https://github.com/tf4fun/antnest-platform/pull/225)、`88453a80` | 同步父 span 闭合后再判定稳定；迟到、永久缺失和中止回归通过；69 个相关 fixture、完整仓库准入、RPC 默认/延迟导出及 managed MCP ACP v1/v2 Docker 验收、独立 review、必需 CI 和 RPC CI 分片通过后合并                                           |
| 2026-10-10 | #193       | [PR #227](https://github.com/tf4fun/antnest-platform/pull/227)、`45752015` | 确认 active source 2/1 与 peer 1/1 的 ACK 时序缺口；37 个相关测试、完整仓库检查、Docker caller 及清理、独立 review、必需 CI 和 Skill discovery CI 分片通过后合并                                                                            |
| 2026-10-10 | #197       | [PR #231](https://github.com/tf4fun/antnest-platform/pull/231)、`e8cf8f15` | 确定性读取竞争先 red 后 green；1,706 个 ACP 单元测试、202 个集成测试、完整仓库检查、Docker source lifecycle 及清理、独立 review、必需 CI 和 discovery/learning/install-lifecycle 分片通过后合并；历史单次 503 缺少 trace，未回溯归因        |
| 2026-10-10 | #112、#235 | [PR #234](https://github.com/tf4fun/antnest-platform/pull/234)、`dec230dc` | Tier C 成为必需门禁，新增三个已有 Docker 入口，完整终态与逐套件证据校验；独立修复 lifecycle 重放/观察竞争。2,307 Node、61 Python、适用 Docker 与清理、独立 review、全部 81 个 CI 套件与 47 项 PR 检查通过；部分手动运行不能提供完整必需检查 |
| 2026-10-11 | #63        | [PR #245](https://github.com/tf4fun/antnest-platform/pull/245)、`c40b6b47` | 28 契约、20 消费方、Gateway race 173/1,064、真实 HTTPS 48 个伪造 Header、15 readiness 反例与完整 Docker caller 通过；52 PR 检查、82 套件/21 分片准入。扩展证据缺口独立登记 #246/#247，下一项 #58。                                          |
| 2026-10-11 | #58        | [PR #249](https://github.com/tf4fun/antnest-platform/pull/249)、`8f854c76` | 双期限、事务轮换/撤销、静默流退役、双浏览器会话控制与真实 HTTPS 通过；58 PR 检查、83 套件/21 分片准入，保留原始严格告警与 #246/#247 证据限制。下一项 #61。                                                                                  |
| 2026-10-11 | #61        | [PR #251](https://github.com/tf4fun/antnest-platform/pull/251)、`af0ac319` | OIDC 显式策略、预绑定/SCIM 配对、双浏览器 notice/解绑与真实 HTTPS 已交付；56 项 PR 检查、83 套件/21 分片准入，1,330 个最终 CI 文件已校验归档。保留 #246/#247 限制，新登记 #252。下一项 #59。                                                |
| 2026-10-13 | #59        | [PR #254](https://github.com/tf4fun/antnest-platform/pull/254)、`1fcf37ab` | 完整 Principal 缓存、撤销/活动边界与 Identity 停机降级交付；61 项 PR 检查、84 套件/21 分片准入，4,419 Node/61 Python 通过，最终 CI 1,686 个文件校验归档。原始失败、Node SDK 延后调查及 #246/#247 限制保留。下一项 #60。                     |
| 2026-10-13 | #60        | [PR #256](https://github.com/tf4fun/antnest-platform/pull/256)、`85f6a65f` | 密码资源预算、持久失败计数、rehash/原子轮换、规范 429/503 及双实例 HTTPS 验收完成；56 项 PR 检查、84 套件/21 分片，72 passed/12 已复核 warning，零失败。保留原始严格诊断、历史归因与 #246/#247/#252 限制。下一项 #2。                       |
