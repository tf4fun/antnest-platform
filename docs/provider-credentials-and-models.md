# Provider 凭证与模型分离

> 日期：2026-09-11。
> 状态：P0/P1、P2 Controller 执行消费、Console 连接管理与模板引用已实现。
> 创建连接及初始模型的 Console 浏览器与跨服务复验已获人工确认；模板创建复验待确认，ACP 消费未完成。
> 当前实例已替换 Controller/Console，管理场景见 [BF-CAT-02](business-flow-provider-connection.md)。
> 按用户要求暂不修改 ACP，逐场景推进管理主线，不宣称 Run 执行兼容性已验收。

## 1. 范围

目标流程为 DeepSeek builtin Provider：创建连接、独立配置与轮换 API Key、
预填模型列表、增加和修改模型、模板选择及 Run 执行。内置目录由 Admin Console
维护，组织确认的连接、凭证和模型配置由 Agent Controller 持久化，不要求管理员
逐项填写，也不在保存时强制恢复预设。

当前批准的修改范围仅为 Agent Controller 和 Admin Console，按服务分批交付。
先落实内置目录所有权与保存语义，再完成连接/凭证/模型分离；ACP 执行端、Gateway
及其他服务不在本轮修改范围。后续执行消费与全链路验收未完成前，不宣称流程闭环。

custom Provider、其他 builtin Provider、远端模型发现、Codex 订阅认证是后续扩展。
本轮确定扩展合同和拒绝未支持能力的行为，不显示可用的 Codex 登录按钮，不实现
返回假成功的 OAuth/discovery 方法，不新增凭证服务或后台刷新调度系统。
既有其他 Provider 的入口须在消费者批次同步收口，不能只隐藏 UI 而保留可提交的
未支持分支；协议测试中的合成模型服务不等于对外支持新的产品 Provider。

## 2. 现状问题

- 创建和修订 Model Profile 都要求重新提交 Key，并生成新凭证记录。
- ModelProfileRevision 同时携带模型信息和 credential_ref / credential_version。
- AgentSpec 固化这些凭证字段；Run 凭证解析又要求命中原版本。
- 已知模型的 context window、输出上限和多模态字段由 canonicalModelSpec 强制重写。
- 管理入口以 api_key 为固定字段；执行消费只认识 bearer 字符串，没有认证方法描述。

因此这不是单独的 Console 表单修改。持久化、领域引用、Run 准入与凭证解析、ACP
客户端合同和 UI 必须分批迁移，不能在某个生产者完成后宣称全链路已闭环。

## 3. 参考实现及取舍

参考本地源码，不把第三方实现当作其服务的公开兼容承诺：

| 项目 | 已核对的实现 | 本项目采用的原则 |
| --- | --- | --- |
| pi | AuthCredential 区分 api_key 与 oauth；AuthStorage 按需解析和刷新，刷新加锁后重新读取 | 认证方法独立于模型；并发刷新由凭证所有者处理 |
| pi | ModelRegistry 允许内置模型覆盖及已有 Provider 下添加模型 | builtin 是初始数据，不是禁止编辑的配置 |
| Goose | ChatGPT Codex 独立 Provider，保存 token 有效期、refresh token、account_id，并使用专用 Responses 请求路径 | 订阅认证和请求协议都需要适配，不能仅把 token 填进 Chat Completions 的 api_key |
| Hermes | Codex 运行时凭证解析先检查有效期，需要刷新时加锁并重新判断 | 解析不等于每次向外部服务刷新；不复制其多来源凭证池和自动导入回退 |
| Cherry Studio | 远端模型 ID 与内置 registry 匹配；未知项作为自定义模型 | 模型发现与完整能力资料分开，不能假定远端列表提供全部参数 |

源码位置（相对外层仓库）：

- `references/pi/packages/coding-agent/src/core/auth-storage.ts`
- `references/pi/packages/coding-agent/src/core/model-registry.ts`
- `references/pi/packages/ai/src/utils/oauth/openai-codex.ts`
- `references/goose/crates/goose/src/providers/chatgpt_codex.rs`
- `references/hermes-agent/hermes_cli/auth.py`：`resolve_codex_runtime_credentials`
- `references/cherry-studio/src/main/data/services/ProviderRegistryService.ts`：`resolveModels`

不照搬本机文件锁、localhost 登录回调、宿主机 auth.json 自动扫描、多账号池或
无界刷新重试。平台服务中的这些行为必须重新匹配组织隔离和 HTTP 入口边界。

## 4. 两层业务模型

### 4.1 Provider 连接与凭证

组织创建一个 Provider 连接，包含稳定 ID、organization_id、provider_key、显示名、
API endpoint 和认证方法。连接持有一组独立维护的凭证，供其下多个模型共享。
同一组织可以为同一提供商创建多组连接，不能把 provider_key 当作全局唯一账号。

`builtin/custom` 表示配置的初始化来源，不表示认证类型，也不代表调用协议。
API Key、OAuth 和未来其他认证方法都通过 Provider 描述中声明的能力判断是否支持。

### 4.2 Provider 模型

模型属于组织内的 Provider 连接，包含稳定 ID、API model ID、显示名、上下文与输出
上限、多模态能力、可选价格和可用状态。唯一约束为 `(provider_connection_id, model_id)`。
模型记录不保存 Key、refresh token 或凭证版本；base_url 来自连接，执行快照才组合
endpoint 与模型参数。API model ID 是身份，修改它视为新增模型，而非偷偷替换已有引用。

模板引用连接内选定的模型；底层稳定模型记录已包含连接关系，持久化不用额外复制
一份可能不一致的 provider/model 组合。前端可以按 Provider 分组选择，后端仍须校验
模型及连接属于同一请求组织且处于可用状态。

### 4.3 预设与修改

1. Console 维护 builtin 目录并预填模型；创建连接时提交管理员确认的模型数据，
   Controller 校验后与连接、凭证一并持久化。Controller 不复制或维护第二份内置目录。
2. custom 连接未来启用时，初始模型列表为空。
3. 保存后以组织模型记录为权威；管理员可以增加、编辑或停用 builtin 连接下的模型。
4. 软件升级不改写已保存数据，不自动删除模型，也不恢复管理员停用的模型。
5. 未来“获取模型”先返回候选列表；新增项可导入，已有项更新须显式确认，不做静默覆盖。
6. 未知价格保持未知，不按免费计算；未知能力不能被冒充为已知。创建可执行模型须通过
   所需字段校验。discovery 失败不清空现有列表，运行也不依赖实时 discovery。

本阶段采用预填后持久化，不建立运行时多层配置覆盖引擎。编辑只更新当前模型参数、
配置标识和并发版本，不保存独立模型历史，也不改写凭证。Agent 构建和 Run 准入
各自保留实际使用的参数快照，承担执行追溯。

## 5. 认证扩展合同

### 5.1 三个独立维度

| 维度 | 本轮 | 后续扩展示例 |
| --- | --- | --- |
| Provider 定义 | deepseek | 其他 builtin、custom |
| Credential method | api_key | oauth |
| 模型请求协议 adapter | openai_chat_completions | Provider 专用 Responses 或其他协议 |

可执行的 Provider/认证/请求协议支持范围由服务端校验，不由客户端自行宣称能力；
它与 Console 的模型目录不同，后者只是可编辑的初始参数。本轮只注册 DeepSeek 和
api_key。未知 Provider、未知认证方法、未知请求协议均明确拒绝，不自动回退为 DeepSeek。
支持一个新的 Provider，需要同时具备认证解析、请求 adapter 和对应测试，不以增加一条
模型目录数据冒充已经接入。

### 5.2 最小接口边界

以下为职责合同，不要求现在为未实现的 OAuth 建空实现：

| 接口 | 输入与输出 | 所有者 |
| --- | --- | --- |
| BuiltinProviderCatalog | provider_key、默认 endpoint、预设模型及元数据来源；仅用于预填，不是执行权威 | Admin Console |
| ProviderSupport | provider_key、已实现的 auth_methods、请求 adapter 标识；拒绝未实现组合，不包含模型名称/价格/上下文目录 | Agent Controller |
| CredentialResolver | 组织/连接授权上下文、当前凭证记录 -> 调用所需认证材料、有效期、凭证修订；必要时产生更新 | Agent Controller 的认证 adapter |
| ModelDiscovery（可选） | 已授权连接与解析后的认证材料 -> 模型候选列表，允许部分元数据缺失 | Agent Controller 的 Provider adapter |
| ModelTransport | 已解析的模型参数、认证材料 -> 模型请求与流式事件 | Agent ACP Service |

注册表是服务内部扩展点，不提供动态插件上传、任意认证回调 URL 或任意反射装载。
Provider adapter 只能消费合法的组织连接；凭证不能因模型同名而跨连接或跨组织共享。

### 5.3 管理输入与存储

本轮创建请求不再是“模型 + api_key”，而是连接命令，例如：

```json
{
  "provider_key": "deepseek",
  "display_name": "DeepSeek",
  "base_url": "https://api.deepseek.com",
  "credential": {
    "method": "api_key",
    "api_key": "<write-only>"
  }
}
```

api_key 是认证方法内的字段，不再是所有 Provider 管理命令都必须具备的顶层字段。
模型编辑命令不接收任何凭证字段。凭证轮换命令不接收模型列表。
以上仅展示连接与凭证字段；创建时由 Console 附上管理员确认的初始模型列表，
不能要求 Controller 根据 provider_key 自行补齐模型参数。

未来 OAuth 凭证包含 access token、refresh token、过期时间及必要的账号绑定信息，
由认证 adapter 产生并整体加密保存，不要求前端把 token 当成 API Key 手工填写。
管理 API 返回配置状态与已实现认证方法，不返回 token。OAuth 登录事务将由
Begin/Get/Complete（按授权方式需要）处理，并绑定组织、连接、发起者、state/PKCE 和
过期时间；具体公开路径在实现该 Provider 时确定，不提前暴露无实现端点。

现有内部 Run API 的 `secret_type=bearer` 描述的是请求认证材料，不是凭证取得方式；
不能拿它判断存储的是 API Key 还是 OAuth token。后续请求认证材料应为带类型的合同，
能表达短期 access token 与必要的 Provider 账号属性，但不把 refresh token 下发 ACP。
不向数据库增加每个 Provider 独有的一批空字段；扩展认证 payload 使用有类型校验的
加密结构，不以无约束 JSON 作为领域模型。

### 5.4 轮换与有效期

- 凭证独立于模型修订和 AgentSpec。轮换不改模板、Agent 生命周期或 Runtime generation。
- Run 准入绑定被授权的 Provider 连接和确定的模型修订，不把某个长期固定 token 作为配置。
- 每次模型调用前可以解析认证材料，但有效期内读取/复用已有材料，不等于每次发起外部刷新。
- 后续 OAuth 刷新按连接串行化，锁内重新读取版本与有效期，刷新后的 access/refresh token
  原子保存；不会让并发刷新覆盖较新的 refresh token，也不长时间持有跨服务事务。
- 无法刷新时返回可区分的暂时不可用或需要重新授权，不无限重试，不把失败转成空 Key。
- 已发出的 HTTP 请求不能靠本地 Key 轮换撤回；后续请求使用轮换后的凭证。审计可记录
  实际使用的凭证修订标识，不保存秘密。模型价格、能力快照与凭证轮换分别管理。

## 6. 数据、执行与服务边界

组织配置、认证材料和模型都归 Agent Controller 自有 Postgres 管理，业务数据收敛为
`provider_connections`（连接与当前加密凭证）和 `model_profiles`（模型与当前参数）。
不保留独立的历史凭证表或模型修订表。凭证轮换原子替换当前密文与版本，模型修改原位
更新参数与并发控制版本；审计快照不包含秘密。命令回执保存当次响应所需的非秘密快照，
更新后的重试仍返回原响应，不通过查询当前值或历史秘密重建回执。
全局预设随 Console 源码维护，不需要独立数据库表；不再保留“一个模型修订必须
新建一个凭证”的外键设计。Console 更新仅影响后续预填，不会自动回写组织配置。

Console 通过本服务目录接口提供预设，通过 Controller 合同读写持久化配置，不接触
Controller 的任何数据库表；缺省元数据在 Console 填充，Controller 不按名称偷偷改值。
ACP 通过已获准 Run 的凭证解析接口
取得调用材料，不读取 Controller 的数据库，也不自行刷新 Controller 持有的 OAuth。
平台 OIDC 登录属于 Identity Service；供应商订阅授权属于 Provider 管理，两者不能混淆。
Runtime Controller、Runtime、Egress 均不参与 Provider 凭证和模型管理。

执行时在 Run 准入处解析已选模型的当前可用修订并冻结本次使用的参数；模板仍选中同一
模型身份，模型列表更新不会自动切换到另一个模型。正在执行的 Run 不随模型编辑改变参数。
新 Run 读取更新后的参数；已记录 Run 的价格/能力快照不被改写。这里需要一起替换旧的
Template 固定 ModelProfileRevision 引用方式，不能只更新 Console 下拉框。

P2 的具体边界：模板保存 `model_profile_id`；Agent 保存同一稳定模型 ID，构建时的
模型修订和参数仅保留为构建审计快照，不作为后续 Run 的配置权威。准入锁定模型当前
修订并校验所属连接可用，Session 默认值和候选能力也从当前可用模型读取。
Model revision、AgentSpec 和 Run 配置摘要不包含凭证版本。凭证解析只接受本次准入
授权的连接，读取该连接当前凭证；实际使用的凭证版本由解析响应返回。
模型更新、凭证轮换均不修改 Runtime 或 Agent 生命周期。已结束/过期的准入和不属于
准入连接的凭证请求拒绝。P2 合同变更后，Console 模板选择和 ACP DTO 必须分别更新，
不能单独把 Controller 新镜像部署到仍使用旧消费者的验收实例。

模型修订标识在既有执行快照中仅作为诊断标识保留，不再是历史资源地址或外键。
不提供独立模型历史详情端点；Console 展示当前模型，Agent 构建详情直接展示该 Agent
自身保存的参数。已准入 Run 仍保存完整执行快照。尚未被构建或执行消费过的模型编辑
不再提供单独的历史浏览、旧版选择或回滚能力。Template 的版本历史不受本次调整影响。

凭证访问接口与物理存储独立：公开连接投影不能包含密文、nonce 或秘密；执行端仅能
经已授权准入解析当前凭证。未来 OAuth 使用有类型的加密 payload、连接级刷新协调及
CAS，不能将“需要刷新”解释为“需要历史秘密库”。本轮不实现 OAuth 或修改 ACP 执行端。

## 7. 分服务实施计划

每批按 doc -> test -> code 推进，执行验证由协调者串行完成。未完成消费者的合同不可
标为已闭环。用户最新决策为 ACP 暂缓、管理流程先行：Provider、模板与 Agent 管控
按其自身依赖逐场景验收；涉及 ACP 的模型执行仍须等待消费者对齐，不能扩大验收结论。

| 批次 | 唯一业务实现范围 | 工作 | 验收 |
| --- | --- | --- | --- |
| P0 | Controller，然后 Console | 移除 Controller 内置目录与强制覆盖；目录由 Console 本地提供并提交显式模型参数 | Controller 保留所提交参数；Console 目录不请求下游；已保存配置优先于预设 |
| P1 | Agent Controller | Provider 支持范围、连接内当前凭证与轮换、两层模型、连接创建/查询及模型创建/修订 RPC、校验 Console 提交的初始模型、组织隔离与幂等 | 单元、合同、自有 Postgres 集成测试；模型修改不触碰凭证、不自动补齐已知模型参数 |
| P2 | Agent Controller | Template/Agent/Run 引用改为模型身份；准入冻结模型参数；凭证解析按连接授权；轮换后的执行消费 | 旧模板选择不换模型；新 Run 使用新参数和凭证；旧 Run 快照稳定；不重建 Runtime |
| P3 | Agent ACP Service | 更新 Controller DTO 与模型/认证解析边界；本轮保持 DeepSeek 请求 adapter；保留未来 adapter 选择合同 | 凭证轮换后调用成功、未知协议拒绝、模型调用失败正常上报、ACP 配置与模型选择回归 |
| P4 | Admin Console（本轮在 P1 后推进） | 维护 DeepSeek 内置目录、Provider 连接管理、独立凭证编辑、Provider 下模型列表与编辑、模板模型选择 | UI/BFF 合同测试、浏览器验证；创建无需填写上下文，编辑模型无需重新输入 Key |
| P5 | 集成与文档 | 更新相关合同、测试驱动和部署说明，重建开发实例后走完整流程 | Gateway 起点 Jaeger、真实 DeepSeek smoke、数据库结果、无多余资源或后台测试进程 |

Edge Gateway 若沿用现有 `/api/admin/*` 转发，无需增加 Provider 业务分支。若实测合同
要求新入口，单独列 Gateway 消费者批次，不能隐式扩大某个服务的写入范围。
旧数据不做复杂兼容迁移；空白实例验收与重建动作另行明确。切换前不能删掉当前已验收
实例的数据或将旧 BF-CAT-02 结果解释为新模型的验收证据。

## 8. 必须覆盖的正确性用例

1. 管理员无需填写 DeepSeek 模型元数据；Console 预填后提交明确数据，Controller
   校验并保存；一个凭证被多个模型共享。目录读取不请求 Controller 或外部提供商。
2. 同一创建命令重放不重复生成连接、模型和凭证；并发相同命令结果一致，冲突输入拒绝。
3. 内置模型上下文、能力和价格可修改，关闭能力及显式零价也不被默认值覆盖；未知价格不算零。
4. 内置 Provider 下可以增加模型；跨连接允许同名，连接内重复 API model ID 拒绝。
5. 修改模型不增加凭证版本；轮换凭证不增加模型、模板、Agent spec 或 Runtime generation。
6. Provider/模型/凭证读取和编辑都做组织隔离；伪造外部身份头不能跨越 Gateway 边界。
7. 未支持的 Provider、oauth 认证方法、请求 adapter 和 discovery 操作明确拒绝，且不写入半成品。
8. 准入后模型参数与审计快照稳定；模型编辑影响后续 Run，不影响正在执行的 Run。
9. 凭证轮换后既有 Agent 无需重建便可发起后续模型调用；解析接口必须受 Run/连接授权约束。
10. 管理 API 与浏览器不回显秘密；依现行埋点规范仅 RPC 边界采集正文，普通 HTTP 不重复记录。
11. 当前开发环境开启全量 RPC 采集时，凭证可进入本地 Jaeger；真实 Key smoke 沿用用户授权，
    不误报“Trace 已脱敏”，不把原始 Trace、凭证或过程日志写入仓库。
12. 最终按连接创建、模型编辑、凭证轮换、模板创建、Agent 创建与模型调用分别提供 Trace；
    查询前等待 6 秒，校验父子关系、错误与 Jaeger warnings，每完成一个验收场景等待用户确认。

未来 Codex adapter 启用前另加授权成功/取消/超时、state 与组织绑定、有效期内不刷新、
并发刷新一次、refresh token 替换、失败重新授权、账号身份传递和专用模型协议用例。
本轮仅验证未实现能力拒绝，不以测试替身冒充 Codex 已完成。

## 9. 当前进度

- [x] 参考源码核对及领域边界收口。
- [x] 确定 DeepSeek 首期范围、订阅认证扩展位置与分服务验收计划。
- [x] P0：Console 内置目录与 Controller 持久化权威分离。
- [x] P1：连接创建/查询、独立凭证轮换、模型创建/修订管理生产者。
- [x] P2：Controller 模型身份引用、执行消费及轮换后的认证材料解析。
- [ ] P3：ACP 消费者。
- [x] P4：Console 连接/凭证/模型管理消费者与自动回归。
- [x] P4 补充：模板改用稳定 model_profile_id，并通过自动回归。
- [ ] P4：浏览器布局验收。
- [ ] P5：跨服务集成及人类验收。

管理主线复验：新 Controller/Console 已部署；Provider 创建及初始模型保存通过
真实 Gateway/Postgres/Jaeger 核对，用户已确认；模板创建也已确认。
Agent 已由浏览器创建并达到 available，实际 Runtime 健康，正常创建场景已获用户确认，见
[创建场景及遗留](business-flow-agent-create.md)。本轮无 ACP 或外部模型调用，
不把管理链路验收作为 ACP 消费者适配已完成的证据。

### P0 验证（2026-09-11）

- Controller 不再提供 `/internal/model-catalog`，不再按模型名覆盖上下文、能力和
  价格。Console 的 `/api/admin/model-catalog` 在本服务返回 DeepSeek 预设。
- 创建时使用预填参数，允许修改；修订时使用已保存参数。价格显式提交，未设置
  保持未知，关闭能力与零价格不被预设恢复。目录读取保持管理员权限要求。
- Controller/Console 串行 Go race 回归：19 个测试包通过，514 个顶层测试和
  472 个子测试通过；真实 PostgreSQL/HTTP 集成使用独立临时库，已清理。
- Console 前端：98 个纯函数测试、206 个组件测试通过；生产构建通过。
- 浏览器合成数据预览：桌面默认折叠/展开编辑通过；360×800 下页面宽 360、
  对话框 client/scroll 宽均 326，底部按钮可达。未使用真实凭证或外部模型，
  预览已关闭，视口已恢复。提交行为由组件与 HTTP/Postgres 测试验证。
- `make -j1 fmt-check lint`、文档链接及合同 JSON 检查通过。

没有修改数据库结构、ACP 执行实现或部署中的 8090 实例；本批不意味着凭证与模型
已经解耦。现有 Model Profile 修订仍要求凭证，模板/Agent/Run 仍使用旧引用关系，
分别由 P1/P2/P4 和后续 ACP 消费者批次处理。新目录版本不会回写旧实例配置。

### P1 Controller 管理生产者（2026-09-11）

- 新增连接创建、分页查询、详情与独立凭证轮换 RPC。DeepSeek/api_key 是当前唯一
  可用组合，协议支持登记与 Console 模型目录分离；未实现的 OAuth/custom 明确拒绝。
- 连接与初始模型原子创建，一份凭证供多个模型共享。模型命令不接收 Key 或 endpoint；
  模型修订不写凭证，连接内 API model ID 唯一且不能通过修订原地变更。
- 原 P1 曾使用独立凭证/模型修订表；该结构已由 §6 的当前值模型取代。
  `provider_connections` 内联当前密文，`model_profiles` 引用连接并保存当前参数。
- 轮换使用 expected_version CAS；并发创建可重放，冲突请求拒绝。原始创建/轮换结果
  不随后续轮换漂移，事务失败不留下连接、凭证、模型或命令回执的半成品。
- 管理响应不回显 Key；模型响应不返回凭证标识。RPC 和存储观测沿用公共封装，
  已验证父 span 与错误传播。未对开发环境全量 RPC 内容采集增加脱敏承诺。
- Controller 全量 Go race：13 个测试包、431 个顶层测试、359 个子测试通过，
  0 跳过、0 失败；包括真实 PostgreSQL、HTTP、并发 CAS、回滚、组织隔离、价格
  严格解码、历史修订和既有 Agent/Run 流程。使用独立临时测试库，不访问外部模型。
- 最终 `make -j1 fmt-check lint` 通过，Go 标准 lint 为 0 问题；7 份文档的 36 个
  本地链接、2 份合同 JSON 与 diff whitespace 检查通过。临时测试库已删除。

本批只修改 Controller 及其合同/文档，不修改 ACP、Console 或 8090 实例。
P1 交付时 Console 仍发送旧管理请求；下述 P4 已接入新合同，整套部署联调
仍归 P5，不能独立替换运行中的 Controller。P1 基于新的空白 MVP schema；旧 schema 的校验失败不会被绕过。
连接 endpoint 编辑、连接/模型停用与删除管理未在本批实现，不以静态 enabled 字段
冒充管理闭环。P1 交付时 Agent 默认仍固定模型修订、Run 固定凭证版本；
下述 P2 替换 Controller 生产者语义，ACP 执行消费仍归 P3。场景 Trace、真实 DeepSeek 与人类验收仍归 P5。

### P4 Console 管理消费者（2026-09-11）

- 列表以连接为单位，展开查看其模型。创建 DeepSeek 连接时填写一次密钥，并从
  Console 目录选择初始模型，允许空模型列表。没有无效的默认模型选项。
- 增加模型与编辑模型均不要求密钥；已保存模型的 API ID、所属连接与 endpoint
  不在修订表单中变更。模型限制默认折叠，可修改能力、限制和价格；历史参数优先。
- 密钥独立轮换，使用连接版本 CAS。冲突要求管理员刷新后重新确认；响应丢失
  重试保留原版本与幂等请求，禁止静默覆盖其他管理员的更新。提交中禁止关闭弹窗。
- BFF 合同 revision 39：连接读写、凭证轮换、模型的连接引用与参数转发。组织
  来自 Gateway 主体；管理读只返回轮换需要的不透明版本，不返回密钥或加密材料。
- Console 全量 Go race：6 个含测试的包通过。前端 98 个纯函数测试、212 个组件
  测试通过，TypeScript 与 Vite 生产构建通过。最终 `make -j1 fmt-check lint`
  通过，Go 标准 lint 为 0 问题；7 份文档的 25 个本地链接、合同 JSON 与 diff
  whitespace 检查通过。没有外部模型调用。
- 浏览器打开合成预览后，控制工具持续返回 `nodeRepl.fetch request failed`；
  尚未完成操作截图与移动端布局验收，不能以组件测试替代。临时预览服务已停止，
  合成脚本已删除，不保留过程截图或凭证数据。

本批仅改 Console 与相应合同、文档，未改 Controller、ACP 或部署中的 8090 实例。
P4 此批只覆盖连接管理；P2 新模板合同的 model_profile_id 消费见下述补充批次。
P3 ACP 消费、P5 跨服务、Jaeger 与人类验收仍待执行。
本服务维护说明见 [Provider management](../services/admin-console/docs/provider-management.md)。

### P2 Controller 执行生产者（2026-09-11）

- Control 合同 revision 20：模板创建、修订、读取均改为稳定 `model_profile_id`。
  Agent 保留稳定身份与构建时模型审计快照；默认与 Session 显式选择均在每次
  Run 准入冻结当前可用模型修订、价格和能力，不修改旧准入或重建 Runtime。
- Model revision、AgentSpec、执行摘要均不再携带凭证版本。Run 合同 revision 13
  使用 `execution_spec.provider` 描述连接、Provider、认证方法和请求协议。
- `resolve-credential` 以 `admission_id + provider_connection_id` 授权，读取当前
  连接密钥并返回实际版本。活跃 Run 可读取轮换后的 Key；过期、结束、错误连接、
  连接禁用及组织/所有者/访问绑定失效均拒绝。解析不发起外部认证请求。
- Session 默认模型、模型目录和输入能力同时遵循当前可用连接与模型；不再从
  历史 Agent 构建快照宣称当前模型支持某种输入能力。
- TDD 首先复现默认 Run 仍使用旧参数；最终 13 个 Go 包全量 race 通过，
  799 个测试结果（含子测试）、0 跳过、0 失败。包含真实独立 Postgres、HTTP
  凭证轮换、准入快照不变、组织/身份隔离及既有生命周期回归。
- 最终 `make -j1 fmt-check lint` 通过，Go standard lint 为 0 问题，Rust Clippy
  与各前端类型检查通过；9 份文档的本地链接、3 份合同 JSON 与 diff whitespace
  检查通过。专用临时测试库与执行辅助脚本已清理，无遗留测试进程。

本批不修改 ACP/Console 实现，不部署新 Controller 到 8090。Console 稳定模型引用
由下述批次接入；ACP 随后更新严格 DTO 和每次模型调用前的凭证解析，移除旧的固定
凭证版本比较。P5 仍承担部署、真实模型、Jaeger 与人类验收。

### P4 补充：Console 模板引用（2026-09-11）

- BFF 合同 revision 40：模板创建、修订、列表和详情使用 `model_profile_id`；
  不在 BFF 中查询并固定模型修订，旧模板修订字段作为无效输入拒绝。
- 模型元数据修订和分页合并不改变模板的选择身份，同一模型不重复出现。
  当前引用可独立读取，不要求位于第一页；缺失或停用时要求显式选择可用替代项。
- 历史模板读取该模板的不可变配置，再按其模型身份展示“Current model”。
  模型历史页已随 §6 精简移除；Agent 构建审计读取自身快照，模型链接打开当前配置，
  不把当前模型参数冒充历史快照。
- TDD 先复现 BFF 拒绝新字段和前端引用错误；最终 Console 全量 Go race
  6 个含测试的包通过；前端 99 个纯函数测试、217 个组件测试通过，生产构建通过。
- `make -j1 fmt-check lint` 通过，Go standard lint 为 0 问题，Rust Clippy
  与前端类型检查通过；4 份文档的 10 个本地链接、合同 JSON 和 diff whitespace
  检查通过。测试已结束，无遗留 Go/Vitest 测试进程。
- 浏览器控制工具再次返回 `nodeRepl.fetch request failed`，本批没有新增浏览器
  布局验收结论；组件测试不等同于布局验收。

本批仅修改 Console 及其合同/文档；未改 ACP、Controller 或运行中的 8090 实例，
未调用外部模型，未创建测试容器或数据库。下一批是 P3 ACP 消费者，之后才是 P5
空白实例联调与逐场景 Jaeger 验收。

### 当前值存储精简（2026-09-12）

- Control 合同 revision 21、Console 合同 revision 41：合并连接与当前加密凭证；
  模型只保留当前参数、更新计数和配置标识，移除两张独立历史表与模型历史 GET/页面。
  原模型更新 POST 路径保留，但不再创建可查询的历史资源；Template 历史不变。
- 一个连接与三个初始模型只插入五条记录：连接 1、模型 3、命令回执 1。
  凭证轮换原位替换，模型修改原位更新。幂等回执仍保存非秘密原响应，不等同于
  已消费配置的审计快照，也不提供历史浏览或回滚。
- Agent 构建快照和 Run 准入快照保留实际使用的参数。Console 直接展示构建时的
  endpoint、能力、限制、temperature 和价格；模型链接指向当前配置。
- 只读审查后补测并修复：相同凭证轮换并发时的误报冲突、前端 A→B→A 编辑复用
  旧幂等键，以及移除历史页后的构建参数展示缺口。等待模型锁的新 Run 冻结完整
  已提交配置，旧 Agent/Run 快照和命令回执均不漂移。
- Controller、Console 完整 Go race 回归通过，包含真实独立 Postgres 和本地 HTTP
  合同/集成测试。Console 100 个纯函数测试、222 个组件测试及生产构建通过。
- `make -j1 fmt-check lint` 通过，Go standard lint 为 0 问题；Rust Clippy、
  Node lint/typecheck 全部通过。20 份变更文档的 160 个本地链接、2 份合同 JSON
  和 diff whitespace 检查通过。临时测试库及专用角色已清理，未保留过程报告。

本批未修改 ACP 实现或 8090 验收实例，不以旧 Trace 证明新存储结构。
部分历史全平台联调脚本仍使用早期 Provider/模板合同，需随 P3/P5 消费者联调更新，
本批未运行它们或宣称全平台验收通过。旧开发库不做迁移；后续使用新 schema 的
空白实例验收，再按真实 Trace 更新业务时序图。开发 RPC 全量采集仍可能记录秘密，
删除历史凭证表不是对遥测数据保留的保证。

### 模型编辑一致性补强（2026-09-12）

- Control revision 22、Console revision 42：模型编辑必须携带读取时的
  `revision` 作为 `expected_version`。BFF 原样转发，Controller 不替换为新读取的
  版本；现有事务 CAS 拒绝旧表单，沿用 409 `lifecycle_conflict`。不新增历史表、
  锁表或重试机制。
- 同一已提交请求仍优先回放原回执，即使最初查询回执时尚未提交，或模型随后已被
  其他请求更新。不同请求同时编辑同一版本只允许一个提交，失败事务不保留回执。
- Console 冲突后保留参数、能力选项和价格草稿并禁止继续保存。管理员显式重新
  加载后才替换表单，读取失败不丢草稿；响应丢失后的原请求重试不更换版本或幂等键。
- 独立创建、修改和 Provider 初始模型批量创建均校验非空白、最多 200 Unicode
  码点的名称；不按 UTF-8 字节或 UTF-16 单元截断名称。
- 本批仍不修改 ACP 消费者，不补做连接/模型停用，不更新旧全平台联调脚本。
  P3/P5 待办保持不变；运行中的 8090 实例和既有 Jaeger 场景不代表本批代码。
- 最终验证：Controller、Console 全模块 Go race 通过，包含独立 PostgreSQL 的
  HTTP/事务集成测试；Console 101 项纯函数、224 项组件测试及生产构建通过。
  `make -j1 fmt-check lint` 通过，Go lint 0 问题；合同、5 份文档的 16 个本地
  链接和 diff whitespace 检查通过。只读复核无确认缺陷，补强了真实双写竞争和
  多字段草稿恢复测试。临时数据库与角色已删除，审查 agent 已关闭。
