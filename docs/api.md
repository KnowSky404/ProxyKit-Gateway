# API v1

| 路径                                                                  | 类型                                          |
| --------------------------------------------------------------------- | --------------------------------------------- |
| `/v1/private/loon`、`/v1/private/quantumultx`、`/v1/private/sing-box` | JSON资源列表（需鉴权）                        |
| `/v1/health`                                                          | JSON `{ "status": "ok" }`；无鉴权、无私人状态 |
| `/v1/private/loon/<name>.list`                                        | text/plain; charset=utf-8                     |
| `/v1/private/quantumultx/<name>.list`                                 | text/plain; charset=utf-8                     |
| `/v1/private/sing-box/<name>.json`                                    | application/json                              |
| `/v1/private/sing-box/<name>.srs`                                     | application/octet-stream                      |

仅GET/HEAD；其他已知路由方法405并返回Allow。仅提供上述三个客户端集合与具体文件；不公开Manifest、仓库根目录、任意仓库/ref/path/upstream参数或开放代理。名称按架构文档限制，路径不解码后再拼接。URL标准解析器可能在Worker收到请求前归一化点段；任何归一化后的有效路径仍要独立授权，其余编码/非法路径404。

设备可用 `paths: ["*"]` 访问固定私人仓库内全部当前及未来的已验证规则，也可使用精确路径列表。仓库范围设备访问未发布或已删除的合法路径返回404；不提供任意文件读取。新增/删除规则以已校验的 `dist` 版本为准，默认缓存窗口内允许约60秒延迟，通常无需更新 Worker 或设备授权。

推荐 `Authorization: Bearer DEVICE_TOKEN_PLACEHOLDER`。可选 `?key=DEVICE_URL_TOKEN_PLACEHOLDER` 需要ALLOW_URL_TOKENS=true和transport=url的独立设备摘要。两种凭据不能互用；同时提供Header和key、重复key、错误Header均401，不降级。除key之外的query参数404。HEAD执行与GET相同的认证和授权；列表验证Manifest并过滤可见资源，具体文件还验证目标正文，返回相同元数据及Content-Length但无正文。

| 状态 | 行为                                                                       |
| ---- | -------------------------------------------------------------------------- |
| 200  | 通过校验的文件、按设备过滤的资源列表，或无敏感内容的health                 |
| 304  | 仅在鉴权、授权、当前版本必要校验/过滤完成后，If-None-Match命中响应摘要     |
| 400  | 私人资源必须使用HTTPS；不重定向携带凭据的HTTP请求                          |
| 401  | 缺失、错误、撤销、禁用凭据或不允许的凭据传输模式                           |
| 403  | 有效凭据没有目标路径权限，或在所请求客户端下没有任何授权路径               |
| 404  | 无效路由，或已授权路径不存在于当前 Manifest                                |
| 405  | 已知路由不支持的方法                                                       |
| 410  | 有效且有权限的设备访问显式disabled_paths订阅                               |
| 503  | 配置不合法、Manifest无效或目标文件不可用、上游错误/限流/超时或内容不合契约 |

客户端集合同时接受有/无末尾 `/` 的路径，不通过重定向携带KEY。示例（占位凭据）：

```text
GET /v1/private/loon?key=DEVICE_URL_TOKEN_PLACEHOLDER
```

```json
{
  "resources": [
    { "name": "example.list", "path": "/v1/private/loon/example.list" }
  ]
}
```

列表只返回当前客户端的资源，按Manifest顺序排列。`sing-box`包含`.json`和`.srs`两种格式。仓库范围设备可看到全部未停用资源；精确路径设备只看到其授权且未停用的文件，没有该客户端的任何授权路径则403。授权路径全部被停用、删除或尚未发布时返回200及空`resources`数组。目录本身不加入`paths`或`disabled_paths`，两者继续使用现有精确文件路径或设备仓库范围标记。

列表不回显KEY、GitHub凭据、内部仓库路径或未授权的名称。`path`是无凭据的站点路径，获取具体内容时须继续携带同一`key`或Bearer凭据。响应列出当前已验证Manifest的声明，不预先下载或保证每个目标正文可用；具体GET/HEAD仍做原有文件校验。列表冷读取3次上游调用（ref/tree/Manifest），有效期内命中0次；到期后同版本仅查ref 1次，原有最近文件字节缓存继续有效。新增/删除发布和每次鉴权、HEAD/304、安全响应头规则同样适用于列表。

每次仅下载所请求的产物正文。冷读取有固定4次上游调用（ref/tree/Manifest/目标文件）；元数据有效期内换文件1次，同文件缓存命中0次；未请求文件正文的损坏或缺失不影响目标文件。Manifest全局结构错误或目标文件损坏仍返回503。

元数据有效期由 `METADATA_CACHE_TTL_SECONDS` 配置，默认60秒，0恢复每次检查版本。命中不续期；新增/修改/删除可以在窗口内延迟可见。设备鉴权、授权和停用每次执行，缓存过期刷新失败返回503，不能用过期数据返回200/304。客户端不能通过query参数改变TTL。

错误JSON只含固定error和随机request_id；503统一为unavailable，不回显GitHub错误。401含WWW-Authenticate。基本路由错误在鉴权前返回；只有通过路径授权才访问私人资源。有效凭据未授权的不存在名称也返回403，不泄露集合存在性。

文件ETag格式为`"sha256-<manifest digest>"`；列表ETag为过滤后JSON响应字节的SHA-256，权限或停用变化先重新过滤再比较，支持If-None-Match列表、弱标签及`*`；不实现Range/分片下载。200/HEAD/304带X-Distribution-Commit便于已授权方追踪dist，未授权响应不暴露版本。所有响应含private,no-store、nosniff、no-referrer、严格CSP、HSTS；不设置宽松CORS，不使用Cookie或Cache API。503限流可带经解析的Retry-After。
