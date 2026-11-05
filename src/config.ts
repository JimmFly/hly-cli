// 凭证与本地配置。
//
// 租户（tenant）= 一家公司在汇联易的应用凭证（appId / appSecret，管理员在 后台 → 设置 → 安全设置 获取）。
// 一次调用 = 租户 + 替谁办（employeeId 工号）。Agent 从飞书等渠道拿到实名身份后，翻译成 --tenant + --employee 调用。
// 多租户：一个 Agent 可以服务多家公司，每家一个 profile；凭证按每次调用解析。
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
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
export interface Resolved extends Credential { source: string; profile?: string }
export interface Config { current?: string; profiles: Record<string, Credential> }

export const DEFAULT_BASE_URL = 'https://api.huilianyi.com/gateway';

const dir = process.env.HLY_CONFIG_DIR ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'hly');
const file = join(dir, 'config.json');
export const cacheDir = () => process.env.HLY_CACHE_DIR ?? join(dir, 'cache');
export const configPath = () => file;

export function loadConfig(): Config {
  if (!existsSync(file)) return { profiles: {} };
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return { profiles: {} }; }
}

export function saveConfig(cfg: Config) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch { /* windows */ }
}

export interface CredentialFlags {
  appId?: string; appSecret?: string; employee?: string; baseUrl?: string; companyCode?: string;
  credentialFile?: string; profile?: string;
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
  const cfg = loadConfig();
  const profileName = f.profile ?? process.env.HLY_PROFILE ?? cfg.current;
  const prof = profileName ? cfg.profiles[profileName] : undefined;
  const fromFile = (p?: string) => (p ? (JSON.parse(readFileSync(p, 'utf8')) as Partial<Credential>) : {});
  const layers: Array<[string, Partial<Credential>]> = [
    [profileName ? `profile:${profileName}` : 'none', prof ?? {}],
    ['HLY_CREDENTIAL_FILE', fromFile(process.env.HLY_CREDENTIAL_FILE)],
    ['env', { appId: process.env.HLY_APP_ID, appSecret: process.env.HLY_APP_SECRET, employeeId: process.env.HLY_EMPLOYEE_ID, baseUrl: process.env.HLY_BASE_URL, companyCode: process.env.HLY_COMPANY_CODE }],
    ['--credential-file', fromFile(f.credentialFile)],
    ['flags', { appId: f.appId, appSecret: f.appSecret, employeeId: f.employee, baseUrl: f.baseUrl, companyCode: f.companyCode }],
  ];
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
    source: sources.join(' + ') || 'none', profile: prof ? profileName : undefined,
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
