# 给 Agent 的操作说明（贴进 CLAUDE.md / AGENTS.md / 系统提示）

你可以用 `hly` 命令替用户操作汇联易（企业报销系统）。永远加 `--json`。失败时 stderr 是一行 JSON `{"error":{code,message,hint}}`，先照 `hint` 做；退出码 2 是你参数传错，3 是凭证问题（告诉用户，不要重试）。

## 凭证

- 不要在对话里要用户的 appSecret。让用户把凭证放在文件里，然后你用 `--credential-file <路径>`，或者用户已经 `hly auth login` 过，你用 `--as <身份名>`。
- 多个人共用你时，每条命令都显式带 `--as` 或 `--credential-file`，不要依赖默认身份。
- 开始前跑 `hly --json whoami` 确认是谁、哪个公司、凭证来自哪里。

## 替员工报销

1. 收集：报销单表单编码（`--form`，不知道就问用户或让管理员查；别猜）、事由、每笔费用的 类型 / 金额 / 日期 / 商户或备注 / 发票信息。
2. `hly expense-types` 看类型 code；标了"需发票"的必须有 `invoice.no`。
3. 先 `hly expense create ... --dry-run`，把请求体里的金额、类型、日期复述给用户确认。
4. 确认后去掉 `--dry-run` 执行。想一步提交就加 `--submit`；返回里 `submitted:false` 时看 `labels[].toast`（超标、超申请等）和 `submitError`，告诉用户。
5. 出差前先 `hly request create` / `hly travel create` 走申请，批准后报销时带 `--reference <申请单号>`；`hly request approved` 列出可关联的申请单。

## 替审批人审批

1. `hly --as <审批人> inbox` 拿待办：单号、单据类型（`entityType`）、申请人、金额、事由。
2. 把要点摘要给用户，**等用户明确说通过或驳回**再执行。
3. `approve <单号> --type <expense|application|...>`，`--type` 必须和待办里的 `entityType` 一致（1002 报销单 → expense，1001 申请单 → application）。
4. 驳回必须带 `--comment` 原因。

## 替老板 / 财务查花费

- `hly spend summary --from --to --by type|employee|month [--status 1002,1003]`：默认统计待审批 + 流程结束的费用，`--status 1003` 只看已走完流程的。
- `hly spend items` 逐笔；`hly spend unreimbursed --employee-id` 看某人待报销。
- 回答时说明口径（状态、时间范围），金额按币种分开说。

## 红线

- 不编造发票号、金额、表单编码。
- 创建并提交、审批通过、驳回之前必须得到用户确认。
- 不把 appSecret、AccessToken 写进回复。
