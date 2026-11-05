// 端到端：启动 mock 汇联易，用真实 CLI 子进程走完 员工报销 → 经理审批 → 财务审批 → 老板查花费，并验证四种传凭证方式与多人同机隔离。
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// mock 必须是独立进程：spawnSync 会阻塞本进程的事件循环
const port = 9700 + Math.floor(Math.random() * 200);
const base = `http://127.0.0.1:${port}`;
const server = spawn('node', ['--no-warnings', '--import', 'tsx', 'test/mock-server.ts'], { env: { ...process.env, PORT: String(port) }, stdio: 'ignore' });
for (let i = 0; i < 100; i++) { try { await fetch(base + '/'); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
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

let n = 0; const step = (name: string, fn: () => void) => { fn(); n++; console.log('  ✓', name); };
try {
  const E = { HLY_CREDENTIAL_FILE: credFile('E001') }; // 员工：环境变量指向凭证文件
  const M = ['--credential-file', credFile('M001')];  // 经理：命令行指定凭证文件
  const Fenv = { HLY_APP_ID: 'demo-app', HLY_APP_SECRET: 'demo-secret', HLY_EMPLOYEE_ID: 'F001', HLY_BASE_URL: base }; // 财务：纯环境变量
  const B = ['--as', '老板']; // 老板：保存的 profile

  step('无凭证 → 退出码 3 且有 hint', () => { const r = hly(['whoami'], {}, true); assert.equal(r.code, 3); assert.equal(r.err.error.code, 'no_credential'); assert.ok(r.err.error.hint); });
  step('错误 appSecret → auth_failed', () => { const r = hly(['whoami', '--app-id', 'demo-app', '--app-secret', 'wrong', '--employee', 'E001', '--base-url', base], {}, true); assert.equal(r.code, 3); assert.equal(r.err.error.code, 'auth_failed'); });
  step('auth login 保存老板身份（profile）；第二个人不抢默认', () => {
    const r = hly(['auth', 'login', '--app-id', 'demo-app', '--app-secret', 'demo-secret', '--employee', 'B001', '--base-url', base]);
    assert.equal(r.out.profile, '老板'); assert.equal(r.out.default, true);
    const r2 = hly(['auth', 'login', '--app-id', 'demo-app', '--app-secret', 'demo-secret', '--employee', 'M001', '--base-url', base, '--name', 'mgr']);
    assert.equal(r2.out.default, false);
    assert.equal(hly(['auth', 'list']).out.length, 2);
  });
  step('四个人、四种传法，whoami 各自正确', () => {
    assert.equal(hly(['whoami'], E).out.employee.employeeID, 'E001');
    assert.equal(hly(['whoami', ...M]).out.employee.employeeID, 'M001');
    assert.equal(hly(['whoami'], Fenv).out.employee.employeeID, 'F001');
    assert.equal(hly(['whoami', ...B]).out.employee.employeeID, 'B001');
    const amb = hly(['whoami'], {}, true); assert.equal(amb.code, 3); assert.match(amb.err.error.message, /显式指定 --tenant/, '多个 profile 时不允许隐式默认');
    const w = hly(['whoami', '--as', '老板', '--employee', 'E001']); // profile 给 app 凭证，命令行只换人
    assert.equal(w.out.employee.employeeID, 'E001'); assert.match(w.out.credential_source, /profile:老板 \+ flags/);
    const bogus = hly(['whoami', '--as', '不存在'], {}, true); assert.equal(bogus.code, 3);
  });
  step('HTTP 200 + errorCode 的业务错误不会被当成功：whoami / show / list 都退出 1 并带 hint', () => {
    const r = hly(['whoami', '--as', '老板', '--employee', 'NOPE'], {}, true); assert.equal(r.code, 1); assert.equal(r.err.error.code, 'hly_120207'); assert.match(r.err.error.hint, /工号/);
    assert.equal(hly(['employee', 'show', 'NOPE', '--as', '老板'], {}, true).err.error.code, 'hly_120207');
    assert.equal(hly(['expense', 'show', 'ERX', '--as', '老板'], {}, true).err.error.code, 'hly_120301');
    const bad = hly(['expense', 'create', '--form', 'X', '--item', '{bad', '--as', '老板'], {}, true); assert.equal(bad.code, 2); assert.equal(bad.err.error.code, 'bad_args');
    const nofile = hly(['whoami', '--credential-file', '/nonexistent.json'], {}, true); assert.equal(nofile.code, 3); assert.equal(nofile.err.error.code, 'no_credential');
  });
  step('多租户：tenant add 不绑工号；--tenant + --employee 替谁办；spend 名单生效', () => {
    const t = hly(['tenant', 'add', '--name', '极客科技', '--app-id', 'demo-app', '--app-secret', 'demo-secret', '--base-url', base, '--spend-allow', 'B001', '--spend-allow', 'F001']);
    assert.equal(t.out.employees, 4);
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
  step('tenant add 不继承别家公司的 secret；remove 连缓存一起删', () => {
    const bad = hly(['tenant', 'add', '--name', '隔壁', '--app-id', 'other', '--no-verify', '--tenant', '极客科技'], {}, true);
    assert.equal(bad.err.error.code, 'no_credential'); assert.match(bad.err.error.message, /app-secret/);
    hly(['tenant', 'add', '--name', '隔壁', '--app-id', 'other', '--app-secret', 'x', '--base-url', base, '--no-verify']);
    const saved = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).profiles['隔壁'];
    assert.equal(saved.appSecret, 'x'); assert.equal(saved.companyCode, undefined);
    hly(['tenant', 'remove', '隔壁']);
    assert.ok(!hly(['tenant', 'list']).out.some((x: any) => x.name === '隔壁'));
    const cacheFiles = readdirSync(join(home, 'cache'));
    hly(['employee', 'list', '--tenant', '极客科技']); // 建缓存
    assert.ok(readdirSync(join(home, 'cache')).length >= cacheFiles.length);
  });
  step('翻页：服务端把 size 压到 2 也能按 X-Total-Count 抓全', () => {
    const all = hly(['employee', 'list', '--refresh', '--tenant', '极客科技']).out;
    assert.equal(all.length, 4);
  });
  step('飞书身份 → 工号：按邮箱 / 手机号 / 姓名找员工，走缓存', () => {
    const byEmail = hly(['employee', 'find', '--email', 'ZHANG@geek.cn', '--tenant', '极客科技']).out; assert.equal(byEmail[0].employeeID, 'M001');
    const byMobile = hly(['employee', 'find', '--mobile', '+86 138 0000 0004', '--tenant', '极客科技']).out; assert.equal(byMobile[0].employeeID, 'B001');
    const miss = hly(['employee', 'find', '--email', 'nobody@geek.cn', '--tenant', '极客科技'], {}, true); assert.equal(miss.err.error.code, 'not_found');
    assert.equal(hly(['employee', 'show', 'F001', '--tenant', '极客科技']).out.fullName, '财务小王');
  });
  step('费用类型：默认过滤停用', () => { const t = hly(['expense-types'], E).out; assert.ok(t.some((x: any) => x.code === 'TRAVEL_HOTEL')); assert.ok(!t.some((x: any) => x.code === 'OLD')); });

  let er = '';
  step('员工创建报销单：住宿需发票被拒；补发票后成功；--dry-run 不发请求', () => {
    const bad = hly(['expense', 'create', '--form', 'ER_DAILY', '--title', '上海出差', '--item', '{"type":"TRAVEL_HOTEL","amount":800,"date":"2026-11-02"}'], E, true);
    assert.match(bad.err.error.message, /发票/);
    const dry = hly(['expense', 'create', '--form', 'ER_DAILY', '--title', 'x', '--dry-run', '--item', '{"type":"TAXI","amount":46.5,"date":"2026-11-02"}'], E);
    assert.equal(dry.out.body.employeeId, 'E001'); assert.equal(dry.out.body.openInvoiceCreateDTOList[0].occurrenceDate, '2026-11-01T16:00:00Z');
    const ok = hly(['expense', 'create', '--form', 'ER_DAILY', '--title', '上海出差',
      '--item', '{"type":"TRAVEL_HOTEL","amount":800,"date":"2026-11-02","comment":"如家","invoice":{"no":"19237929","code":"031001900104","date":"2026-11-02","checkCode":"455927"}}',
      '--item', '{"type":"TAXI","amount":46.5,"date":"2026-11-02","comment":"机场到酒店"}'], E);
    er = ok.out.businessCode; assert.match(er, /^ER/); assert.equal(ok.out.total, 846.5); assert.equal(ok.out.status, 1001);
  });
  step('重复发票被拒；餐饮超标在提交时被 entityLabel 拦住', () => {
    const dup = hly(['expense', 'create', '--form', 'ER_DAILY', '--item', '{"type":"MEAL","amount":10,"date":"2026-11-02","invoice":{"no":"19237929","date":"2026-11-02"}}'], E, true);
    assert.match(dup.err.error.message, /已报销过/);
    const over = hly(['expense', 'create', '--form', 'ER_DAILY', '--submit', '--item', '{"type":"MEAL","amount":2500,"date":"2026-11-03","invoice":{"no":"M-1","date":"2026-11-03"}}'], E);
    assert.equal(over.out.submitted, false); assert.match(over.out.labels[0].toast, /上限/);
  });
  step('提交 → 审批中；经理待办里有它，财务待办没有', () => {
    const s = hly(['expense', 'submit', er], E); assert.equal(s.out.status, 1002);
    const inbox = hly(['inbox', ...M]).out; assert.equal(inbox.length, 1); assert.equal(inbox[0].businessCode, er); assert.equal(inbox[0].applicantId, 'E001');
    assert.equal(hly(['inbox'], Fenv).out.length, 0);
    assert.equal(hly(['expense', 'list'], E).out.length, 1, '员工列表只有自己的');
  });
  step('驳回必须有原因；经理驳回后员工可重提；通过后状态变审核通过', () => {
    const r = hly(['reject', er], M, true); assert.equal(r.code, 2);
    hly(['reject', er, '--comment', '打车缺备注', ...M]);
    assert.equal(hly(['expense', 'show', er], E).out.status, 1001);
    hly(['expense', 'submit', er], E);
    const noauth = hly(['approve', er], Fenv, true); assert.match(noauth.err.error.message, /转交|审批人/);
    hly(['approve', er, '--comment', 'ok', ...M]);
    const d = hly(['expense', 'show', er], E).out; assert.equal(d.status, 1004); assert.equal(d.history.length, 4);
  });
  step('大额单：经理通过后进财务节点，财务通过后结束', () => {
    const big = hly(['expense', 'create', '--form', 'ER_DAILY', '--title', '采购显卡', '--submit', '--item', '{"type":"TRAVEL_HOTEL","amount":12000,"date":"2026-11-04","invoice":{"no":"BIG-1","date":"2026-11-04"}}'], E).out;
    assert.equal(big.submitted, true);
    hly(['approve', big.businessCode, ...M]);
    const f = hly(['inbox'], Fenv).out; assert.equal(f.length, 1); assert.equal(f[0].node, '财务审批');
    hly(['approve', big.businessCode], Fenv);
    assert.equal(hly(['expense', 'show', big.businessCode], E).out.status, 1004);
    assert.equal(hly(['inbox', '--done', ...M]).out.length, 3);
  });
  step('费用申请单：创建 → 提交 → 经理审批 → 已通过列表可见 → 报销关联', () => {
    const a = hly(['request', 'create', '--form', 'EA_DEFAULT', '--title', '去深圳见客户', '--submit', '--budget', '{"type":"TRAVEL_HOTEL","amount":1500,"department":"1002"}'], E).out;
    assert.match(a.businessCode, /^EA/); assert.equal(a.submitted, true);
    assert.equal(hly(['request', 'show', a.businessCode], E).out.status, 1002);
    hly(['approve', a.businessCode, '--type', 'application', ...M]);
    const ok = hly(['request', 'approved'], E).out; assert.equal(ok.length, 1); assert.equal(ok[0].businessCode, a.businessCode);
    const r = hly(['expense', 'create', '--form', 'ER_DAILY', '--reference', a.businessCode, '--item', '{"type":"TAXI","amount":30,"date":"2026-11-10"}'], E);
    assert.match(r.out.businessCode, /^ER/);
  });
  step('老板查花费：按类型 / 员工汇总，逐笔明细，待报销', () => {
    const s = hly(['spend', 'summary', '--from', '2026-01-01', '--to', '2027-01-01', '--by', 'type', ...B]).out;
    assert.equal(s.grand_total, 12846.5); assert.equal(s.rows[0].label, '住宿费');
    const byEmp = hly(['spend', 'summary', '--from', '2026-01-01', '--to', '2027-01-01', '--by', 'employee', '--status', '1003', ...B]).out;
    assert.equal(byEmp.rows[0].label, 'E001');
    const items = hly(['spend', 'items', '--from', '2026-01-01', '--to', '2027-01-01', '--status', '1001', ...B]).out;
    assert.equal(items.length, 1); assert.equal(items[0].amount, 30);
    assert.equal(hly(['spend', 'unreimbursed', '--employee-id', 'E001', ...B]).out.count, 1);
  });
  step('raw api 逃生口', () => { assert.equal(hly(['api', 'GET', '/api/open/user/detail/F001', ...B]).out.fullName, '财务小王'); });
  step('token 缓存：第二次调用不再请求 /oauth/token（verbose 日志里无 token 请求）', () => {
    const r = spawnSync('node', ['--no-warnings', 'dist/cli.js', '--json', '--verbose', 'whoami', ...B], { encoding: 'utf8', env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('HLY_'))), HLY_CONFIG_DIR: home } });
    assert.ok(!r.stderr.includes('/oauth/token'), r.stderr);
  });
  console.log(`\n全部通过：${n} 个场景`);
} catch (e) { console.error('\n失败：', e); process.exitCode = 1; }
finally { server.kill(); rmSync(home, { recursive: true, force: true }); }
