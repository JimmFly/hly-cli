// 凭证与本地配置。
//
// 租户（tenant）= 一家公司在汇联易的应用凭证（appId / appSecret，管理员在 后台 → 设置 → 安全设置 获取）。
// 一次调用 = 租户 + 替谁办（employeeId 工号）。Agent 从飞书等渠道拿到实名身份后，翻译成 --tenant + --employee 调用。
// 多租户：一个 Agent 可以服务多家公司，每家一个 profile；凭证按每次调用解析。
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Credential {
  baseUrl: string;      // 默认 https://api.huilianyi.com/gateway
  appId: string;
  appSecret: string;
  employeeId: string;   // 工号：报销单申请人 / 审批人 / 查询范围（profile 里可以不填，调用时 --employee 给）
  companyCode?: string; // 集团账号创建申请单时需要
  spendAllowlist?: string[]; // 允许查全公司花费（spend *）的工号；不设则不限制
}
export interface Resolved extends Credential { source: string; profile?: string; implicitDefault?: boolean }
export interface Config { current?: string; profiles: Record<string, Credential> }

export const DEFAULT_BASE_URL = 'https://api.huilianyi.com/gateway';

const dir = process.env.HLY_CONFIG_DIR ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'hly');
const file = join(dir, 'config.json');
export const cacheDir = () => process.env.HLY_CACHE_DIR ?? join(dir, 'cache');
export const configPath = () => file;

export function loadConfig(): Config {
  if (!existsSync(file)) return { profiles: {} };
  try { const c = JSON.parse(readFileSync(file, 'utf8')); if (!c || typeof c.profiles !== 'object') throw new Error('no profiles'); return c; }
  catch (e: any) { throw new HlyError('config_corrupt', `配置文件损坏：${file}（${e.message}）`, '手工修复或删除后重新 hly tenant add；不会自动覆盖'); }
}

/** 原子写：先写临时文件再 rename，避免写一半把其它租户的凭证弄丢 */
export function saveConfig(cfg: Config) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  try { chmodSync(tmp, 0o600); } catch { /* windows */ }
  renameSync(tmp, file);
}

export interface CredentialFlags {
  appId?: string; appSecret?: string; employee?: string; baseUrl?: string; companyCode?: string;
  credentialFile?: string; profile?: string;
  /** 不读任何 profile（tenant add 用，避免把别家公司的 secret 混进来） */
  ignoreProfiles?: boolean;
}

/**
 * 解析本次调用的凭证。优先级（高 → 低）：
 *  1. 命令行 --app-id / --app-secret / --employee / --base-url / --company
 *  2. --credential-file <json>      一个人的凭证放一个文件，不进命令行和 Agent 日志
 *  3. 环境变量 HLY_APP_ID / HLY_APP_SECRET / HLY_EMPLOYEE_ID / HLY_BASE_URL / HLY_COMPANY_CODE
 *  4. HLY_CREDENTIAL_FILE            环境变量指向凭证文件
 *  5. --as <profile> / HLY_PROFILE   hly auth login 保存的命名身份
 *  6. 配置文件里的 current profile
 * 各层可以叠加：例如 profile 提供 appId/appSecret，命令行只换 --employee。
 */
export function resolveCredential(f: CredentialFlags): Resolved {
  const cfg = f.ignoreProfiles ? { profiles: {} } as Config : loadConfig();
  const explicit = f.ignoreProfiles ? undefined : f.profile ?? process.env.HLY_PROFILE;
  const profileName = explicit ?? cfg.current;
  if (explicit && !cfg.profiles[explicit]) throw new HlyError('no_credential', `租户 / 身份「${explicit}」不存在`, '用 hly tenant list 看已保存的公司');
  const prof = profileName ? cfg.profiles[profileName] : undefined;
  const fromFile = (p?: string): Partial<Credential> => {
    if (!p) return {};
    try { return JSON.parse(readFileSync(p, 'utf8')); }
    catch (e: any) { throw new HlyError('no_credential', `凭证文件读不到或不是 JSON：${p}（${e.message}）`, '格式 {"appId","appSecret","employeeId","baseUrl?","companyCode?"}'); }
  };
  const layers: Array<[string, Partial<Credential>]> = [
    [profileName ? `profile:${profileName}` : 'none', prof ?? {}],
    ['HLY_CREDENTIAL_FILE', fromFile(process.env.HLY_CREDENTIAL_FILE)],
    ['env', { appId: process.env.HLY_APP_ID, appSecret: process.env.HLY_APP_SECRET, employeeId: process.env.HLY_EMPLOYEE_ID, baseUrl: process.env.HLY_BASE_URL, companyCode: process.env.HLY_COMPANY_CODE }],
    ['--credential-file', fromFile(f.credentialFile)],
    ['flags', { appId: f.appId, appSecret: f.appSecret, employeeId: f.employee, baseUrl: f.baseUrl, companyCode: f.companyCode }],
  ];
  // 多租户下不允许"没传 --tenant 就用默认 profile 的凭证"：工号在不同公司可能撞车。
  // 但如果更高层（凭证文件 / 环境变量 / 命令行）已经给了 appId，就与 profile 无关。
  const higherHasApp = layers.slice(1).some(([, l]) => !!l.appId);
  const implicitDefault = !explicit && !!prof && Object.keys(cfg.profiles).length > 1 && !higherHasApp;
  // 显式 --tenant 时，企业凭证（baseUrl/appId/appSecret/companyCode/名单）整组只来自该 profile；
  // 环境变量 / 凭证文件 / 命令行若也带了企业凭证，说明调用方把别家公司的凭证混进来了，直接报错而不是悄悄叠加。
  if (explicit && prof) {
    const ENTERPRISE: Array<keyof Credential> = ['baseUrl', 'appId', 'appSecret', 'companyCode', 'spendAllowlist'];
    for (const [name, layer] of layers.slice(1)) {
      const clash = ENTERPRISE.filter((k) => layer[k] !== undefined && layer[k] !== '' && JSON.stringify(layer[k]) !== JSON.stringify(prof[k]));
      if (clash.length) throw new HlyError('credential_conflict', `--tenant ${explicit} 之外又从 ${name} 收到企业凭证（${clash.join('/')}），拒绝混用`, '显式指定租户时只允许额外给 --employee；去掉环境里的 HLY_APP_ID / HLY_APP_SECRET / HLY_BASE_URL 或 --credential-file');
    }
  }
  const out: Partial<Credential> = {};
  const sources: string[] = [];
  for (const [name, layer] of layers) {
    let used = false;
    for (const [k, v] of Object.entries(layer)) if (v !== undefined && v !== '') { (out as any)[k] = v; used = true; }
    if (used) sources.push(name);
  }
  return {
    baseUrl: (out.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, ''),
    appId: out.appId ?? '', appSecret: out.appSecret ?? '', employeeId: out.employeeId ?? '', companyCode: out.companyCode, spendAllowlist: out.spendAllowlist,
    source: sources.join(' + ') || 'none', profile: prof ? profileName : undefined, implicitDefault,
  };
}

export function assertComplete(c: Resolved, needEmployee = true): asserts c is Resolved & { appId: string; appSecret: string; employeeId: string } {
  const keys = needEmployee ? (['appId', 'appSecret', 'employeeId'] as const) : (['appId', 'appSecret'] as const);
  const missing = keys.filter((k) => !c[k]);
  if (missing.length) {
    const map = { appId: 'HLY_APP_ID / --app-id', appSecret: 'HLY_APP_SECRET / --app-secret', employeeId: 'HLY_EMPLOYEE_ID / --employee（替谁办）' };
    throw new HlyError('no_credential', `缺少凭证：${missing.map((m) => map[m]).join('，')}`,
      '用 hly tenant add 保存公司凭证后 --tenant <公司> --employee <工号>；或 --credential-file / 环境变量');
  }
}

export class HlyError extends Error {
  constructor(public code: string, message: string, public hint?: string, public status?: number, public raw?: unknown) { super(message); }
}
