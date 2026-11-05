# ProxyKit-Gateway 工程约束

## 开发、审查与合并流程

- 所有功能迭代、问题修复、重构、测试、文档、配置及本约束文件的修改，均须使用独立 Git worktree 和任务分支。不得直接在 main 或其他集成/发布分支开发、提交或推送。
- 开始前检查工作区、分支和现有 worktree，fetch 最新目标分支（默认 origin/main），以其创建任务 worktree；同一任务的既有 worktree 可复用。分支使用 feat/、fix/、docs/、chore/ 等前缀，一个任务对应一个分支和 PR。保留无关修改与其他任务的 worktree。
- 每次 push（首次、追加修复及 rebase 后推送）和创建 PR 前，必须先执行本地 Codex `/review`。非交互环境使用 `codex review --base origin/main`（其他目标分支相应替换）；有未提交修改时另用 `codex review --uncommitted` 覆盖。审查须覆盖相对目标分支的最新完整差异，不以普通自查或 CI 替代。
- 逐项修复有效审查发现，补充必要验证并重新审查，直至没有未解决的有效问题；不适用的发现须记录依据。失败、中断或未实际运行的审查不算通过。审查后修改内容、解决冲突或 rebase，必须重新验证和审查；内容及基线未变时，创建 PR 可复用推送前的通过结果。
- 验证与本地审查通过后，使用 Conventional Commits 提交，仅包含当前任务内容；推送任务分支并创建 PR，说明最终行为、验证结果和必要限制。不得直接推送 main。
- PR 创建或更新后检查自动触发的所有 Codex 机器人审查，包括 code review 和 Security Review，以及 review、行内评论、普通评论、审查线程和 CI。已自动触发的审查必须覆盖最新 head 并完成；运行中、失败、只覆盖旧提交或暂时没有评论均不算通过。有效问题必须处理；修复后重新验证、本地审查、推送，并检查新 head 的自动审查。
- 禁止手动触发远程 Codex 机器人，包括评论 `@codex review`、`@codex security review`、为触发审查而重新打开 PR 或切换 draft/ready。没有自动触发机器人时，不新增机器人门禁；本地审查、CI、必要审批通过且无冲突后直接 rebase 合并。
- 合并前重新核验最新 head、自动审查完成状态、未解决问题、CI、必要审批及冲突状态。已触发的审查不可用或无法确认完成时，保留 PR 并报告阻塞；不得绕过失败检查或使用管理员合并。
- 满足门禁后默认继续 `gh pr merge --rebase --match-head-commit <sha>`，无需重复确认；不得改用 merge commit 或 squash。仓库不允许 rebase 时报告阻塞。任务分支必须改写历史时，确认不会覆盖他人提交后才可用 `--force-with-lease`，禁止裸 force；此许可不适用于 main/dist。
- 确认 PR 实际合并后，删除远端任务分支；回到主工作区，核验任务 worktree 干净且内容已纳入目标分支，再移除本任务 worktree、删除本地任务分支，并安全 fast-forward 主工作区。Rebase 后 SHA 不同须核对合并状态及内容，不能仅凭祖先关系强删。存在未提交修改或归属不明内容时保留并说明。
- 交付说明包含验证、本地审查、PR 链接、自动机器人审查是否触发及结果、CI、rebase 合并和分支/worktree 清理状态。不得将等待中或未验证的状态宣称为通过。

## Cloudflare 与工程工具

- Cloudflare 操作统一使用 `cf` CLI，优先复用用户已全局安装的命令和已有认证；先用 `cf --version`、`cf auth whoami` 确认版本、身份与账号。没有实际认证故障时不得重新登录或创建凭据。此项目的明确选择覆盖“存在 Wrangler 配置就继续使用 Wrangler”的通用规则。
- 不再以 Wrangler 作为项目开发、构建、部署、类型生成或 CI 的执行入口。先检查当前 cf 的帮助、schema 和官方文档，不凭记忆翻译命令；不支持的能力须明确报告并寻找 cf 支持的方案，不能默默退回 Wrangler。
- 当前遗留的 wrangler.jsonc、package scripts、测试配置、生成类型和 CI/CD 文档尚需迁移。部署前先按官方迁移指南执行 `cf migrate --dry-run`、审查映射，再迁移并处理全部 TODO；统一为 cloudflare.config.ts，更新全部调用方、测试、类型生成、CI 和文档。不得在未迁移时直接 cf deploy，或让新旧配置同时充当部署真相源。工具内部的传递依赖不等于允许直接执行 Wrangler 命令。
- 部署授权以用户当前指令为准：用户已经允许本次后续部署，可以复用现有 cf 认证，无需再次申请“首次部署”授权。部署前仍须完成迁移、验证与既定审查流程，核对账号、Worker、路由和运行时 Secrets；缺失配置时明确报告，不能使用示例凭据上线、覆盖无关服务或扩张 Token 权限。运行时 Secret 与 Actions 部署身份独立管理。
- GitHub 操作用认证 gh（先 gh auth status），Git 本地操作与传输仍使用 git。PR/issue 正文写入临时文件并使用 --body-file，不将 Markdown 内联 shell。
- 使用 TypeScript strict、Workers 原生 API、Bun 锁文件及固定依赖/Actions SHA。绑定及运行时类型使用官方工具生成，不手工修改生成文件；不引入不必要的 Node 兼容标志或运行时依赖。
- 执行与变更相匹配的格式、类型、单元/集成、安全回归及 cf 构建检查，保留 CI 必需检查，运行依赖安全审计。迁移期间不得为通过检查而削弱验证或执行已禁用的 Wrangler 入口；纯约束/文档修改可采用内容、格式和差异检查，完整 CI 仍须通过。新增非平凡逻辑须有回归测试。

## 私人内容与安全边界

- 顺序不可改变：基本路由检查 → 设备认证 → 精确路径授权/停用 → 固定 GitHub Provider。任何缓存命中和 304 也必须鉴权。GitHub 凭据不得返回给设备。
- 遵守 docs/architecture.md 的私人 Schema v1 与规模上限。绑定同一 dist SHA，验证完整快照之后才能提供任何文件；不能因规模、超时、上游错误、损坏或未知 Schema 跳过校验。
- 不输出原始异常、URL/query、Header、Token、私人正文/名称/地址或 GitHub 响应。只记录固定错误类别、状态和随机 requestId。迁移必须保留查询脱敏、禁用 invocation logs/traces 及其他安全配置，不能因 CLI 差异静默丢弃。
- 所有凭据用 Secret Binding；不提交 .dev.vars/.env、真实数据、下载结果或临时文件，不上传私人 Actions Artifact。测试只用保留数据和合成字节，不依赖真实个人 Token 或私人规则。不修改 ProxyKit、ProxyKit-Private 或 dist。
- 不增加规则生成器、在线 SRS 编译、框架、数据库、管理页面或未使用的存储。保持最小完整实现，不为尚未使用的功能增加代码。
