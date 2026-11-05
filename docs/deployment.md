# 配置与部署

本次初始化不部署生产服务。以下步骤由维护者在验收后显式执行；不要把真实值放进聊天、命令参数或公开GitHub记录。工程固定Worker名proxykit-gateway。先核对目标账号、现有Worker、域名路由、变量、Secrets和日志策略；同名已有服务必须确认归属，不能直接覆盖。

## 只读GitHub身份

在GitHub Settings → Developer settings → Fine-grained personal access tokens创建带有效期的Token，Resource owner选择KnowSky404，仅选择ProxyKit-Private，Repository permissions仅Contents: Read（Metadata Read为GitHub附带权限）。不要授予公共Gateway权限、Actions写入或组织管理权限。若组织要求批准，先完成批准。GitHub读取Token只放Worker Secret，不能放设备配置。

## 本地设备配置

```sh
bun install --frozen-lockfile
umask 077
mkdir -p .wrangler/private
bun run device:new phone-header bearer /v1/private/loon/example.list > .wrangler/private/phone.json
```

文件内有一次显示的Token和device条目，只在私人终端查看。将device条目加入DEVICE_AUTH的devices数组，把Token送到该设备私有配置；配置须包括disabled_paths数组。输出保存在忽略目录，文件权限应为600，使用后移到凭据管理器或删除，不要提交。

需要多个客户端格式时，在命令末尾添加其精确API路径。不提供通配授权。URL兼容设备用独立id和`url`参数再生成一次；显式把wrangler.jsonc的ALLOW_URL_TOKENS改为true。支持Header的设备优先Bearer。不要复用同一Token的摘要到两种transport（配置会拒绝重复摘要）。

本地复制.dev.vars.example到.dev.vars并填入GITHUB_READ_TOKEN和完整DEVICE_AUTH JSON。私人资源要求HTTPS；本地认证下载使用`bun run dev --local-protocol https`，在测试客户端信任Wrangler本地证书。默认空devices配置刻意不可用。`bun run dev`即可启动；health正常不代表上游或认证已配置。不要把真实私人响应写入公共目录，不在本地URL模式下使用真实Token（Wrangler访问日志可能回显URL）。

## Cloudflare初始化与运行时Secrets

使用仅目标账户的Workers Scripts编辑权限API Token；绑定路由时另按实际操作配置Zone Workers Routes权限，勿用Global API Key。CLOUDFLARE_ACCOUNT_ID显式选择账号，凭据通过受保护的终端环境/凭据管理注入，不写源码。Paid配置CPU上限3000ms；本次未验证账户计划。

运行前核对：

```sh
bun run check
bun audit
bunx wrangler whoami
bunx wrangler versions upload --help
```

把两个运行时Secrets组织为受保护JSON文件，例如`.wrangler/private/runtime.json`，只有GITHUB_READ_TOKEN和DEVICE_AUTH两个字符串字段；每个Secret值须按UTF-8计不超过5000字节，DEVICE_AUTH建议压缩JSON，设备数取决于路径/ID长度；文件权限600，不使用会展开环境变量的非受信任dotenv。

**首次创建（只在验收后由维护者执行）**：确认目标账号下尚无同名Worker，配置中没有routes/domains，workers_dev=false且preview_urls=false。Wrangler的版本上传不能创建不存在的Worker，先创建一个没有公开入口的初始部署：

```sh
bunx wrangler deploy --name proxykit-gateway --keep-vars --strict \
  --secrets-file .wrangler/private/runtime.json
```

这一步会创建Worker及初始部署，但不发布域名路由或workers.dev入口；不是无副作用的dry run。本次实现没有执行此命令。已有同名Worker不能照搬首次创建流程，须先核对远端配置与归属。

**Worker存在后的候选更新**：上传新代码和Secrets为候选版本，不立即切换流量：

```sh
bunx wrangler versions upload --name proxykit-gateway --keep-vars --strict \
  --secrets-file .wrangler/private/runtime.json
```

检查版本绑定、Secrets名称、变量、Paid计划以及路由配置；确认候选版本后显式100%激活输出的版本：

```sh
bunx wrangler versions deploy WORKER_VERSION_ID@100% --name proxykit-gateway
```

本仓库默认没有域名路由。维护者通过单独已审查的配置变更添加自己的自定义域名/路由，或有意启用workers.dev；不要将示例gateway.example.com原样部署。确认无Cache Everything、无查询日志/追踪、无未经验证的前置缓存。`keep_vars=true`保留未在配置内声明的dashboard变量；ALLOW_URL_TOKENS由已审查配置显式管理。`--strict`拒绝冲突的远端配置变化，不应为方便去掉该保护。Wrangler普通部署保留已有Secrets，不从Actions覆盖运行时Secret值。

## 轮换与撤销

生成新的设备凭据条目，私下编辑完整DEVICE_AUTH JSON，然后用版本Secret命令交互输入（避免值出现在进程参数）：

```sh
bunx wrangler versions secret put DEVICE_AUTH --name proxykit-gateway
# 核验返回的版本，再100%激活
bunx wrangler versions deploy WORKER_VERSION_ID@100% --name proxykit-gateway
```

需要临时双凭据时用不同id；更新设备后删除旧条目并再次100%激活。单设备紧急撤销设置enabled=false或移除；全局停用某订阅把精确路径放入disabled_paths。验证旧Token返回401，已授权停用路径410。每次请求检查当前Secret，不因缓存跳过；平台传播期间和在途请求无法保证瞬时撤回。不要渐进分流旧Secret版本。GitHub Origin Token轮换独立进行，同样使用版本Secret流程。

`wrangler secret put/delete`会直接发布新版本；需要先审核时使用上面的versions命令。不要把Cloudflare API Token、GitHub PAT、设备明文混为一种凭据。

## 手动Actions部署

只在完成首次初始化后使用。GitHub production环境保存CLOUDFLARE_API_TOKEN、CLOUDFLARE_ACCOUNT_ID，建议环境必需审批和只允许main。GITHUB_READ_TOKEN、DEVICE_AUTH留在Worker中，不能放公开CI或PR Secrets。

main上的Deploy production (manual)工作流需要confirmation=`deploy-proxykit-gateway`，先执行完整检查/审计，再在production环境检查目标Worker已存在且两个运行时Secret名称齐全，最后严格部署。名称检查不证明Secret值有效；部署后仍须执行401/403/410及允许请求的烟雾验证。不会自动在main push或PR时部署。禁止绕过失败CI或Security Review。初始PR未触发该工作流。

## 校验、故障和回滚

授权下载使用私有终端，先从私人维护流程取得目标dist Manifest摘要，检查响应X-Distribution-Commit等于该dist SHA，再以`sha256sum`和`wc -c`对照对应条目。ETag包含同一SHA-256；校验原始字节，SRS不得文本重编码。Manifest不通过公开HTTP提供。

503：用X-Request-Id关联脱敏category。upstream_rate_limit遵守Retry-After；upstream_unavailable可能是权限、分支不存在或GitHub故障；contract_rejected/snapshot_rejected表示完整性/契约/规模不满足；auth_configuration/origin_configuration检查Secrets。不要临时打印GitHub响应。GitHub404可能是未发布或权限不足，不能据此断言私人仓库不存在；用既有gh身份先检查认证及仓库权限。不得回退公开Raw URL或猜测main产物。

规则回滚遵循私人publishing.md：在受控私人checkout核对历史快照的全部摘要和来源，将历史完整树恢复到当前dist、普通提交并push，保留历史，不force。停下竞争发布任务再操作，持久回滚需另行PR调整main。Gateway每次解析dist，不按SHA字典序判断新旧。网关代码回滚不能恢复已撤销的旧DEVICE_AUTH；选择保留最新Secret的版本并核对再激活。

## 中国大陆可达性验收

从实际移动/宽带网络分别测试DNS解析、TLS握手、health、401及授权四类下载；在不同运营商/时段测成功率、延迟、二进制摘要及后续更新。健康检查通过不代表规则更新成功，也不证明代理客户端使用相同网络路径。记录脱敏状态/耗时/摘要匹配结果，不保存URL凭据、正文或真实地址。实际用户域名、路由、运营商和客户端未在本次环境验证；有问题先判断DNS/TLS/Cloudflare链路，再决定接入方式，不承诺workers.dev在大陆可达。
