# Agent UI 读屏器与全键盘验收

状态：**待实际操作**。现有 axe、组件和 Chromium 键盘测试已通过；本文件定义它们尚不能证明的人工验收。使用开发部署的 Node Agent UI，经 Gateway 登录测试身份，准备两个 Agent、两个 Session，以及只含测试文本的待批准工具请求。不要在验收记录中保存真实 Prompt、工具输入或登录凭据。

记录读屏器、浏览器、操作系统版本，视口与缩放、测试时间、部署 commit、每项结果和缺陷位置。原始记录存入忽略 Git 的 `artifacts/verification/agent-ui-accessibility/`。至少在桌面读屏器及 390px 移动视口的键盘模式各走一次；若环境只能提供其中一种，另一种保持未验收。

| 流程 | 操作 | 必须观察到的结果 |
| --- | --- | --- |
| Agent 目录 | 刷新 `/workspace/`，从页面顶部依次按 Tab；用读屏器标题/链接导航并按 Enter 选择 Agent | 读出“Your workspaces”、搜索框、Agent 名称与可用状态；焦点顺序和视觉顺序一致，选择后进入该 Agent，不跳到另一身份或 Session |
| 工作环境导航 | 检查侧栏顶部的 Workspace 入口；打开浮层、按 Tab / Shift+Tab、再按 Escape；移动端再按一次 Escape | 工作环境在 New conversation、搜索与历史上方；浮层不挤动历史；当前环境已标明；首次 Escape 回到环境入口且抽屉仍打开，第二次关闭抽屉并回到导航按钮 |
| Session 与草稿 | 在两个 Session 间切换，输入未发送草稿，再跨 Agent 往返；用浏览器 Back/Forward | 读出当前 Agent/Session；各草稿只回到原作用域；切换后焦点处于可操作区域，返回不会提交 Prompt |
| 发送与执行 | 在“Message”输入测试文本，按 Enter；执行中离开页面再返回 | “Message composer”的状态简短提示运行中；“Conversation messages”可主动阅读输出；返回后能读到同一 Run 的权威状态与结果，未重复提交 |
| 断线与受限历史 | 断开观察流，再恢复；切换到受限历史和只读回放失败状态 | 状态播报“不可用”而非沿用“可发送”；发送/批准禁用；受限告警简短播报，长预览只在“Recent output preview”主动聚焦时阅读；恢复后焦点不会被无关控件抢走 |
| 权限决定 | 让工具请求进入“Tool approval”，用 Tab/读屏器读取，再按 Enter 选择“Allow once”或拒绝 | 新请求只播报待办数量与短标题，不自动读出长“Requested tool input”；决定后卡片消失，焦点返回会话消息区，旧 generation 不可再决定 |
| 过程与长历史 | 展开“Show process”，读取内容续页，选择“Load earlier messages”“Load newer messages”“Latest messages” | 控件名称、展开状态和加载反馈可辨；最后一页按钮消失后焦点仍在“Conversation messages”；长输出及代码区域可主动阅读且无横向焦点丢失 |
| 配置、附件、Usage 与复制 | 用键盘改 Mode/Model，添加并移除附件，打开/关闭 Usage，复制回答 | 选项和当前值可辨；异步配置恢复后焦点回选择器且不抢走用户已移动的焦点；移除最后附件后回到可用编辑器；Usage 的 Escape 保留外部焦点；“Copied”由按钮旁状态节点播报 |
| 移动导航 | 390px 打开“Workspace navigation”，连续 Tab/Shift+Tab，按 Escape；再次打开并选择另一个 Session、Agent、全部 Agent | 对话框内焦点循环，不落到背景；Escape 返回导航按钮；选择 Session 聚焦消息区，换 Agent 聚焦新主区域，返回目录聚焦搜索框 |
| 登出与身份变化 | 一个浏览器会话登出，另一个有效会话继续；再用不同身份登录 | 登出的页面清空私有内容并给出“Sign in”；另一有效会话保留自己的状态；新身份看不到旧身份草稿、历史或权限待办 |

发现问题时记录最短复现路径、预期/实际读出文本及焦点位置，并在修复后重跑该项及相关自动测试。全部项有实际通过记录之前，不将 axe 无违规或 DOM 角色检查表述为读屏器验收完成。
