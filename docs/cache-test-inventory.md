# Cache 测试脚本盘点与处置清单

盘点日期：2026-09-23。状态：**缓存资产迁出及最终集成审计完成**。

本文件下方的旧处置表记录上一轮归类，不能作为全部迁移完成的证明。
尤其是“历史保留”不再允许保留在 `.cache`；通用环境快照本身不能替代旧清理
脚本的全部断言。29 份清理脚本和 25 份开发脚本均已通过专项迁移验证，逐份归档并删除。

已将 3,874 份日志、Trace、基线、截图和备份按字节校验后迁入
`artifacts/verification/`。缓存仅允许可重建的依赖和编译缓存；项目测试源码、
清单、fixture、恢复输入和持久证据均禁止写入，包括临时中转。
检查入口是 `make test-storage-policy`；存在缓存项目资产时必须失败。
逐文件校验和删除记录保存在
`artifacts/verification/cache-source-exit-20260922/migrations.jsonl`。

追加核对已完成 45 份普通命令／Make 包装：正式执行器的 12 项合同检查通过，
保留 14 份的 30 秒清理等待和 31 份的 180 秒清理等待，统一总超时 1,200 秒。
五种原始内容按哈希去重保存在 `tests/e2e/history/command-wrappers/`，
每个来源、哈希、正式入口及参数记录在
[`cache-wrappers.json`](../tests/support/migrations/cache-wrappers.json)。
45 个缓存原件已逐份校验、删除。此检查点剩余 **91 个项目文件**：
63 个 Python、22 个 MJS、1 个 shell、3 个 Dockerfile、2 个 manifest。
这不是剩余独立用例数；已经迁出但尚待验证的正式副本也不据此判为完成。

随后又完成 27 个缓存原件的核验和删除：11 份汇总、7 份依赖包装、4 份队列
包装、2 份 manifest 和 3 份 Dockerfile，随后完成全部 10 份诊断／核验脚本。
该检查点剩余 54 份脚本，即 29 份环境／清理、25 份开发验收。
前六份的 87 项合同与底层检查通过，历史报告离线重放一致；后四份通过 27 项
Python／12 项清理合同和四组真实隔离回归，严格诊断失败保留。十份原件均已删除，映射见
[`cache-diagnostics.json`](../tests/support/migrations/cache-diagnostics.json)。
完整进度、真实回归结果和待办见 [缓存资产迁出记录](cache-source-exit.md)。
随后完成 29 份环境／清理脚本：30 项清理合同、全部 57 项 Python 工具检查、
29 组历史报告重放和 29 类真实 Docker 检查通过，真实容器残留反例按预期失败。
29 个原件已逐份校验删除，25 种原始内容保存在永久源码历史目录，映射见
[`cache-cleanups.json`](../tests/support/migrations/cache-cleanups.json)。
该检查点剩余 25 份开发验收脚本：8 个 Python、17 个 MJS。
随后验证并删除 Runtime／Temporal 收尾与 Controller 正常重启三个原件：
18 项新合同、全部 75 项 Python 检查、两组历史报告及 18 条 raw Trace 重放、
隔离 Docker 正向与过期发布反例检查通过。映射见
[`cache-development.json`](../tests/support/migrations/cache-development.json)。
随后完成 Controller 收尾原件迁移：保留全部原断言，补齐报告身份关联及
Session／Runtime／workspace 检查；全部 84 项 Python 检查、历史报告兼容性、
真实 Docker／PostgreSQL 的 2 个正向与 11 个预期失败场景通过。隔离资源已清理，
原环境不变。此验证使用合成业务数据，不代表重新完成浏览器业务验收。
随后完成 9 份只读 MJS 原件：5 份 Agent 状态、3 份聊天 Trace 检查、1 份拒绝
Trace 检查，归并为 3 个正式入口。64 项组合检查通过，其中 22 项使用真实命令入口
与本地 HTTP fixture；13 份历史 Agent 报告、13 条聊天 Trace 和 1 条拒绝 Trace
重放一致，保留 4 项 strict 失败。恢复了自定义状态报告名，输出叶子前置检查与
独占写入禁止覆盖或通过悬空链接写回缓存。未连接保留环境或部署服务。
随后完成 Runtime／Temporal 的两个 SDK Session 重放原件：82 项组合回归和
7 项进程执行器检查通过；独立 PostgreSQL 的 2 个正向、7 个反例，以及两份
原始 PGDMP 备份重放通过。每组历史均保留 71 条消息、69 个通知和精确原报告，
Runtime strict 失败、Temporal strict 通过不变。HTTP／WebSocket／Jaeger 使用
本地适配器，未连接保留服务；自有容器已删除，保留资源和镜像未变。
随后完成 Controller 恢复原件：79 项相关检查和 10 个隔离 Docker 场景通过，
包含原始工作区 tar、完整 SHA-256 清单、恢复报告和 284-span Trace 重放；
原有 strict 失败保留。修复 tmpfs 遮蔽检查和夹具匿名卷清理后，保留资源与
镜像不变，原件已逐项归档核验并删除。
随后完成三份普通 lifecycle 原件：Controller 20260917／20260921 与 Temporal
20260921 归并至正式 `development/lifecycle.mjs`，保留五阶段、三次 publication、
workspace 保留及删除、保留 Agent 不变等断言。`lifecycle-contracts-final` 的
118 项检查和 `lifecycle-docker-final` 的 9 个场景通过：4 个正向（含三组精确
历史报告重放）、5 个预期失败；三组历史的 15 条 lifecycle strict 失败保留。
Docker 场景使用自有 shell Runtime／卷与本地 Gateway／Jaeger fixture，
不代表真实服务业务验收。12 个保留容器、271 个卷、14 个网络及镜像不变，
三个原件已逐项归档核验并删除。
随后完成 Runtime-loss 的 `runtime-sync-20260921/lifecycle.mjs` 原件，
归并至正式 `development/runtime-loss.mjs`，已归档核验并删除。
`runtime-loss-contracts-final` 的 159 项相关检查及 `runtime-loss-docker`
的 7 个真实 Docker 场景通过：2 个正向（含一份历史报告精确重放）、5 个
预期失败；TERM 后退出 7 的反例在 rebuild 前拒绝，未使用 SIGKILL。
正常路径保留退出 0 → exited → rm → absent → rebuild，generation 2 → 3、
5 次 absence 和 6 项 checks；历史 5 条 lifecycle strict 失败保留。
共享配置预检校验快照身份和 publication cutoff，并从 Compose 派生 scope，
调用方无需新增字段。本批使用自有 shell Runtime／卷及本地 Gateway／Jaeger
fixture，不代表真实服务业务验收；12 个保留容器、271 个卷、14 个网络及
镜像不变，结果与隔离检查均通过。
随后完成 `metadata-browser.mjs` 原件迁移、归档核验并删除。
239 项相关回归、存储复核后的 44 项定向检查、9 个真实 UI／Chromium 场景通过：
2 个正向（含历史报告精确兼容）、7 个预期失败，正常 SIGTERM 可保存中断报告。
三个输出均提前检查并独占私有写入，工作区 URL 绑定 Gateway／Agent／Session。
夹具要求全新输出目录，提供构建后的真实 UI 和本地 ACP；不调用 Provider，
也不声称重放缺失的历史浏览器帧。保留资源不变，相关进程均已回收。
**当前剩余 0 份开发验收脚本。** 开发映射已完成
25 份，待验 0 份，对应 0 个待验正式目标；总迁移账本为 4,057 次转移、8,114 条记录。
上述 91、64、54、25、22、21、12、10、9、6 均为历史检查点数字。

存储入口追加检查已通过 335 项：共享路径检查拒绝悬空链接，Identity 原始
Trace／失败日志、三个访问控制入口及 Foundation 十种 profile 均在外部动作前
校验证据路径。普通私有快照仍可重复更新；该检查使用阻断外部动作的 CLI
夹具，不代表重跑部署业务。Go 崩溃存储检查随后通过 6 项测试、19 个子场景：
证据目录、TMPDIR、子进程输入、效果日志和诊断输出均提前检查，拒绝原始路径
中的父目录分段，测试夹具也使用受检查的临时目录。四个原始崩溃边界使用
独立 PostgreSQL／Docker 复验通过，generation、2/2/1/1 效果计数、workspace
和终态重放断言保留，4 份报告权限均为 600。保留资源和全部镜像标签不变。
证据为 `crash-storage-reviewed-contracts` 与 `crash-storage-reviewed-docker`；
剩余缓存源码为 0 份。

Runtime 部署原件随后通过 `runtime-deployment-python-final` 的 95 项支持测试与
18 项完整四阶段入口测试，以及 `runtime-deployment-docker-final` 的 5 个真实
Docker 场景，现已校验归档并删除。覆盖三个数据库备份、正常部署和同 ID 重启、
停机后备份失败恢复、候选退出回滚及 find/hash 失败；恢复成功仍返回原失败。
有效 Compose、完整容器 ID、基线和输出文件均绑定校验。全局 `after` 正向由完整
daemon 组件模型验证；共享 Docker 中原有容器停止，该断言保持预期失败。
现有 12 个容器、271 个卷、14 个网络及所有镜像标签不变。

Controller 20260921 部署原件随后通过 95 项支持测试、30 项入口集成测试，
抽出共用快照断言后再通过 12 项定向测试；6 个真实 Docker 场景和历史快照／
报告字段兼容性均通过，原件已归档删除。保留全局运行容器范围、三个数据库
备份、原行保护且允许新增，以及指定 Runtime 的恢复绑定。真实夹具还验证了
旧 Controller 删除后创建失败的恢复，保留资源与标签不变。历史 `after` 是恢复前
快照，仍按预期失败；历史 full inspect 已处于停止状态，不补造健康基线。
原严格 Trace 失败保留。另将 Runtime 部署同类缺失恢复窗口列入最后集成复查。

Controller 20260917 部署原件随后通过完整 96 项支持测试、38 项集成测试，
9 个真实 Docker 场景覆盖两种更新顺序、精确 final 业务断言，以及各服务失败时
只恢复当前目标、保留已更新兄弟服务。共用后的 20260921 入口再通过 6 个
Docker 场景和历史兼容检查。0917 历史快照与报告字段兼容，浏览器 Trace 失败
和五项 lifecycle strict 失败原样保留。原件已归档并删除；该检查点缓存仅余 Temporal。
较早一次 observer 进程组探测出现 PermissionError，已确认无遗留子进程，随后
16 项定向测试及完整回归通过，失败记录保留。Runtime 缺失恢复已在后续批次补齐。

Temporal 部署原件最后通过完整 96 项支持测试、50 项集成测试，8 个实际 Docker
场景和历史基线／部署／备份兼容检查。保留五模式、四库备份和依赖启停顺序；
旧镜像恢复使用保存的旧探针，完整 workspace 字节以及 find/hash 失败均有验证。
全局 after 对停止的保留容器保持预期失败，正向由完整 daemon 组件模型证明。
历史早期 restart 失败及后续 resume/restart 成功记录保留，不补造缺失的最新
inspect 或原始数据库／workspace 内容。候选镜像和自有资源均已清理，原件
已归档删除，缓存项目资产为零。Runtime 缺失容器恢复随后通过 22 项流程测试、
96 项支持／54 项集成测试和 6 个真实 Docker 场景，原部署失败仍保留，
其他容器、卷和镜像不变。最终 `make test-node` 通过 3,364 项，保留 5 项
原有 PostgreSQL 显式开关跳过；缓存格式扫描和配置检查通过。迁移账本
4,057 项全部哈希一致，134 项源码／构建文件映射、23 个套件／273 行、85 个证据路径
完整，缓存原件全部不存在。最终 12 容器、271 卷、14 网络及 44 镜像引用
与基线一致，未遗留测试进程。没有缓存迁移待办，历史严格 Trace 失败仍保留。

本清单保留整理前的存量数字，并记录每组旧源码的当前入口或历史身份。
可复用运行器、断言和开发环境 driver 已有正式源码；一次性升级动作、
诊断副本和修改前快照继续作为历史证据。代码迁移不等于重新通过部署验收，
本轮检查及实际执行范围统一见 [测试目录迁移记录](test-layout-migration.md)。

原盘点范围为 `.cache/<任务目录>/` 的直接子文件，后缀为 `.py`、`.sh`、
`.mjs`、`.js`、`.ts` 或 `.tsx`。共 **36 个任务目录、134 份脚本、
73 种不同文件内容**；按文件字节的 SHA-256 去重。数字不包括 Go 依赖缓存、
嵌套 `before/` 源码快照、候选源码备份、日志或 JSON 结果，也不是独立用例数。

### 完整性边界复核

本清单证明已盘点文件的归属，尚不是“全部缓存测试断言均有正式等价覆盖”的
证明。2026-09-22 的追加递归检查扩展到 Go/Rust 源码，排除依赖及构建缓存后
发现 172 份源码：原 134 份浅层脚本、另外九份浅层 Go/Rust 文件，以及
29 份嵌套源码。嵌套项分布在三个 `before/` 历史快照目录（6、10、9 份）
和 `timeout-failure-followup-20260922/candidate-untracked/`（4 份）。
九份 Go/Rust 文件位于 Temporal readiness 调查目录（8 份）和 F07 SDK
调查目录（1 份）。该递归数量仍是源码文件数，不是独立测试用例数。

这次追加工作已为所有迁移条目记录专项覆盖、历史证据及适用的隔离 Docker
验证；并非只凭通用运行器或目录归类宣布完成。历史部署的数据库行、workspace
和 Trace 结果按各自证据边界核对，缺失原始输入时不会补造重放结果。八个开发
MJS driver 与四份 deployment 原件均已删除，但本轮未重启保留环境。最后的
Runtime 恢复补齐和集成检查仍见 [缓存迁出记录](cache-source-exit.md#remaining-work)。

## 当前目录边界

- 单元测试随所属服务维护；集成和 E2E 资产位于根目录 `tests/integration/`
  和 `tests/e2e/`；共享运行器位于 `tests/support/`。
- `.cache/` 仅允许可重建的依赖和编译缓存。私有日志、Trace、截图、数据库
  备份、基线和结果属于 `artifacts/verification/`；正式源码与必要的源码历史
  属于 `tests/`，上游调查引用属于 `docs/research/`。
- 四份 `deployment.py`、三份 `final-checks.py` 和一次 `recover.mjs` 属于
  已完成的特定候选升级、数据保留检查或故障恢复。其数据库行、workspace
  digest 和前后快照是当次升级证据，不是默认目录回归需要重新执行的动作。
- 凭据、原始响应、数据库内容和私有工作区数据继续留在运行配置及证据目录。
  新工具没有固定真实 Agent、开发项目、端口或历史结果文件默认值。

## 主用途与正式归属

每份浅层脚本只归入一个主用途，数量合计 134。

| 主用途 | 原文件数 | 处置 |
| --- | ---: | --- |
| `run-command.py`、`run-profile.py`、`queue.py` | 49 | 使用 `tests/support/run-command.mjs`、`run-suite.mjs`；旧任务包装保留历史 |
| 环境、清理及镜像断言 | 29 | 全部迁入专用 `tests/support/verification/cleanup.py` profiles，保留历史不同断言；已验证删除原件 |
| `summarize*`、`audit-traces.py` | 11 | 使用 `tests/support/verification/summarize-log.py`、`audit-traces.py`；原批次专用汇总保留历史 |
| PostgreSQL、Temporal 或服务依赖运行器 | 7 | 使用 `tests/support/dependencies.mjs`；服务测试调用使用正式服务或根集成入口 |
| 保留环境的部署、业务及 Trace 脚本 | 25 | 归并为 `tests/e2e/development/` 的八个 MJS driver 和 Python 部署／收尾／重启入口；已完成与待验范围见下表 |
| 历史源码快照及冻结诊断副本 | 4 | 保留历史，不恢复旧实现或退役分支 |
| 其他诊断 | 9 | 链接和 crash 复查工具已有正式入口；一次性调查及固定旧结果复核保留历史 |

49 份执行包装中有 25 份 `run-command.py`、22 份 `run-profile.py`。
五份 `agent-state.mjs`、三份 `trace-review.mjs`、Runtime/Temporal 的两份
`replay.mjs` 分别为相同内容，现各有一个正式 driver。两份相同的
`http-diagnostics.mjs` 已归并至 `tests/support/diagnostics/http-errors.mjs`，
合同验证后删除了两个缓存原件。

## 上一轮逐目录归类（仍需按上述条件复核）

以下目录相对于 `.cache/`。为使映射简洁，表中“执行器”指
`tests/support/run-command.mjs` / `run-suite.mjs`；“依赖工具”指
`tests/support/dependencies.mjs`；“环境检查”指
`tests/support/verification/environment.mjs`；“汇总”指同目录
`summarize-log.py`；“开发 driver”指 `tests/e2e/development/`。
历史场景记录和原始证据不因归并而改写。

| 缓存目录 | 原文件数 | 当前入口 / 历史处置 |
| --- | ---: | --- |
| `acceptance-migration-closeout-20260921` | 1 | `run-command.py` → 执行器 |
| `acceptance-retirement-20260921` | 4 | 运行、汇总和清理 → 执行器、汇总、环境检查；业务在 `tests/e2e/lifecycle-closeout/`、`workspace-closeout/` |
| `acp-persistence-20260917` | 2 | `run-postgres.py` → 依赖工具；`check-links.py` → `tests/support/verification/check-links.py`，文档列表作为输入 |
| `acp-progress-20260916` | 1 | `interrupt.py` 保留当次 SIGTERM 证据；当前进程回收由执行器及 `run-command.test.mjs` 覆盖，资源比较使用环境检查；旧项目不是当前入口 |
| `acp-v1-release-audit-20260916` | 1 | `run-postgres.py` → 依赖工具；审计断言使用根目录对应集成入口 |
| `browser-finish-retirement-20260921` | 6 | 四份包装 → 执行器、汇总、环境检查；两份 `browser-control` 是修改前快照，当前实现位于 `tests/e2e/workspace-closeout/` |
| `controller-sync-20260917` | 4 | `agent-state`、`trace-review`、`lifecycle` 已验收删除；普通 lifecycle 使用同名开发 driver，旧 publication 选择器不恢复；`deployment.py` → `development/deployment/controller-20260917.py`，已验收归档删除 |
| `controller-sync-20260921` | 9 | 两份包装 → 执行器；`agent-state`、`trace-review`、`controller-final-checks.py`、`idle-restart.py`、`recover.mjs`、`lifecycle` 已验收删除；`deployment` → `development/deployment/controller-20260921.py`，已验收归档删除 |
| `controller-workflow-span-20260921` | 3 | `run-components.py` → 依赖工具的 Temporal 模式和正式集成入口；另外两份 → 执行器、环境检查 |
| `crash-recovery-research-20260921` | 1 | `run-command.py` → 执行器；研究记录保留历史 |
| `development-sync-20260917` | 4 | `agent-state`、`trace-review`、`metadata-browser`、`rejection-trace` → 四个同名开发 driver |
| `final-regression-20260922` | 8 | `queue`、`run-command` → 执行器；`summarize-log` → 汇总；`final-environment` → 环境检查；`audit-postgres` → 依赖工具；`audit-traces` → 正式同名工具；两份故障采集器为一次性调查 |
| `identity-migration-20260917` | 2 | 运行、清理 → 执行器、环境检查；业务在 `tests/e2e/identity-closeout/` |
| `interruption-assets-retirement-20260921` | 4 | 运行、汇总、清理 → 执行器、汇总、环境检查；嵌套旧源码不是当前实现 |
| `legacy-acceptance-20260917` | 8 | 六份场景清理 → 环境检查；`run-profile` → 执行器；cost 汇总 → 通用汇总；原固定任务列表保留历史 |
| `legacy-closeout-20260921` | 2 | 运行、清理 → 执行器、环境检查；业务在 `tests/e2e/acp-closeout/` |
| `lifecycle-foundation-20260921` | 2 | 运行、清理 → 执行器、环境检查；业务为 `tests/e2e/lifecycle-closeout/foundation-run.mjs` |
| `lifecycle-health-migration-20260921` | 2 | 两份运行包装 → 执行器；业务为 `tests/e2e/lifecycle-closeout/run.mjs health` |
| `lifecycle-interrupted-migration-20260921` | 4 | 运行、清理 → 执行器、环境检查；固定两次运行的 `audit.mjs` 保留历史复核；当前业务使用 `tests/e2e/lifecycle-closeout/interrupted-run.mjs` 及其 oracle |
| `lifecycle-loss-migration-20260921` | 3 | 运行、清理 → 执行器、环境检查；业务为 `tests/e2e/lifecycle-closeout/run.mjs loss` |
| `lifecycle-network-migration-20260921` | 3 | 运行、清理 → 执行器、环境检查；业务为 `tests/e2e/lifecycle-closeout/run.mjs network` |
| `lifecycle-restore-migration-20260921` | 3 | 运行、清理 → 执行器、环境检查；业务为 `tests/e2e/lifecycle-closeout/run.mjs restore` |
| `lifecycle-shutdown-migration-20260921` | 4 | 运行、清理 → 执行器、环境检查；HTTP 诊断保留当次调查；业务为 `tests/e2e/lifecycle-closeout/run.mjs shutdown` |
| `publication-trace-20260917` | 1 | `run-postgres.py` → 依赖工具；原服务断言通过对应正式入口调用 |
| `recovery-support-split-20260921` | 4 | 运行、汇总、清理 → 执行器、汇总、环境检查；共享恢复资产在 `tests/e2e/lifecycle-closeout/` |
| `retained-seed-retirement-20260921` | 3 | 运行、清理 → 执行器、环境检查；不恢复已退役 retained seed 分支 |
| `runtime-crash-integration-20260922` | 4 | 三份包装 → 执行器、汇总、环境检查；`recheck-traces.mjs` → `tests/support/verification/recheck-crash-traces.mjs`，沿用当前 crash oracle |
| `runtime-crash-recovery-20260921` | 3 | `postgres-gate.py` → 依赖工具；其余 → 执行器、环境检查；测试按服务单元/根集成边界执行 |
| `runtime-inspect-absence-20260921` | 4 | 运行包装 → 执行器和 `tests/support/verification/go-service.mjs`；清理、镜像及保留状态 → 环境检查 |
| `runtime-sync-20260921` | 6 | `run-command` → 执行器；`agent-state`、`replay`、`runtime-final-checks.py`、`lifecycle` 已验收删除；Runtime-loss 使用开发 `runtime-loss.mjs`，`deployment` → `development/deployment/runtime-20260921.py`，已验收归档删除 |
| `stage3-tail-retirement-20260921` | 6 | 运行、清理 → 执行器、环境检查；`identity-before.sh` 是旧源码快照，`identity-diagnostic.sh` 是冻结诊断变体，`capture-failure.mjs` 是当次钩子，均非当前入口 |
| `temporal-readiness-20260921` | 4 | 运行、清理 → 执行器、环境检查；HTTP 诊断保留当次调查；当前 readiness/lifecycle 使用正式测试 |
| `temporal-sync-20260921` | 6 | `run-command` → 执行器；`agent-state`、`replay`、`temporal-final-checks.py`、`lifecycle` 已验收删除；`deployment` → `development/deployment/temporal-20260921.py`，已验收归档删除 |
| `timeout-failure-followup-20260922` | 4 | `queue`、`run-command` → 执行器；`summarize-log` → 汇总；`final-environment` → 环境检查；嵌套候选副本不是当前源码 |
| `workspace-browser-migration-20260921` | 4 | 运行、汇总、清理 → 执行器、汇总、环境检查；业务为 `tests/e2e/workspace-closeout/browser-run.mjs`、`c4-run.mjs` |
| `workspace-protocol-migration-20260921` | 4 | 运行、汇总、清理 → 执行器、汇总、环境检查；业务为 `tests/e2e/workspace-closeout/run.mjs` |

## 25 份保留环境脚本的具体归并

以下数量合计 25。新开发 driver 是显式配置的手工 E2E 入口，默认测试不会
连接真实保留环境。配置与影响见 [开发验收说明](../tests/e2e/development/README.md)。

| 原文件组 | 原数量 | 当前归属与边界 |
| --- | ---: | --- |
| `agent-state.mjs` | 5 | 一个正式 `development/agent-state.mjs`；Agent、Gateway、配置和输出均显式输入；Playwright 依赖锚定 UI 服务 |
| `deployment.py` | 4 | 已有 `development/deployment/` 下四个显式配置的手工入口，Runtime、Controller 20260917／20260921 与 Temporal 20260921 均已验收归档删除；数据库/workspace 基线、备份和镜像晋升检查不能由通用环境比较替代，待验缓存原件剩余 0 份 |
| `final-checks.py` | 3 | 正式 `development/{controller,runtime,temporal}-final-checks.py`；保留原数据库/workspace/Trace 断言，合同、历史重放及隔离 Docker 验证通过，三个原件已删除 |
| `idle-restart.py` | 1 | 正式 `development/idle-restart.py`；正常停止退出零、同容器重新启动和健康断言经隔离 Docker 验证通过，原件已删除；未重启保留 Controller |
| `lifecycle.mjs` | 4 | 三份普通场景及一份 Runtime source-missing 场景均通过合同、历史报告重放及隔离 Docker 检查，四个原件已删除；旧 Controller 选择器不恢复，普通场景统一 `development/lifecycle.mjs`，Runtime-loss 单列 `development/runtime-loss.mjs` |
| `recover.mjs` | 1 | 正式手工入口 `development/recover.mjs` 的配置/目标绑定、原恢复断言、完整 workspace digest、历史兼容及隔离 Docker 检查通过，原件已删除；未执行保留 Agent 恢复 |
| `replay.mjs` | 2 | 一个正式 `development/replay.mjs`；Agent/Session、数据库容器/用户/库名及输出参数化，保留历史逐条比较和无新增执行断言 |
| `metadata-browser.mjs` | 1 | 正式同名 driver 已验收，原件已归档删除；保留双页 metadata/list/reload、完整可见历史、无重发和音频拒绝断言，真实浏览器夹具不代表重新部署或调用真实模型 |
| `rejection-trace.mjs` | 1 | 正式同名 driver；拒绝 Session 和 Jaeger 显式输入，保留无模型 HTTP/Runtime Tool 调用及错误类别断言 |
| `trace-review.mjs` | 3 | 一个正式同名 driver；Session、Trace 数和最少 Runtime Trace 数显式输入，保留拓扑与 strict/时间诊断分离 |

普通和 Runtime-loss driver 仍各自保留登录、等待、publication oracle、
生命周期及清理流程，迁移时没有合并或重写两种业务实现。Runtime-loss 通过
显式 `restartSnapshot` 与 `composeSnapshot` 取得 publication 时间下限和
Runtime Controller scope，不再依赖任何固定历史文件。共享预检校验两份
快照的身份与 cutoff，并从 Compose 派生 scope，无需调用方新增字段。

## 诊断脚本的当前处置（含 Identity 钩子）

| 原文件 | 处置 |
| --- | --- |
| `acp-persistence-20260917/check-links.py` | 正式 `tests/support/verification/check-links.py`；位置参数指定文档列表 |
| `acp-progress-20260916/interrupt.py` | 正式 `tests/e2e/acp-progress/interruption.py`；真实 SIGTERM 验收通过，fixture 退出 143 且自行清理全部测试资源和子进程，原件已删除 |
| `final-regression-20260922/commands-diagnostic.py` | 正式 `tests/support/diagnostics/commands-observer.py`；本地进程合同和真实业务/采集/清理通过，严格时间失败保留，原件已删除 |
| `final-regression-20260922/sdk-diagnostic.py` | 正式 `tests/support/diagnostics/sdk-observer.py`；本地进程合同和四组真实 SDK 场景/采集/清理通过，原件已删除 |
| `lifecycle-interrupted-migration-20260921/audit.mjs` | 正式 `tests/support/verification/audit-lifecycle-evidence.mjs`；合同和 3+16 条历史 Trace 重放通过，原件已删除 |
| `lifecycle-shutdown-migration-20260921/http-diagnostics.mjs` | 正式 `tests/support/diagnostics/http-errors.mjs`；合同通过，原件已删除 |
| `runtime-crash-integration-20260922/recheck-traces.mjs` | 正式 `tests/support/verification/recheck-crash-traces.mjs`；场景目录和输出文件显式输入，仍调用当前 crash oracle |
| `stage3-tail-retirement-20260921/capture-failure.mjs` | 正式 `tests/support/diagnostics/capture-http-failure-traces.mjs`；模拟 fetch 的采集合同通过，原件已删除，未查询当前 Jaeger |
| `temporal-readiness-20260921/http-diagnostics.mjs` | 与 shutdown 调查副本内容相同，共用正式入口；原件已删除 |
| `stage3-tail-retirement-20260921/identity-diagnostic.sh` | 完整三服务日志采集已加入正式 Stage 3 入口；真实 Identity 业务／拓扑／日志／清理验证通过，两条严格失败和退出码 2 保留，原件已删除 |

## 历史出处与验证范围

[浏览器辅助退役报告](browser-finish-retirement.md) 记载两份 `browser-control`
是修改前快照。[Controller 部署报告](controller-development-sync-20260921.md)
和 [Temporal 部署报告](temporal-development-sync-20260921.md) 记录原 driver
与私有证据曾共同存放的事实。本清单给出当前可复用源码入口，不改写那些报告
的候选、结果或一次性数据保留结论。

[最终候选回归](final-candidate-regression-20260922.md) 和
[超时/失败跟进](timeout-failure-followup-20260922.md) 的原始失败与复跑记录
保持历史身份。源码归属整理、当前验证结果以及未执行的保留环境范围统一见
[测试目录迁移记录](test-layout-migration.md)；本清单不为八个开发 MJS driver
追加未经执行的通过结论。
