#!/usr/bin/env node
// hly — 汇联易开放 API 的命令行封装，给 AI Agent 用。
// 约定：所有命令支持 --json；错误走 stderr 的 JSON + 非零退出码（2 参数错误，3 凭证/权限，1 其他）。
import { Command, Option } from 'commander';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { Hly, ENTITY_TYPES, ENTITY_NAMES, REPORT_STATUS, APPLICATION_STATUS, INVOICE_STATUS } from './hly.js';
import { resolveCredential, assertComplete, loadConfig, saveConfig, configPath, HlyError, DEFAULT_BASE_URL } from './config.js';

const VERSION: string = createRequire(import.meta.url)('../package.json').version;
const program = new Command();
// 参数错误统一退出码 2（Agent 可据此区分"我传错了"和"业务失败"）；必须在定义子命令之前设置才会被继承
program.exitOverride();
program.configureOutput({ writeErr: (str) => { if (!process.argv.includes('--json')) process.stderr.write(str); } });
program
  .name('hly').version(VERSION)
  .description('汇联易 CLI（给 Agent 用，多租户）：报销、申请、审批、花费查询。一次调用 = --tenant 公司 + --employee 替谁办。')
  .option('--json', 'JSON 输出（Agent 建议始终加）')
  .option('--tenant <name>', '用 hly tenant add 保存的某家公司的凭证')
  .option('--as <profile>', '同 --tenant（也可是 hly auth login 保存的"公司+工号"身份）')
  .option('--credential-file <path>', '凭证 JSON 文件 {appId, appSecret, employeeId, baseUrl?, companyCode?}')
  .option('--app-id <id>').option('--app-secret <secret>')
  .option('--employee <工号>', '以哪个员工的身份操作')
  .option('--company <code>', '公司编码（集团账号创建申请单时需要）')
  .option('--base-url <url>', `默认 ${DEFAULT_BASE_URL}`)
  .option('--verbose', '打印 HTTP 请求与响应到 stderr');

function cred(ignoreProfiles = false) {
  const o = program.opts();
  const c = resolveCredential({ appId: o.appId, appSecret: o.appSecret, employee: o.employee, baseUrl: o.baseUrl, companyCode: o.company, credentialFile: o.credentialFile, profile: o.tenant ?? o.as, ignoreProfiles });
  if (c.implicitDefault) throw new HlyError('no_credential', `已保存多家公司，必须显式指定 --tenant（当前默认是「${c.profile}」）`, '多租户 Agent 每条命令都带 --tenant <公司> --employee <工号>');
  return c;
}
/** 需要"替谁办"的命令 */
function hly(): Hly {
  const c = cred(); assertComplete(c);
  return new Hly(c, { verbose: program.opts().verbose });
}
/** 只需要公司凭证的命令（查员工、费用类型） */
function hlyApp(): Hly {
  const c = cred(); assertComplete(c, false);
  return new Hly(c, { verbose: program.opts().verbose });
}
/** 全公司数据（花费、--all 列表、raw api）：租户配了 spendAllowlist 时，只有名单内的工号能用 */
function hlySpend(what = '花费查询'): Hly {
  const h = hly();
  const allow = h.cred.spendAllowlist;
  if (allow?.length && !allow.includes(h.cred.employeeId)) {
    throw new HlyError('forbidden', `工号 ${h.cred.employeeId} 不在该公司的全公司数据名单里，不能${what}`, '让管理员 hly tenant allow-spend <公司> <工号> 加入；名单通常是财务和老板');
  }
  return h;
}
/**
 * 提交结果判定（#5）：只有 data.status 是明确的"已提交"状态才算成功；1001 是失败；缺失/未知状态报"无法确认"。
 * 失败时抛错（退出码 1），raw 里保留单号、是否已被 autoDelete、labels，供 Agent 恢复。
 */
function assertSubmitted(r: any, ctx: { deletedOnFail: boolean; created: boolean }) {
  const s = r.data?.status;
  const labels: any[] = r.data?.entityLabel ?? [];
  const detail = { businessCode: r.key ?? null, status: s ?? null, deleted: false, labels, submitError: r.data?.submitErrorMessage ?? null, submitErrorCode: r.data?.submitErrorCode ?? null };
  if (s === 1001) {
    detail.deleted = ctx.deletedOnFail;
    const why = [detail.submitError, ...labels.map((l) => l.toast)].filter(Boolean).join('；') || r.message || '汇联易未说明原因';
    throw new HlyError('submit_failed', `${ctx.created ? '单据已创建但' : ''}提交失败：${why}`, ctx.deletedOnFail ? '草稿已被自动删除（--no-auto-delete 可保留）；修正后重新创建' : '修正后重新 expense submit', undefined, detail);
  }
  if (typeof s !== 'number' || !(s in REPORT_STATUS)) {
    throw new HlyError('submit_unconfirmed', `汇联易返回了未知的单据状态 ${JSON.stringify(s)}，无法确认是否已提交`, `用 hly expense show ${r.key ?? '<单号>'} 核实`, undefined, detail);
  }
}
/** 单据详情的读取权限：本人、该单审批链上的人、或全公司数据名单内 */
async function assertCanView(h: Hly, businessCode: string, applicantEmployeeId: string | undefined, what: string) {
  const me = h.cred.employeeId;
  if (!applicantEmployeeId || applicantEmployeeId === me) return;
  const allow = h.cred.spendAllowlist;
  if (!allow?.length || allow.includes(me)) return;
  if (await h.isApproverOf(businessCode, me)) return;
  throw new HlyError('forbidden', `工号 ${me} 不是${what} ${businessCode} 的申请人或审批人，不能查看`, '只有本人、审批链上的人、或 tenant allow-spend 名单内的工号可以看别人的单');
}
/** CLI 选项里的 JSON：解析失败算参数错误 */
function parseJson<T = any>(src: string, what: string, example: string): T {
  try { return JSON.parse(src); } catch (e: any) { throw new HlyError('bad_args', `${what} 不是合法 JSON：${e.message}`, `例：${example}`); }
}
const ITEM_EXAMPLE = `--item '{"type":"TRAVEL_HOTEL","amount":800,"date":"2026-11-02","comment":"如家","invoice":{"no":"123","date":"2026-11-02"}}'`;
const kv = (kvs: string[]) => kvs.map((x) => { const i = x.indexOf('='); need(i > 0, `--field 格式应为 code=value：${x}`); return { fieldCode: x.slice(0, i), value: x.slice(i + 1) }; });
const isJson = () => !!program.opts().json;
function out(data: unknown, human?: () => void) { if (isJson() || !human) console.log(JSON.stringify(data, null, 2)); else human(); }
function table(rows: Record<string, unknown>[], cols: string[]) {
  if (!rows.length) { console.log('(空)'); return; }
  const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length)));
  const line = (v: string[]) => v.map((x, i) => x.padEnd(w[i] + 2)).join('');
  console.log(line(cols)); rows.forEach((r) => console.log(line(cols.map((c) => String(r[c] ?? '')))));
}
const money = (n: unknown) => Number(n ?? 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const TZ = Number(process.env.HLY_TZ_OFFSET ?? 480);
/** 显示用：UTC 时间按东八区（HLY_TZ_OFFSET）转成本地日期 */
const day = (s?: string) => { if (!s) return ''; const t = new Date(s); return isNaN(t.getTime()) ? String(s).slice(0, 10) : new Date(t.getTime() + TZ * 60000).toISOString().slice(0, 10); };
const todayStr = () => day(new Date().toISOString());
/** n 个月前的今天（按本地时区；月末溢出取该月最后一天） */
const monthAgo = (n: number) => { const [y, m, d] = todayStr().split('-').map(Number); const t = new Date(Date.UTC(y, m - 1 - n, 1)); const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate(); t.setUTCDate(Math.min(d, last)); return t.toISOString().slice(0, 10); };
const monthStart = () => todayStr().slice(0, 8) + '01';

async function run(fn: () => Promise<void>) {
  try { await fn(); } catch (e: any) {
    const err = e instanceof HlyError ? { code: e.code, message: e.message, hint: e.hint, status: e.status, raw: isJson() ? e.raw : undefined } : { code: 'cli', message: e.message };
    if (isJson()) console.error(JSON.stringify({ error: err }));
    else { console.error(`错误 [${err.code}] ${err.message}`); if (err.hint) console.error(`提示：${err.hint}`); }
    const authish = ['no_credential', 'credential_conflict', 'auth_failed', 'forbidden', 'http_401', 'http_403', 'config_corrupt'];
    process.exitCode = authish.includes(err.code) ? 3 : err.code === 'bad_args' ? 2 : 1; // 不用 process.exit：让 stderr 写完
  }
}
const need = (cond: unknown, msg: string, hint?: string) => { if (!cond) throw new HlyError('bad_args', msg, hint); };
const entityTypeOf = (s: string) => { const n = ENTITY_TYPES[s] ?? Number(s); need(Number.isInteger(n) && n > 0, `未知单据类型 ${s}`, `可用：${Object.keys(ENTITY_TYPES).join('/')} 或数字编码`); return n; };

// ================= tenant =================
const tenant = program.command('tenant').description('租户（公司）凭证管理：一个 Agent 服务多家公司时每家一条');
tenant.command('add').description('保存一家公司的汇联易应用凭证（不绑工号；调用时 --employee 指定替谁办）')
  .requiredOption('--name <公司>').option('--no-verify', '不调用接口校验')
  .option('--spend-allow <工号...>', '允许查全公司花费的工号（财务/老板），可重复', (v: string, acc: string[]) => [...acc, v], [] as string[])
  .action((o) => run(async () => {
    const c = cred(true); assertComplete(c, false); // 只认命令行 / 凭证文件 / 环境变量，不继承别家公司的 profile
    let count: number | null = null;
    if (o.verify) { await new Hly(c).token(true); count = (await new Hly(c).employees(true)).length; }
    const cfg = loadConfig();
    cfg.profiles[o.name] = { baseUrl: c.baseUrl, appId: c.appId, appSecret: c.appSecret, employeeId: '', companyCode: c.companyCode, spendAllowlist: o.spendAllow.length ? o.spendAllow : undefined };
    if (!cfg.current) cfg.current = o.name;
    saveConfig(cfg);
    out({ tenant: o.name, employees: count, spendAllowlist: o.spendAllow }, () => console.log(`已保存公司「${o.name}」${count !== null ? `，员工 ${count} 人` : ''}。调用：hly --tenant ${o.name} --employee <工号> ...`));
  }));
tenant.command('list').action(() => run(async () => {
  const cfg = loadConfig();
  const rows = Object.entries(cfg.profiles).map(([k, v]) => ({ name: k, default: cfg.current === k ? '*' : '', boundEmployee: v.employeeId || '(按调用指定)', appId: v.appId, spendAllowlist: (v.spendAllowlist ?? []).join(',') || '(不限)', baseUrl: v.baseUrl }));
  out(rows, () => table(rows, ['name', 'default', 'boundEmployee', 'appId', 'spendAllowlist', 'baseUrl']));
}));
tenant.command('allow-spend <公司> <工号...>').description('设置允许查全公司花费的工号（覆盖）').action((n, ids) => run(async () => {
  const cfg = loadConfig(); need(cfg.profiles[n], `公司 ${n} 不存在`); cfg.profiles[n].spendAllowlist = ids; saveConfig(cfg);
  out({ tenant: n, spendAllowlist: ids }, () => console.log(`「${n}」花费查询名单：${ids.join(', ')}`));
}));
tenant.command('remove <公司>').description('删除公司凭证，连同其 token 与员工缓存').action((n) => run(async () => { const cfg = loadConfig(); need(cfg.profiles[n], `公司 ${n} 不存在`); Hly.clearCache(cfg.profiles[n]); delete cfg.profiles[n]; if (cfg.current === n) cfg.current = Object.keys(cfg.profiles)[0]; saveConfig(cfg); out({ removed: n }, () => console.log(`已删除 ${n}`)); }));

// ================= auth =================
const auth = program.command('auth').description('身份（凭证）管理：每个人保存自己的一份');
auth.command('login').description('把一份凭证保存为命名身份。appId/appSecret 由公司管理员在 汇联易后台 → 设置 → 安全设置 获取；employee 是本人工号')
  .option('--name <name>', '身份名称，默认用员工姓名')
  .option('--default', '设为默认身份（第一个保存的自动成为默认）')
  .option('--no-verify', '不调用接口校验')
  .action((o) => run(async () => {
    const c = cred(true); assertComplete(c);
    let name = o.name; let emp: any = null;
    if (o.verify) { emp = await new Hly(c).employee(); name ??= emp.fullName; }
    name ??= c.employeeId;
    const cfg = loadConfig();
    cfg.profiles[name] = { baseUrl: c.baseUrl, appId: c.appId, appSecret: c.appSecret, employeeId: c.employeeId, companyCode: c.companyCode };
    if (o.default || !cfg.current) cfg.current = name;
    saveConfig(cfg);
    out({ profile: name, default: cfg.current === name, employee: emp && { fullName: emp.fullName, employeeID: emp.employeeID, departmentName: emp.departmentName, companyName: emp.companyName } },
      () => console.log(`已保存身份「${name}」${emp ? `：${emp.companyName} / ${emp.departmentName} / ${emp.fullName}（${emp.employeeID}）` : ''}${cfg.current === name ? '（默认）' : `，使用时加 --as ${name}`}\n配置文件 ${configPath()}`));
  }));
auth.command('list').description('列出已保存身份').action(() => run(async () => {
  const cfg = loadConfig();
  const rows = Object.entries(cfg.profiles).map(([k, v]) => ({ name: k, default: cfg.current === k ? '*' : '', employeeId: v.employeeId, appId: v.appId, baseUrl: v.baseUrl }));
  out(rows, () => table(rows, ['name', 'default', 'employeeId', 'appId', 'baseUrl']));
}));
auth.command('use <name>').description('切换默认身份').action((n) => run(async () => { const cfg = loadConfig(); need(cfg.profiles[n], `身份 ${n} 不存在`); cfg.current = n; saveConfig(cfg); out({ current: n }, () => console.log(`默认身份 → ${n}`)); }));
auth.command('logout <name>').description('删除身份（连同 token 与员工缓存）').action((n) => run(async () => { const cfg = loadConfig(); need(cfg.profiles[n], `身份 ${n} 不存在`); Hly.clearCache(cfg.profiles[n]); delete cfg.profiles[n]; if (cfg.current === n) cfg.current = Object.keys(cfg.profiles)[0]; saveConfig(cfg); out({ removed: n }, () => console.log(`已删除 ${n}`)); }));
auth.command('token').description('获取（或刷新）AccessToken，用于验证凭证').option('--refresh').action((o) => run(async () => {
  await hlyApp().token(!!o.refresh); out({ ok: true }, () => console.log('凭证有效，已拿到 AccessToken'));
}));

program.command('whoami').description('当前身份（员工信息 + 凭证来源）').action(() => run(async () => {
  const c = cred(); const emp = await hly().employee();
  const brief = { employeeID: emp.employeeID, fullName: emp.fullName, companyName: emp.companyName, companyCode: emp.companyCode, departmentName: emp.departmentName, departmentPath: emp.departmentPath, title: emp.title, directManagerName: emp.directManagerName, directManagerEmployeeId: emp.directManagerEmployeeId, status: emp.status };
  out({ credential_source: c.source, profile: c.profile ?? null, baseUrl: c.baseUrl, employee: brief, raw: isJson() ? emp : undefined },
    () => console.log(`${brief.companyName} / ${brief.departmentPath ?? brief.departmentName} / ${brief.fullName}（${brief.employeeID}）${brief.title ? ' · ' + brief.title : ''}${brief.directManagerName ? ' · 直属上级 ' + brief.directManagerName : ''}\n凭证来源：${c.source}`));
}));

const employee = program.command('employee').description('员工查询（把飞书身份翻译成工号）');
employee.command('show <工号>').action((id) => run(async () => { const e = await hlyApp().employee(id); out(e, () => console.log(`${e.fullName}（${e.employeeID}） ${e.companyName} / ${e.departmentPath ?? e.departmentName} · ${e.title ?? ''} · 上级 ${e.directManagerName ?? '-'}`)); }));
employee.command('find').description('按邮箱 / 手机号 / 姓名找工号（结果缓存 24h）').option('--email <e>').option('--mobile <m>').option('--name <n>').option('--refresh', '强制刷新缓存')
  .action((o) => run(async () => {
    need(o.email || o.mobile || o.name, '至少给 --email / --mobile / --name 之一');
    const hit = await hlyApp().findEmployee({ email: o.email, mobile: o.mobile, name: o.name }, !!o.refresh);
    if (!hit.length) throw new HlyError('not_found', '没有匹配的员工', '确认该人已在汇联易建档，邮箱/手机号与汇联易一致；--refresh 可绕过缓存');
    out(hit, () => table(hit.map((e: any) => ({ employeeID: e.employeeID, fullName: e.fullName, email: e.email ?? '', mobile: e.mobile ?? '', department: e.departmentPath ?? e.departmentName, title: e.title ?? '' })), ['employeeID', 'fullName', 'email', 'mobile', 'department', 'title']));
  }));
employee.command('list').description('全部在职员工（缓存；含邮箱手机号，受全公司数据名单限制）').option('--refresh').action((o) => run(async () => {
  const list = await hlySpend('导出员工名单').employees(!!o.refresh);
  out(list, () => table(list.map((e: any) => ({ employeeID: e.employeeID, fullName: e.fullName, email: e.email ?? '', department: e.departmentName ?? '' })), ['employeeID', 'fullName', 'email', 'department']));
}));

// ================= 费用类型 =================
program.command('expense-types').alias('types').description('费用类型（创建报销/申请时要用 code）').option('--all', '包含停用的').option('--keyword <k>')
  .action((o) => run(async () => {
    let list = await hlyApp().expenseTypes();
    if (!o.all) list = list.filter((t: any) => t.enabled !== false);
    if (o.keyword) list = list.filter((t: any) => `${t.name} ${t.code}`.includes(o.keyword));
    const rows = list.map((t: any) => ({ code: t.code, name: t.name, category: t.expenseTypeCategoryName ?? '', attachment: t.isAttachmentRequired ? '需附件' : '', invoice: t.pasteInvoiceNeeded ? '需发票' : '', fields: (t.fields ?? []).filter((f: any) => f.required).map((f: any) => f.name).join('/'), oid: t.expenseTypeOID }));
    out(rows, () => table(rows, ['code', 'name', 'category', 'attachment', 'invoice', 'fields']));
  }));

// ================= 报销单 =================
const expense = program.command('expense').alias('er').description('报销单');
expense.command('create').description('创建报销单（可同时带费用明细；--submit 直接提交审批）')
  .requiredOption('--form <formCode>', '报销单表单编码（后台"表单管理"里看；或问管理员）')
  .option('--title <事由>')
  .option('--field <code=value...>', '单据自定义控件，可重复：--field department=1002 --field remark=xx', (v: string, acc: string[]) => [...acc, v], [] as string[])
  .option('--item <json...>', '费用明细 JSON，可重复。字段：type(费用类型code) amount date(YYYY-MM-DD) comment invoice{typeNo,no,code,date,checkCode,amountWithoutTax} fields{messageKeyCode:value}', (v: string, acc: string[]) => [...acc, v], [] as string[])
  .option('--items <json>', '明细数组 JSON（与 --item 二选一）')
  .option('--invoice-oid <oid...>', '复用已录入费用（invoiceOID），可重复', (v: string, acc: string[]) => [...acc, v], [] as string[])
  .option('--reference <申请单号...>', '关联申请单号，可重复', (v: string, acc: string[]) => [...acc, v], [] as string[])
  .option('--submit', '创建后直接提交审批')
  .option('--no-auto-delete', '提交失败时不自动删除单据（默认自动删除，避免留草稿）')
  .option('--uuid <uuid>', '幂等键，不传自动生成')
  .option('--dry-run', '只打印将要发送的请求体')
  .action((o) => run(async () => {
    const h = hly();
    const extra = o.items ? parseJson(o.items, '--items', '--items \'[{"type":"TAXI","amount":46.5,"date":"2026-11-02"}]\'') : [];
    need(Array.isArray(extra), '--items 必须是数组 JSON');
    const rawItems: any[] = [...o.item.map((x: string) => parseJson(x, '--item', ITEM_EXAMPLE)), ...extra];
    need(rawItems.length || o.invoiceOid.length, '至少要一条费用明细（--item / --items）或 --invoice-oid', '例：--item \'{"type":"TRAVEL_HOTEL","amount":800,"date":"2026-11-02","comment":"如家"}\'');
    const invoices = rawItems.map((it) => {
      need(it.type && it.amount && it.date, '每条明细必须有 type、amount、date');
      const inv: any = { expenseTypeCode: it.type, amount: Number(it.amount), occurrenceDate: h.toUtc(it.date), invoiceCurrencyCode: it.currency ?? 'CNY', comment: it.comment, ownerEmployeeId: it.owner };
      if (it.fields) inv.data = Object.entries(it.fields).map(([messageKeyCode, value]) => ({ messageKeyCode, value: typeof value === 'string' ? value : JSON.stringify(value) }));
      if (it.invoice) inv.openReceiptRequestDTOList = [{ receiptTypeNo: it.invoice.typeNo ?? '04', billingNo: it.invoice.no, billingCode: it.invoice.code, billingDate: it.invoice.date, checkCode: it.invoice.checkCode, feeWithoutTax: it.invoice.amountWithoutTax }];
      if (it.invoices) inv.openReceiptRequestDTOList = it.invoices.map((r: any) => ({ receiptTypeNo: r.typeNo ?? '04', billingNo: r.no, billingCode: r.code, billingDate: r.date, checkCode: r.checkCode, feeWithoutTax: r.amountWithoutTax }));
      return inv;
    });
    const fields = kv(o.field);
    if (o.title) fields.unshift({ fieldCode: 'title', value: o.title });
    const body: Record<string, unknown> = {
      formCode: o.form, autoSubmit: !!o.submit, autoDelete: o.submit ? o.autoDelete : undefined, uuid: o.uuid ?? randomUUID(),
      openCustomFormValueRequestDTOList: fields.length ? fields : undefined,
      openInvoiceCreateDTOList: invoices.length ? invoices : undefined,
      invoiceOIDSet: o.invoiceOid.length ? o.invoiceOid : undefined,
      referenceApplicationBusinessCodeList: o.reference.length ? o.reference : undefined,
    };
    if (o.dryRun) { out({ dry_run: true, body: { employeeId: h.cred.employeeId, ...body } }); return; }
    const r = await h.createExpenseReport(body);
    const status = r.data?.status; const labels = r.data?.entityLabel ?? [];
    const total = invoices.reduce((s, i) => s + i.amount, 0);
    if (o.submit) assertSubmitted(r, { deletedOnFail: o.autoDelete, created: true });
    const result = { businessCode: r.key, status, status_text: REPORT_STATUS[status] ?? String(status), submitted: !!o.submit, labels, total };
    out({ ...result, raw: isJson() ? r : undefined }, () => {
      console.log(`报销单 ${result.businessCode} 已创建，合计 ${money(total)}，状态 ${result.status_text}${o.submit ? '，已提交审批' : ''}`);
      for (const l of labels) console.log(`  ⚠ ${l.name}：${l.toast}`);
    });
  }));
expense.command('submit <单号>').description('提交编辑中的报销单').action((code) => run(async () => {
  const r = await hly().submitExpenseReport(code); const s = r.data?.status;
  assertSubmitted(r, { deletedOnFail: false, created: false });
  out({ businessCode: r.key ?? code, status: s, status_text: REPORT_STATUS[s] ?? String(s), submitted: true, labels: r.data?.entityLabel ?? [], message: r.message }, () => console.log(`已提交，状态 ${REPORT_STATUS[s] ?? s}`));
}));
expense.command('show <单号>').description('报销单详情（含费用明细与审批历史）；本人、审批人或名单内可看').action((code) => run(async () => {
  const h = hly(); const d = await h.expenseReportDetail(code);
  await assertCanView(h, code, d.applicantID ?? d.applicant?.employeeID ?? d.employeeId, '报销单');
  const items = (d.expenseReportInvoices ?? []).map((x: any) => { const v = x.invoiceView ?? x; return { type: v.expenseTypeName, amount: v.amount, currency: v.currencyCode, date: day(v.invoiceDate ?? v.createdDate), comment: v.comment ?? v.summaryInfo ?? '' }; });
  const history = (d.approvalHistoryDTOs ?? []).map((a: any) => ({ at: day(a.operationDate ?? a.createdDate), who: a.operatorName ?? a.operator?.fullName ?? a.userName, op: a.operationTypeName ?? a.operationName ?? a.operation, detail: a.operationDetail ?? '' }));
  const brief = { businessCode: d.businessCode, formName: d.formName, status: d.status, status_text: REPORT_STATUS[d.status] ?? String(d.status), applicant: d.applicantName ?? d.applicant?.fullName, department: d.departmentName, totalAmount: d.totalAmount, currency: d.currencyCode, remark: d.remark, submittedAt: d.lastSubmittedDate, items, history };
  out({ ...brief, raw: isJson() ? d : undefined }, () => {
    console.log(`报销单 ${brief.businessCode} · ${brief.formName} · ${brief.applicant} / ${brief.department} · ${brief.status_text} · 合计 ${money(brief.totalAmount)} ${brief.currency ?? ''}${brief.remark ? '\n备注：' + brief.remark : ''}`);
    table(items.map((i: any) => ({ ...i, amount: money(i.amount) })), ['date', 'type', 'amount', 'comment']);
    if (history.length) { console.log('审批历史：'); table(history, ['at', 'who', 'op', 'detail']); }
  });
}));
expense.command('list').description('报销单列表（默认本人、近 3 个月）')
  .option('--from <date>').option('--to <date>').option('--status <codes>', '1001 编辑中 1002 审批中 1003 待审核 1004 审核通过 1005 已付款 1007 待付款，逗号分隔')
  .option('--employee-id <工号>', '查别人（需要权限）').option('--all', '不按申请人过滤（管理员/财务）').option('--page <n>').option('--size <n>')
  .action((o) => run(async () => {
    const h = o.all || o.employeeId ? hlySpend('查看他人报销单') : hly();
    const body = await h.listExpenseReports({ from: o.from ?? monthAgo(3), to: o.to ?? todayStr(), status: o.status, employeeId: o.all ? undefined : o.employeeId ?? h.cred.employeeId, page: o.page ? Number(o.page) : 1, size: o.size ? Number(o.size) : 50 });
    const list: any[] = Array.isArray(body) ? body : body?.data ?? [];
    const rows = list.map((d) => ({ businessCode: d.businessCode, form: d.formName, applicant: d.applicantName ?? d.applicant?.fullName ?? d.submittedName, department: d.departmentName, total: d.totalAmount, status: REPORT_STATUS[d.status] ?? d.status, submitted: day(d.lastSubmittedDate ?? d.submittedDate), remark: d.remark ?? '' }));
    out(rows, () => table(rows.map((r) => ({ ...r, total: money(r.total) })), ['businessCode', 'form', 'applicant', 'department', 'total', 'status', 'submitted']));
  }));

// ================= 申请单 =================
const request = program.command('request').alias('ea').description('费用申请单（事前申请）');
request.command('create').description('创建费用申请单（预算行 = 费用类型 + 金额）')
  .requiredOption('--form <formCode>', '申请单表单编码')
  .requiredOption('--title <事由>')
  .option('--field <code=value...>', '单据自定义控件 fieldCode=value，可重复', (v: string, acc: string[]) => [...acc, v], [] as string[])
  .option('--budget <json...>', '预算行 JSON，可重复：{"type":"费用类型code","amount":1500,"currency":"CNY","department":"部门编码","remark":"..."}', (v: string, acc: string[]) => [...acc, v], [] as string[])
  .option('--submit', '创建后提交审批').option('--dry-run')
  .action((o) => run(async () => {
    const h = hly();
    const budgets = o.budget.map((x: string) => parseJson(x, '--budget', '--budget \'{"type":"TRAVEL_HOTEL","amount":1500,"department":"1002"}\''));
    need(budgets.length, '至少一条预算行 --budget');
    const custFormValues = [{ fieldCode: 'title', messageKey: 'title', value: o.title }, ...kv(o.field)];
    const body = {
      formCode: o.form, status: 1001, custFormValues,
      expenseApplication: { itineraryBudgetDTOs: budgets.map((b: any) => ({
        expenseTypeCode: b.type, amount: Number(b.amount), currencyCode: b.currency ?? 'CNY',
        apportionmentDTOList: b.department ? [{ scale: 100, costCenterItems: [{ type: 1, code: b.department }] }] : undefined,
        expenseBudgetCustomValueDTOs: [{ fieldCode: 'com_budget', messageKey: 'com_budget', value: JSON.stringify({ currencyCode: b.currency ?? 'CNY', amount: Number(b.amount) }) }, ...(b.remark ? [{ fieldCode: 'com_remarks', messageKey: 'com_remarks', value: b.remark }] : []), ...Object.entries(b.fields ?? {}).map(([fieldCode, value]) => ({ fieldCode, value: String(value) }))],
      })) },
    };
    if (o.dryRun) { out({ dry_run: true, body: { employeeID: h.cred.employeeId, companyCode: h.cred.companyCode, ...body } }); return; }
    const r = await h.createExpenseApplication(body);
    let submit: any = null;
    if (o.submit && r.key) submit = await h.submitExpenseApplication(r.key);
    out({ businessCode: r.key, submitted: !!submit, raw: isJson() ? { create: r, submit } : undefined }, () => console.log(`申请单 ${r.key} 已创建${submit ? '并提交审批' : '（编辑中）'}`));
  }));
request.command('submit <单号>').action((c) => run(async () => { const r = await hly().submitExpenseApplication(c); out({ businessCode: r.key ?? c, ok: true }, () => console.log(`已提交 ${r.key ?? c}`)); }));
request.command('show <单号>').description('申请单详情；本人、审批人或名单内可看').action((c) => run(async () => {
  const h = hly(); const r = await h.expenseApplicationDetail(c); const d = r.data ?? r;
  await assertCanView(h, c, d.applicant?.employeeID ?? d.employeeId, '申请单');
  const budgets = (d.expenseApplication?.itineraryBudgetDTOs ?? []).map((b: any) => ({ type: b.expenseTypeName ?? b.expenseTypeCode, amount: b.amount, currency: b.currencyCode }));
  const brief = { businessCode: d.businessCode, title: d.title, status: d.status, status_text: APPLICATION_STATUS[d.status] ?? String(d.status), applicant: d.applicant?.fullName, totalAmount: d.totalAmount, budgets };
  out({ ...brief, raw: isJson() ? d : undefined }, () => { console.log(`申请单 ${brief.businessCode} · ${brief.title} · ${brief.applicant} · ${brief.status_text} · 合计 ${money(brief.totalAmount)}`); table(budgets.map((b: any) => ({ ...b, amount: money(b.amount) })), ['type', 'amount', 'currency']); });
}));
request.command('list').description('申请单列表（默认本人、近 3 个月）').option('--from <date>').option('--to <date>').option('--status <code>', '1001 编辑中 1002 审批中 1003 已通过 1012 已报废').option('--employee-id <工号>').option('--all')
  .action((o) => run(async () => {
    const h = o.all || o.employeeId ? hlySpend('查看他人申请单') : hly();
    const body = await h.listExpenseApplications({ from: o.from ?? monthAgo(3), to: o.to ?? todayStr(), status: o.status, employeeId: o.all ? undefined : o.employeeId ?? h.cred.employeeId });
    const list: any[] = Array.isArray(body) ? body : body?.data ?? [];
    const rows = list.map((d) => ({ businessCode: d.businessCode, title: d.title, applicant: d.applicant?.fullName, total: d.totalAmount, status: APPLICATION_STATUS[d.status] ?? d.status, submitted: day(d.submittedDate) }));
    out(rows, () => table(rows.map((r) => ({ ...r, total: money(r.total) })), ['businessCode', 'title', 'applicant', 'total', 'status', 'submitted']));
  }));
request.command('approved').description('本人已通过、可关联报销的申请单').option('--employee-id <工号>').action((o) => run(async () => {
  const h = o.employeeId ? hlySpend('查看他人申请单') : hly(); const r = await h.approvedApplications(o.employeeId ?? h.cred.employeeId);
  const rows = (r.data ?? []).map((d: any) => ({ businessCode: d.businessCode, kind: d.type === 1002 ? '差旅' : '费用', title: d.title, total: d.totalAmount, travel: d.travelStartDate ? `${day(d.travelStartDate)}~${day(d.travelEndDate)}` : '', referReports: (d.referReportList ?? []).map((x: any) => x.businessCode).join(',') }));
  out(rows, () => table(rows.map((x: any) => ({ ...x, total: money(x.total) })), ['businessCode', 'kind', 'title', 'total', 'travel', 'referReports']));
}));

// ================= 差旅申请 =================
const travel = program.command('travel').description('差旅申请单');
travel.command('create').description('创建差旅申请（行程 + 预算）')
  .requiredOption('--form <formCode>').requiredOption('--title <事由>')
  .option('--from-city <城市>').option('--to-city <城市>').requiredOption('--start <date>').requiredOption('--end <date>')
  .option('--budget <json...>', '预算行：{"type":"TRAVEL_HOTEL","amount":800,"department":"1001"}', (v: string, acc: string[]) => [...acc, v], [] as string[])
  .option('--field <code=value...>', '', (v: string, acc: string[]) => [...acc, v], [] as string[])
  .option('--submit').option('--dry-run')
  .action((o) => run(async () => {
    const h = hly();
    const budgets = o.budget.map((x: string) => parseJson(x, '--budget', '--budget \'{"type":"TRAVEL_HOTEL","amount":800}\''));
    const body = {
      formCode: o.form, status: 1001, supportBudget: false,
      custFormValues: [{ fieldCode: 'title', messageKey: 'title', value: o.title }, ...kv(o.field)],
      travelApplication: {
        itineraryHeadDTOs: [{ startDate: h.toUtc(o.start), endDate: h.toUtc(o.end), fromCityCode: o.fromCity, toCityCode: o.toCity, remark: o.title }],
        itineraryBudgetDTOs: budgets.map((b: any) => ({ expenseTypeCode: b.type, amount: Number(b.amount), currencyCode: b.currency ?? 'CNY', apportionmentDTOList: b.department ? [{ scale: 100, costCenterItems: [{ type: 1, code: b.department }] }] : undefined, expenseBudgetCustomValueDTOs: [] })),
      },
    };
    if (o.dryRun) { out({ dry_run: true, body: { applicant: { employeeID: h.cred.employeeId }, companyCode: h.cred.companyCode, ...body } }); return; }
    const r = await h.createTravelApplication(body);
    const submit = o.submit && r.key ? await h.submitTravelApplication(r.key) : null;
    out({ businessCode: r.key, submitted: !!submit, raw: isJson() ? { create: r, submit } : undefined }, () => console.log(`差旅申请 ${r.key} 已创建${submit ? '并提交审批' : '（编辑中）'}`));
  }));
travel.command('submit <单号>').action((c) => run(async () => { const r = await hly().submitTravelApplication(c); out({ businessCode: r.key ?? c, ok: true }, () => console.log(`已提交 ${r.key ?? c}`)); }));

// ================= 审批 =================
program.command('inbox').description('待我审批的单据（--done 看已办）')
  .option('--done').option('--type <t...>', `单据类型：${Object.keys(ENTITY_TYPES).join('/')}`, (v: string, acc: string[]) => [...acc, v], [] as string[])
  .option('--from <date>').option('--to <date>').option('--page <n>').option('--size <n>')
  .action((o) => run(async () => {
    const r = await hly().approvals({ done: !!o.done, entityTypes: o.type.length ? o.type.map(entityTypeOf) : undefined, from: o.from, to: o.to, page: o.page ? Number(o.page) : 1, size: o.size ? Number(o.size) : 50 });
    const rows = (r.data ?? []).map((t: any) => ({ businessCode: t.businessCode, entityType: t.entityType, type: ENTITY_NAMES[t.entityType] ?? t.entityType, form: t.formName, applicant: t.applicant?.fullName, applicantId: t.applicant?.employeeID, department: t.department?.name, amount: t.baseCurrencyAmount ?? t.amount, currency: t.baseCurrencyCode ?? t.currencyCode, title: t.title, submitted: day(t.submittedDate), node: t.nodeName, result: t.result, link: t.approvalLink }));
    out(rows, () => { console.log(o.done ? '已办：' : '待办：'); table(rows.map((x: any) => ({ ...x, amount: money(x.amount) })), ['businessCode', 'type', 'applicant', 'department', 'amount', 'title', 'submitted', 'node']); });
  }));
program.command('approve <单号>').description('审批通过（以当前身份）')
  .addOption(new Option('--type <t>', '单据类型').default('expense')).option('--comment <文字>')
  .action((code, o) => run(async () => { const r = await hly().pass(code, entityTypeOf(o.type), o.comment); out({ businessCode: code, ok: true, message: r.message }, () => console.log(`已通过 ${code}`)); }));
program.command('reject <单号>').description('审批驳回（必须写原因）')
  .addOption(new Option('--type <t>', '单据类型').default('expense')).requiredOption('--comment <原因>')
  .option('--reject-type <n>', '1 驳回后重新走流程，2 回到驳回节点；默认按流程配置')
  .action((code, o) => run(async () => { const r = await hly().reject(code, entityTypeOf(o.type), o.comment, o.rejectType ? Number(o.rejectType) : undefined); out({ businessCode: code, ok: true, message: r.message }, () => console.log(`已驳回 ${code}`)); }));

// ================= 花费 =================
const spend = program.command('spend').description('花费查询（老板/财务视角，基于费用明细）');
const DATE_FIELD_HELP = 'occurred（默认，费用发生日期）| modified（接口原生口径：费用修改日期，返回"期间有变动的费用"）';
async function fetchInvoices(h: Hly, o: any) {
  const from = o.from ?? monthStart(), to = o.to ?? todayStr();
  const q = { from, to, status: o.status, employeeId: o.employeeId, expenseTypeOIDs: o.typeOid?.length ? o.typeOid : undefined };
  const rows = o.dateField === 'modified' ? await h.listInvoicesModified(q) : await h.listInvoicesOccurred({ ...q, tz: day });
  return { from, to, rows };
}
const ccy = (r: any) => r.invoiceCurrencyCode ?? r.currencyCode ?? 'UNKNOWN';
spend.command('summary').description('汇总：按费用类型 / 员工 / 月份，各币种分开')
  .option('--from <date>', '默认本月 1 日').option('--to <date>', '默认今天')
  .option('--by <dim>', 'type|employee|month', 'type')
  .option('--date-field <f>', DATE_FIELD_HELP, 'occurred')
  .option('--status <codes>', '费用状态：1002 待审批 1003 流程结束（默认两者）', '1002,1003')
  .option('--employee-id <工号>', '只看某人')
  .action((o) => run(async () => {
    const h = hlySpend();
    const { from, to, rows } = await fetchInvoices(h, o);
    const key = (r: any) => o.by === 'employee' ? `${r.employeeId ?? r.userOID}` : o.by === 'month' ? day(Hly.occurredAt(r)).slice(0, 7) : `${r.expenseTypeName ?? r.expenseTypeCode}`;
    const agg = new Map<string, { label: string; currency: string; total: number; count: number }>();
    for (const r of rows) { const c = ccy(r); const k = `${key(r)}\u0000${c}`; const a = agg.get(k) ?? { label: key(r), currency: c, total: 0, count: 0 }; a.total += Number(r.amount ?? 0); a.count++; agg.set(k, a); }
    const list = [...agg.values()].sort((a, b) => a.currency.localeCompare(b.currency) || b.total - a.total).map((a) => ({ ...a, total: Math.round(a.total * 100) / 100 }));
    const totals: Record<string, number> = {};
    for (const a of list) totals[a.currency] = Math.round(((totals[a.currency] ?? 0) + a.total) * 100) / 100;
    out({ from, to, by: o.by, date_field: o.dateField, status: o.status, count: rows.length, totals_by_currency: totals, rows: list }, () => {
      console.log(`花费汇总 ${from} ~ ${to}（按 ${o.by}，${o.dateField === 'modified' ? '修改日期' : '发生日期'}口径，状态 ${o.status}）  共 ${rows.length} 笔  合计 ${Object.entries(totals).map(([c, v]) => `${money(v)} ${c}`).join('，') || '0'}`);
      table(list.map((x) => ({ [o.by]: x.label, currency: x.currency, total: money(x.total), count: x.count })), [o.by, 'currency', 'total', 'count']);
    });
  }));
spend.command('items').description('逐笔费用明细').option('--from <date>').option('--to <date>').option('--date-field <f>', DATE_FIELD_HELP, 'occurred').option('--status <codes>', '', '1002,1003').option('--employee-id <工号>').option('--type-oid <oid...>', '', (v: string, acc: string[]) => [...acc, v], [] as string[]).option('--limit <n>', '', '200')
  .action((o) => run(async () => {
    const { rows } = await fetchInvoices(hlySpend(), o);
    const list = rows.slice(0, Number(o.limit)).map((r: any) => ({ date: day(Hly.occurredAt(r)), modified: day(r.lastModifiedDate), employee: r.employeeId, type: r.expenseTypeName, amount: r.amount, currency: ccy(r), status: INVOICE_STATUS[r.invoiceStatus] ?? r.invoiceStatus, comment: r.comment ?? '', invoiceOID: r.invoiceOID }));
    out(list, () => table(list.map((x) => ({ ...x, amount: money(x.amount) })), ['date', 'employee', 'type', 'amount', 'status', 'comment', 'invoiceOID']));
  }));
spend.command('unreimbursed').description('某人待报销费用汇总').option('--employee-id <工号>').action((o) => run(async () => {
  const h = hlySpend(); const r = await h.unreimbursed(o.employeeId ?? h.cred.employeeId);
  out(r.data, () => console.log(`待报销 ${r.data?.count ?? 0} 笔：${(r.data?.amountByCurrencyCodeList ?? []).map((a: any) => `${money(a.totalAmount)} ${a.currencyCode}`).join('，') || '0'}`));
}));

// ================= 原始接口 =================
program.command('api <METHOD> <path>').description('直接调用任意开放接口（自动带 token），例：hly api GET /api/open/expenseType')
  .option('--params <json>').option('--data <json>')
  .action((m, p, o) => run(async () => {
    // raw 接口能拿到全公司任何数据，按"全公司数据"权限处理
    const h = hlySpend('直接调用接口');
    out(await h.call(m.toUpperCase(), p, { params: o.params ? parseJson(o.params, '--params', `--params '{"page":1,"size":20}'`) : undefined, data: o.data ? parseJson(o.data, '--data', `--data '{"employeeId":"E001"}'`) : undefined, raw: true }));
  }));

try { await program.parseAsync(process.argv); }
catch (e: any) {
  if (e.code === 'commander.helpDisplayed' || e.code === 'commander.version' || e.code === 'commander.help') process.exit(0);
  if (process.argv.includes('--json')) console.error(JSON.stringify({ error: { code: 'bad_args', message: e.message.replace(/^error: /, '') } }));
  process.exit(2);
}
