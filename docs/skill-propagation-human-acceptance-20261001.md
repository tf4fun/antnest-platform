# Skill 动态传播：浏览器演示与人工验收（2026-10-01）

状态：重启后已完成受控 Chrome 的真实模型演示及只读后端核验，等待用户体验评审。
本批记录四步 Skill 流程的现场结果，不修改服务实现。此前
[DI1](skill-propagation-integration-delivery-20261001.md)、
[DI2](skill-source-lifecycle-delivery-20261001.md) 和
[DI3](skill-discovery-caller-integration-delivery-20261001.md) 的机器门禁已通过；
它们不代替真实模型的选择、生成质量和人的体验判断。

## 1. 现场环境

- 登录页：`http://127.0.0.1:18090/login`；Jaeger：`http://127.0.0.1:55220`。
- 独立项目 `antnest-human-skills-17b7d4b9`，使用本批从工作区构建的镜像。
  12 个常驻服务运行，11 个配置了健康检查的服务均健康，Jaeger 的 HTTP
  查询单独通过。启动时核验此前 17 个容器停止；最新核对时这 17 个 ID 已
  不在同一 OrbStack 上下文中，当前只有本批 12 个常驻服务和 4 个已完成
  初始化容器。保留初始记录与最新清单，数据卷没有复用旧部署。
- Skill 准备容器使用本批 RC 镜像；数据卷，包括备用备份卷，按项目隔离。
- 初始五个业务目录均为空。用户随后提供凭证，经普通 Gateway/Console/
  Controller 接口保存一个 DeepSeek 连接和一个模型，未创建 Skill、模板、
  Agent 或 Session，未进行模型推理。临时凭证导入文件在核验保存成功后删除。
- 正常 Provider 查询返回 `deepseek-flash`，显示名为 `DeepSeek-V4.1-Flash`。
  验收配置采用 128,000 上下文和 4,096 输出上限；这是操作者设置的保守限额，
  不是 Provider 声明的能力。三个 Session 均先以“你好”验证首条消息自动创建
  会话，再选择 `Thinking Off` 执行下面的任务；初始问候使用模型默认设置。
- 2026-10-01 系统重启后，先启动既有 OrbStack，再恢复同一 Compose 项目，
  核验原有镜像和数据卷保留，没有另建部署或重新配置凭证。Chrome 插件已连接，
  登录、创建、聊天、检索、提升、模板修订及重建都通过实际页面操作完成。
  演示结束时有一个 Provider、一个模型、一个正式 Skill（v1/v2）、两个模板、
  三个 Agent 和三个 Session。验收环境保留供用户检阅。
- 私有登录信息、镜像/卷核验、模型配置和上传 ZIP 位于
  `artifacts/verification/human-skill-propagation-20261001/`，忽略 Git/Docker。
  共享文档、截图与普通日志不保存密码、API Key 或认证 Cookie。

原有[基础演示场景](../tests/e2e/skill-registry/fixtures/human-demo/scenario.json)
及 [SKILL.md](../tests/e2e/skill-registry/fixtures/human-demo/SKILL.md)
继续用于上传、文件工具和学习通知体验。下面额外验证另一 Agent 消费、
显式提升及版本交付。Skill、模板、Agent 和 Session 均在现场通过 UI 创建。

## 2. 四步传播的现场顺序

| 步骤 | 页面操作与任务 | 需要观察的结果 |
| --- | --- | --- |
| 准备两个 Agent | 登录后创建只引用 Flash 模型、无预设 Skill 的基础模板；从它创建来源 A 和消费方 B。打开 A 的聊天，直接发送首条消息 | 创建时准备进度完成，首条消息创建 Session，执行状态和工具结果可读 |
| A 自动学习并投影 | A 执行下文文件核验任务；Run 正常结束后保持空闲，等待正常自动复盘。应用后打开来源会话，再到 Skills → Discover Agent Skills 搜索实际生成的名称 | 学习 notice 对应真实 applied 结果和来源 Run；搜索返回 A 的动态来源、sequence 和摘要，尚未产生正式版本 |
| B 临时使用 | B 的新 Session 选择 Thinking Off，发送下文消费任务，将占位名称换成实际名称 | 真实工具卡展示 Find Skill、Load Skill；选择摘要一致，B 按规则完成本 Run。来源正文不复制成 B 的永久 Skill |
| 显式提升 v1 | 同一所有者搜索 A 的名称，点击 Review and promote；核对正文和文件，选择 Create a new formal Skill，再点击 Promote Skill | Registry 产生正式 v1 和摘要；来源仍为个人 Skill，模板与现有 Agent 未被自动修改 |
| 模板创建交付 | 新建预设模板 T，选择 Flash 模型和正式 v1；从 T 创建 C，要求实际读取该 Skill | 创建经过准备流程；C 读取 `/skills/<实际名称>/SKILL.md`，配置冻结 T 修订和正式 v1 |
| 动态来源与正式版本分离 | A 使用已有个人 Skill 完成后续文件任务，提供可核验的新规则；如果复盘实际更新它，重新搜索新 sequence/摘要，再向同一正式 Skill 追加 v2 | 只有实际学习更新后才演示 v2；v1、T 旧修订和 C 当前预设保留原有内容身份 |
| 显式重建交付 | 创建 T 新修订并选择正式 v2；先确认 C 没有热更新，再显式把 B 重建到该修订并读取预设 | 准备、Drain 和重建完成，B 的新 Run 使用 v2；没有重建的 C 继续使用 v1 |

学习与动态发现遵守当前所有者范围。模型输入不填写组织、用户或调用方身份；
用户提示不作为发布授权。提升通过 Console 的明确操作。
入口以[当前 Console 实现](../services/admin-console/web/src/pages/skill-sources.tsx)
为准；模型工具输入以[发现合同](../contracts/agent-acp/skill-discovery-tools.md)为准。

## 3. 现场任务文本

来源 A 的第一项任务：

> 请整理一个测试项目的交接资料。先分别创建 demo/brief.md 和
> demo/checklist.md：项目名为内部知识助手，目标是文档问答，三个检查点为
> 登录可用、文档读取可用、回答带来源。明确这些是待执行的产品检查。创建后
> 实际读取两份文件，再生成 demo/handover.md，按“完成内容、文件证据、
> 待验证项”的顺序写交接说明。最后读取 handover.md，核对项目名、三个
> 检查点和未实际执行的检查，并汇报实际完成的内容。

来源 Run 应有至少三个真实工具轮次，结束原因为正常回答完成；达到模型调用
上限或只声称完成，不能作为任务通过的证据。

消费方 B 的任务（现场替换占位名称）：

> 请使用 find_skill 查找“<A 实际生成的 Skill 名称>”，从结果中选择来源
> Agent A 的当前条目，并用返回的引用和摘要调用 load_skill。根据加载到的
> 规则整理一个简短的交接说明，写到 demo/peer-handover.md，再实际读取
> 核验。不要将这份来源 Skill 安装成个人 Skill。汇报使用的来源、核验文件
> 和仍待执行的检查。

新建或重建后的预设读取任务：

> 请读取系统预设 /skills/<实际名称>/SKILL.md，说明其中的交接规则，并列出
> 本次实际读取的文件。不要修改预设 Skill。

## 4. 判定与证据

真实模型可能合法选择 `skip`。记录来源 Run、学习任务、原因及 Trace，不能
伪造 learned notice，也不能把“进入复盘”写成“生成 Skill”。没有实际
applied 来源，后续传播保持待验收，不手动插入投影或改写学习状态。
若使用用户已要求的[系统内学习 debug](skill-learning-debug-20260930.md)，
明确记录 debug 标记并走正常队列；它要求尝试生成，不替代候选校验，也不
证明普通模式必然生成。任务结束后关闭临时设置。

每步记录实际 Agent、Session、Run、学习任务、来源 sequence/摘要、正式版本、
Template 修订及 Trace ID。准备阶段浏览器不可用的记录保留为历史；系统重启后
已完成页面操作并保存实际截图，不能继续把该历史情况作为当前阻塞。

模型推理、复盘、验证及 Runtime apply 的父链按既有
[学习诊断](skill-learning-debug-20260930.md)核对。来源发现和临时交付还检查
Registry 的 SERVER/CLIENT 父链，参照 [DI3](skill-discovery-caller-integration-delivery-20261001.md)。
只接受此前约定的纯时钟告警，逻辑缺父和实际流程失败仍记录为失败。

当前准备证据不证明多文件个人 Skill 的自动生成。首版学习生成单文件
SKILL.md；真实临时目录与附件执行、完成/取消/重启清理已有独立 Docker
证据，范围见[临时交付报告](skill-discovery-temporary-consumer-delivery-20261001.md)。

## 5. 本轮实际结果

所有对象经受控 Chrome 创建或修改。后台核验仅通过正常认证接口读取审计、
生命周期回执，通过 Docker 读取实际挂载及文件，并查询已结束的 Jaeger Trace。
没有手动插入学习结果或投影，没有使用 debug，没有解密、重放模型凭证。

| 对象 | 实际身份 | 演示结束时的配置 |
| --- | --- | --- |
| 基础模板 | `template_ca896bfc87bb6a8ea45d96ca4ebb2ca3` | Skill Propagation Base，修订 1，无预设 |
| 预设模板 | `template_f41038f6762e248756b1710eae65035f` | Skill Handover Preset，修订 1 固定正式 v1；修订 2 固定正式 v2 |
| 来源 A | `agent_b62f271d8bad8b8078340bba14fa22ea` | 基础模板修订 1；一个自动维护的个人 Skill，无预设 |
| 消费方 B | `agent_451a4d7f5bf9d12a921cc6d19d310d55` | 从基础模板创建，后显式重建到预设模板修订 2，只读 v2 |
| 对照 C | `agent_b8123e12a992a3f027e1437dd83afdcd` | 预设模板修订 1，只读 v1，未重建 |

三个 Agent 始终保持 Runtime 公网访问关闭。三个会话分别为
`session_ef84fd0e52385461b69a96ed96d438ac`（A）、
`session_6ac07caac95ebecbb20953d2fc62aebe`（B）、
`session_a06c2b2f73a8671a11f4623109675319`（C）。B 在原会话中完成重建后的新 Run。

### 5.1 自动学习、动态来源与临时使用

A 第一项任务实际创建三份文档并各自读回。正常空闲复盘新增
`project-handover-package`，UI 显示 `New skill learned` 及来源会话链接；
Console 检索到来源 revision 1。B 的真实 `find_skill` / `load_skill`
引用 A 的当前来源及同一摘要，按加载规则完成三份文档与读回核验。
加载结果为 `temporary_files: null`、`requires_runtime_delivery: false`：
本次单文件正文只供当前 Run 使用，没有安装为 B 的个人 Skill。

A 随后的任务先实际读取该个人 Skill，再执行新项目交接。用户纠正明确要求
每项待验证项包含“证据缺口”和“下一步执行方式”；前景只写业务文档，不直接
修改 Skill。正常复盘随后更新同一个 Skill，UI 显示 `Skill updated`，
Console 来源升至 revision 2。此时正式目录仍为 v1，直到操作者显式追加发布。

| 学习结果 | 来源 Run | 学习任务 | 推理次数 / 输出 token | Trace |
| --- | --- | --- | --- | --- |
| 创建 | `run_1f089defe9944bc1c0daa2c36ed42d09` | `learn_38652df688d0497243d0cff81b562fe3` | 2 / 1,589；首个候选格式未通过，修复后应用 | [209 spans](http://127.0.0.1:55220/trace/14fbd7aba0c824d7b1fb600b5a2cb296) |
| 更新 | `run_96bd416667cb7a6370da096daf96cb62` | `learn_be743d1b9c9648e2da6eb46fe6b309ee` | 1 / 880；候选通过并应用 | [206 spans](http://127.0.0.1:55220/trace/7603e91406fea5731352a4c7a8eb437a) |

两次均为 `debug: false`，符合每任务最多 2 次推理、合计最多 4,000 输出
token 的限制；有界证据发生截断，记录为 `evidenceTruncated: true`。
学习 Trace 覆盖 task、review、model、validation、apply 和 Runtime 维护 HTTP，
父链完整。notice 经 `changeId` / 来源 Run 与页面结果对齐；不宣称 Bridge/SSE
和学习任务构成同一条 Trace。

B 的消费任务自身也触发了正常后台复盘，但没有形成可应用的候选，诊断仍记录
`review_inconclusive`。它没有产生学习通知或个人 Skill，也没有阻止后续重建和
前景读取；不能把 B 的这次复盘写成自动学习通过。

### 5.2 显式提升与冻结交付

操作者两次核对来源包正文后，先创建正式 v1，再向同一正式 Skill 追加 v2。
正式 Skill 身份为 `skill_6aa355bbb3f25b9e8adb42a68b1bee68`：

| 正式版本 / 对应来源 | 内容摘要 |
| --- | --- |
| v1 / A revision 1 | `sha256:915c05e03aaa194e3bab15f0d5c8fb0d40c35a591e174826ef30fd2f29351468` |
| v2 / A revision 2 | `sha256:4c667d233fd08d1790deabba82a77e8ab116f258bf01faf96e71409cade00799` |

C 从固定 v1 的模板创建，实际读取 `/skills/project-handover-package/SKILL.md`。
v2 和模板修订 2 发布后，C 再次实际读取，仍不包含两项新规则。B 只有在明确
重建到修订 2 后才读到新规则。正常服务审计也确认 C 的 AgentSpec 和 Runtime
修订未变，B 两项修订都已变化，后续 Run 使用新的 AgentSpec。

Docker 核验三个 Agent 使用各自的 RC 所有 Skill 集合卷，`/skills` 挂载均为
只读；A 的预设清单为空，B 清单固定 v2，C 清单固定 v1。目录是实际目录，
SKILL.md 是普通文件，内容摘要和清单中的文件摘要一致。A 当前个人正文与
B 交付的 v2 正文摘要相同。这里的单文件摘要与整包 `content_digest` 是不同身份，
不混用。没有符号链接交付或静默空集合。

### 5.3 Run、生命周期与验收边界

9 个前景 Run（含三个初始问候）均为 `completed / end_turn`，未因模型请求
上限而结束。以下为六个业务 Run 的 Trace：

| 步骤 | Run | Trace |
| --- | --- | --- |
| A 文档任务 | `run_1f089defe9944bc1c0daa2c36ed42d09` | [655 spans](http://127.0.0.1:55220/trace/874f6bac23986f1c2278c3d422bd1fd3) |
| B 动态检索及使用 | `run_932c32863cd48f6d10f9da2eb161cbad` | [1,083 spans](http://127.0.0.1:55220/trace/d76547a40c979331cf746a91ca764c55) |
| C 首次读取 v1 | `run_b29867c1f3c2db33a4c675cef1849e09` | [522 spans](http://127.0.0.1:55220/trace/10cfd232578aa18b4db5fde63540f130) |
| A 文档纠正任务 | `run_96bd416667cb7a6370da096daf96cb62` | [770 spans](http://127.0.0.1:55220/trace/9a2d33c37e2e3653fbdde94741daf757) |
| C 发布后仍读取 v1 | `run_555d39bc899338903e748085b6df365f` | [470 spans](http://127.0.0.1:55220/trace/1d73a0a66a414af8a3bcd73858a1233f) |
| B 重建后读取 v2 | `run_743132e816e12f67fc099a8dcb9cd137` | [380 spans](http://127.0.0.1:55220/trace/a792f851d388080e7e4f9e3859a73520) |

B 的检索 Trace 有一个 search、一个 load、两个 A 来源观察，Registry
SERVER/CLIENT 及回源 ACP 父链完整，没有调用方自身来源观察。所有前景 Run
和三个创建、一个重建的生命周期 Trace 都已核验父链完整、正文捕获关闭。
保留此前允许的 `clock skew adjustment disabled` 告警，不改 NTP。
重建回执 `lifecycle-740b5a1fd7e56d8e40d6a9c6663e912f0f969c68fe05449f24ee5e43920124a3`
为 completed，对应[401-span Trace](http://127.0.0.1:55220/trace/a0023458c031f51234b67048fa708ef1)。

最终证据为私有目录中的 `human-browser-admission.json`；正常接口审计、卷清单、
Trace 原始值及 Chrome 截图均保留。通过的串行核验为
`human-source-and-caller-admission`、`human-final-functional-admission-corrected`
和 `human-lifecycle-and-evidence-closeout`。首个收尾脚本将 UI 的 Available
误当作协议状态（实际为 ready），已修正断言并保留失败记录；可选事件选择器
也已在收尾中改为实际 `agent_rebuilt`，并强制核对 completed 回执。
这两项是核验脚本问题，没有修改服务代码。

本轮证明四步传播功能可通过真实模型和页面完成；用户体验确认仍待用户评审。
自动生成正文含本次示例的检查点名称，是否足够通用也由人工评审。
本轮没有进行多文件个人 Skill 自动生成验收，没有重复宣称全仓所有门禁。
