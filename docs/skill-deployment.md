# Skill 学习与动态传播的常规部署

普通 `compose.yaml` 与 `compose.stage3.yaml` 现已接入已有的签名维护、学习策略
读取、自动来源投影与动态发现配置。无需使用测试目录里的配置覆盖文件。
接口及权限不变，部署边界见[配置合同](../contracts/skill-registry/deployment.md)。

## 配置

下列值全部为空时，个人 Skill 维护与动态来源发现保持关闭，Registry 正式包托管、
模板引用和只读预设交付仍然可用。由部署操作者显式提供稳定配置：

| 配置项                                        | 使用位置                                                        |
| --------------------------------------------- | --------------------------------------------------------------- |
| `ANTNEST_ACP_SKILL_MAINTENANCE_SIGNING_KID`   | ACP 签名 key id                                                 |
| `ANTNEST_ACP_SKILL_MAINTENANCE_SIGNING_KEY`   | ACP 的 Ed25519 PKCS8 DER，标准 base64                           |
| `ANTNEST_RUNTIME_SKILL_MAINTENANCE_VERIFIERS` | RC 的公开 current/next 验证集合；创建/重建时冻结进 Runtime      |
| `ANTNEST_SKILL_REGISTRY_SOURCE_TOKEN`         | ACP 与 Registry 共用的独立来源读取 bearer，至少 32 个可打印字符 |

Registry API bearer 继续使用已有的 `ANTNEST_SKILL_REGISTRY_API_TOKEN`，必须与
来源 bearer 不同。Compose 根据来源 bearer 同时设置两侧私有地址和 token；
设置签名私钥则连接已有的 Controller 学习策略读取入口。Agent 自身仍按既有
维护策略决定自动学习是否开启、何时触发及预算，不另加用户学习命令。

Registry 与其他服务共用 `OTEL_SDK_DISABLED`、`OTEL_TRACES_EXPORTER`、
`OTEL_EXPORTER_OTLP_ENDPOINT` 和 `http/protobuf` 配置，也支持 traces 专属
endpoint/protocol；默认仍关闭导出，服务名固定为 `skill-registry`。源码
由 [D1T](skill-registry-trace-delivery-20261001.md) 单独验收，完整来源 Trace
仍以 [DI3](skill-discovery-caller-integration-delivery-20261001.md) 的真实回归
为准。关闭导出会保留 W3C 传播，HTTP span 不采集正文/查询/凭证。

已有密钥时直接使用对应值。首次空白开发部署可以在本机 nvm Node 环境生成
一份忽略 Git/Docker 上下文的 `.env.skills`，命令不会打印私钥或覆盖已有文件：

```sh
node --input-type=module <<'JS'
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
const kid = 'development-1';
const pair = generateKeyPairSync('ed25519');
const signing = pair.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
const publicKey = pair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64url');
const verifiers = JSON.stringify({ keys: [{ kid, algorithm: 'Ed25519', public_key_base64url: publicKey }] });
const values = {
  ANTNEST_ACP_SKILL_MAINTENANCE_SIGNING_KID: kid,
  ANTNEST_ACP_SKILL_MAINTENANCE_SIGNING_KEY: signing,
  ANTNEST_RUNTIME_SKILL_MAINTENANCE_VERIFIERS: verifiers,
  ANTNEST_SKILL_REGISTRY_SOURCE_TOKEN: randomBytes(32).toString('base64url'),
};
writeFileSync('.env.skills', Object.entries(values).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600, flag: 'wx' });
JS
```

保持这些值稳定，并将它们纳入现有受保护配置备份。不要把解析后的 Compose
环境输出到工单、截图或公共日志。上面只生成新的维护凭据，不读取、解密或
重放模型 Provider 凭据。

## 启动及应用

按[单节点运行手册](docker-single-node-operations.md)准备现有 `.env`、镜像与
网络后，用普通配置启动；两个 env 文件按顺序读取，后者只补充 Skill 选项：

```sh
docker compose --env-file .env --env-file .env.skills \
  -f compose.yaml -f compose.stage3.yaml --profile stage3 up -d --build --wait
```

RC 配置变化不会修改运行中 Runtime 的公钥集合。新建 Agent 会使用当前配置；
已有 Agent 必须经过现有模板／显式重建流程。不要在已有在途生命周期操作中
更换验证集合，轮换与泄露处理遵守[学习密钥合同](../contracts/skill-learning/learning-api.md)。
仅希望启用个人自动学习时，可不设置来源 bearer；配置签名与公开验证集合即可。
本轮代码交付不会自动生成实际部署凭据或启动此前停止的验收环境。

## 验证

`make test-skill-deployment` 使用合成临时密钥渲染普通配置，校验独立开关、
两侧 bearer、一致的私有地址、私钥隔离及标准构建包含 Registry。
`make e2e-skill-deployment` 构建隔离
候选服务，以这些常规环境变量执行真实学习、来源投影、临时使用、浏览器提升
及模板创建／重建／Run；配置覆盖只选择候选镜像、网络范围和本地模型。
它不使用实际 `.env`、不消耗真实模型额度，结束后清理所有本批资源。
