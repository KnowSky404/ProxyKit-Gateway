# ProxyKit-Gateway 工程约束

- 只在独立任务 worktree/分支开发；开始前检查状态并 fetch 目标分支。保留无关修改。提交使用 Conventional Commits，完成验证后创建 PR，不直接写 main。
- 每次 push、创建 PR 前运行本地 `codex review --base origin/main`；有未提交变更时另运行 `codex review --uncommitted`。修复有效发现后重新验证和审查。审查必须覆盖最新完整差异，不以 CI 代替本地审查。
- PR 创建/更新后检查 CI、review、行内/普通评论及自动触发的 Security Review。已触发的 Security Review 必须覆盖最新 head 并完成，问题必须处理。禁止手动请求远程机器人审查；未自动触发时不新增该门禁。
- 满足本地审查、CI、所需审批、Security Review（若自动触发）且无冲突后，以 `gh pr merge --rebase --match-head-commit <sha> --delete-branch` 合并。不得绕过失败检查、使用管理员合并或裸 force。合并确认后清理本任务分支/worktree，安全 fast-forward 主工作区。
- GitHub 操作用认证 gh（先 `gh auth status`），Git 传输仍使用 git。PR/issue 正文使用临时文件和 `--body-file`，不内联 Markdown。
- TypeScript strict、Workers 原生 API、Bun 锁文件、固定依赖和 Actions SHA。此工程有 wrangler.jsonc，使用项目本地 Wrangler；绑定类型必须由 `bun run types` 生成，不能手写修改生成文件。
- 变更后执行 `bun run check`、`bun audit`、`bunx wrangler types --strict-vars=false --check`。新增非平凡逻辑须有回归测试。测试仅用保留域名、文档网段和合成字节，不依赖真实 Token/私人规则。
- 顺序不可改变：基本路由检查 → 设备认证 → 精确路径授权/停用 → 固定 GitHub Provider。任何缓存命中和 304 也必须鉴权。GitHub 凭据不得返回给设备。
- 遵守 docs/architecture.md 中的私人 Schema v1 和规模上限。绑定 dist SHA，验证完整快照之后才能提供任何文件。不能因规模、超时、上游错误、损坏或未知 Schema 跳过校验。
- 不输出原始异常、URL/query、Header、Token、私人正文/名称/地址或 GitHub 响应。只记录固定错误类别、状态和随机 requestId。保持 query 脱敏、invocation logs 和 traces 关闭，启用前须重新评估 URL 凭据泄漏。
- 所有凭据用 Secret Binding；不提交 .dev.vars/.env、下载结果、临时文件、真实数据，不上传私人 Actions Artifact。不要修改 ProxyKit、ProxyKit-Private 或 dist。
- 不增加规则生成器、SRS 编译、框架、数据库、管理页面或未使用的存储。部署只允许显式手动操作，首次初始化不部署生产。运行时 Secret 与 Actions 部署凭据独立管理。
