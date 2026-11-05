# 配置与部署

目标为 Workers Free，固定 Worker 名 `proxykit-gateway`。`cloudflare.config.ts` 是唯一部署配置：启用 workers.dev 和独立 URL 凭据，关闭预览 URL、invocation logs 和 traces，并保留 query 脱敏。不配置付费专用 CPU 上限；完整快照校验保持不变。免费套餐 CPU/请求额度仍须通过实际下载验证，不能把本地测试当成生产容量证明。

## 身份与运行时 Secrets

使用已有 `cf` 认证，先执行 `cf --version`、`cf auth whoami` 并显式设置 `CLOUDFLARE_ACCOUNT_ID`。自动化部署身份与运行时 Secrets 独立管理；无需重新登录或扩大 Token 权限。首次部署须确认账号下没有同名 Worker；已有服务先核对归属、当前版本、变量、路由、日志和 Secrets。

`GITHUB_READ_TOKEN` 使用仅限私人仓库 Contents: Read 的 fine-grained PAT（Metadata Read 为 GitHub 附带权限），设有效期；不要给设备或 Actions。`DEVICE_AUTH` 是完整压缩 JSON，包含非空 `devices` 和 `disabled_paths` 数组。两个 Secret 均不得超过 5000 UTF-8 字节。

在私人终端把两个字符串字段组织到受保护的 JSON 文件，例如 `.cloudflare/private/runtime.json`，目录权限 700、文件权限 600。真实值不能出现在聊天、命令参数、公开 GitHub 记录、测试夹具或 Actions Artifact 中。避免会展开环境变量的 dotenv Secrets 文件。

## 设备授权

```sh
bun install --frozen-lockfile
umask 077
mkdir -p .cloudflare/private
bun run device:new phone-header bearer /v1/private/loon/example.list > .cloudflare/private/phone.json
```

生成结果包含一次显示的 Token 和 device 条目。将条目加入 `DEVICE_AUTH.devices`，把 Token 私下送到设备。`disabled_paths` 默认为空数组。授权必须列出精确路径，最多 32 个；需要全部当前订阅时从已验证快照列出全部路径，不使用通配符，也不关闭鉴权。新增订阅后须更新设备授权。

支持 Header 的客户端使用 Bearer。不能可靠设置 Header 的订阅客户端可另生成 `transport=url` 的凭据；两种 transport 不复用 Token。URL Token 可能随订阅配置、备份或平台访问记录泄露，按设备拆分后可独立撤销。不要将完整订阅 URL 粘贴到公共调试工具。

本地复制 `.dev.vars.example` 到 `.dev.vars`，填入 Secrets。私人下载要求 HTTPS，运行 `bun run dev` 并在客户端信任本地开发证书（`wrangler.config.ts` 仅为 cf 提供本地 HTTPS 开发设置，不是部署配置）。本地测试只用 Bearer，开发服务器可能记录 URL；health 成功不证明上游或认证有效。

## 验证与首次部署

```sh
bun run check
bun audit
bunx --no-install cf deploy --dry-run
```

`bun run typecheck` 先通过 `cf workers types` 生成 `.cloudflare/types/index.d.ts`，无需手写或提交生成类型。构建和测试均从 `cloudflare.config.ts` 读取配置；Wrangler 仅为 cf 和官方测试工具的内部依赖，不作为命令入口。

部署前完成独立 worktree、验证、本地 Codex 审查、PR、自动审查与 CI，以及 rebase 合并。核对实际账号、Worker 不存在、Secrets 内容有效、workers.dev 无额外缓存后，首次部署：

```sh
bunx --no-install cf deploy --secrets-file .cloudflare/private/runtime.json
```

这会创建并公开 Worker，不是 dry run。不要部署占位 Secrets。首次公开时已经携带完整运行时 Secrets，所有私人路径必须先认证。不要在命令行打印 Secrets 文件或私人响应。

## 更新、轮换与撤销

cf beta 不支持旧 `keep_vars` 和 `--strict`。本项目所有非敏感变量由已审查配置显式管理，不保留未声明的 dashboard 变量。没有等价冲突保护时，不将无人值守的部署直接切换流量；Actions 只上传候选版本。

Worker 存在后，可上传候选代码，省略 Secrets 文件以保留已有运行时 Secrets：

```sh
bunx --no-install cf workers versions create
```

轮换时在私人终端编辑完整 Secrets JSON，再上传候选版本：

```sh
bunx --no-install cf workers versions create --secrets-file .cloudflare/private/runtime.json
```

核验返回版本的代码、绑定、变量、Secrets 名称、日志配置及当前生产版本没有外部变动后，使用 `cf workers deployments create --worker proxykit-gateway --strategy percentage --versions @/path/to/reviewed-versions.json` 激活。JSON 文件为 `[{"version_id":"REVIEWED_VERSION_UUID","percentage":100}]`；不使用渐进分流旧 Secret，不使用 bypass 参数。候选上传不替代路由和观测设置的核验；修改这些设置时须另行审查并使用 `cf` 支持的部署流程。

撤销设备可删除条目或设置 `enabled=false`；停用订阅将精确路径加入 `disabled_paths`。更新后验证旧凭据 401、被停用路径 410。需要短暂双凭据时使用不同 id，更新设备后移除旧条目。GitHub PAT 独立轮换。回滚代码时必须保留最新撤销状态，不能重新启用旧 Secret；不要回滚或修改私人仓库的 dist。

## 手动 Actions

`Prepare production version (manual)` 只接受 main 上 `confirmation=deploy-proxykit-gateway`。production 环境保存 `CLOUDFLARE_API_TOKEN` 和 `CLOUDFLARE_ACCOUNT_ID`，建议必需审批和只允许 main。工作流执行完整检查和依赖审计，确认已有 Worker 的两个 Secret 名称，再上传候选，不上传运行时凭据、不激活流量。名称检查不证明值有效，激活前仍须核验。main push 和 PR 不部署。

## 部署后验证与边界

在私人终端验证 health、未认证/错误凭据 401、权限不足 403、停用 410、撤销 401，以及全部允许路径的 GET/HEAD/304。下载字节只能在内存或私人临时目录处理；逐一核对完整快照 SHA、文件大小和 SHA-256、四类 MIME、`private,no-store` 与安全响应头。任何缓存命中或 304 都必须鉴权。不要将有意错误配置发布给真实设备来验证 403/410，可通过隔离的合成认证条目验证并在交付前撤销。

503 用随机 requestId 关联固定错误类别；不打印原始异常、URL/query、Header、Token、正文、私人名称或 GitHub 响应。GitHub 404 可能是权限或发布状态问题，不能据此判断私人仓库不存在。不得回退公开 Raw URL、陈旧文件或跳过全量校验。平台资源超限须单独记录，不能声称免费套餐已通过最大规模或并发验证。

workers.dev 的实际可达性由客户端网络决定。真实 Loon/QX/sing-box 版本、移动/宽带运营商、DNS/TLS、定时更新及冷加载资源消耗须实测；本地或单个云端出口通过不代表中国大陆或真机验收通过。
