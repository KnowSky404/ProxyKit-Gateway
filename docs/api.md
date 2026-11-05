# API v1

| 路径                                  | 类型                                          |
| ------------------------------------- | --------------------------------------------- |
| `/v1/health`                          | JSON `{ "status": "ok" }`；无鉴权、无私人状态 |
| `/v1/private/loon/<name>.list`        | text/plain; charset=utf-8                     |
| `/v1/private/quantumultx/<name>.list` | text/plain; charset=utf-8                     |
| `/v1/private/sing-box/<name>.json`    | application/json                              |
| `/v1/private/sing-box/<name>.srs`     | application/octet-stream                      |

仅GET/HEAD；其他已知路由方法405并返回Allow。没有Manifest、目录、规则列表、任意仓库/ref/path/upstream参数或开放代理。名称按架构文档限制，路径不解码后再拼接。URL标准解析器可能在Worker收到请求前归一化点段；任何归一化后的有效路径仍要独立授权，其余编码/非法路径404。

推荐 `Authorization: Bearer DEVICE_TOKEN_PLACEHOLDER`。可选 `?key=DEVICE_URL_TOKEN_PLACEHOLDER` 需要ALLOW_URL_TOKENS=true和transport=url的独立设备摘要。两种凭据不能互用；同时提供Header和key、重复key、错误Header均401，不降级。除key之外的query参数404。HEAD执行与GET相同的认证及完整验证，返回相同元数据及Content-Length但无正文。

| 状态 | 行为                                                          |
| ---- | ------------------------------------------------------------- |
| 200  | 通过校验的文件，或无敏感内容的health                          |
| 304  | 仅在鉴权、授权、当前快照验证完成后，If-None-Match命中文件摘要 |
| 400  | 私人资源必须使用HTTPS；不重定向携带凭据的HTTP请求             |
| 401  | 缺失、错误、撤销、禁用凭据或不允许的凭据传输模式              |
| 403  | 有效凭据不具备此精确API路径权限                               |
| 404  | 无效路由，或已授权路径不存在于当前完整快照                    |
| 405  | 已知路由不支持的方法                                          |
| 410  | 有效且有权限的设备访问显式disabled_paths订阅                  |
| 503  | 配置不合法、无可用完整快照、上游错误/限流/超时或内容不合契约  |

错误JSON只含固定error和随机request_id；503统一为unavailable，不回显GitHub错误。401含WWW-Authenticate。基本路由错误在鉴权前返回；只有通过路径授权才访问私人资源。有效凭据未授权的不存在名称也返回403，不泄露集合存在性。

ETag格式为`"sha256-<manifest digest>"`，支持If-None-Match列表、弱标签及`*`；不实现Range/分片下载。200/HEAD/304带X-Distribution-Commit便于已授权方追踪dist，未授权响应不暴露版本。所有响应含private,no-store、nosniff、no-referrer、严格CSP、HSTS；不设置宽松CORS，不使用Cookie或Cache API。503限流可带经解析的Retry-After。
