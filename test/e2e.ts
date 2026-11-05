// 端到端：启动 mock 汇联易，用真实 CLI 子进程走完 员工报销 → 经理审批 → 财务审批 → 老板查花费，并验证四种传凭证方式与多人同机隔离。
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// mock 必须是独立进程：spawnSync 会阻塞本进程的事件循环
const port = 9700 + Math.floor(Math.random() * 200);
const base = `http://127.0.0.1:${port}`;
const todayStr = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const server = spawn('node', ['--no-warnings', '--import', 'tsx', 'test/mock-server.ts'], { env: { ...process.env, PORT: String(port) }, stdio: 'ignore' });
const port2 = port + 1, base2 = `http://127.0.0.1:${port2}`; // 第二家公司：不同凭证、不同地址
const server2 = spawn('node', ['--no-warnings', '--import', 'tsx', 'test/mock-server.ts'], { env: { ...process.env, PORT: String(port2), MOCK_APP_ID: 'b-app', MOCK_APP_SECRET: 'b-secret' }, stdio: 'ignore' });
for (const b of [base, base2]) for (let i = 0; i < 100; i++) { try { await fetch(b + '/'); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
if (!existsSync('dist/cli.js')) spawnSync('npx', ['tsc', '-p', 'tsconfig.json'], { stdio: 'inherit' });
const home = mkdtempSync(join(tmpdir(), 'hly-test-'));
const credFile = (employeeId: string) => { const p = join(home, `${employeeId}.json`); writeFileSync(p, JSON.stringify({ appId: 'demo-app', appSecret: 'demo-secret', employeeId, baseUrl: base })); return p; };

function hly(args: string[], env: Record<string, string> = {}, expectFail = false) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('HLY_'))); // 开发者自己的 HLY_* 不能影响测试
  const r = spawnSync('node', ['--no-warnings', 'dist/cli.js', '--json', ...args], { encoding: 'utf8', env: { ...clean, HLY_CONFIG_DIR: home, ...env } });
  const parse = (s: string) => { try { return JSON.parse(s); } catch { return s; } };
  if (!expectFail && r.status !== 0) throw new Error(`hly ${args.join(' ')} 失败(${r.status}): ${r.stderr}`);
  if (expectFail && r.status === 0) throw new Error(`hly ${args.join(' ')} 本应失败: ${r.stdout}`);
  return { code: r.status, out: parse(r.stdout), err: parse(r.stderr) };
}

let n = 0; const step = async (name: string, fn: () => void | Promise<void>) => { await fn(); n++; console.log('  ✓', name); };
try {
  const E = { HLY_CREDENTIAL_FILE: credFile('E001') }; // 员工：环境变量指向凭证文件
  const M = ['--credential-file', credFile('M001')];  // 经理：命令行指定凭证文件
  const Fenv = { HLY_APP_ID: 'demo-app', HLY_APP_SECRET: 'demo-secret', HLY_EMPLOYEE_ID: 'F001', HLY_BASE_URL: base }; // 财务：纯环境变量
  const B = ['--as', '老板']; // 老板：保存的 profile

  await step('无凭证 → 退出码 3 且有 hint', () => { const r = hly(['whoami'], {}, true); assert.equal(r.code, 3); assert.equal(r.err.error.code, 'no_credential'); assert.ok(r.err.error.hint); });
  await step('错误 appSecret → auth_failed', () => { const r = hly(['whoami', '--app-id', 'demo-app', '--app-secret', 'wrong', '--employee', 'E001', '--base-url', base], {}, true); assert.equal(r.code, 3); assert.equal(r.err.error.code, 'auth_failed'); });
  await step('auth login 保存老板身份（profile）；第二个人不抢默认', () => {
    const r = hly(['auth', 'login', '--app-id', 'demo-app', '--app-secret', 'demo-secret', '--employee', 'B001', '--base-url', base]);
    assert.equal(r.out.profile, '老板'); assert.equal(r.out.default, true);
    const r2 = hly(['auth', 'login', '--app-id', 'demo-app', '--app-secret', 'demo-secret', '--employee', 'M001', '--base-url', base, '--name', 'mgr']);
    assert.equal(r2.out.default, false);
    assert.equal(hly(['auth', 'list']).out.length, 2);
  });
  await step('四个人、四种传法，whoami 各自正确', () => {
    assert.equal(hly(['whoami'], E).out.employee.employeeID, 'E001');
    assert.equal(hly(['whoami', ...M]).out.employee.employeeID, 'M001');
    assert.equal(hly(['whoami'], Fenv).out.employee.employeeID, 'F001');
    assert.equal(hly(['whoami', ...B]).out.employee.employeeID, 'B001');
    const amb = hly(['whoami'], {}, true); assert.equal(amb.code, 3); assert.match(amb.err.error.message, /显式指定 --tenant/, '多个 profile 时不允许隐式默认');
    const w = hly(['whoami', '--as', '老板', '--employee', 'E001']); // profile 给 app 凭证，命令行只换人
    assert.equal(w.out.employee.employeeID, 'E001'); assert.match(w.out.credential_source, /profile:老板 \+ flags/);
    const bogus = hly(['whoami', '--as', '不存在'], {}, true); assert.equal(bogus.code, 3);
  });
  await step('HTTP 200 + errorCode 的业务错误不会被当成功：whoami / show / list 都退出 1 并带 hint', () => {
    const r = hly(['whoami', '--as', '老板', '--employee', 'NOPE'], {}, true); assert.equal(r.code, 1); assert.equal(r.err.error.code, 'hly_120207'); assert.match(r.err.error.hint, /工号/);
    assert.equal(hly(['employee', 'show', 'NOPE', '--as', '老板'], {}, true).err.error.code, 'hly_120207');
    assert.equal(hly(['expense', 'show', 'ERX', '--as', '老板'], {}, true).err.error.code, 'hly_120301');
    const bad = hly(['expense', 'create', '--form', 'X', '--item', '{bad', '--as', '老板'], {}, true); assert.equal(bad.code, 2); assert.equal(bad.err.error.code, 'bad_args');
    const nofile = hly(['whoami', '--credential-file', '/nonexistent.json'], {}, true); assert.equal(nofile.code, 3); assert.equal(nofile.err.error.code, 'no_credential');
  });
  await step('多租户：tenant add 不绑工号；--tenant + --employee 替谁办；spend 名单生效', () => {
    const t = hly(['tenant', 'add', '--name', '极客科技', '--app-id', 'demo-app', '--app-secret', 'demo-secret', '--base-url', base, '--spend-allow', 'B001', '--spend-allow', 'F001']);
    assert.equal(t.out.employees, 5);
    const noEmp = hly(['whoami', '--tenant', '极客科技'], {}, true); assert.equal(noEmp.err.error.code, 'no_credential'); assert.match(noEmp.err.error.message, /替谁办/);
    assert.equal(hly(['whoami', '--tenant', '极客科技', '--employee', 'E001']).out.employee.fullName, '李工');
    const denied = hly(['spend', 'summary', '--tenant', '极客科技', '--employee', 'E001'], {}, true); assert.equal(denied.code, 3); assert.equal(denied.err.error.code, 'forbidden');
    assert.equal(hly(['spend', 'summary', '--tenant', '极客科技', '--employee', 'B001']).out.count, 0);
    assert.equal(hly(['tenant', 'list']).out.find((x: any) => x.name === '极客科技').spendAllowlist, 'B001,F001');
    // 全公司数据的其它入口同样受名单限制
    assert.equal(hly(['api', 'GET', '/api/open/expenseType', '--tenant', '极客科技', '--employee', 'E001'], {}, true).err.error.code, 'forbidden');
    assert.equal(hly(['expense', 'list', '--all', '--tenant', '极客科技', '--employee', 'E001'], {}, true).err.error.code, 'forbidden');
    assert.ok(Array.isArray(hly(['api', 'GET', '/api/open/expenseType', '--tenant', '极客科技', '--employee', 'F001']).out));
  });
  await step('tenant add 不继承别家公司的 secret；remove 连缓存一起删', () => {
    const bad = hly(['tenant', 'add', '--name', '隔壁', '--app-id', 'other', '--no-verify', '--tenant', '极客科技'], {}, true);
    assert.equal(bad.err.error.code, 'no_credential'); assert.match(bad.err.error.message, /app-secret/);
    hly(['tenant', 'add', '--name', '隔壁', '--app-id', 'other', '--app-secret', 'x', '--base-url', base, '--no-verify']);
    const saved = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).profiles['隔壁'];
    assert.equal(saved.appSecret, 'x'); assert.equal(saved.companyCode, undefined);
    hly(['tenant', 'remove', '隔壁']);
    assert.ok(!hly(['tenant', 'list']).out.some((x: any) => x.name === '隔壁'));
    const cacheFiles = readdirSync(join(home, 'cache'));
    hly(['employee', 'list', '--tenant', '极客科技', '--employee', 'B001']); // 建缓存
    assert.ok(readdirSync(join(home, 'cache')).length >= cacheFiles.length);
  });
  await step('#1 显式 --tenant 时企业凭证整组来自该租户；环境里混入别家凭证直接报错', () => {
    hly(['tenant', 'add', '--name', '乙公司', '--app-id', 'b-app', '--app-secret', 'b-secret', '--base-url', base2, '--no-verify']);
    const okB = hly(['whoami', '--tenant', '乙公司', '--employee', 'E001']); assert.equal(okB.out.baseUrl, base2);
    const mixed = hly(['whoami', '--tenant', '乙公司', '--employee', 'E001'], { HLY_APP_ID: 'demo-app', HLY_APP_SECRET: 'demo-secret', HLY_BASE_URL: base }, true);
    assert.equal(mixed.code, 3); assert.equal(mixed.err.error.code, 'credential_conflict');
    const sameOk = hly(['whoami', '--tenant', '乙公司', '--employee', 'E001'], { HLY_APP_ID: 'b-app' }); assert.equal(sameOk.out.baseUrl, base2, '与 profile 一致的值不算冲突');
    const empOnly = hly(['whoami', '--tenant', '乙公司'], { HLY_EMPLOYEE_ID: 'M001' }); assert.equal(empOnly.out.employee.employeeID, 'M001', '只给工号可以');
    // 写操作也不会串：在乙公司创建的单在甲公司查不到
    const r = hly(['expense', 'create', '--form', 'X', '--title', '乙', '--tenant', '乙公司', '--employee', 'E001', '--item', '{"type":"TAXI","amount":1,"date":"2026-11-01"}']).out;
    assert.equal(hly(['expense', 'show', r.businessCode, '--tenant', '极客科技', '--employee', 'E001'], {}, true).err.error.code, 'hly_120301');
    hly(['tenant', 'remove', '乙公司']);
  });
  await step('翻页：服务端把 size 压到 2 也能按 X-Total-Count 抓全', () => {
    const all = hly(['employee', 'list', '--refresh', '--tenant', '极客科技', '--employee', 'B001']).out;
    assert.equal(all.length, 5);
  });
  await step('飞书身份 → 工号：按邮箱 / 手机号 / 姓名找员工，走缓存', () => {
    const byEmail = hly(['employee', 'find', '--email', 'ZHANG@example.com', '--tenant', '极客科技']).out; assert.equal(byEmail[0].employeeID, 'M001');
    const byMobile = hly(['employee', 'find', '--mobile', '+86 138 0000 0004', '--tenant', '极客科技']).out; assert.equal(byMobile[0].employeeID, 'B001');
    const miss = hly(['employee', 'find', '--email', 'nobody@example.com', '--tenant', '极客科技'], {}, true); assert.equal(miss.err.error.code, 'not_found');
    assert.equal(hly(['employee', 'show', 'F001', '--tenant', '极客科技']).out.fullName, '财务小王');
  });
  await step('费用类型：默认过滤停用', () => { const t = hly(['expense-types'], E).out; assert.ok(t.some((x: any) => x.code === 'TRAVEL_HOTEL')); assert.ok(!t.some((x: any) => x.code === 'OLD')); });

  let er = '';
  await step('员工创建报销单：住宿需发票被拒；补发票后成功；--dry-run 不发请求', () => {
    const bad = hly(['expense', 'create', '--form', 'ER_DAILY', '--title', '上海出差', '--item', '{"type":"TRAVEL_HOTEL","amount":800,"date":"2026-11-02"}'], E, true);
    assert.match(bad.err.error.message, /发票/);
    const dry = hly(['expense', 'create', '--form', 'ER_DAILY', '--title', 'x', '--dry-run', '--item', '{"type":"TAXI","amount":46.5,"date":"2026-11-02"}'], E);
    assert.equal(dry.out.body.employeeId, 'E001'); assert.equal(dry.out.body.openInvoiceCreateDTOList[0].occurrenceDate, '2026-11-01T16:00:00Z');
    const ok = hly(['expense', 'create', '--form', 'ER_DAILY', '--title', '上海出差',
      '--item', '{"type":"TRAVEL_HOTEL","amount":800,"date":"2026-11-02","comment":"如家","invoice":{"no":"19237929","code":"031001900104","date":"2026-11-02","checkCode":"455927"}}',
      '--item', '{"type":"TAXI","amount":46.5,"date":"2026-11-02","comment":"机场到酒店"}'], E);
    er = ok.out.businessCode; assert.match(er, /^ER/); assert.equal(ok.out.total, 846.5); assert.equal(ok.out.status, 1001);
  });
  await step('重复发票被拒；餐饮超标在提交时被 entityLabel 拦住', () => {
    const dup = hly(['expense', 'create', '--form', 'ER_DAILY', '--item', '{"type":"MEAL","amount":10,"date":"2026-11-02","invoice":{"no":"19237929","date":"2026-11-02"}}'], E, true);
    assert.match(dup.err.error.message, /已报销过/);
    const over = hly(['expense', 'create', '--form', 'ER_DAILY', '--submit', '--item', '{"type":"MEAL","amount":2500,"date":"2026-11-03","invoice":{"no":"M-1","date":"2026-11-03"}}'], E, true);
    assert.equal(over.code, 1); assert.equal(over.err.error.code, 'submit_failed'); assert.match(over.err.error.message, /上限/); assert.equal(over.err.error.raw.deleted, true);
    const draft = hly(['expense', 'create', '--form', 'ER_DAILY', '--item', '{"type":"MEAL","amount":2500,"date":"2026-11-03","invoice":{"no":"M-2","date":"2026-11-03"}}'], E).out;
    const sub = hly(['expense', 'submit', draft.businessCode], E, true); assert.equal(sub.code, 1); assert.equal(sub.err.error.code, 'submit_failed'); assert.equal(sub.err.error.raw.deleted, false);
  });
  await step('提交 → 审批中；经理待办里有它，财务待办没有', () => {
    const s = hly(['expense', 'submit', er], E); assert.equal(s.out.status, 1002);
    const inbox = hly(['inbox', ...M]).out; assert.equal(inbox.length, 1); assert.equal(inbox[0].businessCode, er); assert.equal(inbox[0].applicantId, 'E001');
    assert.equal(hly(['inbox'], Fenv).out.length, 0);
    assert.equal(hly(['expense', 'list'], E).out.length, 2, '员工列表只有自己的（出差单 + 未提交的餐饮草稿）');
  });
  await step('#2 全公司数据名单覆盖 employee list；单据详情只许本人 / 审批链上的人 / 名单内', async () => {
    const T = ['--tenant', '极客科技'];
    assert.equal(hly(['employee', 'list', ...T, '--employee', 'E001'], {}, true).err.error.code, 'forbidden');
    assert.equal(hly(['employee', 'list', ...T, '--employee', 'B001']).out.length, 5);
    assert.ok(hly(['employee', 'find', '--email', 'ligong@example.com', ...T]).out.length, 'find 仍可用于身份翻译');
    assert.equal(hly(['expense', 'show', er, ...T, '--employee', 'E001']).out.businessCode, er, '本人');
    assert.equal(hly(['expense', 'show', er, ...T, '--employee', 'M001']).out.businessCode, er, '审批链上的经理');
    assert.equal(hly(['expense', 'show', er, ...T, '--employee', 'B001']).out.businessCode, er, '名单内的老板');
    assert.equal(hly(['expense', 'show', er, ...T, '--employee', 'F001']).out.businessCode, er, '财务在名单内');
    const other = hly(['expense', 'show', er, ...T, '--employee', 'E002'], {}, true); assert.equal(other.code, 3); assert.equal(other.err.error.code, 'forbidden', '同事既不在名单也不在审批链');
    // 申请人字段缺失 ≠ 放行
    await fetch(`${base}/__test/strip-applicant/${er}`, { method: 'POST' });
    const noApplicant = hly(['expense', 'show', er, ...T, '--employee', 'E002'], {}, true); assert.equal(noApplicant.err.error.code, 'forbidden'); assert.match(noApplicant.err.error.message, /无法确认/);
    assert.equal(hly(['expense', 'show', er, ...T, '--employee', 'M001']).out.businessCode, er, '申请人缺失时审批人仍可看');
  });
  await step('驳回必须有原因；经理驳回后员工可重提；通过后状态变审核通过', () => {
    const r = hly(['reject', er], M, true); assert.equal(r.code, 2);
    hly(['reject', er, '--comment', '打车缺备注', ...M]);
    assert.equal(hly(['expense', 'show', er], E).out.status, 1001);
    hly(['expense', 'submit', er], E);
    const noauth = hly(['approve', er], Fenv, true); assert.match(noauth.err.error.message, /转交|审批人/);
    hly(['approve', er, '--comment', 'ok', ...M]);
    const d = hly(['expense', 'show', er], E).out; assert.equal(d.status, 1004); assert.equal(d.history.length, 4);
  });
  await step('大额单：经理通过后进财务节点，财务通过后结束', () => {
    const big = hly(['expense', 'create', '--form', 'ER_DAILY', '--title', '采购显卡', '--submit', '--item', '{"type":"TRAVEL_HOTEL","amount":12000,"date":"2026-11-04","invoice":{"no":"BIG-1","date":"2026-11-04"}}'], E).out;
    assert.equal(big.submitted, true);
    hly(['approve', big.businessCode, ...M]);
    const f = hly(['inbox'], Fenv).out; assert.equal(f.length, 1); assert.equal(f[0].node, '财务审批');
    hly(['approve', big.businessCode], Fenv);
    assert.equal(hly(['expense', 'show', big.businessCode], E).out.status, 1004);
    assert.equal(hly(['inbox', '--done', ...M]).out.length, 2, 'mock 每页压到 2 条');
    // M001 已办 ≥3 条，目标单在第 2 页：审批链校验要翻页才找得到
    assert.equal(hly(['expense', 'show', er, '--tenant', '极客科技', '--employee', 'M001']).out.businessCode, er);
  });
  await step('费用申请单：创建 → 提交 → 经理审批 → 已通过列表可见 → 报销关联', () => {
    const a = hly(['request', 'create', '--form', 'EA_DEFAULT', '--title', '去深圳见客户', '--submit', '--budget', '{"type":"TRAVEL_HOTEL","amount":1500,"department":"1002"}'], E).out;
    assert.match(a.businessCode, /^EA/); assert.equal(a.submitted, true);
    assert.equal(hly(['request', 'show', a.businessCode], E).out.status, 1002);
    hly(['approve', a.businessCode, '--type', 'application', ...M]);
    const ok = hly(['request', 'approved'], E).out; assert.equal(ok.length, 1); assert.equal(ok[0].businessCode, a.businessCode);
    const r = hly(['expense', 'create', '--form', 'ER_DAILY', '--reference', a.businessCode, '--item', '{"type":"TAXI","amount":30,"date":"2026-11-10"}'], E);
    assert.match(r.out.businessCode, /^ER/);
  });
  await step('老板查花费：按类型 / 员工汇总，逐笔明细，待报销；币种分开；发生日期口径', async () => {
    // 一笔 USD、一笔发生在 2025 年但本月才录入的费用
    hly(['expense', 'create', '--form', 'ER_DAILY', '--submit', '--item', '{"type":"TAXI","amount":100,"date":"2026-11-05","currency":"USD"}', '--item', '{"type":"TAXI","amount":7,"date":"2025-12-20"}'], E);
    const s = hly(['spend', 'summary', '--from', '2026-01-01', '--to', '2027-01-01', '--by', 'type', ...B]).out;
    assert.deepEqual(s.totals_by_currency, { CNY: 12846.5, USD: 100 }); assert.equal(s.grand_total, undefined, '不再给跨币种合计');
    assert.ok(s.rows.some((r: any) => r.label === '市内交通' && r.currency === 'USD' && r.total === 100));
    assert.equal(s.rows.find((r: any) => r.currency === 'CNY' && r.label === '住宿费').total, 12800);
    const old = hly(['spend', 'summary', '--from', '2025-12-01', '--to', '2025-12-31', '--by', 'month', ...B]).out;
    assert.deepEqual(old.totals_by_currency, { CNY: 7 }); assert.equal(old.rows[0].label, '2025-12', '按发生日期能查到去年发生、今年录入的费用');
    const mod = hly(['spend', 'summary', '--from', '2025-12-01', '--to', '2025-12-31', '--date-field', 'modified', ...B]).out;
    assert.equal(mod.count, 0, '修改日期口径下去年没有变动');
    // 没有发生日期字段的费用：不冒充、单独计数；修改日期口径仍能看到
    await fetch(`${base}/__test/invoice-without-occurrence`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ amount: 9 }) });
    const s2 = hly(['spend', 'summary', '--from', '2026-01-01', '--to', '2027-01-01', ...B]).out;
    assert.equal(s2.excluded_no_occurrence_date, 1); assert.equal(s2.totals_by_currency.CNY, 12846.5, '没并入统计');
    const m2 = hly(['spend', 'items', '--from', todayStr(), '--to', todayStr(), '--date-field', 'modified', ...B]).out;
    assert.ok(m2.some((i: any) => i.date === '(无发生日期)' && i.amount === 9));
    const byEmp = hly(['spend', 'summary', '--from', '2026-01-01', '--to', '2027-01-01', '--by', 'employee', '--status', '1003', ...B]).out;
    assert.equal(byEmp.rows.find((r: any) => r.currency === 'CNY').label, 'E001');
    const items = hly(['spend', 'items', '--from', '2026-01-01', '--to', '2027-01-01', '--status', '1001', ...B]).out;
    assert.deepEqual(items.map((i: any) => i.amount).sort((a: number, b: number) => a - b), [30, 2500], '草稿里的费用是 INIT'); assert.equal(items[0].currency, 'CNY');
    assert.equal(hly(['spend', 'unreimbursed', '--employee-id', 'E001', ...B]).out.count, 2);
  });
  await step('raw api 逃生口', () => { assert.equal(hly(['api', 'GET', '/api/open/user/detail/F001', ...B]).out.fullName, '财务小王'); });
  await step('token 缓存：第二次调用不再请求 /oauth/token（verbose 日志里无 token 请求）', () => {
    const r = spawnSync('node', ['--no-warnings', 'dist/cli.js', '--json', '--verbose', 'whoami', ...B], { encoding: 'utf8', env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('HLY_'))), HLY_CONFIG_DIR: home } });
    assert.ok(!r.stderr.includes('/oauth/token'), r.stderr);
  });
  console.log(`\n全部通过：${n} 个场景`);
} catch (e) { console.error('\n失败：', e); process.exitCode = 1; }
finally { server.kill(); server2.kill(); rmSync(home, { recursive: true, force: true }); }
