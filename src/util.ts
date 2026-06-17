import { execFileSync } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';

export type TaskStatus =
  | 'inbox'
  | 'scoped'
  | 'ready'
  | 'running'
  | 'review'
  | 'changes_requested'
  | 'done'
  | 'blocked'
  | 'cancelled'
  | 'abandoned';
export type RunStatus =
  | 'created'
  | 'planning'
  | 'dispatching'
  | 'workers_running'
  | 'collecting'
  | 'reviewing'
  | 'awaiting_approval'
  | 'applying'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timed_out';
export type RunMode = 'basic' | 'roles' | 'multi';
export type Decision = 'pass' | 'changes_requested' | 'blocked' | 'fail';

export interface TaskMeta {
  schema_version: number;
  id: string;
  title: string;
  status: TaskStatus;
  priority: 'low' | 'normal' | 'high';
  created_at: string;
  updated_at: string;
}
export type ExecutorKind = 'omx' | 'codex' | 'agy' | 'command';
export interface RunMeta {
  schema_version: number;
  id: string;
  task_id: string;
  status: RunStatus;
  executor: ExecutorKind;
  mode: RunMode;
  run_dir: string;
  max_workers?: number;
  command?: string;
  created_at: string;
  updated_at: string;
  started_at?: string;
  ended_at?: string;
  exit_code?: number;
  decision?: Decision;
}
export interface ProjectRecord {
  schema_version: number;
  id: string;
  name: string;
  root_path: string;
  agent_dir: string;
  created_at: string;
  updated_at: string;
  last_opened_at?: string;
}
export interface ApprovalRecord {
  schema_version: number;
  id: string;
  run_id: string;
  type: string;
  status: 'requested' | 'approved' | 'rejected' | 'applied' | 'failed_to_apply';
  risk: 'low' | 'medium' | 'high';
  summary: string;
  created_at: string;
  updated_at: string;
  proposal_sha256?: string;
  proposal_path?: string;
  command_sha256?: string;
  command_preview?: string;
}
export interface PromotionRecord {
  schema_version: number;
  id: string;
  run_id: string;
  target_type: 'agent_instruction' | 'skill' | 'workflow' | 'eval' | 'memory' | 'policy';
  status: 'proposed' | 'approved' | 'applied' | 'rejected';
  reason: string;
  target_path: string;
  proposal_path: string;
  applied_path?: string;
  created_at: string;
  updated_at: string;
}
export interface ProductIndex {
  schema_version: number;
  generated_at: string;
  project: ProjectRecord | null;
  tasks: TaskMeta[];
  runs: RunMeta[];
  approvals: ApprovalRecord[];
  promotions: PromotionRecord[];
  artifacts: { run_id: string; type: string; path: string }[];
}

export const AGENT_DIR = '.agent';
const SECRET_PATTERNS = [
  /^\.env(\..*)?$/,
  /.*\.pem$/,
  /.*\.key$/,
  /^id_rsa$/,
  /^id_ed25519$/,
  /^secrets\..*/,
  /^\.ssh(\/.*)?$/,
  /^\.config(\/.*)?$/,
];

export function nowIso(): string {
  return new Date().toISOString();
}
export function slug(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9가-힣]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'item'
  );
}
export function uniqueId(prefix: string, label: string): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:TZ.]/g, '')
    .slice(0, 17);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${stamp}-${rand}-${slug(label).slice(0, 24)}`;
}
export function projectRoot(cwd = process.cwd()): string {
  return realpathSync(cwd);
}
export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}
export function registryPath(): string {
  return join(homedir(), '.dominic_orchestration', 'registry.json');
}

export function gitNoIndexPatch(workspace: string, file: string): string {
  try {
    return execFileSync('git', ['diff', '--binary', '--no-index', '--', '/dev/null', file], {
      cwd: workspace,
      encoding: 'utf8',
    });
  } catch (err: any) {
    return String(err.stdout || '');
  }
}
export function normalizeNoIndexPatch(patch: string): string {
  return patch;
}
export function patchTouchedFiles(patch: string): string[] {
  return patch
    .split('\n')
    .filter((line) => line.startsWith('diff --git '))
    .map((line) => line.trim().split(/\s+/)[3] || '')
    .filter(Boolean)
    .map((file) => file.replace(/^b\//, ''));
}
export function safeJoin(root: string, ...parts: string[]): string {
  const realRoot = realpathSync(root);
  const target = resolve(realRoot, ...parts);
  const targetRel = relative(realRoot, target).replaceAll('\\', '/');
  if (targetRel === '..' || targetRel.startsWith('../') || targetRel.startsWith('..\\'))
    throw new Error(`path escapes project root: ${target}`);
  const parent = existsSync(target) ? target : dirname(target);
  const realParent = existsSync(parent) ? realpathSync(parent) : realRoot;
  const rel = relative(realRoot, realParent).replaceAll('\\', '/');
  if (rel === '..' || rel.startsWith('../')) throw new Error(`path escapes project root: ${target}`);
  const rootRel = relative(realRoot, target).replaceAll('\\', '/');
  if (isSecretPath(rootRel)) throw new Error(`refusing secret path: ${rootRel}`);
  return target;
}

export function isSecretPath(rootRelativePath: string): boolean {
  const normalized = rootRelativePath.replaceAll('\\', '/');
  return normalized.split('/').some((part, idx, arr) => {
    const rest = arr.slice(idx).join('/');
    return SECRET_PATTERNS.some((pattern) => pattern.test(part) || pattern.test(rest));
  });
}

export function writeIfMissing(path: string, content: string): boolean {
  if (existsSync(path)) return false;
  ensureDir(dirname(path));
  writeFileSync(path, content);
  return true;
}
export function yaml(meta: Record<string, unknown>): string {
  return (
    Object.entries(meta)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
      .join('\n') + '\n'
  );
}
export function frontmatter(meta: Record<string, unknown>, body: string): string {
  return `---\n${yaml(meta)}---\n\n${body.trim()}\n`;
}
export function parseFrontmatter(text: string): Record<string, string> {
  if (!text.startsWith('---\n')) return {};
  const end = text.indexOf('\n---', 4);
  if (end < 0) return {};
  const raw = text.slice(4, end).trim();
  const out: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    let value: unknown = line.slice(idx + 1).trim();
    try {
      value = JSON.parse(String(value));
    } catch {}
    out[key] = String(value);
  }
  return out;
}
export function readYaml(path: string): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    const raw = line.slice(idx + 1).trim();
    try {
      out[key] = JSON.parse(raw);
    } catch {
      out[key] = raw;
    }
  }
  return out;
}
export interface EvidenceResult {
  ok: boolean;
  output: string;
  error?: string;
}
export function gitEvidence(args: string[], cwd = process.cwd()): EvidenceResult {
  try {
    return {
      ok: true,
      output: execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
    };
  } catch (err: any) {
    const error = String(err.stderr || err.message || err);
    return { ok: false, output: error, error };
  }
}
export function git(args: string[], cwd = process.cwd()): string {
  return gitEvidence(args, cwd).output;
}

const SECRET_VALUE_PATTERNS: RegExp[] = [
  /-----BEGIN[ A-Z]*PRIVATE KEY-----[\s\S]*?-----END[ A-Z]*PRIVATE KEY-----/g, // PEM private keys
  /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWTs
  /sk-(?:proj-|ant-)?[A-Za-z0-9_-]{8,}/g, // OpenAI / Anthropic
  /gh[opsu]_[A-Za-z0-9_]{8,}/g,
  /github_pat_[A-Za-z0-9_]+/g, // GitHub
  /npm_[A-Za-z0-9]{20,}/g, // npm
  /xox[baprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/g, // Stripe
  /AIza[0-9A-Za-z_-]{20,}/g,
  /ya29\.[0-9A-Za-z_-]{20,}/g, // Google API / OAuth
  /(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|A3T[A-Z0-9])[0-9A-Z]{12,}/g, // AWS access key ids
  /[Bb]earer\s+[A-Za-z0-9._~+/-]{20,}=*/g, // bearer tokens
];
const SECRET_KV_PATTERN =
  /(["']?(?:aws_secret_access_key|secret|secret_key|token|password|passwd|pwd|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key)["']?\s*[:=]\s*["']?)([A-Za-z0-9/+_=.~-]{12,})(["']?)/gi;
const SECRET_DB_URL_PATTERN =
  /((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|rediss|amqp|amqps):\/\/)[^:@\s/]+:[^@\s/]+@/g;
export function redact(s: string): string {
  let out = s.replace(SECRET_DB_URL_PATTERN, '$1[REDACTED]@');
  for (const re of SECRET_VALUE_PATTERNS) out = out.replace(re, '[REDACTED]');
  return out.replace(SECRET_KV_PATTERN, '$1[REDACTED]$3');
}
// True when text still contains something that SHOULD have been redacted. Shares the
// redact() patterns as the single source of truth: redact(s) leaves no match, so this
// returns false for already-redacted text and true for a raw leak.
export function containsLikelySecret(s: string): boolean {
  if ([...SECRET_VALUE_PATTERNS].some((re) => new RegExp(re.source).test(s))) return true;
  if (new RegExp(SECRET_KV_PATTERN.source, 'i').test(s)) return true;
  return new RegExp(SECRET_DB_URL_PATTERN.source).test(s);
}
export function sha256Text(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function reviewProvenanceKey(): string {
  const env = process.env.AGENT_REVIEW_HMAC_KEY;
  if (typeof env === 'string' && env.trim()) return env.trim();
  const keyFile = join(homedir(), '.dominic_orchestration', 'review-signing.key');
  if (existsSync(keyFile)) return readFileSync(keyFile, 'utf8').trim();
  return '';
}

export function reviewCustodyKey(): string {
  const env = process.env.AGENT_REVIEW_CUSTODY_HMAC_KEY;
  if (typeof env === 'string' && env.trim()) return env.trim();
  const keyFile = join(homedir(), '.dominic_orchestration', 'review-custody.key');
  if (existsSync(keyFile)) return readFileSync(keyFile, 'utf8').trim();
  return '';
}

export function reviewProvenanceSignature(
  key: string,
  inputHash: string,
  reviewerSha: string,
  architectSha: string,
): string {
  return createHmac('sha256', key).update(`${inputHash}:${reviewerSha}:${architectSha}`).digest('hex');
}

export interface ReviewCustodyMetadata {
  custody_issuer?: string;
  review_session_id?: string;
  reviewer_agent_id?: string;
  reviewer_artifact_path?: string;
  architect_artifact_path?: string;
  reviewer_artifact_sha256?: string;
  architect_artifact_sha256?: string;
}

export function reviewCustodySignature(
  key: string,
  custody: string,
  inputHash: string,
  provenanceSignature: string,
  metadata: ReviewCustodyMetadata = {},
): string {
  const payload = [
    custody,
    inputHash,
    provenanceSignature,
    metadata.custody_issuer || '',
    metadata.review_session_id || '',
    metadata.reviewer_agent_id || '',
    metadata.reviewer_artifact_path || '',
    metadata.architect_artifact_path || '',
    metadata.reviewer_artifact_sha256 || '',
    metadata.architect_artifact_sha256 || '',
  ].join(':');
  return createHmac('sha256', key).update(payload).digest('hex');
}
