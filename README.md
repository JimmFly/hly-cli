# hly-cli

汇联易（Huilianyi）开放 API 的命令行封装，**给 AI Agent 用，多租户**。

典型场景：一个绑在飞书上的 Agent，服务一家或多家公司。员工找它填报销单，经理找它审批，老板找它查花费。Agent 从飞书拿到实名身份，翻译成「哪家公司 + 哪个工号」，然后调 `hly`。

```
员工在飞书说"帮我报销上周出差"
   → Agent 拿到说话人的飞书身份（公司、邮箱）
   → hly --tenant 极客科技 employee find --email ligong@geek.cn     # 翻译成工号 E001
   → hly --tenant 极客科技 --employee E001 expense create ...       # 以 E001 的身份提单
```

汇联易官方只提供面向 ERP 对接的 HTTP API，没有 CLI、没有 MCP、没有给 Agent 的文档。本项目补这一层。MIT 开源。

---

## 信任模型（先读这个）

汇联易开放 API 的鉴权是**企业级**的：公司管理员在 汇联易后台 → 设置 → 安全设置 拿到 `appId` / `appSecret`，CLI 用它换 AccessToken，每个请求里用 `employeeId` 声明"替谁办"。API 不校验调用方是不是这个人。

所以：

- **身份由 Agent 的渠道保证**（飞书实名），不由 CLI 保证。CLI 相信 Agent 传进来的 `--employee`。
- **appSecret 只在 Agent 运行的那台机器上**，由运维用 `hly tenant add` 配置。员工、老板都不接触它。
- **审批**有汇联易自己的校验：`approve/reject` 必须是该单当前节点的审批人，否则报错 121935。
- **报销 / 申请**天然按工号归属。
- **花费查询**是唯一没有服务端校验的，CLI 用每家公司的 `spendAllowlist`（财务 / 老板的工号）拦。

这个模型要求 Agent 本身可信（它是公司运营的 Agent，不是员工自己的）。docs/AGENT.md 里写了 Agent 该守的规矩，最重要的一条：永远用说话人自己的工号。

---

## 安装

需要 Node ≥ 20。

```bash
git clone https://github.com/JimmFly/hly-cli && cd hly-cli
pnpm install && pnpm build && npm link     # 得到全局命令 hly
```

---

## 配置：每家公司一条

```bash
hly tenant add --name 极客科技 --app-id <appId> --app-secret <appSecret> \
  --spend-allow B001 --spend-allow F001          # 老板和财务的工号，允许查全公司花费
hly tenant list
hly tenant allow-spend 极客科技 B001 F001 F002    # 之后改名单
```

`tenant add` 会换一次 token 并拉一遍员工表校验凭证。配置在 `~/.config/hly/config.json`（权限 600）；`HLY_CONFIG_DIR` 可改位置。多家公司就多跑几次。

除了 profile，凭证也可以从 `--credential-file <json>`、环境变量 `HLY_APP_ID / HLY_APP_SECRET / HLY_BASE_URL / HLY_COMPANY_CODE`、`HLY_CREDENTIAL_FILE` 给，优先级依次高于 profile，可叠加（例如 profile 给公司凭证，命令行只给 `--employee`）。`hly whoami` 会报告本次凭证来自哪一层。

单人用也可以 `hly auth login --app-id … --app-secret … --employee E001` 把公司和工号绑成一个身份，之后不用每次传 `--employee`。

---

## Agent 怎么调

每条命令：`hly --json --tenant <公司> --employee <工号> <命令>`。

**翻译身份**

```bash
hly --json --tenant 极客科技 employee find --email ligong@geek.cn     # 或 --mobile / --name
hly --json --tenant 极客科技 --employee E001 whoami
```

员工表按公司缓存 24 小时；找不到会自动刷新一次再找。

**员工报销**

```bash
hly --tenant 极客科技 --employee E001 expense-types
hly --tenant 极客科技 --employee E001 expense create --form ER_DAILY --title "11月上海出差" --dry-run \
  --item '{"type":"TRAVEL_HOTEL","amount":800,"date":"2026-11-02","comment":"如家","invoice":{"no":"19237929","code":"031001900104","date":"2026-11-02","checkCode":"455927"}}' \
  --item '{"type":"TAXI","amount":46.5,"date":"2026-11-02","comment":"机场到酒店"}'
# 用户确认后去掉 --dry-run，加 --submit
```

`--form` 是报销单表单编码，在汇联易后台"表单管理"里看。

**经理审批**

```bash
hly --tenant 极客科技 --employee M001 inbox
hly --tenant 极客科技 --employee M001 approve ER00000123 --comment ok
hly --tenant 极客科技 --employee M001 reject  ER00000124 --comment "打车缺备注"
```

**老板查花费**

```bash
hly --tenant 极客科技 --employee B001 spend summary --from 2026-11-01 --to 2026-11-30 --by type
hly --tenant 极客科技 --employee B001 spend summary --by employee
hly --tenant 极客科技 --employee B001 spend items --status 1003 --limit 50
```

不在名单里的工号调 `spend` 会得到退出码 3 和 `forbidden`。

---

## 命令总览

```
hly tenant add|list|allow-spend|remove          # 公司凭证
hly auth login|list|use|logout|token            # 单人模式：公司 + 工号绑成一个身份
hly whoami
hly employee find|show|list                     # 飞书身份 → 工号
hly expense-types [--all] [--keyword]
hly expense create|submit|show|list
hly request create|submit|show|list|approved    # 费用申请单
hly travel  create|submit                       # 差旅申请单
hly inbox [--done] [--type expense|application|...]
hly approve <单号> [--type] [--comment]
hly reject  <单号> [--type] --comment <原因> [--reject-type 1|2]
hly spend summary|items|unreimbursed            # 受 spendAllowlist 限制
hly api <METHOD> <path> [--params json] [--data json]   # 任意开放接口，自动带 token
```

全局：`--json`（Agent 请始终加）、`--verbose`（HTTP 日志到 stderr）、`--tenant` / `--as`、`--employee`、`--credential-file`、`--app-id` / `--app-secret` / `--base-url` / `--company`。

退出码：`0` 成功，`1` 业务 / 网络错误，`2` 参数错误，`3` 凭证 / 权限错误。错误是 stderr 上一行 JSON：`{"error":{"code","message","hint","status","raw"}}`，`hint` 里是修复建议。

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

单据头的自定义控件用 `--field code=value`。`--reference EA…` 关联已批准的申请单。`--submit` 等于汇联易的 `autoSubmit`，提交失败时默认 `autoDelete` 删掉草稿，加 `--no-auto-delete` 保留。时区默认东八区，`HLY_TZ_OFFSET=480` 可改。

---

## 对应的汇联易接口

| 命令 | 接口 |
|---|---|
| `auth token` / 所有命令 | `POST /oauth/token`（Basic appId:appSecret，`grant_type=client_credentials&scope=write`） |
| `employee find/list` | `GET /api/open/user`（翻页抓全，缓存） |
| `employee show` / `whoami` | `GET /api/open/user/detail/{employeeId}` |
| `expense-types` | `GET /api/open/expenseType` |
| `expense create/submit/show/list` | `POST /api/open/expenseReport/create`、`…/submit`，`GET …/detail`，`GET /api/open/expenseReport` |
| `request create/submit/show/list/approved` | `POST /api/open/expenseApplication/create`、`…/submit`，`GET …/detail`，`GET /api/open/expenseApplication`，`GET /api/open/application/by/user` |
| `travel create/submit` | `POST /api/open/travelApplication/create`、`…/submit` |
| `inbox` | `POST /api/open/batch/approval` |
| `approve` / `reject` | `POST /api/open/approvals/pass`、`…/reject`（operator = approver = `--employee`） |
| `spend summary/items` | `GET /api/open/invoice`（翻页抓全后本地聚合） |
| `spend unreimbursed` | `POST /api/open/invoice/query/unreimbursed/expenses` |

文档：<https://opendocs.huilianyi.com/>。生产域名 `https://api.huilianyi.com/gateway`。AccessToken 按 `baseUrl + appId` 缓存在 `~/.config/hly/cache/`，过期前复用，401 自动刷新一次。

### 已知不确定点（没有真实租户，无法验证）

- token 接口路径取自官方 SDK 的用法（`/oauth/token`，相对 base url）。不对的话用 `--base-url` 改；`hly auth token --refresh` 可单独验证。
- 列表接口的响应，有的租户返回裸数组，有的包在 `data` 里；CLI 两种都处理。
- `expense show` 的审批历史字段名按文档示例推断；`--json` 里有 `raw` 原始数据。
- 差旅申请的行程有三种模式，CLI 用"行程卡片按日程"；别的模式走 `hly api`。

遇到不一致请提 issue，附 `--verbose --json` 输出（抹掉 token）。

---

## 本地试玩（不需要汇联易账号）

```bash
pnpm mock      # http://localhost:9797，appId=demo-app secret=demo-secret，员工 E001 李工 / M001 张经理 / F001 财务 / B001 老板
hly tenant add --name demo --base-url http://localhost:9797 --app-id demo-app --app-secret demo-secret --spend-allow B001
hly --tenant demo --employee E001 whoami
pnpm test      # 16 个端到端场景
```

## 项目结构

```
src/config.ts        凭证解析（六层优先级）、租户 profile 存储
src/hly.ts           汇联易 API 客户端：token 缓存、统一请求、员工表缓存、各接口薄封装
src/cli.ts           命令
test/mock-server.ts  按官方文档行为写的 mock 汇联易
test/e2e.ts          端到端测试
docs/AGENT.md        给 Agent 的操作规矩
```
