# hly-cli

汇联易（Huilianyi）开放 API 的命令行封装，**给 AI Agent 用**。让 Claude Code、Codex、OpenClaw 或任何能跑命令的 Agent 替人：

- 员工：提报销单、提费用申请 / 差旅申请、查自己的单据
- 管理层：看待办、审批通过 / 驳回
- 老板 / 财务：按费用类型、员工、月份汇总花费，看逐笔明细

**同一台机器、同一个 Agent，不同的人用各自的凭证**：凭证按每次调用解析，谁给的凭证就以谁的身份调用，不会串。

汇联易官方只提供面向 ERP 对接的 HTTP API，没有 CLI、没有 MCP、没有给 Agent 的文档。本项目补这一层。MIT 开源。

---

## 凭证：你需要什么

汇联易开放 API 的鉴权是**企业级**的，不是个人账号：

| 东西 | 从哪来 | 给谁 |
|---|---|---|
| `appId` / `appSecret` | 公司管理员在 汇联易后台 → 设置 → 安全设置 | 公司 |
| `employeeId`（工号） | 你自己的工号 | 个人 |
| 接口权限 | 管理员在汇联易侧为该应用开通（创建报销单、审批操作、费用查询等） | 公司 |

CLI 用 `appId:appSecret` 走 `client_credentials` 换 AccessToken（`POST /oauth/token`），之后所有请求带 `Authorization: Bearer`，并在请求体里以 `employeeId` 指明"以谁的身份"。

> **安全提醒**：`appSecret` 是公司级密钥，拿到它的人技术上可以以任何工号操作。"每人用自己的凭证"在本工具里是约定，不是汇联易侧的强制隔离。建议：只把 secret 放在凭证文件里（权限 600），不要写进 Agent 的提示词或聊天记录；由管理员分发；离职就换 secret。

---

## 安装

需要 Node ≥ 20。

```bash
git clone <本仓库> && cd hly-cli
pnpm install && pnpm build
npm link        # 得到全局命令 hly
```

或直接 `node bin/hly.js ...`。

---

## 五分钟上手

**1. 保存一份身份**（每个人在自己的机器 / 自己的凭证文件里做一次）：

```bash
hly auth login --app-id <appId> --app-secret <appSecret> --employee E001
```

会调一次接口校验，并按姓名保存为 profile（`~/.config/hly/config.json`，权限 600）。再保存第二个人不会抢默认身份，使用时加 `--as 张经理`。

**2. 看看我是谁**：

```bash
hly whoami
```

**3. 报销**：

```bash
hly expense-types                       # 看费用类型 code、哪些要发票
hly expense create --form ER_DAILY --title "11月上海出差" --submit \
  --item '{"type":"TRAVEL_HOTEL","amount":800,"date":"2026-11-02","comment":"如家","invoice":{"no":"19237929","code":"031001900104","date":"2026-11-02","checkCode":"455927"}}' \
  --item '{"type":"TAXI","amount":46.5,"date":"2026-11-02","comment":"机场到酒店"}'
```

`--form` 是报销单表单编码，在汇联易后台"表单管理"里看，或问管理员；不知道的话先 `--dry-run` 看请求体。

**4. 审批**（经理的凭证）：

```bash
hly --as 张经理 inbox
hly --as 张经理 approve ER00000123 --comment ok
hly --as 张经理 reject  ER00000124 --comment "打车缺备注"
```

**5. 老板查花费**：

```bash
hly --as 老板 spend summary --from 2026-11-01 --to 2026-11-30 --by type
hly --as 老板 spend summary --by employee
hly --as 老板 spend items --status 1003 --limit 50
```

---

## 凭证怎么传：六种方式，按优先级

| 优先级 | 方式 | 适合 |
|---|---|---|
| 1 | `--app-id --app-secret --employee [--base-url] [--company]` | 一次性 |
| 2 | `--credential-file person.json` | **推荐给 Agent**：密钥不进命令行和日志 |
| 3 | `HLY_APP_ID` `HLY_APP_SECRET` `HLY_EMPLOYEE_ID` `HLY_BASE_URL` `HLY_COMPANY_CODE` | 容器 / CI |
| 4 | `HLY_CREDENTIAL_FILE=person.json` | 给 Agent 进程注入 |
| 5 | `--as <name>` / `HLY_PROFILE=<name>` | 本机多人 |
| 6 | 配置文件里的默认 profile | 单人 |

各层可以叠加：例如 profile 提供 appId/appSecret，命令行只用 `--employee E002` 换人。`hly whoami` 会告诉你本次凭证来自哪一层。

凭证文件格式：

```json
{ "appId": "…", "appSecret": "…", "employeeId": "E001", "baseUrl": "https://api.huilianyi.com/gateway", "companyCode": "GEEK" }
```

AccessToken 按 `baseUrl + appId` 缓存在 `~/.config/hly/cache/`，过期前自动复用，401 自动刷新一次。

---

## 命令总览

```
hly auth login|list|use|logout|token
hly whoami                      hly employee <工号>
hly expense-types [--all] [--keyword]
hly expense create|submit|show|list
hly request create|submit|show|list|approved      # 费用申请单
hly travel  create|submit                         # 差旅申请单
hly inbox [--done] [--type expense|application|...]
hly approve <单号> [--type] [--comment]
hly reject  <单号> [--type] --comment <原因> [--reject-type 1|2]
hly spend summary|items|unreimbursed
hly api <METHOD> <path> [--params json] [--data json]   # 任意开放接口，自动带 token
```

全局：`--json`（Agent 请始终加）、`--verbose`（HTTP 日志到 stderr）、以及上面的凭证选项。

退出码：`0` 成功，`1` 业务 / 网络错误，`2` 参数错误，`3` 凭证错误。错误是 stderr 上一行 JSON：`{"error":{"code","message","hint","status","raw"}}`，`hint` 里是修复建议。

### `expense create` 的明细 JSON

```json
{
  "type": "TRAVEL_HOTEL",            // 费用类型 code（hly expense-types）
  "amount": 800,
  "date": "2026-11-02",              // YYYY-MM-DD，按东八区转 UTC；或直接给 ISO 时间
  "currency": "CNY",                 // 可省
  "comment": "如家",
  "owner": "E002",                   // 费用归属人，可省（默认申请人）
  "invoice": { "typeNo": "04", "no": "发票号", "code": "发票代码", "date": "2026-11-02", "checkCode": "校验码后6位", "amountWithoutTax": 754.72 },
  "fields": { "helios.city": "上海", "helios.participants": "[{\"employeeID\":\"E002\"}]" }   // 费用自定义控件 messageKeyCode → value
}
```

单据头的自定义控件用 `--field code=value`（如 `--field department=1002 --field remark=xx`）。`--reference EA…` 关联已批准的申请单。`--submit` 等于汇联易的 `autoSubmit`，提交失败时默认 `autoDelete` 删掉草稿，加 `--no-auto-delete` 保留。

时区：日期转换默认东八区，`HLY_TZ_OFFSET=480` 可改。

---

## 对应的汇联易接口

| 命令 | 接口 |
|---|---|
| `auth token` | `POST /oauth/token`（Basic appId:appSecret，`grant_type=client_credentials&scope=write`） |
| `whoami` / `employee` | `GET /api/open/user/detail/{employeeId}` |
| `expense-types` | `GET /api/open/expenseType` |
| `expense create` / `submit` / `show` / `list` | `POST /api/open/expenseReport/create` / `…/submit`，`GET …/detail`，`GET /api/open/expenseReport` |
| `request create` / `submit` / `show` / `list` / `approved` | `POST /api/open/expenseApplication/create` / `…/submit`，`GET …/detail`，`GET /api/open/expenseApplication`，`GET /api/open/application/by/user` |
| `travel create` / `submit` | `POST /api/open/travelApplication/create` / `…/submit` |
| `inbox` | `POST /api/open/batch/approval` |
| `approve` / `reject` | `POST /api/open/approvals/pass` / `…/reject`（operator = approver = 当前工号） |
| `spend summary` / `items` | `GET /api/open/invoice`（翻页抓全后本地聚合） |
| `spend unreimbursed` | `POST /api/open/invoice/query/unreimbursed/expenses` |

文档：<https://opendocs.huilianyi.com/>。生产域名 `https://api.huilianyi.com/gateway`。

### 已知不确定点（没有真实租户，无法验证的部分）

- token 接口的路径取自官方 SDK 的用法（`/oauth/token`，相对 base url）。如果你的环境 base url 不同，用 `--base-url` 改；`hly auth token --refresh` 可单独验证。
- `expense list` / `request list` 的响应，有的租户返回裸数组，有的包在 `data` 里；CLI 两种都处理。
- `expense show` 里的审批历史字段名（`operatorName` / `operationTypeName`）按文档示例推断，若你的返回不同，`--json` 里有 `raw` 原始数据。
- 差旅申请的行程结构有三种模式（itineraryMap / itineraryHeadDTOs / 一屏式），CLI 用"行程卡片按日程"模式；别的模式请走 `hly api` 直接传。

遇到不一致欢迎提 issue，附 `--verbose --json` 的输出（记得抹掉 token）。

---

## 本地试玩（不需要汇联易账号）

仓库带一个按官方文档行为写的 mock 服务：

```bash
pnpm mock            # http://localhost:9797，appId=demo-app secret=demo-secret，员工 E001 李工 / M001 张经理 / F001 财务 / B001 老板
hly --base-url http://localhost:9797 --app-id demo-app --app-secret demo-secret --employee E001 whoami
pnpm test            # 14 个端到端场景：四种传凭证方式、报销、两级审批、申请单、花费汇总、token 缓存
```

---

## 给 Agent 的说明

见 [docs/AGENT.md](docs/AGENT.md)，可直接贴进 CLAUDE.md / AGENTS.md。

## 项目结构

```
src/config.ts   凭证解析（六层优先级）、profile 存储
src/hly.ts      汇联易 API 客户端：token 缓存、统一请求、各接口薄封装、状态码表
src/cli.ts      命令
test/mock-server.ts   mock 汇联易
test/e2e.ts     端到端测试
```
