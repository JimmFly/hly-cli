// 汇联易开放 API 的 mock：按官方文档的路径、参数、响应结构实现最小行为，用于本地测试与演示。
// 启动：pnpm mock（端口 9797）。凭证：appId=demo-app appSecret=demo-secret；员工 E001 李工（上级 M001 张经理，部门 研发部）、M001、F001 财务、B001 老板。
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { randomUUID } from 'node:crypto';

export function createMock(opts: { appId: string; appSecret: string }) {
  const app = new Hono();
  const tokens = new Set<string>();
  const employees: Record<string, any> = {
    E001: { employeeID: 'E001', fullName: '李工', email: 'ligong@geek.cn', mobile: '13800000001', companyName: '极客科技', companyCode: 'GEEK', departmentName: '研发部', departmentPath: '极客科技|研发部', custDeptNumber: '1002', title: '工程师', status: 1001, directManagerName: '张经理', directManagerEmployeeId: 'M001' },
    M001: { employeeID: 'M001', fullName: '张经理', email: 'zhang@geek.cn', mobile: '13800000002', companyName: '极客科技', companyCode: 'GEEK', departmentName: '研发部', departmentPath: '极客科技|研发部', custDeptNumber: '1002', title: '经理', status: 1001 },
    F001: { employeeID: 'F001', fullName: '财务小王', email: 'wang@geek.cn', mobile: '13800000003', companyName: '极客科技', companyCode: 'GEEK', departmentName: '财务部', departmentPath: '极客科技|财务部', custDeptNumber: '1003', title: '会计', status: 1001 },
    B001: { employeeID: 'B001', fullName: '老板', email: 'boss@geek.cn', mobile: '13800000004', companyName: '极客科技', companyCode: 'GEEK', departmentName: '总经办', departmentPath: '极客科技|总经办', custDeptNumber: '1001', title: 'CEO', status: 1001 },
  };
  const expenseTypes = [
    { expenseTypeOID: 'et-hotel', code: 'TRAVEL_HOTEL', name: '住宿费', enabled: true, pasteInvoiceNeeded: true, isAttachmentRequired: true, expenseTypeCategoryName: '差旅', fields: [] },
    { expenseTypeOID: 'et-taxi', code: 'TAXI', name: '市内交通', enabled: true, pasteInvoiceNeeded: false, isAttachmentRequired: false, expenseTypeCategoryName: '差旅', fields: [] },
    { expenseTypeOID: 'et-meal', code: 'MEAL', name: '餐饮费', enabled: true, pasteInvoiceNeeded: true, isAttachmentRequired: true, expenseTypeCategoryName: '日常', fields: [{ name: '用餐人数', required: true }] },
    { expenseTypeOID: 'et-old', code: 'OLD', name: '停用类型', enabled: false, fields: [] },
  ];
  const reports = new Map<string, any>();      // 报销单
  const applications = new Map<string, any>(); // 费用申请单
  const invoices: any[] = [];                  // 费用明细
  const tasks: any[] = [];                     // 审批待办
  let seq = 100;
  const err = (c: any, errorCode: string, message: string) => c.json({ message, errorCode });
  const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  app.post('/oauth/token', async (c) => {
    const basic = c.req.header('authorization') ?? '';
    const [id, secret] = Buffer.from(basic.replace(/^Basic /, ''), 'base64').toString().split(':');
    const form = await c.req.parseBody();
    if (id !== opts.appId || secret !== opts.appSecret) return c.json({ error: 'invalid_client', error_description: 'Bad client credentials' }, 401);
    if (form.grant_type !== 'client_credentials') return c.json({ error: 'unsupported_grant_type' }, 400);
    const t = 'tok-' + randomUUID(); tokens.add(t);
    return c.json({ access_token: t, token_type: 'bearer', expires_in: 3600, scope: 'write' });
  });

  app.use('/api/*', async (c, next) => {
    const t = (c.req.header('authorization') ?? '').replace(/^Bearer /, '');
    if (!tokens.has(t)) return c.json({ error: 'invalid_token', error_description: 'Invalid access token' }, 401);
    await next();
  });

  app.get('/api/open/user/detail/:id', (c) => { const e = employees[c.req.param('id')]; return e ? c.json(e) : err(c, '120207', '员工不存在'); });
  app.get('/api/open/user', (c) => { const list = Object.values(employees); c.header('X-Total-Count', String(list.length)); const page = Math.max(1, Number(c.req.query('page'))), size = Number(c.req.query('size')); return c.json(list.slice((page - 1) * size, page * size)); });
  app.get('/api/open/expenseType', (c) => c.json(expenseTypes));

  // ---- 报销单 ----
  const addTask = (entityType: number, doc: any, approverId: string, nodeName: string) => tasks.push({
    entityType, formOID: randomUUID(), applicant: { fullName: employees[doc.employeeId].fullName, employeeID: doc.employeeId }, approver: { fullName: employees[approverId].fullName, employeeID: approverId },
    department: { name: employees[doc.employeeId].departmentName, custDeptNumber: employees[doc.employeeId].custDeptNumber }, formName: doc.formName, formCode: doc.formCode, businessCode: doc.businessCode,
    submittedDate: now(), amount: doc.totalAmount, currencyCode: 'CNY', baseCurrencyAmount: doc.totalAmount, baseCurrencyCode: 'CNY', title: doc.title, nodeName, heliosTaskId: String(++seq), taskStatus: 1000, approvalLink: `https://mock/approval/${doc.businessCode}`,
  });
  const submitReport = (r: any) => {
    if (r.status !== 1001) return { ok: false, message: '单据不是编辑态', code: '121209' };
    const meal = r.expenseReportInvoices.filter((i: any) => i.invoiceView.expenseTypeCode === 'MEAL').reduce((s: number, i: any) => s + i.invoiceView.amount, 0);
    if (meal > 2000) return { ok: false, labels: [{ name: '餐饮超标', level: 'ERROR', toast: `餐饮费单单上限 CNY 2000.00，实际 CNY ${meal.toFixed(2)}`, type: 'EXPENSE_OVER_POLICY' }] };
    r.status = 1002; r.lastSubmittedDate = now();
    r.expenseReportInvoices.forEach((i: any) => { i.invoiceView.invoiceStatus = 'SUBMITTED'; i.invoiceView.lastModifiedDate = now(); });
    r.approvalHistoryDTOs.push({ operationDate: now(), operatorName: employees[r.employeeId].fullName, operationTypeName: '提交单据', operationDetail: '' });
    const mgr = employees[r.employeeId].directManagerEmployeeId ?? 'F001';
    addTask(1002, r, mgr, '直属上级审批');
    return { ok: true };
  };
  app.post('/api/open/expenseReport/create', async (c) => {
    const b = await c.req.json();
    if (!b.employeeId || !b.formCode) return err(c, '120003', `缺少必填项:${!b.employeeId ? 'employeeId' : 'formCode'}`);
    if (!employees[b.employeeId]) return err(c, '120207', '员工不存在');
    if (b.uuid && [...reports.values()].some((r) => r.uuid === b.uuid)) return err(c, '60012', 'uuid 重复');
    const items = (b.openInvoiceCreateDTOList ?? []).map((i: any) => {
      const et = expenseTypes.find((t) => t.code === i.expenseTypeCode);
      if (!et) throw new Error(`费用类型不存在:${i.expenseTypeCode}`);
      if (et.pasteInvoiceNeeded && !(i.openReceiptRequestDTOList?.length)) throw new Error(`费用类型「${et.name}」必须附发票`);
      if (i.openReceiptRequestDTOList?.some((r: any) => invoices.some((x) => x.billingNo === r.billingNo))) throw new Error(`发票 ${i.openReceiptRequestDTOList[0].billingNo} 已报销过`);
      const inv = { invoiceOID: randomUUID(), expenseTypeOID: et.expenseTypeOID, expenseTypeName: et.name, expenseTypeCode: et.code, amount: i.amount, currencyCode: i.invoiceCurrencyCode, invoiceCurrencyCode: i.invoiceCurrencyCode, employeeId: i.ownerEmployeeId ?? b.employeeId, invoiceStatus: 'INIT', createdDate: i.occurrenceDate, lastModifiedDate: now(), comment: i.comment, billingNo: i.openReceiptRequestDTOList?.[0]?.billingNo, data: i.data ?? [] };
      invoices.push(inv);
      return { invoiceOID: inv.invoiceOID, createdDate: inv.createdDate, status: 1000, invoiceView: inv };
    });
    const code = `ER${String(++seq).padStart(8, '0')}`;
    const title = (b.openCustomFormValueRequestDTOList ?? []).find((f: any) => f.fieldCode === 'title')?.value ?? '';
    const r = { businessCode: code, uuid: b.uuid, formCode: b.formCode, formName: '日常报销单', employeeId: b.employeeId, applicantName: employees[b.employeeId].fullName, departmentName: employees[b.employeeId].departmentName, status: 1001, totalAmount: items.reduce((s: number, i: any) => s + i.invoiceView.amount, 0), currencyCode: 'CNY', title, remark: title, createdDate: now(), lastModifiedDate: now(), lastSubmittedDate: null, expenseReportInvoices: items, approvalHistoryDTOs: [] as any[], referenceApplicationBusinessCodeList: b.referenceApplicationBusinessCodeList ?? [] };
    reports.set(code, r);
    let data: any = { status: 1001 };
    if (b.autoSubmit) { const s = submitReport(r); data = s.ok ? { status: 1002 } : { status: 1001, entityLabel: s.labels, submitErrorCode: s.code, submitErrorMessage: s.message ?? s.labels?.[0]?.toast }; if (!s.ok && b.autoDelete !== false) { reports.delete(code); items.forEach((i: any) => invoices.splice(invoices.indexOf(i.invoiceView), 1)); } }
    return c.json({ message: '操作成功', errorCode: '0000', key: code, data });
  });
  app.onError((e, c) => c.json({ message: e.message, errorCode: '120999' }));
  app.post('/api/open/expenseReport/submit', async (c) => {
    const b = await c.req.json(); const r = reports.get(b.businessCode);
    if (!r) return err(c, '120301', '报销单不存在'); if (r.employeeId !== b.employeeId) return err(c, '120302', '只能提交本人单据');
    const s = submitReport(r);
    return c.json(s.ok ? { message: '操作成功', errorCode: '0000', key: r.businessCode, data: { status: 1002 } } : { message: s.message ?? '提交失败', errorCode: '0000', key: r.businessCode, data: { status: 1001, entityLabel: s.labels } });
  });
  app.get('/api/open/expenseReport/detail', (c) => { const r = reports.get(c.req.query('businessCode') ?? ''); return r ? c.json(r) : err(c, '120301', '报销单不存在'); });
  app.get('/api/open/expenseReport', (c) => {
    const q = c.req.query(); const st = (q.status ?? '').split(',').filter(Boolean).map(Number);
    const list = [...reports.values()].filter((r) => (!q.applicantEmployeeId || r.employeeId === q.applicantEmployeeId) && (!st.length || st.includes(r.status)) && r.lastModifiedDate >= q.startDate!.replace(' ', 'T') && r.lastModifiedDate <= q.endDate!.replace(' ', 'T') + 'Z');
    const page = Math.max(1, Number(q.page)), size = Number(q.size);
    c.header('X-Total-Count', String(list.length));
    return c.json(list.slice((page - 1) * size, page * size));
  });

  // ---- 申请单 ----
  app.post('/api/open/expenseApplication/create', async (c) => {
    const b = await c.req.json();
    if (!b.status) return err(c, '120003', '缺少必填项:status'); if (!employees[b.employeeID]) return err(c, '120207', '员工不存在');
    const code = `EA${String(++seq).padStart(8, '0')}`;
    const budgets = (b.expenseApplication?.itineraryBudgetDTOs ?? []).map((x: any) => ({ ...x, expenseTypeName: expenseTypes.find((t) => t.code === x.expenseTypeCode)?.name }));
    const a = { businessCode: code, employeeId: b.employeeID, formCode: b.formCode, formName: '费用申请单', title: b.custFormValues?.find((f: any) => f.fieldCode === 'title' || f.messageKey === 'title')?.value, status: b.status, totalAmount: budgets.reduce((s: number, x: any) => s + x.amount, 0), currencyCode: 'CNY', applicant: { fullName: employees[b.employeeID].fullName, employeeID: b.employeeID }, expenseApplication: { itineraryBudgetDTOs: budgets }, type: 1001, submittedDate: null as string | null, lastModifiedDate: now(), referReportList: [] };
    applications.set(code, a);
    return c.json({ message: 'operation completed', errorCode: '0000', key: code });
  });
  app.post('/api/open/expenseApplication/submit', (c) => {
    const a = applications.get(c.req.query('businessCode') ?? ''); if (!a) return err(c, '120301', '申请单不存在'); if (a.status !== 1001) return err(c, '121209', '该费用申请单非编辑态');
    a.status = 1002; a.submittedDate = now(); a.lastModifiedDate = now(); addTask(1001, a, employees[a.employeeId].directManagerEmployeeId ?? 'F001', '直属上级审批');
    return c.json({ message: '操作成功', errorCode: '0000', key: a.businessCode });
  });
  app.get('/api/open/expenseApplication/detail', (c) => { const a = applications.get(c.req.query('businessCode') ?? ''); return a ? c.json({ message: '', errorCode: '0000', data: a }) : err(c, '120301', '申请单不存在'); });
  app.get('/api/open/expenseApplication', (c) => { const q = c.req.query(); return c.json([...applications.values()].filter((a) => (!q.applicantEmployeeId || a.employeeId === q.applicantEmployeeId) && (!q.status || Number(q.status) === a.status))); });
  app.get('/api/open/application/by/user', (c) => c.json({ message: 'operation completed', errorCode: '0000', data: [...applications.values()].filter((a) => a.employeeId === c.req.query('applicantEmployeeId') && a.status === 1003) }));

  // ---- 审批 ----
  app.post('/api/open/batch/approval', async (c) => {
    const b = await c.req.json(); const done = b.status === 1002;
    const list = tasks.filter((t) => (!b.employeeId || t.approver.employeeID === b.employeeId) && (done ? t.taskStatus === 1001 : t.taskStatus === 1000) && (!b.entityType?.length || b.entityType.includes(t.entityType)));
    c.header('X-Total-Count', String(list.length));
    return c.json({ message: 'operation completed', errorCode: '0000', data: list });
  });
  const decide = (b: any, result: 'AGREE' | 'REFUSE') => {
    const t = tasks.find((x) => x.businessCode === b.businessCode && x.entityType === b.entityType && x.taskStatus === 1000);
    if (!t) return '单据不存在或无待办任务';
    if (t.approver.employeeID !== b.approver) return '自审批无部门经理可转交';
    t.taskStatus = 1001; t.result = result; t.taskUpdateDate = now();
    const doc = b.entityType === 1002 ? reports.get(b.businessCode) : applications.get(b.businessCode);
    doc.approvalHistoryDTOs?.push({ operationDate: now(), operatorName: employees[b.operator].fullName, operationTypeName: result === 'AGREE' ? '审批通过' : '审批驳回', operationDetail: b.approvalTxt ?? '' });
    if (result === 'REFUSE') { doc.status = 1001; return null; }
    if (b.entityType === 1002 && doc.totalAmount >= 5000 && t.nodeName !== '财务审批') { addTask(1002, doc, 'F001', '财务审批'); return null; }
    doc.status = b.entityType === 1002 ? 1004 : 1003; doc.lastModifiedDate = now();
    if (b.entityType === 1002) doc.expenseReportInvoices.forEach((i: any) => { i.invoiceView.invoiceStatus = 'FINISHED'; i.invoiceView.lastModifiedDate = now(); });
    return null;
  };
  app.post('/api/open/approvals/pass', async (c) => { const b = await c.req.json(); const e = decide(b, 'AGREE'); return e ? err(c, '121935', e) : c.json({ message: '', errorCode: '0000' }); });
  app.post('/api/open/approvals/reject', async (c) => { const b = await c.req.json(); if (!b.approvalTxt) return err(c, '120003', '缺少必填项:approvalTxt'); const e = decide(b, 'REFUSE'); return e ? err(c, '121935', e) : c.json({ message: '', errorCode: '0000' }); });

  // ---- 费用 ----
  app.get('/api/open/invoice', (c) => {
    const q = c.req.query(); const st = (q.invoiceStatus ?? '').split(',').filter(Boolean);
    const map: Record<string, string> = { '1001': 'INIT', '1002': 'SUBMITTED', '1003': 'FINISHED', '1005': 'DELETED' };
    const list = invoices.filter((i) => (!q.employeeId || i.employeeId === q.employeeId) && (!st.length || st.map((s) => map[s] ?? s).includes(i.invoiceStatus)) && i.lastModifiedDate >= q.startDate!.replace(' ', 'T') && i.lastModifiedDate <= q.endDate!.replace(' ', 'T') + 'Z' && (!q.expenseTypeOIDs || q.expenseTypeOIDs.split(',').includes(i.expenseTypeOID)));
    const page = Math.max(1, Number(q.page)), size = Number(q.size);
    c.header('X-Total-Count', String(list.length));
    return c.json(list.slice((page - 1) * size, page * size));
  });
  app.post('/api/open/invoice/query/unreimbursed/expenses', async (c) => {
    const b = await c.req.json(); const mine = invoices.filter((i) => i.employeeId === b.employeeId && i.invoiceStatus === 'INIT');
    return c.json({ message: '操作成功', errorCode: '0000', data: { count: mine.length, amountByCurrencyCodeList: mine.length ? [{ currencyCode: 'CNY', totalAmount: mine.reduce((s, i) => s + i.amount, 0) }] : [] } });
  });

  // 测试辅助：让某申请单直接通过
  app.post('/__test/approve-application/:code', (c) => { const a = applications.get(c.req.param('code')); if (a) a.status = 1003; return c.json({ ok: !!a }); });
  return app;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop()!)) {
  const port = Number(process.env.PORT ?? 9797);
  serve({ fetch: createMock({ appId: 'demo-app', appSecret: 'demo-secret' }).fetch, port }, () =>
    console.log(`mock 汇联易 已启动 http://localhost:${port}  appId=demo-app appSecret=demo-secret  员工 E001 李工 / M001 张经理 / F001 财务小王 / B001 老板`));
}
