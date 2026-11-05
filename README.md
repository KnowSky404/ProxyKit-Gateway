# ProxyKit-Gateway

基于 Cloudflare Workers 的私人规则分发网关。向个人 Loon、Quantumult X、sing-box 设备提供独立鉴权、精确路径授权和经过完整性验证的不可变规则快照。

```text
ProxyKit-Private / dist → 固定 GitHub REST API → Worker → 已授权设备
                            ↑ 全量校验 SHA-256
```

[ProxyKit](https://github.com/KnowSky404/ProxyKit) 维护公共规则及生成器；ProxyKit-Private 保存私人源、构建并发布四类产物。本仓库只负责读取与分发。公共规则继续直连 ProxyKit。保留原有 AGPL LICENSE。

技术栈：TypeScript、Workers 原生 Fetch/Web Crypto、Wrangler、Bun、Cloudflare 官方 Vitest 插件。无运行时第三方依赖，无数据库或前端，不生成/转换规则、不编译 SRS。

```text
src/
  index.ts           Worker 入口
  app.ts             HTTP 路由与条件请求
  auth/devices.ts    摘要认证、设备授权与停用
  providers/github.ts ArtifactProvider / GitHub 快照读取与有界内存缓存
  manifest/          严格 JSON / Schema / 摘要校验
  config/contract.ts 固定路径和资源上限
  http/errors.ts     脱敏错误、安全响应头
scripts/device-token.ts  本地设备凭据生成工具
tests/                  合成数据的单元、运行时集成、安全回归测试
docs/                   架构、API、安全、部署、客户端与验证记录
.github/workflows/       CI 和手动部署
```

本地开发（Bun 1.4.4；Wrangler/Vitest 使用 Node.js 22.18+，CI 推荐 Node 24）：

```sh
bun install --frozen-lockfile
cp .dev.vars.example .dev.vars
# 在私人终端编辑 .dev.vars，填入自己的运行时 Secrets
bun run dev
```

健康检查不需 Secrets：`http://localhost:8787/v1/health`。未配置有效认证时私人资源始终拒绝，不返回示例规则。Wrangler 本地请求日志可能显示 URL：本地测试使用 Bearer；不要将真实 URL Token 粘贴到调试工具。

| 配置                                             | 用途                                   | 保存位置                           |
| ------------------------------------------------ | -------------------------------------- | ---------------------------------- |
| `GITHUB_READ_TOKEN`                              | 仅私人仓库 Contents: Read              | Worker Secret / 本地忽略文件       |
| `DEVICE_AUTH`                                    | 设备摘要、传输模式、授权路径、停用路径 | Worker Secret / 本地忽略文件       |
| `ALLOW_URL_TOKENS`                               | 显式允许独立 URL 凭据，默认 `false`    | wrangler.jsonc vars                |
| `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` | 手动部署身份与账号                     | 私人终端 / Actions production 环境 |

```sh
bun run check
bun audit
bunx wrangler types --strict-vars=false --check
```

[部署文档](docs/deployment.md) 包含只读 GitHub 凭据、Secret 初始化、设备生成/轮换/撤销和手动发布步骤。部署工作流只接受 main 上的显式 workflow_dispatch；本次初始化不部署。默认 workers.dev/预览 URL 均关闭，需要维护者配置受控域名路由并检查 Cloudflare 缓存与日志设置。

API 示例（占位值）：

```sh
curl --fail --header 'Authorization: Bearer DEVICE_TOKEN_PLACEHOLDER' \
  https://gateway.example.com/v1/private/loon/example.list
```

支持 GET/HEAD、鉴权后的 ETag/304。所有私人响应 `private, no-store`。完整列表见 [API](docs/api.md)，客户端配置见 [客户端示例](docs/client-examples.md)。

V1 安全上限：每文件/manifest ≤1,000,000 字节；最多 8 个规则集合、总产物 ≤8,000,000 字节；一次冷加载最多 35 次 GitHub 请求，每次 3 秒、整批 15 秒，不重试。需要 Workers Paid 的配置 CPU 预算；免费计划及生产负载尚未验证。超限/损坏/不兼容/上游失败都返回 503，绝不跳过完整校验。每次授权后重新解析 dist；缓存不提供陈旧回退。

已验证能力与证据见 [验证记录](docs/verification.md)：自动化测试覆盖全部四类响应、字节完整性、权限与上游故障；当前实现也使用现有 gh 身份对真实私人 GitHub API 完成只读快照验证。尚未部署 Cloudflare、未验证真实设备和中国大陆网络；不能将模拟响应测试解释为真机兼容性认证。

后续优先：人工验收/受控部署、Loon/QX/sing-box 真机与大陆可达性验证、根据实测 API 配额和负载再决定是否升级发布契约或接入 R2。更多边界与取舍见 [架构](docs/architecture.md) 和 [安全](docs/security.md)。
