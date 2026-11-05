# 安全说明

## 信任模型

汇联易开放 API 只有企业级凭证（appId / appSecret）。持有它的进程可以用任何工号发起操作。hly-cli 不能、也不试图在这一层做身份校验；"替谁办"由调用它的 Agent 根据渠道（如飞书实名）决定。请只在**公司自己运营、可信的 Agent 进程**里部署本工具，不要把 appSecret 分发给个人。

## 本工具做的防护

- 凭证文件与 token 缓存写入 `~/.config/hly/`，目录 700、文件 600
- `--json` / `--verbose` 输出不包含 appSecret 和完整 access_token
- 花费查询受每租户 `spendAllowlist` 限制；审批由汇联易校验当前审批人
- 所有写操作有 `--dry-run`

## 报告漏洞

请不要公开提 issue。发邮件到仓库作者（GitHub 主页），说明复现步骤。会在 7 天内回复。
