# 参与贡献

## 开发

```bash
pnpm install
pnpm test          # 构建 + 启动 mock 汇联易 + 端到端测试
pnpm mock          # 本地起一个 mock，手动试 hly --base-url http://localhost:9797 ...
```

代码在 `src/`：`config.ts` 凭证与租户，`hly.ts` API 客户端，`cli.ts` 命令。mock 在 `test/mock-server.ts`，按官方文档的路径和响应结构写；加接口时先补 mock 再补测试。

## 提 issue 最有用的信息

- 跑失败的完整命令，带 `--json --verbose`（**抹掉 token 和 appSecret**）
- 你那边汇联易真实返回的 JSON（抹掉人名工号也行），尤其是和 README「已知不确定点」相关的
- 汇联易文档页链接

## 加一个新接口

1. 在 `src/hly.ts` 加一个薄方法（路径、参数名照文档）
2. 在 `src/cli.ts` 加命令：支持 `--json`，错误走 `HlyError` 并给 `hint`
3. mock 加路由，`test/e2e.ts` 加一个场景
4. README 的命令总览和接口对照表各加一行

## 约定

- 所有写操作命令都要有 `--dry-run` 或等价的"先看请求体"方式
- 不在任何输出里打印 appSecret / access_token
- 日期对用户用 `YYYY-MM-DD`，对汇联易用它要求的格式，转换集中在 `Hly.toUtc` / `toQueryDate`
