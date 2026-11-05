// 汇联易开放 API 客户端：token 获取与缓存、统一请求、各业务接口的薄封装。
// 接口路径来自 https://opendocs.huilianyi.com/ ；鉴权方式来自官方 SDK 用法（/oauth/token, client_credentials）。
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { cacheDir, HlyError, type Credential } from './config.js';

export interface Envelope<T = any> { message?: string; errorCode?: string; key?: string; oid?: string; data?: T; spanId?: string }

/** 单据类型 entityType */
export const ENTITY_TYPES: Record<string, number> = { application: 1001, expense: 1002, loan: 3001, budget_journal: 3005, generic: 4001, contract: 6001, payment: 7001, supplier: 9001 };
export const ENTITY_NAMES: Record<number, string> = { 1001: '申请单', 1002: '报销单', 3001: '借款单', 3005: '预算日记账', 4001: '通用表单', 6001: '合同申请', 7001: '付款申请', 9001: '供应商申请' };
export const REPORT_STATUS: Record<number, string> = { 1001: '编辑中/已驳回', 1002: '审批中', 1003: '待审核', 1004: '审核通过', 1005: '已付款', 1007: '待付款', 1008: '付款中', 1015: '取消支付' };
export const APPLICATION_STATUS: Record<number, string> = { 1001: '编辑中', 1002: '审批中', 1003: '已通过', 1010: '已删除', 1011: '已变更', 1012: '已报废' };
export const INVOICE_STATUS: Record<string, string> = { '1001': '初始', '1002': '待审批', '1003': '流程结束', '1005': '已删除', INIT: '初始', SUBMITTED: '待审批', FINISHED: '流程结束', DELETED: '已删除' };

export class Hly {
  constructor(public cred: Credential, private opts: { verbose?: boolean; tzOffsetMin?: number } = {}) {}

  // ---------- 日期 ----------
  /** YYYY-MM-DD（按东八区零点）或完整 ISO → 汇联易要求的 UTC 格式 2020-09-25T03:16:33Z */
  toUtc(d: string): string {
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) {
      const off = this.opts.tzOffsetMin ?? Number(process.env.HLY_TZ_OFFSET ?? 480);
      const sign = off >= 0 ? '+' : '-'; const a = Math.abs(off);
      d = `${d}T00:00:00${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
    }
    const t = new Date(d);
    if (isNaN(t.getTime())) throw new HlyError('bad_date', `无法解析日期 ${d}`, '用 YYYY-MM-DD 或 ISO 8601');
    return t.toISOString().replace(/\.\d{3}Z$/, 'Z');
  }
  /** 列表查询用的 yyyy-MM-dd HH:mm:ss（本地时区语义，汇联易按租户时区解释） */
  toQueryDate(d: string, endOfDay = false): string {
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return `${d} ${endOfDay ? '23:59:59' : '00:00:00'}`;
    return d;
  }

  // ---------- token ----------
  private tokenPath() {
    const key = createHash('sha256').update(`${this.cred.baseUrl}|${this.cred.appId}`).digest('hex').slice(0, 16);
    return join(cacheDir(), `token-${key}.json`);
  }

  async token(force = false): Promise<string> {
    const p = this.tokenPath();
    if (!force && existsSync(p)) {
      try {
        const c = JSON.parse(readFileSync(p, 'utf8')) as { access_token: string; expires_at: number };
        if (c.expires_at - Date.now() > 60_000) return c.access_token;
      } catch { /* ignore */ }
    }
    const basic = Buffer.from(`${this.cred.appId}:${this.cred.appSecret}`).toString('base64');
    const body = new URLSearchParams({ grant_type: 'client_credentials', scope: 'write' });
    const res = await this.fetch(`${this.cred.baseUrl}/oauth/token`, { method: 'POST', headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded' }, body });
    const text = await res.text();
    let data: any = {};
    try { data = JSON.parse(text); } catch { /* not json */ }
    if (!res.ok || !data.access_token) {
      throw new HlyError('auth_failed', `获取 AccessToken 失败（HTTP ${res.status}）：${data.error_description ?? data.message ?? text.slice(0, 200)}`,
        '检查 appId / appSecret 是否正确、是否在汇联易后台开通了开放接口权限、base url 是否为 https://api.huilianyi.com/gateway', res.status, data);
    }
    const ttl = Number(data.expires_in ?? 3600) * 1000;
    mkdirSync(cacheDir(), { recursive: true, mode: 0o700 });
    writeFileSync(p, JSON.stringify({ access_token: data.access_token, expires_at: Date.now() + ttl }), { mode: 0o600 });
    return data.access_token;
  }

  private async fetch(url: string, init: RequestInit): Promise<Response> {
    if (this.opts.verbose) console.error(`> ${init.method ?? 'GET'} ${url}${init.body && typeof init.body === 'string' ? ' ' + init.body.slice(0, 500) : ''}`);
    try { return await fetch(url, init); } catch (e: any) {
      throw new HlyError('network', `无法连接 ${url}: ${e.cause?.code ?? e.message}`, '检查网络 / HLY_BASE_URL');
    }
  }

  /** 统一请求：自动带 token，401 时刷新一次重试；errorCode != 0000 一律抛错（raw 只表示"不要求返回体是信封"） */
  async call<T = any>(method: string, path: string, opts: { params?: Record<string, unknown>; data?: unknown; raw?: boolean } = {}, retry = true): Promise<T> {
    return (await this.callFull<T>(method, path, opts, retry)).body;
  }
  async callFull<T = any>(method: string, path: string, opts: { params?: Record<string, unknown>; data?: unknown; raw?: boolean } = {}, retry = true): Promise<{ body: T; headers: Headers }> {
    const url = new URL(this.cred.baseUrl + path);
    for (const [k, v] of Object.entries(opts.params ?? {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, Array.isArray(v) ? v.join(',') : String(v));
    const headers: Record<string, string> = { authorization: `Bearer ${await this.token()}`, accept: 'application/json' };
    if (opts.data !== undefined) headers['content-type'] = 'application/json';
    const res = await this.fetch(url.toString(), { method, headers, body: opts.data === undefined ? undefined : JSON.stringify(opts.data) });
    if (res.status === 401 && retry) { await this.token(true); return this.callFull(method, path, opts, false); }
    const text = await res.text();
    let body: any;
    try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
    if (this.opts.verbose) console.error(`< ${res.status} ${text.slice(0, 800)}`);
    if (!res.ok) throw new HlyError(`http_${res.status}`, `HTTP ${res.status} ${path}: ${body.message ?? body.error_description ?? text.slice(0, 300)}`, res.status === 403 ? '应用没有该接口权限，找汇联易管理员开通' : undefined, res.status, body);
    // 汇联易业务错误常以 HTTP 200 + errorCode 返回，裸数组响应没有信封
    if (body && typeof body === 'object' && !Array.isArray(body) && 'errorCode' in body && body.errorCode !== '0000') {
      throw new HlyError(`hly_${body.errorCode}`, `${body.message || '汇联易返回错误'}（errorCode ${body.errorCode}）`, hintFor(body.errorCode), res.status, body);
    }
    return { body: body as T, headers: res.headers };
  }

  /** 翻页抓全：优先按 X-Total-Count 判断结束，没有该头则按"返回不足一页/空页"判断；超过 maxPages 抛错而不是悄悄截断 */
  async pageAll<T>(path: string, params: Record<string, unknown>, size = 100, maxPages = 200): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; ; page++) {
      if (page > maxPages) throw new HlyError('too_many_pages', `${path} 超过 ${maxPages} 页（${out.length} 条）仍未取完`, '缩小时间范围或加过滤条件');
      const { body, headers } = await this.callFull<any>('GET', path, { params: { ...params, page, size }, raw: true });
      const rows: T[] = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : [];
      out.push(...rows);
      const total = Number(headers.get('x-total-count'));
      if (rows.length === 0) break;
      if (Number.isFinite(total) && total > 0) { if (out.length >= total) break; }
      else if (rows.length < size) break;
    }
    return out;
  }

  /** 删除该租户的 token 与员工缓存（tenant remove / auth logout 时用） */
  static clearCache(cred: Pick<Credential, 'baseUrl' | 'appId'>) {
    const key = createHash('sha256').update(`${cred.baseUrl}|${cred.appId}`).digest('hex').slice(0, 16);
    for (const f of [`token-${key}.json`, `employees-${key}.json`]) { try { unlinkSync(join(cacheDir(), f)); } catch { /* 不存在 */ } }
  }

  // ---------- 主数据 ----------
  /** 全部员工（翻页抓全，按租户缓存 24h）。用于把飞书邮箱/手机号翻译成工号。 */
  async employees(refresh = false): Promise<any[]> {
    const key = createHash('sha256').update(`${this.cred.baseUrl}|${this.cred.appId}`).digest('hex').slice(0, 16);
    const p = join(cacheDir(), `employees-${key}.json`);
    if (!refresh && existsSync(p)) {
      try { const c = JSON.parse(readFileSync(p, 'utf8')); if (Date.now() - c.at < 24 * 3600e3) return c.list; } catch { /* ignore */ }
    }
    const list = await this.pageAll<any>('/api/open/user', { startDate: '2000-01-01 00:00:00', endDate: this.toQueryDate(new Date(Date.now() + 86400e3).toISOString().slice(0, 10), true), containLeavedUser: false });
    const slim = list.map((u) => ({ employeeID: u.employeeID, fullName: u.fullName, email: u.email, mobile: u.mobile, companyName: u.companyName, companyCode: u.companyCode, departmentName: u.departmentName, departmentPath: u.departmentPath, title: u.title, status: u.status, directManagerEmployeeId: u.directManagerEmployeeId, directManagerName: u.directManagerName }));
    mkdirSync(cacheDir(), { recursive: true, mode: 0o700 });
    writeFileSync(p, JSON.stringify({ at: Date.now(), list: slim }), { mode: 0o600 });
    return slim;
  }
  async findEmployee(q: { email?: string; mobile?: string; name?: string }, refresh = false) {
    const norm = (s?: string) => (s ?? '').trim().toLowerCase();
    const mob = (s?: string) => (s ?? '').replace(/\D/g, '').slice(-11);
    if (q.mobile && mob(q.mobile).length < 7) throw new HlyError('bad_args', `手机号太短：${q.mobile}`);
    if (q.email && !q.email.includes('@')) throw new HlyError('bad_args', `邮箱格式不对：${q.email}`);
    const match = (list: any[]) => list.filter((u) => (q.email && norm(u.email) === norm(q.email)) || (q.mobile && mob(u.mobile) === mob(q.mobile)) || (q.name && u.fullName === q.name));
    let hit = match(await this.employees(refresh));
    if (!hit.length && !refresh) hit = match(await this.employees(true)); // 缓存可能过期：新员工
    return hit;
  }

  employee(employeeId = this.cred.employeeId) { return this.call('GET', `/api/open/user/detail/${encodeURIComponent(employeeId)}`, { params: { containLeavedUser: true }, raw: true }); }
  expenseTypes() { return this.call<any[]>('GET', '/api/open/expenseType', { raw: true }); }

  // ---------- 报销单 ----------
  createExpenseReport(body: Record<string, unknown>) { return this.call<Envelope>('POST', '/api/open/expenseReport/create', { data: { employeeId: this.cred.employeeId, ...body } }); }
  submitExpenseReport(businessCode: string) { return this.call<Envelope>('POST', '/api/open/expenseReport/submit', { data: { employeeId: this.cred.employeeId, businessCode } }); }
  expenseReportDetail(businessCode: string) { return this.call<any>('GET', '/api/open/expenseReport/detail', { params: { businessCode }, raw: true }); }
  listExpenseReports(q: { from: string; to: string; status?: string; employeeId?: string; page?: number; size?: number; withApprovalHistory?: boolean }) {
    return this.call<any>('GET', '/api/open/expenseReport', { params: {
      startDate: this.toQueryDate(q.from), endDate: this.toQueryDate(q.to, true), status: q.status ?? '1001,1002,1003,1004,1005,1007,1008',
      applicantEmployeeId: q.employeeId, page: q.page ?? 1, size: q.size ?? 50, withApprovalHistory: q.withApprovalHistory,
    }, raw: true });
  }

  // ---------- 申请单 ----------
  createExpenseApplication(body: Record<string, unknown>) { return this.call<Envelope>('POST', '/api/open/expenseApplication/create', { data: { employeeID: this.cred.employeeId, companyCode: this.cred.companyCode, ...body } }); }
  submitExpenseApplication(businessCode: string) { return this.call<Envelope>('POST', '/api/open/expenseApplication/submit', { params: { businessCode } }); }
  expenseApplicationDetail(businessCode: string) { return this.call<Envelope>('GET', '/api/open/expenseApplication/detail', { params: { businessCode, withCustomFormShowValue: true } }); }
  listExpenseApplications(q: { from: string; to: string; status?: string; employeeId?: string; page?: number; size?: number }) {
    return this.call<any>('GET', '/api/open/expenseApplication', { params: { startDate: this.toQueryDate(q.from), endDate: this.toQueryDate(q.to, true), status: q.status, applicantEmployeeId: q.employeeId, page: q.page ?? 1, size: q.size ?? 50 }, raw: true });
  }
  createTravelApplication(body: Record<string, unknown>) { return this.call<Envelope>('POST', '/api/open/travelApplication/create', { data: { applicant: { employeeID: this.cred.employeeId }, companyCode: this.cred.companyCode, ...body } }); }
  submitTravelApplication(businessCode: string) { return this.call<Envelope>('POST', '/api/open/travelApplication/submit', { params: { businessCode } }); }
  approvedApplications(employeeId = this.cred.employeeId, page = 1, size = 100) { return this.call<Envelope<any[]>>('GET', '/api/open/application/by/user', { params: { applicantEmployeeId: employeeId, page, size } }); }

  // ---------- 审批 ----------
  approvals(q: { done?: boolean; entityTypes?: number[]; from?: string; to?: string; page?: number; size?: number; employeeId?: string }) {
    return this.call<Envelope<any[]>>('POST', '/api/open/batch/approval', {
      params: { page: q.page ?? 1, size: q.size ?? 50 },
      data: { employeeId: q.employeeId ?? this.cred.employeeId, status: q.done ? 1002 : 1001, entityType: q.entityTypes, toStartDate: q.from, toEndDate: q.to },
    });
  }
  pass(businessCode: string, entityType: number, comment?: string) {
    return this.call<Envelope>('POST', '/api/open/approvals/pass', { data: { businessCode, entityType, operator: this.cred.employeeId, approver: this.cred.employeeId, approvalTxt: comment } });
  }
  reject(businessCode: string, entityType: number, comment: string, rejectType?: number) {
    return this.call<Envelope>('POST', '/api/open/approvals/reject', { data: { businessCode, entityType, operator: this.cred.employeeId, approver: this.cred.employeeId, approvalTxt: comment, rejectType } });
  }

  // ---------- 费用 ----------
  /** 按"修改日期"增量拉费用（接口原生口径） */
  listInvoicesModified(q: { from: string; to: string; status?: string; employeeId?: string; expenseTypeOIDs?: string[] }) {
    return this.pageAll<any>('/api/open/invoice', { startDate: this.toQueryDate(q.from), endDate: this.toQueryDate(q.to, true), invoiceStatus: q.status, employeeId: q.employeeId, expenseTypeOIDs: q.expenseTypeOIDs });
  }
  /** 费用的发生日期：只认 occurrenceDate / invoiceDate；没有就是未知，不拿创建日期冒充 */
  static occurredAt(inv: any): string | undefined { return inv.occurrenceDate ?? inv.invoiceDate ?? undefined; }
  /**
   * 按"发生日期"取期间费用。接口只按修改日期筛选，所以：按修改日期拉 [from, 今天]，按 invoiceOID 去重（取最后一次），再按发生日期过滤。
   * 前提：一笔费用的最后修改时间不早于它的发生日期。正常录入满足；若租户允许录入未来日期的费用、或导入时保留了早于发生日期的时间戳，这类费用会漏。
   * 没有发生日期字段的费用不纳入统计，单独计数返回给调用方。
   */
  async listInvoicesOccurred(q: { from: string; to: string; status?: string; employeeId?: string; expenseTypeOIDs?: string[]; tz?: (s: string) => string }) {
    const today = new Date(Date.now() + 86400e3).toISOString().slice(0, 10);
    const rows = await this.listInvoicesModified({ ...q, to: today });
    const byOid = new Map<string, any>();
    for (const r of rows) byOid.set(r.invoiceOID ?? JSON.stringify(r), r); // 同一 OID 后出现的覆盖先出现的
    const day = q.tz ?? ((s: string) => s.slice(0, 10));
    const matched: any[] = []; let noDate = 0;
    for (const r of byOid.values()) {
      const d = Hly.occurredAt(r);
      if (!d) { noDate++; continue; }
      const k = day(d); if (k >= q.from && k <= q.to) matched.push(r);
    }
    if (noDate > 0 && matched.length === 0 && byOid.size > 0) {
      throw new HlyError('no_occurrence_date', `拉到 ${byOid.size} 笔费用，但都没有发生日期字段（occurrenceDate / invoiceDate），无法按发生日期统计`, '用 --date-field modified 按修改日期口径查看，并把真实返回的字段名提 issue');
    }
    return { rows: matched, excluded_no_occurrence_date: noDate, fetched: byOid.size };
  }
  /**
   * 某工号是否在某张单据的审批链上（待办或已办里出现过）。
   * 按接口分页契约（X-Total-Count）翻完待办和已办，找到即停；超过 maxPages 仍没翻完则抛 unconfirmed，而不是伪装成"无权限"。
   */
  async isApproverOf(businessCode: string, employeeId = this.cred.employeeId, maxPages = 20): Promise<boolean> {
    for (const done of [false, true]) {
      let seen = 0;
      for (let page = 1; ; page++) {
        if (page > maxPages) throw new HlyError('unconfirmed', `工号 ${employeeId} 的${done ? '已办' : '待办'}超过 ${maxPages * 100} 条，无法确认是否为 ${businessCode} 的审批人`, '用 --from/--to 缩小范围，或让管理员把该工号加入 tenant allow-spend 名单');
        const { body, headers } = await this.callFull<Envelope<any[]>>('POST', '/api/open/batch/approval', { params: { page, size: 100 }, data: { employeeId, status: done ? 1002 : 1001 } });
        const rows = body.data ?? [];
        if (rows.some((t: any) => t.businessCode === businessCode)) return true;
        seen += rows.length;
        const total = Number(headers.get('x-total-count'));
        if (rows.length === 0) break;
        if (Number.isFinite(total) && total > 0) { if (seen >= total) break; }
        else if (rows.length < 100) break;
      }
    }
    return false;
  }
  unreimbursed(employeeId = this.cred.employeeId) { return this.call<Envelope>('POST', '/api/open/invoice/query/unreimbursed/expenses', { data: { employeeId } }); }
}

function hintFor(code: string): string | undefined {
  const map: Record<string, string> = {
    '120207': '员工不存在：检查 --employee 工号是否正确（区分大小写）',
    '120003': '缺少必填项：看 message 里缺的字段；创建报销单需要 formCode，用 hly forms 或后台查看表单编码',
    '121209': '单据不是编辑态，不能重复提交',
    '121935': '当前工号不是该单据的当前审批人；也检查 --type 是否与 inbox 里的 entityType 一致（1002 报销单=expense，1001 申请单=application）',
    '60012': 'uuid 已用过，换一个或去掉',
  };
  return map[code];
}
