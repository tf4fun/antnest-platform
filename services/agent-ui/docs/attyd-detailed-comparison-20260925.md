# attyd 与 Agent UI 详细对比（2026-09-25）

**当前判断：Node Bridge 持有执行、浏览器用 HTTP 提交意图和 SSE 观察的方向与 attyd 一致。近期上游的资源释放、慢观察者、期限、过程分页和阅读体验原则已在 Antnest 领域模型内实现并通过本地及六服务 E2E；仍不能宣称两个产品或所有运行环境完全等价。非本机代理/长期真实流量及实际读屏器验收暂缓。**

以下表格描述本次对齐候选源码；后面的 B1–F5 表及前几批记录是首次审查的历史快照，不能作为当前缺陷清单。本文件记录源码、测试和实际页面的对照结果；候选提交与阶段三验收状态另行记录。

| 维度 | 当前已验证的对齐 | 保留的差异与证据边界 |
| --- | --- | --- |
| 后端行为 | 服务端 owner 独立于浏览器观察连接；冷历史原子切换、短时失败退避、永久 404、请求期限、取消迟到保护和重启恢复有单元、HTTP/SSE 与六服务回归 | Antnest 用 durable intent/appendVersion、多租户容量，而 attyd 管理本地 ACP fork/resume 资源；服务端历史退避是有界的，不等同于上游所有可选 workflow |
| 后端内存 | 水位后释放、慢端有界 reset、SSE 帧共享、正文按需分页和闲置清理、稳定预览复用；Node V8 探针、生产容器小更新/中断分页/180 次观察连接样本通过 | Rust allocator 数值不可与 Node V8/RSS 横比；固定本机负载不能证明长期真实流量的上限 |
| 前后端交互 | 快照接 SSE、断线后权威 View 恢复、执行不受观察者断线影响、版本化过程增量及失败重试；真实浏览器、Node HTTP/SSE 和六服务 E2E 已覆盖代表性路径 | 多项交错或超出八次的过程变更安全回退分页；真实代理长时间离线和实际读屏器体验未验收 |
| 前端样式 | 加载骨架、过程页脚、跨页阅读身份、移动页和失败状态有实际截图/Chromium/WCAG 证据；修正 Antnest token 与历史续载按钮偏差 | 工作区侧栏、暖色与 lime 信号属于 Antnest 设计规范；attyd 的主题、语言和整页像素布局不作为复制目标 |

当前后端与续页归属修正后，服务端 219 项、浏览器逻辑 156 项、契约 19 项、HTTP/SSE 16 项、生产 Bridge 容器 E2E，以及真实六服务完整历史和无回执崩溃对账 E2E 均通过。随后 IME 键盘修正又通过组件 106 项、生产构建/类型检查、Chromium 4 项及真实六服务主流程 E2E。完整历史场景直接检查大回答的按钮归属、内容重组、键盘焦点和刷新后恢复。上述证据对应固定场景与负载，不代表所有故障时序。原始内存样本和截图在 Git 忽略的 `artifacts/verification/`。

**参考基线与证据范围**

协调者通过 `git ls-remote https://github.com/tf4fun/attyd.git refs/heads/main` 在线核对，最新 main 为 `754ac145ab6d8a3437655e778f7a06fb04aa7239`；本机 attyd 源码与此一致。重点检查以下提交的实际代码，而非只读 README：

| 上游提交 | 重点变化 | 当前 Agent UI 对齐程度 |
| --- | --- | --- |
| [a5b07ff](https://github.com/tf4fun/attyd/commit/a5b07ff) | 无观察者 Session 的空闲状态机 | 已有独立 Session 空闲计时及工作保活；回收对象有所不同 |
| [0857250](https://github.com/tf4fun/attyd/commit/0857250) | history workflow 跨重试退避保有 owner | 已有服务端有界退避和工作保活；未复制所有 fork/resume 终态 |
| [802c20b](https://github.com/tf4fun/attyd/commit/802c20b) | 水位释放、可替换交付槽、结束 generation 清理 | 原事件释放和慢端 reset 原则已对齐 |
| [2d1ed94](https://github.com/tf4fun/attyd/commit/2d1ed94) | 轻量控制更新、实体共享、诊断归档收缩、HTTP deadline、过程懒加载 | 已有对应的 Node 分配探针、期限、共享与分页实现；仍缺长期生产 RSS 等价证据 |
| [754ac14](https://github.com/tf4fun/attyd/commit/754ac145ab6d8a3437655e778f7a06fb04aa7239) | 完整会话骨架、过程分页状态、跨页分组和展示身份 | 已按 Antnest 结构吸收并用加载完成页面截图/Chromium 验证；保留品牌和导航差异 |

首次审查前的证据为 457 项本地检查和 3 个 Docker E2E，详见 [修复记录](attyd-alignment-fixes.md)。首次审查新增探针直接调用当时的生产方法，并将 Bridge 投影接入 React 静态渲染。该轮私有结果保存在 `artifacts/verification/agent-ui-attyd-detailed-probes-20260925.json`，没有在 `.cache` 保存源码或证据。后续变更和复测见文末批次。

首次审查时没有两项目的加载完成页面截图，因此下列初始样式判断只来自组件结构和 CSS。第二十六批补充了双方实际加载页面的截图对照；不同 fixture 仍不能作为像素等价证明。

**以下至“同日后续修复与剩余边界”均为首次审查的问题快照。**

**一、后端行为模式**

| 行为 | attyd | Agent UI 当前工作树 | 判断 |
| --- | --- | --- | --- |
| 执行所有权 | 服务端 Bridge 持有执行，浏览器只是观察者 | Node owner/operation 持有工作，SSE 断开单独释放观察 lease | 已对齐 |
| 前端通道 | 普通 HTTP 提交意图，业务 SSE 同步状态 | 同样使用 HTTP + SSE | 已对齐；attyd 自身支持的其他 Agent transport 不等于要求浏览器使用 WS |
| 冷历史恢复 | staged candidate，完成后原子提交 | sealed load + 完整 delivery watermark 后替换 current | 已对齐 |
| 普通本地 Run | 不因每轮完成重载全部历史 | 本地 intent 回执证明连续 appendVersion 后推进 live version | 上一轮修复有效 |
| 无浏览器的活跃工作 | 工作 owner 阻止回收 | 恢复的 active Run 也持有 work，后台 sweep 继续观察 | 已对齐原则 |
| 普通 HTTP 超时 | 60 秒兜底，SSE 豁免，已接受工作继续 | 60 秒包含 handler/完整 response body，SSE 豁免 | 已对齐 |
| 旧实例回写 | epoch/incarnation/owner 检查 | epoch/incarnation、加载/配置身份与关闭后回写隔离 | 主要已对齐，取消有独立竞争窗口 |

当前证据入口：`web/server/src/bridge/operations.ts:137`、`session-replay.ts:98`、`agent-owner.ts:519`、`:549`、`:716`、`:742`，以及 `web/server/src/http/node-server.ts:208`。

应保留的领域差异：

- attyd 主要围绕通用 ACP 单写者模型；其 epoch 内 CAS 不保证 Bridge 重启后 exactly-once。Agent UI 依赖 Antnest 的 durable intent、appendVersion、delivery cut，能够处理服务重启对账和外部写入。这是平台需要的能力。
- attyd 的终端、MCP、fork/resume 等本地资源模型不应全部搬入 UI。当前平台相关工作由 Runtime/ACP 等服务负责。
- Agent UI 空闲时释放本地投影，不向上游发送 Session close/cancel，适合 durable Run 的所有权边界。
- Agent UI 默认最多 16 个 owner，单位是 organization/principal/agent。容量满时可提前淘汰无观察者、无工作的 owner，全部繁忙时拒绝新增；这与 attyd 的纯空闲政策不同，属于明确的服务容量策略，不能说成“最多 16 个 Session”。

后端仍有三个差异：

| 编号 | 发现与影响 | 证据及建议 |
| --- | --- | --- |
| B1 | **取消响应迟到可回退本地终态。** cancel 先读 running，等待上游期间已观察 completed，随后仍写回 cancelling | `operations.ts:349–368`；本轮已确定性复现。新持久回执可将结果纠正，尚未证明持续业务错误。应在异步完成处检查最新终态/操作身份 |
| B2 | **不存在的 Session 被当作临时离线。** producer 的永久 404 被改成 capability error，View 路由再转 503，浏览器持续重试 | `adapters/acp-http.ts:572–580`、`http/agent-view-routes.ts:38–49`、`src/lib/bridge-agent-controller.ts:141–154,308–315`。应保留 session_not_found 语义并退出无效选择 |
| B3 | **历史恢复依赖浏览器重新 select。** 单次 cold load 失败结束，没有服务端维持同一 loading workflow 跨退避重试 | `agent-owner.ts:519–547`；这是恢复体验差异，并非已证明数据错误。可在 B2 后考虑引入 workflow/attempt owner |

B2 的 producer 已在 `services/agent-acp-service/src/transport/bridge-observation.ts:103–114` 返回 `404 session_not_found, retryable:false`，因此无需先扩展生产者协议。attyd 的对应处理在 `src/bridge.rs:1992–1998,4201–4205`。

B3 以 attyd `src/bridge.rs:2624–2678` 与 `docs/history-sync-lifecycle.md` 为准；其旧 `active-turn-runtime.md` 仍残留未实现说明，不能据此否认最新代码已落地。

**二、后端内存优化**

已经对齐的部分：完整 delivery 应用后释放原始 pending 更新，只保留摘要；工具提供的字段替换当前值而非累计旧版本；完整业务历史不按累计字节截断；隐藏工具正文不提前格式化；慢订阅者超限后保留最新 reset 意图；无工作且无观察的 Session 最终回收 transcript、pager、journal。

这些可在 `delivery.ts:169–198`、`compact-transcript.ts:359–413`、`stream-journal.ts:197–278`、`agent-owner.ts:742–796` 和相应单元测试中确认。Node 的同步队列操作与 reset marker 可以实现 attyd 状态槽的目的，没有必要照搬 Rust Mutex/Arc 类型。

仍有三处效率问题：

| 编号 | 当前实现 | 与参考优化的关系 | 建议 |
| --- | --- | --- | --- |
| M1 | 大工具 processContent 每页重新物化整个工具、JSON 格式化和 clone，二分预算时还生成大 Base64/JSON 临时值 | 是 Agent UI 自有字节分页的额外成本；普通回答分页已优化，工具分页未同步 | 复用版本化序列化块，预算按编码长度计算，避免每页处理全正文 |
| M2 | Pager 缓存包含 delivery watermark，每次推进都会重建最近窗口并 clone 可见内容；新旧 View 校验也遍历窗口 | 基础 reducer 的实体共享已采用，但尚无等价于 attyd E04 的分配门槛，更没有端到端门槛 | 将稳定历史实体/窗口与游标签名分离复用；增加无关大正文 + 小更新的成本检查 |
| M3 | 同一 SSE 对象在发布、留存、各订阅者入队/出队、淘汰和发送时反复 JSON.stringify | attyd 共享已编码的 Arc<str>，长度直接记账 | 缓存 bytes，按需要复用 wire encoding，验证 1/4/8 订阅者成本 |

M1 代码位置为 `view-pager.ts:290–351`、`compact-transcript.ts:425–433`；M2 为 `agent-owner.ts:669–675`、`view-pager.ts:87–94,436–492`、`workspace-runtime.ts:127–128`；M3 为 `stream-journal.ts:139,199,277,301,307,390` 与 `http/event-routes.ts:146`。

本轮 M1 探针使用相同生产 Pager、128 B inline、64 KiB page，只统计分页阶段的 JSON 序列化，输入构造和首个过程目录页不计入：

| 工具原文大小 | 内容页数 | 完整 rawOutput 格式化次数 | 累计 JSON.stringify 返回字符数 |
| --- | ---: | ---: | ---: |
| 8 KiB | 1 | 1 | 24,790 |
| 1 MiB | 22 | 22 | 83,455,439 |

输入是 ASCII，后者约 83 MB 序列化处理量。**这不是 retained heap、RSS 或实际 allocator 分配总量，也不是默认 256 KiB 页的生产负载基准。** 它证明同一大工具被跨页重复处理，应补成本回归而不是仅验证最终内容正确。

需要避免夸大上游：attyd `docs/lazy-turn-process.md:134–137` 也承认当前 HTTP 精简投影会先构造完整内部视图。它的 E04 测的是 registry fold 中无关正文对小更新分配的影响，不能据此宣称 attyd 所有 HTTP 路径都是常数成本。

当前 `cached_history_bytes` 是 transcript 的逻辑字节估计，不涵盖所有公共窗口、序列化 Buffer 和临时对象。上轮固定负载 GC/容器内存回落是有效证据，但既不证明任意历史的固定内存上限，也不替代 M1–M3 的分配检查。

**三、前后端交互及浏览器内存**

HTTP 初始快照到 SSE 的游标衔接、连续增量、gap/reset、scope fencing、意图回执查询、权限恢复与重连退避均已存在。剩余问题在状态进入浏览器后的处理，而不是是否使用 SSE。

| 编号 | 发现 | 用户影响与证据 |
| --- | --- | --- |
| F1 | **运行中的过程也一律按需分页和默认折叠** | attyd 只对完成历史懒加载；运行中直接展示 live 过程。Agent UI 的 `view-pager.ts:473–523` 对所有 outcome 都只返回过程数量/版本，`Conversation.tsx:156,165,219,250` 一律折叠。展开后遇过程版本变化需要重新拉页 |
| F2 | **离开 Session 后，外层目录/workspace 仍持有完整过程** | `use-bridge-workspace.ts:187–190` 保存整个 Conversation，`bridge-catalog.ts:24–30,66` 与 `workspace-projection.ts:45–48` 保留旧正文；组件卸载取消 5 分钟计时器。store.close 不足以释放外部引用 |
| F3 | **请求的取消范围不准确** | 任何 View 更新都调用 store.accept，后者无条件 abort 全局 controller；无关控制更新也取消正在展开的正文。反过来，过程 TTL unload 只隔离迟到回写，却不 abort 在途分页下载 |
| F4 | **超时和失败恢复不完整** | 30 秒截止与用户 abort 都变成 workspace_request_interrupted。第一页过程加载失败没有直接 Retry；收起再展开才能重试。完整内容按钮没有加载状态 |
| F5 | **过程还有累计 1024 个续页游标限制** | `bridge-session-store.ts:222–225` 会把未重复的新游标误报为不前进。每页满 10 项时，超过 10250 项可能触发；小于 10 项的页会更早触发。不是单页大小限制 |

F2 的本轮探针：加载 1 MiB 过程后关闭 store，store.conversation 已清空，但 catalog 和已发布 Conversation 仍各能到达 1,048,577 个消息字符。这里可能共享同一对象，**不能说复制了两份正文**；问题是外部引用仍阻止回收。完整 hook 的导航路径由代码审查确认，尚未做真实浏览器导航堆快照。

attyd 专门在离开会话时精简已完成过程缓存：`web/src/lib/state.ts:2691–2695,2923–2956`；其 `docs/lazy-turn-process.md:92–100` 明确防止组件卸载后 TTL 不再执行而后台长期保留正文。

F3 有两组已复现的生产方法结果：

- `store.accept` 接受仅 title 改变、过程身份/版本未变的 View，正在加载过程的 signal 变成 aborted，返回页未应用。实际调用入口是 `bridge-agent-controller.ts:115–117`，全局 abort 在 `bridge-session-store.ts:127–129`。
- 调用 `unloadProcess` 后 signal 没有 aborted，随后仍请求下一片；generation 检查阻止了旧内容回写，但并未阻止下载。对应 `bridge-session-store.ts:244–295` 与 `bridge-process.ts:49–65`。

应按 Session owner、turn、过程/正文版本管理请求；仅在依赖发生变化时取消，释放某一过程时明确 abort 该过程的请求。需要一起检查组件、store、catalog、workspace 的全部引用，不能只清某一个 Map。

F4 的 attyd 对照为 `web/src/lib/business-api.ts:237–286` 与 `components/acp/conversation.tsx:347–390`：保留明确 timeout 类型、错误文案、首/后续页 Retry 和已加载数量。Agent UI 对应代码为 `workspace-api-client.ts:171–197`、`Conversation.tsx:185–193,252–267`。

**四、前端样式与真实数据呈现**

最需要先处理的是语义呈现，并非调色和圆角。用真实 `projectBridgeConversation/replaceBridgeProcess` 产物接入当前 `MessageView` 静态渲染，已得到：

| 数据 | 当前实际呈现 | attyd 呈现 | 判断 |
| --- | --- | --- | --- |
| Plan | 被转换成 thought，标题为 Thinking，条目成为普通 JSON/text | 独立 Plan、完成数量、默认展开、保持折叠选择 | 实质偏移 |
| 带 Input/Output 的 Tool | activity 没有 input/output/detail，卡片显示 No output received；真实正文在卡片外 | Input、content、additional output 在工具卡片内分区显示 | 已复现语义错误 |
| pending/unknown 工具 | 合并成 running | 保留不同状态及取消结果呈现 | 状态展示过度简化 |

入口为 `compact-transcript.ts:307–315,425–433`、`src/lib/bridge-conversation.ts:183–193`、`MessageView.tsx:110–138`、`ToolActivity.tsx:42–85`。当前独立 Plan/Tool 组件测试通过，不能证明生产 Bridge 投影正确接入组件。

最新加载与过程 UI 的对比：

| 体验/样式 | attyd 最新实现 | Agent UI | 处理建议 |
| --- | --- | --- | --- |
| 历史加载骨架 | header、正文、过程槽、输入区使用同一布局；独立错误、Retry、返回 | 已有正文骨架与 aria 状态；外层保留实际 header/composer 并禁用 | 补完整状态布局，验证加载前后位置，而非只确认 skeleton 存在 |
| 过程分页反馈 | 加载图标、超时/失败状态、已加载 x/y、明确 Retry/Load more | 简单文本，首次失败无 Retry；展开后 label 可由总 updates 变成已加载 tool calls | 优先统一总数/已加载数和动作反馈 |
| 跨页过程分组 | 页边界不拆 assistant/thought 语义组，chunk ID 稳定 | 通用 Message 列表逐项呈现，无对应跨页分组模型 | 在过程模型修正后补交互检查 |
| 阅读位置 | 阅读时不强制折叠，回到底部再折叠 | 对应逻辑已经存在 | 保留，使用真实 Bridge 数据补测 |
| 色彩/尺寸 | 明暗主题，中英文；过程槽 46px/9px 圆角；轮次 gap 30px | 英文、固定浅色；过程槽 44px/6px；轮次 gap 36px | 属于产品/品牌差异，不应自动判为缺陷 |
| 触屏与键盘 | 响应式布局及可访问按钮 | 已有 44px 触控、焦点与响应式规则 | 保留并验证，不必逐像素复制 |

样式入口：Agent UI `SessionOpening.tsx:1–20`、`styles.css:511–567,612–669,2129–2156`；attyd `session-opening.tsx:13–64`、`conversation.tsx:287–390`、`styles.css:1285–1316,1913–1933`。

现有 `tests/integration/agent-ui/legacy-directory-benchmark.mjs` 比较的是旧 Antnest SPA 与新 SSR 的目录页，**不构成与 attyd 的视觉一致性证据**。当前也不能把手工构造旧 Message 模型的 live-process 测试等同于真实 Bridge 路径验收。

**建议处理顺序与验收范围**

1. 先定义共享过程契约：保留 Plan/Tool 的结构化语义，明确运行中过程增量与完成历史分页的边界，确定内容请求依赖哪些版本。
2. Agent UI Node 批次：补 B1/B2 的并发/永久错误分流，落实过程契约，优化 M1；分别带服务单元和合同回归。M2/M3 先建立成本门槛，再优化。
3. Agent UI 浏览器批次：闭合 F2/F3 的外层缓存与请求生命周期，接入正确的 live/Plan/Tool 展示，修复首屏失败重试和累计游标限制。B3 的服务端自动重试可后置。
4. 显式集成批次：真实 Bridge 输出驱动组件与浏览器，检查大过程导航释放、并发小增量下展开读取、完成/取消竞争、missing Session、首/后续页超时。桌面与手机覆盖骨架、Plan、Tool、分页状态和布局稳定性。

新行为应先建立失败回归。测试源码分别放服务内与根 `tests/integration`、`tests/e2e`；性能证据同时写明工作负载、测量对象和局限。中英文、深色主题和品牌 token 可作为独立产品选择，不必阻塞以上正确性与内存修复。

附带文档遗留：`architecture.md:99` 仍提到 cached/reserved history bytes，其中 reserved 配额指标已在上一轮删除，应在后续文档批次同步。

**同日后续修复与剩余边界**

上面的 B1/B2/F2 表格保留了首次审查时的失败证据，不能再将这三项描述为当前尚未修复。后续已先写失败回归再改代码：

| 项 | 当前工作树的结果 | 已通过的定向验证 | 尚缺的验收 |
| --- | --- | --- | --- |
| B1 取消迟到 | 上游 cancel 返回后重新读取当前本地/持久回执；终态优先于 cancelling，Run 身份变化时冲突 | `operations.test.ts` 中本地与恢复操作竞争两例及该套件 | 实际 HTTP/容器并发路径 |
| B2 永久缺失 Session | ACP `session_not_found` 保留为独立错误；选定 Session 的 View、SSE、历史、操作、配置路由返回不可重试 404；浏览器退出无效选择 | ACP 适配器、各路由、controller 与 hook 定向测试 | 完整端到端缺失/权限边界回归 |
| F2 离开 Session 的已完成过程 | 导航时从外层 workspace 和目录精简已完成过程；迟到的旧 Session 快照也精简，保留运行中的过程和答案 | 历史合并、导航、目录单元测试及 React hook 导航测试 | 真实浏览器堆快照和 Docker E2E |
| F3 过程请求取消范围 | 每个 turn 的过程页和内容读取有独立取消器；无关 View 更新保留请求，收起时立即停止在途请求并保留五分钟缓存，过程版本变化、历史页替换和关闭 Session 也中断请求 | Store 与 Conversation 定向回归、类型检查 | 真实 HTTP/SSE 并发读取和浏览器回归 |
| F5 累计 1024 过程游标 | 移除与进度无关的累计页数上限；仍校验游标循环、条目重复和广告总数 | 1026 个单条目连续页回归 | 真实大过程 HTTP/浏览器回归 |
| F4 读取超时和重试 | 浏览器普通 JSON 截止时间包含响应体，底层 fetch 忽略 abort 时仍结算；过程首/后续页和完整正文显示加载、超时、失败及 Retry，过程已加载数和总数独立显示 | 超时与停滞响应体单元测试、组件失败/重试测试；完整本地套件及 4 项浏览器、14 项 HTTP/SSE 集成通过 | 真实网络故障下的浏览器交互与 Docker E2E |
| M1 大工具分页重复物化 | Pager 仅保留当前过程项和当前块的序列化结果；分页完成即释放，按实际签名游标与 Base64 长度计算响应预算 | 1 MiB/22 页由 22 次原始输出序列化降至 1 次；完成后的重复读取重新物化；逐页字节上限、精确重组和生产容器大历史回归 | 专门的容器分配/RSS 对照与并发修改负载 |
| M3 SSE 重复编码 | 每个事件的 JSON 与 UTF-8 字节数只计算一次；弱引用缓存供 journal 留存、订阅队列和 HTTP 发送复用 | 1/4/8 观察者成本回归、真实 SSE 路由帧、14 项 HTTP/SSE 集成及生产容器慢端回归 | 专门的编码分配对照 |

M1 缓存只保存当前过程项及其当前序列化块；如果浏览器中途停止读取，它会保留到下一次过程项读取或 Pager 被替换/回收。已避免逐页重复计算，尚不能据此声称中断读取后立即释放临时大块。M3 的编码缓存使用 `WeakMap`，事件不再被 journal、队列或发送路径持有时可随事件回收；容器内存回归不是单独的编码分配基准。

当前代码的 `npm test`、类型检查、16 项契约、4 项浏览器、14 项 HTTP/SSE 集成及生产容器 E2E 已通过；Docker 测试没有留下容器。**仍没有覆盖所有新增情景的真实浏览器故障交互回归**。因此完整对齐仍未完成。B3、M2、F1、Plan/Tool 真实投影、最新骨架及分页交互仍按上文排序推进。更早的 457 项本地和 3 项 Docker E2E 只覆盖后续修改之前的冻结代码。

**同日第二批：Plan/Tool 真实投影与当前四维结论**

再次在线核对 attyd `main` 仍为 `754ac145ab6d8a3437655e778f7a06fb04aa7239`。上文首次探针和“剩余边界”是修复前的历史记录；以下是本批之后的当前判断：

| 维度 | 当前已对齐的行为 | 仍未对齐或缺少证据的部分 |
| --- | --- | --- |
| 后端行为模式 | Node Bridge 独立持有执行，浏览器以 HTTP 提交意图、以 SSE 观察；冷历史原子切换、工作保活、普通请求期限、取消迟到及永久 404 分流均有回归 | B3：历史恢复失败后的重试仍由浏览器再次选中触发，服务端不拥有跨退避的 history workflow；F1 所需运行中过程推送契约尚未建立 |
| 后端内存优化 | delivery 水位释放和慢端 reset；M1 大工具跨页复用当前序列化块；M3 单事件编码复用；完成历史按需分页与离开 Session 后精简已加载过程 | M2：小更新仍可能重建/克隆稳定大窗口，缺少 attyd E04 式成本门槛；M1 中途放弃读取时当前大块要等下一次读取或 Pager 释放；尚无同负载 RSS/分配对照 |
| 前后端交互 | HTTP 快照接 SSE、游标衔接、独立过程请求取消、首/后续页和完整正文 Retry；真实 HTTP 工具页带 `toolSections`，浏览器能够把跨页工具正文留在卡片内 | F1：运行中的过程仍走完成历史的折叠/按需分页路径；B3 失败重试仍由浏览器驱动；并发小更新+大正文读取、真实故障网络及导航堆快照还没有浏览器验收 |
| 前端呈现与样式 | 标准 Plan 从 SDK 条目 JSON 恢复为独立进度卡；Tool 的 Input、Output、Details、附件与 pending/running/completed/failed/unknown 状态在工具卡片内呈现；Chromium 真实页面已验证展开、完整正文和下一页 | attyd `754ac14` 的完整页面骨架、稳定过程展示身份、跨页分组与阅读位置尚未逐项完成；没有两项目并排截图/视觉或实际读屏器验收。颜色、语言和尺寸的产品差异不按功能缺陷处理 |

本批先扩充共享 `processItem` 契约，再改 Node 物化/分页，最后改浏览器 DTO、投影和组件。Tool 的 `toolSections` 明确 synthetic Input/Output 和附加正文的位置；schema 要求工具有该字段，非工具不得携带。标准 Plan 仍以首个文本块的 SDK 条目数组为来源，内容续页完成后重新投影。真实浏览器交互测试随新卡片结构更新为先展开工具，再检查内容，避免把卡片外文本误当作验收。

当前工作树验证：205 项服务端、151 项浏览器逻辑、97 项组件测试通过；17 项契约、14 项 HTTP/SSE 集成、4 项 Chromium 集成、1 项生产容器 E2E 及类型检查通过；`git diff --check` 通过，容器无残留。测试证明本批输出语义和常规链路，不证明 M2 成本、F1 live 过程或视觉像素一致性。下一批应先定义 live 过程的共享契约并做 F1；之后分别处理 B3/M2 和页面骨架/过程阅读体验，最后做显式跨层集成和视觉验收。

**同日第三批：运行中过程的显示与读取**

沿用既有 `outcome`、`processVersion`、`processCount` 和带签名的分页游标，不扩大每次 View/SSE 的正文。契约文档现明确：运行中的过程默认展开并自动连续读取过程页，版本变化后重取；用户主动收起会停止请求，重新展开从当前 View 恢复；完成历史仍按需加载。浏览器投影把 `processVersion` 带到轮次，组件以版本、数量和已加载条目识别下一次 live 读取，避免无关重渲染重复发请求。运行转完成时，读者离开底部则保持展开，在底部可以折叠。

组件回归验证了无点击启动、自动第二页、相同数量下的版本更新、收起/重开，以及完成时的阅读位置。真实 Chromium 测试新增第二个运行中轮次，验证 SSE View 后自动读取两页过程和终态回复。修改后 205 项服务端、151 项浏览器逻辑、98 项组件、4 项 Chromium 和生产容器 E2E 通过，类型检查通过；生产容器无残留。

这解决了 F1 的**默认折叠与手动逐页读取**偏差，但尚未达到 attyd 将运行中完整过程直接纳入权威实时投影的传输模式。目前每次过程版本变化可能重新从第一页读取；对很多历史过程项、频繁工具更新的负载，网络和服务端物化成本需要专项测量并优化。内容块仍遵守独立字节分页，大块正文按需读取。不能把本批称为 F1 的全部完成，也不能据此称 M2 成本已对齐。

**同日第四批：稳定轮次预览的跨水位复用**

确认生产 Owner 在输出水位变化时会重新创建 Pager，因此仅在单个 Pager 中复用预览不会覆盖正常过程更新。现在 `CompactTranscript` 对提问、回答以及中间回复转移维护每轮正文修订；Owner 仅在同一 transcript、epoch、incarnation 和签名密钥下，把最多 20 轮的预览缓存传给新水位 Pager。过程状态更新复用未变的公开提问/回答数组；新增回答和转移中间回复重新物化正文。每个 Pager 根据自己的水位重新签发内容游标，不复用旧签名。不同 inline 预算也会重新物化。

定向测试先复现原有重复克隆，再验证同 Pager 和跨水位 Pager 的正文引用复用、新答案更新、工具开始时中间回复转移、旧水位游标拒绝及不同预算的重新物化。最终 207 项服务端、151 项浏览器逻辑、99 项组件、14 项 HTTP/SSE 集成、4 项 Chromium、1 项生产容器 E2E、类型检查和 `git diff --check` 通过；容器无残留。

这使 M2 的**稳定预览重复克隆**部分得到实质优化，并让 SSE diff 对共享的正文数组可直接跳过。仍缺 attyd E04 同类的同步分配字节门槛，以及高频 live 过程重取、完整 View 构建和容器 RSS 的负载对照；不能把本批测试等同于完整 M2 性能验收。

**同日第五批：冷 Session 恢复的服务端退避所有权**

attyd `0857250` 保护的主要是 fork/resume 后可选历史同步流程；Agent UI 没有同构的 fork/resume 入口。这里按已有 Session 选择的实际语义实现同一生命周期原则：`authorizeSession` 对每个 Session 保留一个服务端工作流，并发读取共享其结果；一次工作流最多四次 ACP load，退避为 0.5/1/2 秒，RPC 排队许可在退避期间释放，Session pin 与 Owner 工作 lease 保持到整个流程终结。`session_not_found`、访问撤销、能力错误、容量拒绝等永久/本地错误不重试；Owner 退休会取消退避，旧流程不能再发 load。全部尝试失败后释放资源并向当前请求返回错误，后续新的读取才可开启新的流程。

定向测试覆盖并发合流、退避期间无观察者 sweep、永久缺失、退休取消和重试耗尽释放。真实 Node HTTP 测试确认一次 Session 选择在首次 ACP load 暂时失败后返回 `ready`，无需浏览器第二次选择。最终 210 项服务端、151 项浏览器逻辑、99 项组件、17 项契约、15 项 HTTP/SSE、4 项 Chromium、1 项生产容器 E2E 及类型检查通过；`git diff --check` 通过且容器无残留。

这消除了 B3 原先“每次临时失败都只能由浏览器重新选中”的情况。它是**有界恢复**，不能把重试耗尽后的再次读取或 attyd 可选 fork/resume 的缓存 fallback 说成已经实现；两者的业务入口和终态契约不同。后续仍需高频 live 过程的传输成本、M2 分配门槛以及最新页面骨架/过程阅读体验的验收。

**同日第六批：过程分页状态区**

对照 attyd `754ac14` 的过程页脚，Agent UI 已将加载图标、超时/失败提示、已加载数量和继续/重试操作集中于同一状态区。读取时容器标记 `aria-busy`，此前已载入的条目保持可见；移动和键盘布局使用可换行状态文字与明确焦点样式。原有首/后续页重试及内容保留逻辑不变。

组件测试先复现缺少忙碌语义，再覆盖读取期间保留首项；Chromium 增加 1/2、2/2 的真实分页计数断言。最终 100 项组件测试、类型检查、4 项 Chromium 和生产容器 E2E 通过，容器无残留。该批解决分页反馈偏差，仍不证明整体加载骨架、跨页语义分组或两项目视觉一致性。

**同日第七批：高频 live 过程增量与成本边界**

先用生产 `BridgeSessionStore` 与分页客户端做 40 项、每页 10 项的可重复调用探针：初次展示读取 4 页；随后 8 次仅更新同一个过程项，旧路径又读取 32 页，响应合计约 36.5 KiB。这个数字是 Mock HTTP 返回值的序列化体积，不是实际网络吞吐、分配量或 RSS。

共享契约现允许运行中轮次带 `liveProcessDelta`：至多 10 个当前过程项，稳定索引，以及可覆盖的最旧 `processVersion`。Node transcript 当时保留最近 10 次过程变更，将这些索引计入 retained-bytes 估算，并在轮次终态释放；Pager 从这些索引取当前值，按 View 页预算限制公开增量，完成轮次不发布。浏览器仅在同一 epoch/incarnation、已持有完整过程、先前版本位于覆盖窗口、已有索引身份一致、新索引连续补齐总数时原位更新；其他情况按版本重新分页。收起并释放的过程不会由 SSE 增量复活。工具正文仍受独立内容游标限制。

测试先复现浏览器缓存失效、服务端缺少增量与变更索引未计入内存估算，再验证短窗口、索引更新/追加、过期回退、终态释放和完成后不发布。40 项/8 次更新的 Store 回归现为初读 4 页、后续 0 页；Chromium 实际从两页过程进入 SSE 更新后显示新内容，过程页请求数保持不变。最终 213 项服务端、153 项浏览器逻辑（其中 152 项全套与新增成本定向回归）、100 项组件、18 项契约、15 项 HTTP/SSE、4 项 Chromium、1 项生产容器 E2E 与类型检查通过；`git diff --check` 通过。Docker 本轮没有留下新容器，机器上另有三日前已退出的旧开发容器。

这消除了连续、已完整读取的 live 过程因每个版本变化而重读全部页的问题，但初次读取、变更窗口缺口、超出公开字节预算及收起后的重新展开仍需要分页。尚缺同负载的浏览器网络/Node 分配与 RSS 定量对照、M2 整体 View 分配门槛、完整加载骨架、跨页语义分组及并排视觉/读屏器验收。因此这批是 F1 高频更新成本的功能修复，不宣称全面达到 attyd 的内存与体验水平。

**同日第八批：对照 attyd E04 排除无关大工具重复物化**

attyd `2d1ed94` 的 E04 在真实 registry fold 上，用 8 KiB、256 KiB、1 MiB 无关正文和 8 次小工具/消息更新测量同步 allocator 请求字节；大样本相对 8 KiB 基线至多增加 64 KiB。Agent UI 的结构不同，前批 10 次变更窗口在小工具更新后仍把窗口内的大工具纳入 `liveProcessDelta`；只追加回答时甚至会因过程版本未变而再次发布同一个大工具。两种路径都会重复物化无关的 1 MiB 工具内容，上一批的过程页请求计数并没有发现这项服务端成本。

现在 Node transcript 只记最近一次过程变更，Pager 仅在这次变更仍是最新 transcript 修订时发布相邻版本增量。浏览器连续观察仍能在现有完整缓存上更新一个过程项；跨过过程版本、或过程变更后又有回答/其他 transcript 修订的观察端，按既有契约重新读取分页。Node 的变更索引继续计入 retained-bytes 估算并于终态释放。服务端回归先验证旧代码在上述两种 8 次小更新中重复物化无关 1 MiB 工具，修复后该大内容的 `structuredClone` 次数均为零，且原工具完整内容不丢失。

本批通过 Agent UI 全套服务端/浏览器逻辑/组件测试、18 项契约、15 项真实 HTTP/SSE、4 项 Chromium、1 项生产容器 E2E 和类型检查。这个证据覆盖大正文的重复克隆与正常连续更新；它**不是** attyd E04 的 allocator 请求字节、Node RSS 或同负载跨实现数值对照。下一步仍应建立稳定的 Node 分配/RSS 探针，并检查最新页面骨架、跨页分组及本地可用的视觉/可访问性证据。

**同日第九批：加载骨架、失败恢复与本地视觉对照**

直接查看 attyd `754ac14` 于 2026-09-22 生成的 390px/1280px 浅色加载截图，与当前 Agent UI 浏览器截图对照：两者都保留会话宽度的过程槽与占位正文，宽屏会话内容居中、窄屏无横向溢出；attyd 用整页会话骨架替换标题和输入区，Agent UI 保留工作区侧栏、真实顶栏及禁用的输入区，使已有草稿留在原处。后者是当前工作区交互差异，不能据此宣称像素或整页布局一致。Agent UI 原骨架过程槽仅占约 38% 列宽且高 32px，现在按真实过程槽的整列宽和最小 44px 布局；动画遵守减少动态效果设置。

首次历史读取失败时，旧页面显示空会话和位于外层的错误提示。现在同一加载面板以非忙碌状态显示错误、Retry loading 与 Back to agent；输入区仍禁用且保留草稿，提示文字分别说明正在加载或历史不可用，不再把正常等待误报为连接不可用。桌面与 390px Chromium 回归验证加载前后过程槽的 x/宽度误差不超过 2px；移动端模拟 504 后可重试到完整历史，也可返回 Agent 无 Session 路由。加载/错误两态通过自动可访问性检查；减少动态效果下骨架动画为 `none`。

Agent UI 的截图保存在 Git 和 Docker 上下文均排除的 `artifacts/verification/agent-ui/opening-{desktop,mobile}.png` 与 `opening-error-mobile.png`。对照用 attyd 截图是其本机 `test-results/session-loading.pw.ts-*` 于 2026-09-22 12:54 生成的测试产物；它证明该提交的视觉状态，不是今日重新执行 attyd 浏览器测试。最终 102 项组件、4 项 Chromium、1 项生产容器 E2E 与类型检查通过。实际读屏器、深色主题并排检查、跨页过程语义分组和 Node 分配/RSS 对照仍缺直接证据。

**同日第十批：跨过程页的展示身份与中间回复顺序**

attyd 的过程页是 ACP update 时间线，页边界可能把相邻 reply/thought 切成多个 assistant 容器，所以在 `conversation.tsx` 合并相邻 assistant chunks 并维持稳定身份。Agent UI 的服务端过程项已经按 message/tool ID 聚合，浏览器每个项用稳定 `turn:process:itemId` 作为 React key；同一 thought 不需要再人为合并容器。真实组件回归让前 10 项在第一页、展开第 10 个 thought 后加载第 11 项，确认展开节点保持同一个 DOM 元素和 `open` 状态。

审查同时发现一处行为偏差：服务端将工具前的中间 Agent 回复物化为 `notice`，浏览器投影却给它 `system` 角色，轮次归组把它移到最终答案后，且不出现在过程区。现在这种 `notice` 投影为带明确 presentation 的 assistant 过程消息；非过程系统消息仍是系统消息。组件回归和真实 Chromium 两页读取都确认第 11 项中间回复位于过程区、先于最终答案；浏览器不再将其标成 Antnest 系统消息。

该批通过 153 项浏览器逻辑、103 项组件、18 项契约、4 项 Chromium、1 项生产容器 E2E 与类型检查。它验证了这两类跨页阅读不变量；attyd 对其他 chunk/compaction 类型的时间线合并和实际读屏器行为尚不能用此结果概括，Node allocator/RSS 定量对照也仍待完成。

**同日第十一批：与 attyd E04 对应的 Node 小更新内存探针**

新增可重复执行的 `npm run test:bridge:memory`，走生产 `CompactTranscript.apply` → 新水位 `ViewPager.recentTurns` 路径。在 8 KiB、256 KiB、1 MiB 的不变大工具正文旁，分别做 8 次小工具更新和 8 次小消息追加；保留旧快照并核对其不变，核对新 transcript 仍保有完整大正文。每个大小做三轮，交错样本顺序并取中位数，以减少预热和 GC 顺序影响。采样区间只含更新及新 Pager 构建，不含 fixture 创建、HTTP/SSE 发送或浏览器渲染。

| 小更新类型 | 大工具正文 | V8 采样分配 | GC 后 heapUsed 增量 | GC 后 RSS 增量 |
| --- | ---: | ---: | ---: | ---: |
| 工具 | 8 KiB | 5,232 B | 13,560 B | 135,168 B |
| 工具 | 256 KiB | 5,808 B | 23,328 B | 36,864 B |
| 工具 | 1 MiB | 5,088 B | 14,272 B | 94,208 B |
| 消息 | 8 KiB | 7,600 B | 12,456 B | 12,288 B |
| 消息 | 256 KiB | 6,728 B | 13,840 B | 20,480 B |
| 消息 | 1 MiB | 7,168 B | 14,712 B | 0 B |

表格是最终一次运行的三轮中位数；完整探针在调整交错顺序后另重复运行两次，均通过。门槛为每种更新的 256 KiB/1 MiB 样本相对 8 KiB 基线：采样分配增加不超过 128 KiB，GC 后留存 heap 增加不超过 256 KiB。RSS 只报告、不设门槛，因为进程页分配和回收噪声很大。负控在同一测量区间把 1 MiB 正文重复序列化八次，采样到 16,781,896 B 分配和 12,615,680 B RSS 增量，证明探针能识别按正文大小重复工作的回归。最终原始输出位于 Git/Docker 上下文排除的 `artifacts/verification/agent-ui/memory-efficiency-node26.log`。

attyd E04 使用 Rust `System` allocator 对 registry fold 精确计数，阈值为大正文相对 8 KiB 基线增加 64 KiB；这里是 V8 heap sampling 的估计量，路径还包含 Agent UI 的 transcript 和 Pager，数值及门槛不能直接横比。当前可以确认 **M2 所涉同步 transcript→Pager 小更新没有随无关工具正文线性分配**。完整 HTTP View/SSE 物化、并发观察者、生产容器持续 RSS 和浏览器堆占用仍需各自负载证据；这一测试不代表全链路或跨语言同负载内存已对齐。

**当前四维判断（以上十一批之后）**

| 维度 | 已验证的共同原则/行为 | 当前限制 |
| --- | --- | --- |
| 后端行为 | 服务端独立持有工作；HTTP 意图、SSE 观察；冷恢复原子提交、有界服务端重试；断线不打断已接受的工作；永久缺失与临时失败分流 | attyd 的 fork/resume 和本地资源所有权不是 Agent UI 的业务入口，不能按文件一比一移植 |
| 后端内存 | delivery 水位释放、慢端 reset、单事件 SSE 编码复用、当前工具页块复用、稳定预览跨水位复用；小更新旁有 1 MiB 无关正文时的 V8 采样分配没有线性增长；闲置分页块按 sweep 释放 | Runtime View/SSE 四观察者探针和短时生产容器内存样本见第十三、十四批；持续生产 RSS、实际中断读取后的容器回落仍缺专项验收 |
| 前后端交互 | 快照到 SSE 的游标衔接；运行中过程自动读取及连续更新的增量合并；独立取消与失败重试；完成历史懒加载；切换 Session 时真实浏览器中断在途工具正文请求，六轮 1 MiB 正文导航有 CDP 堆采样 | 初读、增量窗口缺口或收起重开仍需分页；其他真实网络故障及更长时间/生产环境的导航堆占用仍待验收 |
| 前端呈现 | Plan/Tool 真实投影、加载/失败状态、过程分页反馈、跨页稳定展示身份及中间回复顺序已有组件和 Chromium 证据 | 品牌布局有意不同；深色主题并排视觉、实际读屏器及其他 chunk/compaction 类型的跨页阅读尚无完整验收 |

因此架构方向与 attyd 一致，已经修复审查中复现的主要语义和体验偏差；仍不能宣称行为、内存或视觉的全面等价。上文早期表格记录发现当时的状态，后续各批和此表为当前状态。

**同日第十二批：多观察者共享完整 SSE 帧**

复查 M3 时发现前批只复用了事件 JSON：`event-routes` 仍为每个 HTTP 观察者重新拼接 `id/event/data` 并执行 `TextEncoder.encode`。先加四观察者回归，旧实现确实返回四个独立的 UTF-8 帧。现在 journal 的弱引用事件缓存首次发送时生成完整 SSE 帧，后续观察者直接复用同一 `Uint8Array`；生成帧后释放缓存中的 JSON 字符串，避免长期同时保留字符串和字节副本。事件仍按原有 JSON 字节预算入队/留存，慢端超限会 reset；帧头开销与 JS 对象自身不计入该逻辑预算。

定向测试验证四个 HTTP 观察者收到同一帧实例、帧内容与事件游标正确，原有单次 JSON 编码和慢端队列测试也通过。全套服务端 216 项、浏览器逻辑 153 项、组件 103 项、契约 18 项、真实 HTTP/SSE 15 项、Chromium 4 项、生产容器 E2E 1 项和类型检查通过。首次在沙箱内跑全量服务端时，7 项需要回环监听的测试因 `127.0.0.1` 的 `EPERM` 失败；在允许本机监听的环境用相同命令重跑后 216 项全通过。E2E 未留下新容器，只有三日前退出的旧开发容器。

这进一步贴近 attyd 的共享编码交付原则，但没有完成前表所列完整 HTTP View/SSE 分配、长期 RSS 和浏览器堆占用测量。`Uint8Array` 由服务端内部只读地交给 HTTP 写出路径；若未来允许其他调用方修改该返回数组，需要重新评估共享边界。

**同日第十三批：Runtime View/SSE 路径的同负载分配探针**

新增根目录集成测试 `tests/integration/agent-ui/workspace-runtime-memory.test.mjs`，使用生产 `createWorkspaceRuntime.handle`、真实 Agent View 与 SSE 路由和四个同步观察者。Session 先拥有 8 KiB/256 KiB/1 MiB 的不变大工具正文，再进行八次小工具更新；每次读取四个 SSE 帧及最新 View。三种大小交错运行三轮并取中位数，测量 V8 采样分配、GC 后 heapUsed、RSS 和实际返回字节。测试同时检查 View 的过程数量、更新完整交付和每个响应不会带出无关的大正文。

| 不变工具正文 | 八次 View 总字节 | 四观察者 SSE 总字节 | V8 采样分配 | GC 后 heapUsed 增量 | GC 后 RSS 增量 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 8 KiB | 11,605 B | 38,528 B | 95,344 B | 120,864 B | 159,744 B |
| 256 KiB | 11,605 B | 38,528 B | 102,072 B | 129,824 B | 57,344 B |
| 1 MiB | 11,605 B | 38,528 B | 101,904 B | 97,784 B | 65,536 B |

这些是最后一次运行的三轮中位数，包含三次独立完整运行均通过。门槛为大正文样本相对 8 KiB 基线的 View/SSE 返回量分别增加不超过 128 KiB、V8 采样分配和 GC 后 heapUsed 分别增加不超过 512 KiB；RSS 只记录不设门槛。同路径负控把 1 MiB 正文额外序列化八次，采样到 16,885,296 B 分配，证明探针能识别正文规模的重复处理。持久私有原始输出为 `artifacts/verification/agent-ui/runtime-memory-node26.log`。

本批比第十一批更进一步，覆盖 Runtime 的路由、Agent 投影/差量、journal、SSE 响应体与 View JSON 响应体；在这一负载下没有发现无关正文导致的线性分配或传输增长。它使用内存中的 `Request/Response`，不经过 Node HTTP socket、TLS/代理或 Docker 镜像，因此**还不能称为生产容器长期 RSS 验收**；V8 sampling 也不等于 attyd 的 Rust allocator 精确字节。浏览器导航后的堆占用、真实网络故障和深色主题/读屏器对照仍按前表保留为待验项。

**同日第十四批：生产容器中的大正文与四观察者短时 RSS**

扩充既有生产镜像 E2E 的官方 ACP HTTP fixture，以独立 `session-memory` 加载 1,048,592 B 的工具正文和一个小工具，随后连接四个真实 Node HTTP/SSE 观察者，连续发送八次小工具更新。每个观察者均达到对应水位；八次 View 合计 11,971 B，四个观察者的 SSE 合计 39,344 B，没有在常规响应中带出不变的 1 MiB 正文。更新结束后经过程页及签名内容游标逐片取回大工具，重组结果与原始正文逐字相同。

测试用 `docker stats --no-stream` 在更新前后各取一次容器内存，门槛为这段固定负载新增小于 64 MiB。两次完整生产 E2E 均通过：首轮约 94.6→90.2 MB；加入精确内容重组断言后复跑约 200.8→196.5 MB。绝对基线波动很大，不能从这两个样本推断常驻 RSS 上限、GC 回收速度或与 attyd 的数值等价；它只排除了此负载下明显的短时累积。最终私有样本保存在 `artifacts/verification/agent-ui/memory-container-small-updates.json`，排除于 Git 和 Docker 上下文。E2E 清理了两次临时容器；机器上只有此前已退出的旧开发容器。

内存维度现有同步 transcript→Pager、Runtime View/SSE 及真实容器 socket 三层互补证据。仍缺长时间、高并发及中断过程分页后的 RSS 曲线；这些项目与浏览器堆和视觉/读屏器验收一起保留为未完成项。

**同日第十五批：中断分页后的序列化缓冲生命周期**

审查 Pager 时发现过程内容缓存保留最近一个已序列化块，浏览器停止翻页后，它原先会一直留到下次过程项读取、水位替换或 Pager 回收；普通回答的 `serializedContent` 在完整分页后也没有主动清理。现在每次内容页读取刷新缓存的最后访问时间；已有 owner sweep 清理闲置超过 30 秒的工具和回答临时缓冲，不创建逐页定时器。完整回答的最后一页立即释放缓冲，与已完成过程分页的释放语义一致。默认 sweep 周期同为 30 秒，因此正常运行下闲置缓存一般会在最后访问后约 30–60 秒清理；修改 sweep 配置会改变这一上界。

定向测试先复现缺少 idle 清理入口，随后验证 29 秒内仍复用两种大块、闲置 31 秒后重新从未变 transcript 物化且旧签名游标可继续；另验证大回答完整读取后再次读取会重新物化。完成后全套服务端 217 项、浏览器逻辑 153 项、组件 103 项、契约 18 项、HTTP/SSE 15 项、Chromium 4 项、生产容器 E2E 1 项、两组内存探针及类型检查通过；容器无新增残留。生产 E2E 仍主要验证正常完成的分页和固定负载内存，本批**没有**用真实浏览器中断读取后直接测量容器 RSS 回落，因此长期 RSS 仍保持未验收。

**同日第十六批：真实浏览器切换 Session 时取消在途工具正文**

在既有 Chromium Session 切换集成场景中，为第一个完成轮次添加工具过程页和可挂起的完整内容响应。浏览器展开过程和工具、触发 `Load full content`，fixture 确认请求已进入服务端但不返回正文；随后通过工作区导航切换到第二个 Session。服务端观察到挂起响应关闭，第二个 Session 正常展示且没有旧工具正文。完整浏览器套件 4 项通过。该证据覆盖应用内导航导致的请求中断和结果隔离，不等于进程堆或容器 RSS 回落测量，也不覆盖断网后重试的所有交互状态。

**同日第十七批：重复加载大工具后的浏览器堆采样**

沿用同一真实 Chromium 工作区导航与工具卡，六次加载约 1 MiB 的完整工具正文，然后切换到另一 Session；每次确认正文先进入 DOM、离开后旧正文消失。用 CDP `HeapProfiler.collectGarbage` 后的 `Runtime.getHeapUsage.usedSize` 采样，分别记录内容已加载和离开 Session 两态。最初试用 `performance.memory.usedJSHeapSize` 时六次均返回完全相同的 15,200,000 B，粒度不足，已从门槛中删除，不能作为内存结论。

最终一次 CDP 样本：初始 10,116,864 B；六次加载中为 14.0–14.8 MB，离开后从 13,026,488 B 至 13,758,720 B。每一轮已加载态都比对应离开态高超过 512 KiB，证明计量能看到大正文；六轮离开态净增长 732,232 B，低于 2 MiB 门槛，而不是每轮累计约 1 MiB。收紧后的完整 Chromium 套件连续两次通过，原始私有样本在 `artifacts/verification/agent-ui/browser-navigation-heap.json`。第一次精确 CDP 探针也通过，但尚未包含最终较严的断言。

这为浏览器层提供了短序列、真实 DOM/导航/GC 后的直接证据；它运行在本地 Vite fixture，且 CDP JS heap 不覆盖浏览器原生 DOM、GPU 内存或生产容器 RSS。不能据此宣称无限次导航的固定内存上限，其他真实网络故障、深色主题视觉和实际读屏器仍未验收。

**同日第十八批：重新核对最新上游与功能/品牌边界**

再次在线核对 attyd `main` 仍是 `754ac145ab6d8a3437655e778f7a06fb04aa7239`。直接检查该提交与 `2d1ed94` 的变更、两端现行源码及 Agent UI 安装的 ACP SDK 类型。以下表格是**当前工作树**的四维判断，取代上文历史阶段表格中的“仍缺”状态。

| 维度 | attyd 最新做法 | Agent UI 当前状态 | 判断及剩余证据 |
| --- | --- | --- | --- |
| 后端行为 | Bridge 是执行和历史工作流 owner；浏览器以 HTTP 发意图、SSE 观察；连接/观察者、请求期限与旧回写分开管理 | Node owner/operation 持有工作，选择 Session 时在服务端有界退避；断开 SSE 只释放观察；普通 HTTP 60 秒截止、永久 404 与暂时失败分流、取消迟到保护均已有回归 | 核心行为原则已对齐。Antnest durable intent/appendVersion 和多租户 owner 上限是平台领域差异；attyd fork/resume 的本地资源所有权不应机械移植。真实网络故障下的浏览器恢复仍缺直接验收 |
| 后端内存 | delivery 水位释放、状态槽覆盖、稳定实体共享、过程正文懒加载；`2d1ed94` 加入 allocator 分配门槛和 HTTP deadline | 已有 delivery 释放、SSE 完整帧共享、Pager 块缓存/闲置清理、过程分页、稳定预览跨水位复用、live 增量；1 MiB 无关正文旁的小更新通过 Node V8、Runtime View/SSE 和短时生产容器探针 | 功能与增长方向基本对齐。Node V8 sampling 不能与 Rust allocator 绝对数值横比；长期生产 RSS、高并发和中断分页后的容器回落未验收 |
| 前后端交互 | `754ac14` 以完整会话骨架、过程页状态和跨页 assistant 分组稳定加载与阅读；请求超时/失败可恢复 | 快照接 SSE、自动读取 live 过程并合并连续增量；独立取消/Retry、骨架和跨页稳定项身份已有组件/Chromium 证据；六轮 1 MiB 正文导航的 CDP GC 后堆净增约 0.73 MiB | 工作流目标已覆盖，但两端数据模型不同：attyd 合并原始 ACP chunk，Agent UI 在服务端按 message/tool ID 聚合过程项。长时间真实网络中断与实际读屏器未验收 |
| 前端样式 | 系统/浅色/深色主题、英文/中文；最新过程页脚、全页骨架、46px 过程槽 | Antnest 固定浅色、英文，工作区侧栏和保留草稿的输入区；页脚/骨架/移动宽度/减少动态效果已有本地验证 | 品牌、整页结构、主题和语言本来不同，不能声称像素一致，也不宜仅为模仿 attyd 加深色主题。实际发现三项 CSS token 与 Antnest 自身 canonical 规范不一致，见下文 |

ACP 时间线类型要按**能力协商和当前生产者**判断。attyd `web/src/lib/state.ts` 处理 ID 定位的 `plan_update`/`plan_removed` 和 `compaction_update`/`compaction_summary_chunk`，而 Agent UI 的 `CompactTranscript.applyUpdate` 目前仅处理标准 `plan`。这不是当前 Antnest v1 路径的已证实丢失：Node ACP 初始化发送 `clientCapabilities: {}`，未宣告实验性 `plan` 或 `session.compaction`；已安装 SDK 的 `ClientCapabilities`/`ClientSessionCapabilities` 注释规定遗漏即不支持，compaction 生产者只能在宣告后发送；Antnest ACP v1 初始化也没有宣告对应的 Agent 能力，v1 更新映射只发标准 `plan`。因此上文“其他 chunk/compaction 类型未完整验收”应细分为：当前标准消息/Thought/Tool/Plan 已有覆盖；实验性 plan/compaction **未协商、未启用，不列为现有功能回归**。若将来开放通用 ACP 生产者或显式宣告能力，应先扩展共享契约、Node 投影和浏览器展示，再建立对应测试。

样式方面，[Antnest 设计规范](../../../docs/design-language.md) 明确标为 canonical visual contract，规定浅色导航、暖中性底色和 lime 信号，并说明参考 attyd 而非复制页面。因此 attyd 深色主题与完整会话页骨架属于可选择的产品差异，不能作为当前对齐失败。具体到最新过程区，attyd 的轮次间距 30px、过程槽最小高 46px/圆角 9px；Agent UI 分别为 36px、44px/6px，保持 Antnest 较紧凑的卡片圆角；两端的加载、失败、已加载数量与继续/重试操作都集中在同一页脚。Agent UI `web/src/styles.css:14–16` 的 `--paper: #fcfcfd`、`--sidebar: #f2f3f5`、`--line: #e4e5e8`，却分别偏离规范的 `#fbfbfa`、`#efefec`、`#deded9`；这三项是**本仓库内部视觉契约偏差**，应在独立的 Agent UI 样式批次中调整并做桌面/手机截图及对比。现有浅色骨架截图和结构检查不能替代完整页面像素或读屏器验收。

按影响排序，后续可先处理视觉 token，再针对真实网络故障与读屏器做交互验收；生产容器长期 RSS/中断分页曲线另列性能验收。深色主题及实验性 compaction/plan 不阻塞当前 Antnest v1 工作流。上述判断是截至该上游提交的源码审查，后续 token 修复与验证见下文。

**同日第十九批：基础视觉 token 与可访问性规范校正**

进一步核对 canonical token 后，除了上文所列 paper/sidebar/line，还发现 Agent UI 的 `muted` 和 `signal-strong` 数值不同。先在真实 Chromium 页面加入五个 computed-style 断言，旧页面按预期失败。将五项直接设为文档值后，自动 WCAG A/AA 检查指出文档的 `Muted #777772` 在 Canvas `#f7f7f5` 上用于 12–13px 正文字体时仅有 4.19:1，对比度不足 4.5:1。因此保留 Agent UI 原有可读的 `#62625d`，并把 canonical 规范改为该值；paper/sidebar/line/signal-strong 按原规范对齐。此批未更改 attyd 风格的产品边界，只修正 Antnest 视觉契约与可访问性冲突。

定向 Chromium 用例与完整 Bridge 浏览器回归均通过。随后执行 `npm run test:browser`，生产 client/SSR 构建、类型检查及四项 Chromium 集成全部通过；桌面和 390px 手机加载态截图已重新生成于忽略目录 `artifacts/verification/agent-ui/`，人工检查未见过程槽错位或横向溢出。该批没有修改服务端行为，也未重新运行 Docker E2E。当前剩余项是长期生产 RSS、真实网络故障和实际读屏器环境验收。

**同日第二十批：真实浏览器中的读取中断与恢复**

在既有 Chromium + 本地 HTTP Bridge 集成场景中，分别让过程第二页、工具完整正文的 HTTP 响应在 `200` 和部分 JSON body 写出后断开连接。这比只返回 500/504 更接近传输中断：浏览器必须处理响应体读取失败，而不是仅按状态码分流。两次失败后均检查错误提示、Retry 按钮与此前已加载的过程/工具预览仍在；点击 Retry 后同一页和正文均完整到达，第二页仍按原顺序置于最终答案之前。测试断言两种资源各被实际请求两次，避免把缓存或本地重渲染误作重试成功。

定向测试及完整 `npm run test:browser` 均通过；后者包含生产 client/SSR 构建、类型检查和四项 Chromium 集成。本批只增补浏览器集成测试，没有更改生产逻辑或运行 Docker。它验证了**已有会话的过程页及工具正文在单次传输中断后的人工恢复**；尚未覆盖长时间全局离线、SSE 重连期间写入、连续多次失败、真实代理超时或实际读屏器。长期生产 RSS/中断分页后的容器回落仍未验收。

**同日第二十一批：SSE 断线期间遗漏状态的权威恢复**

既有 Chromium 用例已验证 SSE 连接断开、503 窗口与自动重连，但只观察断线前保存的内容。本批在浏览器无观察连接、事件路由仍暂时返回 503 时，修改服务端会话标题并发布一次 View 更新；确认此刻 `clients.size === 0`。恢复事件路由后，浏览器重连并显示新标题；测试同时要求重新读取 Agent View 的次数增加，证明不是由旧 SSE 连接、缓存或 DOM 自行更新。随后恢复原标题并通过实时事件确认连续投影继续生效，未提交任何 Prompt。

定向 Chromium 和完整 `npm run test:browser` 均通过；后者包含生产构建、类型检查及四项 Chromium 集成。该证据说明**单次 SSE 断连造成的会话状态遗漏可由重新读取权威 View 修复**。它不是“执行期间断线不打断工作”的完整验收：该情景还需在真实运行中的 Prompt/operation、断线期间完成、恢复后不重复提交的端到端路径上验证。长时间离线、持续生产 RSS 和实际读屏器仍未完成。

**同日第二十二批：执行期间 SSE 断线、完成后恢复及同 Session 过程保留**

把浏览器集成场景扩展到两个已连接页面：第一个 Prompt 获得 HTTP `202` 后，fixture 立即关闭两条 SSE 观察连接并暂时让事件路由返回 503；Agent operation 在无观察者期间结束并发布最终 View。测试确认完成时确实无 SSE 观察者，恢复连接后两个页面都显示最终答案、会话标题和更新时间，Prompt 总提交数仍为一。原实现虽恢复了答案，却丢失已展开的完整工具正文，旧断言确定性失败。根因是 `BridgeAgentController.select()` 在每次自动重连时关闭并重建同一个 Session 的 `BridgeSessionStore`，清除了按需读取的过程页/正文缓存。

现在控制器对同一 Session 的重连保留 Store，但先 `suspendReads()` 中止旧读取；新的权威 View 到达后，Store 仅在 Bridge epoch/incarnation 和过程版本相符时复用已加载内容。切换 Session、撤销身份和关闭控制器仍释放 Store。Store 的变更回调改按对象身份校验，避免重连后新读取被旧 selection 闭包静默丢弃。新增单元测试覆盖旧正文请求在暂停后即使迟到也不能覆盖已加载过程，以及同 owner 的后续重试可以完成正文。对照 attyd 同 Session 刷新保留时间线的原则，修复了断线恢复时阅读状态回退。

验收：浏览器逻辑单元 154 项、组件 103 项、契约 18 项、真实 Node HTTP/SSE 15 项、Chromium 4 项、生产 client/SSR 构建及类型检查全部通过。生产容器 E2E 的第一次运行在原有 SSE 内存门槛失败，后续诊断与结果见下一批。

**同日第二十三批：区分 Node 临时分配与实际留存的生产容器验收**

生产 E2E 固定负载为 512 次各约 8 KiB 的 ACP 更新、一个正常和一个慢 SSE 观察者；慢端应收到最新水位且发生可替换 reset。原门槛要求断开后 10 秒的容器 RSS 相对负载前低于 64 MiB，连续两次失败，样本分别约 105→221 MiB、214→327 MiB；10 秒等待没有触发 V8 回收。临时 Inspector 诊断第三次失败样本中，断开后容器约 220 MiB；进程在显式 GC 前 `heapUsed` 约 110 MiB、`arrayBuffers` 约 32 MiB，GC 后分别约 44 MiB 和 0.65 MiB，进程 RSS 从约 280 MiB 降至 124 MiB。这个证据表明该固定负载的主要增量是 V8 尚未回收的临时分配，不能把被动 RSS 平台期直接等同于服务仍引用这些数据。

E2E 现同时保留固定负载峰值小于 384 MiB 的门槛，并在断开 10 秒后记录被动容器内存，再通过仅在测试容器内部启用的 Node Inspector 触发 GC，要求**GC 后容器内存**相对负载前增加少于 64 MiB。这样仍检出真正可达的留存或高峰失控，也不要求生产 Node 在无内存压力的空闲 10 秒内主动归还已分配堆。更新后完整生产容器 E2E 通过，且测试清理临时容器；它不证明长时间、高并发、反复连接断开下 RSS 一定稳定，也不把 Node 与 attyd Rust allocator 的绝对值直接比较。实际读屏器环境验收仍缺。

**同日第二十四批：持续慢端负载与容器重复连接**

执行现有 `npm run test:bridge:soak`，它先在真实 Node HTTP/SSE 上持续 36 轮、约 193 秒，发布 18,036 个事件，含三个不同读取速率的慢观察者和一个正常观察者；再运行两条独立身份/Session 流 12 轮、约 72 秒，每条流各发布 6,012 个事件。两段均通过。第一段每轮 journal 排队峰值约 66.9 KiB、保留后缀约 251 KiB；断开后 subscriber/queued bytes 为零，GC 后 heapUsed 23,038,096 B，低于基线 23,851,176 B。第二段断开后 GC heapUsed 23,621,088 B，相对基线 22,709,616 B 增加约 0.91 MiB。逐轮私有样本在 `artifacts/verification/agent-ui-sustained-sse/metrics-soak.json` 和 `metrics-scoped-soak.json`；这些是本机 Node HTTP 进程测量，不是生产容器。

生产容器 E2E 另增加 24 次实际 SSE 连接、读取首帧、取消读取与断开。循环前后都在测试容器内通过 Inspector 显式 GC，再使用相同的 `docker stats` 容器指标比较；本次从 63,721,964 B 至 64,204,308 B，增量 482,344 B，低于 32 MiB 门槛。完整 E2E 通过，临时容器全部清理；私有原始值存于 `artifacts/verification/agent-ui/observer-churn-container.json`。这补充了短时间重复 attach/detach 的容器级留存证据。长期生产 RSS 的真实工作负载曲线、实际代理/网络环境和读屏器仍未直接验收，不能用 24 次循环或本机 soak 推断无限期内存上限。

**同日第二十五批：生产镜像 180 次观察连接长时循环**

在线重查 attyd `main` 仍为 `754ac145ab6d8a3437655e778f7a06fb04aa7239`。将上一批生产容器的 24 次快速 attach/detach 扩展成可选 `npm run test:bridge:docker:soak`：同一生产镜像和官方 ACP fixture，先完成慢端背压/512 次真实更新，再以每次约 1 秒的节奏连接、读取首个 SSE 帧并断开 180 次；每 30 次记录被动容器内存，触发测试容器内部 GC，记录 GC 后容器内存与进程 heapUsed。每次被动容器内存须低于 384 MiB，GC 后相对循环前须增加少于 32 MiB。日常 Docker E2E 仍维持 24 次循环，避免把每次本地门禁延长到数分钟。

首次完整可选 soak 约 391 秒通过，六个采样点的被动容器内存为约 75–86 MiB，GC 后为约 63–77 MiB，均低于门槛；GC 后 heapUsed 从第 30 次的 43,431,576 B 到第 180 次的 44,387,088 B，增长约 0.96 MiB。循环前/最后的 GC 后容器内存从 62,128,128 B 到 76,724,306 B，增加约 14.6 MiB。原始样本位于 `artifacts/verification/agent-ui/observer-churn-container-soak.json`，测试清理了临时容器。这个本机生产镜像负载没有显示大正文或观察者按循环次数线性累积的迹象；小幅堆增长仍需更长时间及真实流量判断。非本机部署、代理网络和实际读屏器仍未验收，不能据此宣称 attyd 的所有产品/运行环境行为完全等价。

**同日第二十六批：加载完成页面的视觉对照与分页按钮修复**

此前只保存了 attyd 开场骨架截图，无法支持对完整会话样式的判断。这次在隔离的临时 clone 中运行 attyd 自身 Playwright 会话和手机过程页场景，取得加载完成后的桌面/手机会话、手机过程 ready/timeout 四张浅色截图；两项上游测试均通过。临时 clone 已删除，未修改原始 attyd 仓库。对应的 Agent UI Chromium 集成场景也保存了手机完整会话、过程 ready/error 截图。截图均存于 Git 忽略的 `artifacts/verification/agent-ui/`，上游截图位于其中的 `attyd-reference/` 子目录；对照过程没有把截图或测试源码放进 `.cache`。

| 可见区域 | attyd 最新页面 | Agent UI 当前页面 | 判断 |
| --- | --- | --- | --- |
| 会话布局 | 桌面端约 850px 居中会话列，手机端全宽；顶部是会话/操作工具栏 | 持续显示工作区导航，手机端为独立工作区顶栏；会话、草稿和状态在同一页面 | 布局不做像素复制；这是 Antnest 已定义的工作区导航与品牌结构 |
| 阅读/输入 | 完整对话按消息分组，底部固定输入区；历史页可续载 | 过程项接在对应轮次之内，最终答案在其后，手机输入区可持续使用；历史有续载控制 | 核心阅读顺序一致，信息架构按平台模型调整 |
| 过程反馈 | ready 与 timeout 均在同一过程页脚展示计数、状态与继续/重试入口 | ready/error 也在过程卡页脚展示数量、状态和操作；已有加载、取消、重试的浏览器/组件回归 | 行为目标一致；内容 fixture 分别为 attyd 10/25、Agent UI 1/2，截图不能据此比较密度或绝对高度 |
| 视觉语言 | 冷中性色、会话工具栏、较宽松过程卡；支持主题/语言选择 | 暖中性色、lime 信号、持续工作区导航和更紧凑卡片 | 保留 canonical Antnest 设计规范；没有把深色主题/中文选项列为当前 v1 的缺陷 |

截图揭示一处实际偏差：Agent UI `.load-older-turns` 没有专门 CSS，手机会话里呈现原生浏览器按钮，与附近的应用控件不一致。先在真实 Chromium 场景加入最小高度和圆角断言，原实现按预期失败；再补充边框、底色、间距、hover/focus/disabled 等样式，重新查看截图确认与页面控件相符。完整 `npm run test:browser` 通过：生产 client/SSR 构建、类型检查和 4 项 Chromium 集成。手机 process error 画面额外运行了 WCAG A/AA 自动检查。本批只改 CSS 与浏览器证据，不影响 Bridge 业务路径，无需重跑容器 E2E。

上述是不同 fixture 的视觉/交互对照，不是逐像素一致性证明。实际读屏器、非本机代理网络及长期真实流量的生产内存仍待验收；用户已明确暂缓提供这类环境，因此当前不把它们伪装成已完成。

**同日第二十七批：生产容器中途停止过程分页的留存探针**

把此前只在 Pager 单元层验证的闲置缓冲清理，补为真实生产镜像的 HTTP/ACP 负载。官方 ACP fixture 对同一工具连续推送 12 个约 1 MiB 的正文版本；每次客户端只读取第一片内容，确认仍有下一页后停止读取。测试容器将 owner sweep 间隔设为 1 秒，其余逻辑保持生产实现；最后一次读取后等待 34 秒，超过 Pager 的 30 秒闲置期限，再用测试容器内部 Node Inspector 显式 GC，并记录堆与 `docker stats` 容器内存。比较基线位于此前完整读取同规模正文之后，已显式 GC；因此它测的是重复版本和未继续分页产生的额外留存，而非整个历史 Session 的绝对内存。

完整 `npm run test:bridge:docker` 通过，耗时约 193 秒，测试退出后无临时 E2E 容器残留。GC 后 heapUsed 从 37,967,824 B 至 39,803,496 B，增加 1,835,672 B（门槛 16 MiB）；容器内存从 54,106,522 B 至 57,210,307 B，增加 3,103,785 B（门槛 32 MiB）。原始私有证据为 `artifacts/verification/agent-ui/abandoned-process-pages-container.json`，`git diff --check` 通过。本次直接覆盖**一页已返回、用户不再请求后续页**和多次同工具版本更新；它不覆盖响应体传输中途断线、无限时间负载，也不能将显式 GC 后的留存样本解读为生产环境自动 GC/RSS 曲线。单次 HTTP body 中断后的浏览器恢复仍由第二十批 Chromium 测试覆盖。

**同日第二十八批：同过程项连续更新的有界增量合并**

运行中过程已具备 `liveProcessDelta`，普通每次更新不会重新读取过程页；本批找到更窄的退化场景：同一工具迅速更新多次，观察者只拿到较晚的 View 时，生产者原先只公布最后一次 `processVersion` 的增量，浏览器虽已持有完整较旧过程，也必须重新读取所有过程页。服务端新增先失败的定向测试（旧实现返回 `fromVersion: 2`，预期覆盖最早已知版本 `0`），确认缺口真实存在。

`CompactTranscript` 现在最多合并连续八次**同一索引**的过程变更，只保留该索引当前项与最早变更版本；换索引或超过八次即重置窗口。这样最新 View 可以安全覆盖跳过的同工具状态，而不会在小工具连续更新时重新物化较早改动过的大工具。客户端仍只在已加载完整过程、身份/索引匹配且版本位于窗口时应用增量，否则继续走签名分页。共享契约文档已写明这个有界语义。原有大工具旁小更新测试和跨版本浏览器 Store 测试均通过。

验收：服务端 218 项、浏览器逻辑 154 项、组件 103 项、共享契约 18 项、生产 client/SSR 构建和类型检查、Chromium 4 项、生产 Docker E2E 1 项全部通过。首次全套本地测试在未授权 loopback 的沙箱中因 `listen EPERM` 中断；允许本地监听后通过，没有将该环境权限错误当作业务失败。Docker 临时容器已由测试清理。该窗口改善同一过程项的短时跳帧体验；多项交错更新或跳过更久的版本仍重新分页，这是为了维持小更新的内存成本与有界状态。

**同日第二十九批：有界增量的真实 HTTP/SSE 集成验收**

增加一条跨层场景：真实 Node HTTP Bridge 的连接收到已接受的运行中 Run，浏览器先读取一次运行中 View；之后通过 ACP 更新回调连续发布同一工具的 `Started`、`Halfway`、`Done` 三个版本，客户端跳过中间版本。再用真实 HTTP 读取最新 Agent View，验证 `processVersion: 3`、`liveProcessDelta.fromVersion: 0` 和最新 `Done` 内容均符合共享 schema；新 SSE 观察连接取得的快照也带同样的增量。测试不模拟浏览器 DOM，但直接覆盖生产路由、owner/transcript/Pager 和 wire schema，与上一批 Store 单元测试及 Chromium 通用回归形成互补。

定向测试通过；完整 `npm run test:bridge:integration` 的 16 项真实 HTTP/SSE 集成全部通过，包含持续慢端背压场景。本批只加集成测试，没有改生产代码，因此沿用上一批已通过的生产 Docker E2E，不重复构建容器。该证据证明短时同工具更新能跨服务端路由传播；实际浏览器在网络代理丢帧后如何恢复仍受浏览器 Store 的版本/身份条件约束，真实代理环境按此前安排暂缓验收。

**同日第三十批：当前工作树的真实六服务部署回归与结论整理**

在上述代码与测试都稳定后，重新运行现有 `tests/e2e/agent-ui/fullstack-current.test.mjs`，由当前工作树构建 Agent UI、ACP 和 Gateway 镜像，启动隔离的 Gateway、Identity、Agent Controller、ACP、Runtime、Agent UI 栈，并用真实 Chromium 执行 Run 接受、Bridge/Gateway 重启、退出登录、Stop、权限、响应超时、身份自然过期及撤销等完整业务场景。该单项 E2E 约 340 秒通过；它还执行固定浏览器堆、服务内存和首屏响应门槛。测试结束后确认没有残留 `antnest-lifecycle-*` Compose 容器；此轮没有更改生产逻辑。

为使结论可审阅，本文件开头新增当前四维总览，并把第一次 B1–F5 表明确标为历史快照；上游 `main` 在线再查仍为 `754ac145ab6d8a3437655e778f7a06fb04aa7239`。至此，当前本机服务范围的行为、内存、交互与视觉原则都有对应源码及分层验证；非本机代理/长周期真实流量和实际读屏器仍按用户决定暂缓，不能据本机固定负载或自动 WCAG 检查宣称这几项也已验收。

**同日第三十一批：真实栈完整历史与刷新后分页验收**

在当前工作树上运行独立的 `tests/e2e/agent-ui/fullstack-history.test.mjs`，由真实 Gateway/Identity/ACP/Runtime 与 Chromium 连续完成四次 Run，其中一次返回 96 KiB 回答。测试通过签名续页逐字重组全部回答，在浏览器中展开大回答，刷新后再次展开并核对；同时持有一个暂停读取的 SSE 观察者，然后断开并检查生产容器内存。单项 E2E 约 90 秒通过，四个模型阶段各只收到一次请求，无页面异常或 ACP 浏览器 WebSocket；测试退出后无残留隔离 Compose 容器。

私有样本 `artifacts/verification/agent-ui-complete-history/metrics.json` 显示容器从四轮前约 175.0 MB 到保留历史时约 178.9 MB，慢观察者断开后约 102.6 MB，10 秒闲置后约 102.4 MB。该场景验证固定四轮、96 KiB 回答的完整性和刷新恢复；它不是任意长度历史或长期生产 RSS 的上限证明。此前主流程 E2E 已覆盖 40 轮浏览器 DOM 窗口，两者关注点不同。

**同日第三十二批：无回执 Bridge 崩溃窗口的真实栈验收**

在当前工作树上运行独立的 `tests/e2e/agent-ui/fullstack-no-receipt.test.mjs`。它以真实 Gateway/Identity/ACP/Runtime 栈故障注入，分别覆盖 Prompt 尚未转发、已到达 ACP 但持久回执尚未提交时 Bridge 崩溃后的对账，验证恢复后不会重复模型执行。单项约 81 秒通过，测试退出后没有残留 `antnest-lifecycle-*` Compose 容器。至此，本次改动后的生产容器、六服务主流程、完整历史和无回执崩溃窗口四类 Docker E2E 均有通过证据；这些确定场景仍不能推出任意网络/崩溃时序都正确。

**同日第三十三批：过程续页结束时的键盘焦点**

本地无障碍审查发现，键盘激活过程页脚的 `Retry process` 后，最后一页成功加载会移除该按钮，焦点落到页面空白处。先在现有真实 Chromium HTTP/SSE 场景加上 Enter 操作与焦点断言，旧实现稳定失败（活动元素类名为空）。现在只在用户以键盘激活且请求完成时焦点确实落在 `body`、最后一页已加载的条件下，把焦点移回同一轮的 `Hide process` 展开按钮；请求中用户已聚焦别处、出错后重试按钮仍在或尚有下一页时不抢焦点。组件测试覆盖“用户主动移走焦点”的情况。

修复后定向 Chromium、全套 104 项组件、生产 client/SSR 构建与类型检查、4 项 Chromium 集成均通过；当前前端镜像重新运行真实六服务主流程 E2E 约 343 秒通过，隔离容器已清理。生产 E2E 验证构建与业务主链路，具体末页焦点行为由针对性 Chromium HTTP/SSE fixture 断言。此项是可自动验证的键盘路径修复，不等于实际读屏器与全键盘人工验收完成。

**同日第三十四批：大回答续页归属与键盘阅读焦点**

进一步以真实六服务完整历史场景审查阅读体验时，发现原公共 Turn 只提供一个 `contentCursor`，浏览器于是把同一续页同时标在用户 Prompt 和 Agent 回答上。96 KiB 回答的按钮首先落在用户消息；尝试直接把按钮限定为回答后，E2E 揭示另一个独立问题：回答首块过大时，前端构造的空回答占位消息被 `conversationTurns` 排除，导致按钮完全不显示。这是前后端契约和轮次投影的实际偏移，不是颜色或布局差异。

共享 Turn schema 现在要求 `contentSection` 与 `contentCursor` 同为 null 或分别指明 `prompt` / `finalResponse`。服务端 Pager 按下一段实际内容设置该字段；浏览器只给所属消息标记未加载，并在回答续页尚无 inline 正文时保留空回答占位。键盘激活“Load full content”后，按钮消失时焦点回到同一回答容器；用户已移动焦点时不抢焦点。契约、Pager、投影和轮次测试先失败再修正。首轮真实栈回归确定性暴露空占位缺陷，修正后再次运行同一六服务 E2E 通过：四轮完整内容、96 KiB 签名续页、回答按钮归属、焦点及刷新后恢复均成立。服务端 219 项、浏览器逻辑 156 项、组件 105 项、契约 19 项、HTTP/SSE 16 项、生产构建/类型检查和 Chromium 4 项也通过。该场景不能替代实际读屏器验收。

**同日第三十五批：更新契约后的生产 Bridge 容器复验**

在同一修改快照上重跑 `npm run test:bridge:docker`。首次运行于冷认证 SSR 门槛失败，探针记录 Docker 启动至端口解析为 24,345 ms、至完整 HTML 为 24,909 ms；此前样本的端口解析约 0.4–0.6 秒。没有跳过或放宽 5 秒门槛。第二次原样运行通过全部容器场景，端口解析 519 ms、完整 HTML 1,507 ms，包含官方 ACP HTTP、SSE 慢观察者、分页中止和闲置回收。两次测试均清理临时容器。现有测量将首次失败定位于容器端口解析的异常延迟，但不能单凭一次重试确定 Docker 宿主机的具体原因；应保留首次失败及样本，而非把它记为应用冷启动通过。

**同日第三十六批：同一契约快照的六服务主流程与崩溃对账**

继续在续页归属协议和空回答占位修正后的工作树上运行 `fullstack-current.test.mjs` 与 `fullstack-no-receipt.test.mjs`。主流程约 323 秒通过，覆盖真实 Chromium 下 Run 接受、Bridge/Gateway 重启、退出登录、Stop、权限、响应超时、身份过期和撤销；无回执场景约 82 秒通过，覆盖 Prompt 转发前和已到 ACP 但回执未持久化两个崩溃窗口，模型执行不重复。此前同一快照的完整历史与生产 Bridge 容器回归也已通过。测试结束后 `docker ps` 没有残留隔离容器，`git diff --check` 通过。四类 Docker 证据现在属于同一实现快照；它们仍是确定性场景，不证明所有网络/崩溃交错。

**同日第三十七批：输入法确认键不触发发送**

扩展近期上游 UX 审计至 `3a2bd6f` 后发现，attyd 会忽略 `isComposing` 及组合结束后仍携带 `keyCode 229` 的按键；Agent UI 原先只过滤前者。在中文等输入法确认时，迟到的 Enter 可误提交草稿，Escape 可误关闭展开编辑器。组件测试先复现误提交，再在键盘处理入口同时过滤两个标记。生产 Chromium HTTP/SSE 测试进一步在已填草稿和附件的编辑器发送 `keyCode 229`，确认没有 Prompt HTTP 提交，随后普通 Enter 仍恰好提交一次。完整组件 106 项、生产构建/类型检查、Chromium 4 项通过。随后当前前端镜像的六服务主流程 E2E 约 342 秒通过，包含真实 Run、Bridge/Gateway 重启、Stop、权限、超时及身份状态变更；临时容器已清理。真实输入法与读屏器人工验收仍属此前暂缓范围。

同批还核对 `3a2bd6f` 的“滚动命令选中项”和 `349c42e` 的 Plan 退役：attyd 的命令菜单保持焦点在输入框，靠活动索引移动，故需显式 `scrollIntoView`；Agent UI 的配置菜单直接把焦点移到实际选项按钮，浏览器随焦点滚动，且没有对应的命令菜单。Plan 在 Agent UI 由服务端按 Run 保存为唯一过程项，新更新替换同一项，完成后仍归属该历史轮次；不存在 attyd 旧版全局 `activePlan` 跨轮残留路径。对应证据为 `ConfigPicker.tsx` 的 `navigate`/`focus`、`compact-transcript.ts` 的 Run 范围 `plan` upsert，及配置导航与匿名 Plan 更新测试。这两处是模型差异，无需照搬上游补丁。

**同日第三十八批：ACP HTTP 连接复用故障的适用性核对**

检查 attyd `95ea43f` 的实际补丁及诊断：其 Rust/Hyper ACP HTTP 在一个 Session 的 Prompt 悬挂、切到第二个 Session 执行时，曾把活跃 SSE 连接误放回空闲池，后续 POST 可能卡在复用队列；上游临时禁用 RPC 空闲连接池并保留 SSE。Agent UI 采用官方 TypeScript ACP SDK 的 HTTP stream 与 Node `fetch`，没有 Hyper 的连接池/调度路径；而当前 ACP 服务的 `RunSupervisor` 同一 Agent 只允许一个活跃 Run，第二 Session 同时 Prompt 会按 `agent_busy` 拒绝。因此不应把上游的 Rust workaround 硬搬到 Node Bridge。现有 `acp-http-bridge.test.mjs` 验证官方 HTTP/SSE 传输，六服务主流程验证断线及重启恢复；它们**没有**证明任意 Node 连接池压力下都不会停滞。若未来允许同 Agent 并发 Run，应先加入对应真实 TCP 挂起/切换 smoke，再评估 Node/SDK 的连接管理。
