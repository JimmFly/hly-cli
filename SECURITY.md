# 安全说明

## 信任模型

汇联易开放 API 只有企业级凭证（appId / appSecret）。持有它的进程可以用任何工号发起操作。hly-cli 不能、也不试图在这一层做身份校验；"替谁办"由调用它的 Agent 根据渠道（如飞书实名）决定。请只在**公司自己运营、可信的 Agent 进程**里部署本工具，不要把 appSecret 分发给个人。

## 本工具做的防护

- 凭证文件与 token 缓存写入 `~/.config/hly/`，目录 700、文件 600
- `--json` / `--verbose` 输出不包含 appSecret 和完整 access_token
- 全公司数据（花费查询、`--all`、`employee list`、`hly api`）受每租户 `spendAllowlist` 限制；单据详情只许本人、审批链上的人、名单内的人；审批由汇联易校验当前审批人
- `expense create`、`request create`、`travel create` 支持 `--dry-run`，只打印请求体不发送；和 `--submit` 一起用时同样只预演。不带 `--dry-run` 的 `create --submit` 会真的创建并提交。
- **独立的 `expense submit`、`request submit`、`travel submit`、`approve`、`reject` 没有 `--dry-run`，会直接调用汇联易接口**，Agent 必须在执行前取得用户确认
- 凭证文件约定放在 `credentials/`（已在 `.gitignore`），模板见 `credentials/company.example.json`；`.gitignore` 不能代替密钥管理，提交前仍要自查

## 报告漏洞

请不要公开提 issue。发邮件到仓库作者（GitHub 主页），说明复现步骤。会在 7 天内回复。
