import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import type webpushTypes from 'web-push';

const require = createRequire(import.meta.url);
const webpush = require('web-push') as typeof webpushTypes;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

type TradingSymbol = 'US100';

interface M5Candle {
  index: number;
  timeLabel: string;
  timestampIso: string;
  open: number;
  high: number;
  low: number;
  close: number;
  median: number;
  ao: number;
  aoRising: boolean;
  signal: 'BUY' | 'SELL' | null;
}

interface MarketFeedResult {
  symbol: TradingSymbol;
  source: string;
  marketState: string;
  fetchedAt: string;
  bars: M5Candle[];
}

type AoTimeframe = 'M5';
const AO_TIMEFRAME_ORDER: AoTimeframe[] = ['M5'];

type CisdTimeframe = 'M5' | 'M15';
const CISD_TIMEFRAME_ORDER: CisdTimeframe[] = ['M15'];
const CISD_CHART_TIMEFRAMES: CisdTimeframe[] = ['M15', 'M5'];

interface MonitorAlertEvent {
  id: string;
  timestamp: string;
  symbol: TradingSymbol;
  timeframe?: string;
  strategy?: 'AO' | 'CISD';
  signal: 'BUY' | 'SELL';
  aoPrev: number;
  aoCurr: number;
  cisdLevel?: number | null;
  price: number;
  deliveredToNtfy: boolean;
  deliveredToTelegram: boolean;
  deliveredWebPushCount: number;
  telegramError?: string;
}

interface M15CisdCandle {
  index: number;
  timeLabel: string;
  timestampIso: string;
  open: number;
  high: number;
  low: number;
  close: number;
  cisdSignal: 'BUY' | 'SELL' | null;
  cisdLevel: number | null;
  closedBelowCisd: boolean;
  closedAboveCisd: boolean;
  activeBearCisdLevel: number | null;
  activeBullCisdLevel: number | null;
}

interface M15CisdSegment {
  id: string;
  kind: 'bearish_break' | 'bullish_break';
  level: number;
  originIndex: number;
  originTimeLabel: string;
  endIndex: number;
  triggeredIndex: number | null;
  triggeredDirection: 'BUY' | 'SELL' | null;
}

interface LastCisdSignalInfo {
  signal: 'BUY' | 'SELL';
  level: number;
  price: number;
  timeLabel: string;
  timestampIso: string;
}

interface M15MarketFeedResult {
  symbol: TradingSymbol;
  timeframe: CisdTimeframe;
  source: string;
  feedProvider?: 'xm_bridge' | 'cfd_ws' | 'yahoo_fallback';
  brokerSymbol?: string;
  xmBridgeConnected?: boolean;
  cfdWsConnected?: boolean;
  marketState: string;
  fetchedAt: string;
  bars: M15CisdCandle[];
  segments: M15CisdSegment[];
  latestBearCisdLevel: number | null;
  latestBullCisdLevel: number | null;
  currentTrend: 'BUY' | 'SELL' | null;
  lastSignalInfo: LastCisdSignalInfo | null;
}

interface StoredPushSubscription {
  endpoint: string;
  expirationTime?: number | null;
  keys: {
    p256dh: string;
    auth: string;
  };
}

interface PersistedServerState {
  vapidKeys: { publicKey: string; privateKey: string };
  enabled: boolean;
  m15Enabled: boolean;
  symbols: TradingSymbol[];
  ntfyTopic: string;
  telegramBotToken: string;
  telegramChatId: string;
  telegramMode: 'fallback' | 'always';
  direction: 'both' | 'buy_only' | 'sell_only';
  m15Direction: 'both' | 'buy_only' | 'sell_only';
  aoImmediateCross: boolean;
  aoTimeframes: AoTimeframe[];
  cisdTimeframes: CisdTimeframe[];
  subscriptions: StoredPushSubscription[];
  events: MonitorAlertEvent[];
  githubToken: string;
  githubOwner: string;
  githubRepo: string;
  githubBranch: string;
  githubPrivate: boolean;
  githubUploadAllowed: boolean;
  githubAutoSyncCode: boolean;
  githubSyncSignals: boolean;
  githubLastSyncedHash: string;
  githubLastSyncAt: string | null;
  githubLastCommitUrl: string | null;
  githubLastError: string | null;
}

const YAHOO_SYMBOL_MAP: Record<TradingSymbol, { ticker: string; digits: number }> = {
  US100: { ticker: 'NQ=F', digits: 2 },
};

const ALL_SYMBOLS: TradingSymbol[] = ['US100'];
const STATE_DIR = path.resolve(__dirname, '.data');
const STATE_FILE = path.join(STATE_DIR, 'ao-server-state.json');

interface MarketTickResult {
  symbol: TradingSymbol;
  price: number;
  bid?: number;
  ask?: number;
  source?: string;
  feedProvider?: 'xm_bridge' | 'cfd_ws' | 'yahoo_fallback';
  xmBridgeConnected?: boolean;
  cfdWsConnected?: boolean;
  marketState: string;
  fetchedAt: string;
}

const feedCache = new Map<string, { expiresAt: number; data: MarketFeedResult }>();
const cisdFeedCache = new Map<
  string,
  { expiresAt: number; fetchedAtMs: number; data: M15MarketFeedResult }
>();
const tickCache = new Map<TradingSymbol, { expiresAt: number; data: MarketTickResult }>();

const FIXED_TELEGRAM_CHAT_ID = '8217822307';

function loadPersistedState(): PersistedServerState {
  const envPublic = process.env.VAPID_PUBLIC_KEY?.trim();
  const envPrivate = process.env.VAPID_PRIVATE_KEY?.trim();
  const envTgToken = process.env.TELEGRAM_BOT_TOKEN?.trim() || '';
  const envTgChatId = FIXED_TELEGRAM_CHAT_ID;
  const envTgMode = process.env.TELEGRAM_MODE?.trim() === 'fallback' ? 'fallback' : 'always';
  const envNtfy = process.env.NTFY_TOPIC?.trim() || '';
  const envGithubToken = process.env.GITHUB_TOKEN?.trim() || '';
  const envGithubOwner = process.env.GITHUB_OWNER?.trim() || '';
  const envGithubRepo = process.env.GITHUB_REPO?.trim() || 'ao-signal-studio';
  const envGithubBranch = process.env.GITHUB_BRANCH?.trim() || 'main';

  try {
    if (fs.existsSync(STATE_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')) as Partial<PersistedServerState>;
      const vapidKeys =
        envPublic && envPrivate
          ? { publicKey: envPublic, privateKey: envPrivate }
          : parsed.vapidKeys?.publicKey && parsed.vapidKeys?.privateKey
          ? parsed.vapidKeys
          : webpush.generateVAPIDKeys();

      return {
        vapidKeys,
        enabled: false,
        m15Enabled: typeof parsed.m15Enabled === 'boolean' ? parsed.m15Enabled : true,
        symbols: ALL_SYMBOLS,
        ntfyTopic:
          typeof parsed.ntfyTopic === 'string' && parsed.ntfyTopic
            ? parsed.ntfyTopic
            : envNtfy,
        telegramBotToken:
          typeof parsed.telegramBotToken === 'string' && parsed.telegramBotToken
            ? parsed.telegramBotToken
            : envTgToken,
        telegramChatId: FIXED_TELEGRAM_CHAT_ID,
        telegramMode:
          parsed.telegramMode === 'fallback' || parsed.telegramMode === 'always'
            ? parsed.telegramMode
            : envTgMode,
        direction:
          parsed.direction === 'buy_only' || parsed.direction === 'sell_only'
            ? parsed.direction
            : 'both',
        m15Direction:
          parsed.m15Direction === 'buy_only' || parsed.m15Direction === 'sell_only'
            ? parsed.m15Direction
            : 'both',
        aoImmediateCross:
          typeof parsed.aoImmediateCross === 'boolean' ? parsed.aoImmediateCross : true,
        aoTimeframes: ['M5'],
        cisdTimeframes: ['M15'],
        subscriptions: Array.isArray(parsed.subscriptions) ? parsed.subscriptions : [],
        events: Array.isArray(parsed.events) ? parsed.events.slice(0, 30) : [],
        githubToken:
          typeof parsed.githubToken === 'string' && parsed.githubToken
            ? parsed.githubToken
            : envGithubToken,
        githubOwner:
          typeof parsed.githubOwner === 'string' && parsed.githubOwner
            ? parsed.githubOwner
            : envGithubOwner,
        githubRepo:
          typeof parsed.githubRepo === 'string' && parsed.githubRepo
            ? parsed.githubRepo
            : envGithubRepo,
        githubBranch:
          typeof parsed.githubBranch === 'string' && parsed.githubBranch
            ? parsed.githubBranch
            : envGithubBranch,
        githubPrivate: typeof parsed.githubPrivate === 'boolean' ? parsed.githubPrivate : true,
        githubUploadAllowed:
          typeof parsed.githubUploadAllowed === 'boolean' ? parsed.githubUploadAllowed : false,
        githubAutoSyncCode:
          typeof parsed.githubAutoSyncCode === 'boolean' ? parsed.githubAutoSyncCode : true,
        githubSyncSignals:
          typeof parsed.githubSyncSignals === 'boolean' ? parsed.githubSyncSignals : true,
        githubLastSyncedHash:
          typeof parsed.githubLastSyncedHash === 'string' ? parsed.githubLastSyncedHash : '',
        githubLastSyncAt:
          typeof parsed.githubLastSyncAt === 'string' ? parsed.githubLastSyncAt : null,
        githubLastCommitUrl:
          typeof parsed.githubLastCommitUrl === 'string' ? parsed.githubLastCommitUrl : null,
        githubLastError:
          typeof parsed.githubLastError === 'string' ? parsed.githubLastError : null,
      };
    }
  } catch {
    // Fall back to fresh default state
  }

  const vapidKeys =
    envPublic && envPrivate
      ? { publicKey: envPublic, privateKey: envPrivate }
      : webpush.generateVAPIDKeys();

  const initial: PersistedServerState = {
    vapidKeys,
    enabled: false,
    m15Enabled: true,
    symbols: ALL_SYMBOLS,
    ntfyTopic: envNtfy,
    telegramBotToken: envTgToken,
    telegramChatId: envTgChatId,
    telegramMode: envTgMode,
    direction: 'both',
    m15Direction: 'both',
    aoImmediateCross: true,
    aoTimeframes: ['M5'],
    cisdTimeframes: ['M15'],
    subscriptions: [],
    events: [],
    githubToken: envGithubToken,
    githubOwner: envGithubOwner,
    githubRepo: envGithubRepo,
    githubBranch: envGithubBranch,
    githubPrivate: true,
    githubUploadAllowed: false,
    githubAutoSyncCode: true,
    githubSyncSignals: true,
    githubLastSyncedHash: '',
    githubLastSyncAt: null,
    githubLastCommitUrl: null,
    githubLastError: null,
  };
  savePersistedState(initial);
  return initial;
}

function savePersistedState(state: PersistedServerState): void {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
  } catch {
    // Ignore read-only filesystem errors
  }
}

const persisted = loadPersistedState();

webpush.setVapidDetails(
  'mailto:alerts@aosignal.local',
  persisted.vapidKeys.publicKey,
  persisted.vapidKeys.privateKey
);

const monitorRuntime = {
  lastCheckedAt: null as string | null,
  lastCheckedMs: 0,
  isRunningCycle: false,
  lastBarBySymbol: {} as Partial<Record<TradingSymbol, string>>,
  lastM15BarBySymbol: {} as Partial<Record<TradingSymbol, string>>,
  dispatchedLiveSignalKeys: new Set<string>(),
};

function markLiveSignalDispatched(key: string) {
  monitorRuntime.dispatchedLiveSignalKeys.add(key);
  if (monitorRuntime.dispatchedLiveSignalKeys.size > 300) {
    const first = monitorRuntime.dispatchedLiveSignalKeys.values().next().value;
    if (first) monitorRuntime.dispatchedLiveSignalKeys.delete(first);
  }
}

for (const ev of persisted.events) {
  if (ev.id) {
    markLiveSignalDispatched(`live-${ev.id}`);
  }
}

function maskTelegramToken(token: string): string {
  const clean = sanitizeTelegramToken(token);
  if (!clean) return '';
  if (clean.length <= 14) return `${clean.slice(0, 4)}••••${clean.slice(-3)}`;
  const colonIdx = clean.indexOf(':');
  if (colonIdx > 0 && clean.length - colonIdx > 10) {
    return `${clean.slice(0, colonIdx + 1)}••••••${clean.slice(-5)}`;
  }
  return `${clean.slice(0, 6)}••••••${clean.slice(-4)}`;
}

function syncPersistence() {
  savePersistedState(persisted);
}

const CRC_TABLE = (() => {
  const tbl = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    tbl[i] = c >>> 0;
  }
  return tbl;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function collectDeployableFiles(rootDir: string): string[] {
  const skipDirs = new Set(['node_modules', '.git', '.data', 'dist', '.vite']);
  const skipFilePrefixes = ['.env'];
  const skipExactFiles = new Set(['.env', '.env.local']);
  const results: string[] = [];

  const walk = (dir: string, relBase: string) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const relPath = relBase ? `${relBase}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue;
        if (relPath === 'public/assets/aistudio') continue;
        walk(path.join(dir, entry.name), relPath);
      } else if (entry.isFile()) {
        if (skipExactFiles.has(entry.name)) continue;
        if (skipFilePrefixes.some((p) => entry.name.startsWith(p) && entry.name !== '.env.example')) {
          continue;
        }
        if (entry.name.endsWith('.zip')) continue;
        results.push(relPath);
      }
    }
  };

  walk(rootDir, '');
  return results.sort();
}

function buildZipBuffer(rootDir: string, relPaths: string[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const relPath of relPaths) {
    const fullPath = path.join(rootDir, relPath);
    const raw = fs.readFileSync(fullPath);
    const compressed = zlib.deflateRawSync(raw);
    const crc = crc32(raw);
    const nameBuf = Buffer.from(`ao-signal-studio/${relPath}`, 'utf-8');

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0x5421, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(raw.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, nameBuf, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0x5421, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(raw.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);

    centralParts.push(centralHeader, nameBuf);
    offset += localHeader.length + nameBuf.length + compressed.length;
  }

  const centralDir = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(relPaths.length, 8);
  eocd.writeUInt16LE(relPaths.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDir, eocd]);
}

const githubRuntime = {
  isSyncing: false,
  pendingResync: false,
  debounceTimer: null as NodeJS.Timeout | null,
};

function sanitizeGithubRepoName(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/^https?:\/\/github\.com\/[^/]+\//i, '')
    .replace(/\.git$/i, '')
    .replace(/[^A-Za-z0-9._-]/g, '-');
  return cleaned || 'ao-signal-studio';
}

function buildSignalsSnapshotJson(): Buffer {
  const payload = {
    app: 'Cisd เตือน (M15)',
    monitoredSymbols: persisted.symbols,
    direction: persisted.direction,
    totalCapturedSignals: persisted.events.length,
    latestSignalAt: persisted.events[0]?.timestamp || null,
    events: persisted.events.map((ev) => ({
      id: ev.id,
      timestamp: ev.timestamp,
      symbol: ev.symbol,
      signal: ev.signal,
      aoPrev: ev.aoPrev,
      aoCurr: ev.aoCurr,
      price: ev.price,
      deliveredToTelegram: ev.deliveredToTelegram,
      deliveredToNtfy: ev.deliveredToNtfy,
      deliveredWebPushCount: ev.deliveredWebPushCount,
    })),
  };
  return Buffer.from(JSON.stringify(payload, null, 2) + '\n', 'utf-8');
}

function computeWorkspaceSnapshot(): {
  entries: Array<{ path: string; buffer: Buffer }>;
  hash: string;
} {
  const relFiles = collectDeployableFiles(__dirname);
  const hasher = crypto.createHash('sha256');
  const entries: Array<{ path: string; buffer: Buffer }> = [];

  for (const relPath of relFiles) {
    try {
      const buf = fs.readFileSync(path.join(__dirname, relPath));
      entries.push({ path: relPath, buffer: buf });
      hasher.update(relPath);
      hasher.update('\0');
      hasher.update(buf);
      hasher.update('\0');
    } catch {
      // Skip file if deleted mid-scan
    }
  }

  if (persisted.githubSyncSignals) {
    const signalsBuf = buildSignalsSnapshotJson();
    entries.push({ path: 'data/signals-log.json', buffer: signalsBuf });
    hasher.update('data/signals-log.json');
    hasher.update('\0');
    hasher.update(signalsBuf);
    hasher.update('\0');
  }

  return {
    entries,
    hash: hasher.digest('hex'),
  };
}

async function githubApiRequest<T = any>(
  token: string,
  method: string,
  endpointPath: string,
  body?: unknown
): Promise<{ status: number; ok: boolean; data: T; errorMessage?: string }> {
  const url = endpointPath.startsWith('https://')
    ? endpointPath
    : `https://api.github.com${endpointPath}`;

  const res = await fetch(url, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'Cisd-Alert-App',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });

  const text = await res.text();
  let parsed: any = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { message: text };
  }

  return {
    status: res.status,
    ok: res.ok,
    data: parsed as T,
    errorMessage: !res.ok ? parsed?.message || `GitHub HTTP ${res.status}` : undefined,
  };
}

async function fetchGithubAuthenticatedUser(token: string): Promise<{
  ok: boolean;
  login?: string;
  name?: string;
  error?: string;
}> {
  const clean = token.trim();
  if (!clean) return { ok: false, error: 'กรุณากรอก GitHub Personal Access Token' };
  try {
    const res = await githubApiRequest<{ login?: string; name?: string }>(
      clean,
      'GET',
      '/user'
    );
    if (!res.ok || !res.data?.login) {
      return {
        ok: false,
        error:
          res.status === 401
            ? 'GitHub Token ไม่ถูกต้องหรือหมดอายุ กรุณาสร้าง Token ที่มีสิทธิ์ repo ใหม่'
            : res.errorMessage || 'ตรวจสอบบัญชี GitHub ไม่สำเร็จ',
      };
    }
    return { ok: true, login: res.data.login, name: res.data.name };
  } catch (err: any) {
    return { ok: false, error: err?.message || 'เชื่อมต่อ GitHub.com ไม่สำเร็จ' };
  }
}

async function ensureGithubRepoAndBranch(params: {
  token: string;
  owner: string;
  repo: string;
  branch: string;
  isPrivate: boolean;
  authenticatedLogin: string;
}): Promise<{ parentCommitSha: string }> {
  const { token, owner, repo, branch, isPrivate, authenticatedLogin } = params;
  const repoPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  let repoRes = await githubApiRequest<{ default_branch?: string }>(token, 'GET', repoPath);

  if (repoRes.status === 404) {
    if (owner.toLowerCase() !== authenticatedLogin.toLowerCase()) {
      throw new Error(
        `ไม่พบ Repository "${owner}/${repo}" หรือ Token ไม่มีสิทธิ์สร้างภายใต้ชื่อ ${owner}`
      );
    }
    const createRes = await githubApiRequest<{ default_branch?: string }>(
      token,
      'POST',
      '/user/repos',
      {
        name: repo,
        private: isPrivate,
        auto_init: true,
        description:
          'Cisd เตือน — Real-Time US100 M15 CISD Monitor & Alert System',
      }
    );
    if (!createRes.ok) {
      throw new Error(createRes.errorMessage || `สร้าง Repository "${repo}" บน GitHub ไม่สำเร็จ`);
    }
    repoRes = createRes;
    await new Promise((r) => setTimeout(r, 900));
  } else if (!repoRes.ok) {
    throw new Error(repoRes.errorMessage || 'ไม่สามารถเข้าถึง Repository บน GitHub ได้');
  }

  const refPath = `${repoPath}/git/ref/heads/${encodeURIComponent(branch)}`;
  const refRes = await githubApiRequest<{ object?: { sha?: string } }>(token, 'GET', refPath);
  if (refRes.ok && refRes.data?.object?.sha) {
    return { parentCommitSha: refRes.data.object.sha };
  }

  // Try seeding empty repo or branching off default_branch
  const defaultBranch = repoRes.data?.default_branch;
  if (defaultBranch && defaultBranch !== branch) {
    const defRefRes = await githubApiRequest<{ object?: { sha?: string } }>(
      token,
      'GET',
      `${repoPath}/git/ref/heads/${encodeURIComponent(defaultBranch)}`
    );
    if (defRefRes.ok && defRefRes.data?.object?.sha) {
      const createBranchRes = await githubApiRequest<{ object?: { sha?: string } }>(
        token,
        'POST',
        `${repoPath}/git/refs`,
        {
          ref: `refs/heads/${branch}`,
          sha: defRefRes.data.object.sha,
        }
      );
      if (createBranchRes.ok && createBranchRes.data?.object?.sha) {
        return { parentCommitSha: createBranchRes.data.object.sha };
      }
    }
  }

  // Repo is completely empty (404/409 on git/refs) -> bootstrap README via Contents API
  const initContent = Buffer.from(
    '# Cisd เตือน\n\nInitializing real-time US100 M15 workspace sync...\n',
    'utf-8'
  ).toString('base64');
  const seedRes = await githubApiRequest<{ commit?: { sha?: string } }>(
    token,
    'PUT',
    `${repoPath}/contents/README.md`,
    {
      message: 'chore: initialize repository',
      content: initContent,
      branch,
    }
  );
  if (!seedRes.ok || !seedRes.data?.commit?.sha) {
    throw new Error(
      seedRes.errorMessage || `ไม่สามารถสร้าง Branch "${branch}" ใน Repository ได้`
    );
  }
  return { parentCommitSha: seedRes.data.commit.sha };
}

async function syncWorkspaceToGithub(options?: {
  force?: boolean;
  reason?: string;
  approved?: boolean;
}): Promise<{
  ok: boolean;
  committed: boolean;
  syncedFilesCount: number;
  commitUrl?: string;
  error?: string;
}> {
  const token = persisted.githubToken.trim();
  const repo = sanitizeGithubRepoName(persisted.githubRepo);
  const branch = persisted.githubBranch.trim() || 'main';
  if (!token || !repo) {
    return { ok: false, committed: false, syncedFilesCount: 0, error: 'ยังไม่ได้ตั้งค่า GitHub' };
  }
  if (!persisted.githubUploadAllowed && !options?.approved) {
    return {
      ok: false,
      committed: false,
      syncedFilesCount: 0,
      error: 'ยังไม่อนุญาตให้อัปโหลดขึ้น GitHub (กรุณากดปุ่มอนุญาตอัปโหลดก่อน)',
    };
  }

  if (githubRuntime.isSyncing) {
    githubRuntime.pendingResync = true;
    return {
      ok: true,
      committed: false,
      syncedFilesCount: 0,
    };
  }

  const snapshot = computeWorkspaceSnapshot();
  if (!options?.force && snapshot.hash === persisted.githubLastSyncedHash) {
    return {
      ok: true,
      committed: false,
      syncedFilesCount: snapshot.entries.length,
      commitUrl: persisted.githubLastCommitUrl || undefined,
    };
  }

  githubRuntime.isSyncing = true;
  try {
    const userRes = await fetchGithubAuthenticatedUser(token);
    if (!userRes.ok || !userRes.login) {
      throw new Error(userRes.error || 'ตรวจสอบ GitHub Token ไม่สำเร็จ');
    }

    const owner = persisted.githubOwner.trim() || userRes.login;
    if (persisted.githubOwner !== owner) {
      persisted.githubOwner = owner;
    }

    const { parentCommitSha } = await ensureGithubRepoAndBranch({
      token,
      owner,
      repo,
      branch,
      isPrivate: persisted.githubPrivate,
      authenticatedLogin: userRes.login,
    });

    const repoPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    const treeItems: Array<{
      path: string;
      mode: '100644';
      type: 'blob';
      sha: string;
    }> = [];

    // Upload file blobs in small parallel batches to stay fast without hitting secondary limits
    const BATCH_SIZE = 8;
    for (let i = 0; i < snapshot.entries.length; i += BATCH_SIZE) {
      const batch = snapshot.entries.slice(i, i + BATCH_SIZE);
      const uploaded = await Promise.all(
        batch.map(async (item) => {
          const blobRes = await githubApiRequest<{ sha?: string }>(
            token,
            'POST',
            `${repoPath}/git/blobs`,
            {
              content: item.buffer.toString('base64'),
              encoding: 'base64',
            }
          );
          if (!blobRes.ok || !blobRes.data?.sha) {
            throw new Error(
              `อัปโหลดไฟล์ ${item.path} ไม่สำเร็จ: ${blobRes.errorMessage || 'Blob error'}`
            );
          }
          return {
            path: item.path,
            mode: '100644' as const,
            type: 'blob' as const,
            sha: blobRes.data.sha,
          };
        })
      );
      treeItems.push(...uploaded);
    }

    const treeRes = await githubApiRequest<{ sha?: string }>(
      token,
      'POST',
      `${repoPath}/git/trees`,
      { tree: treeItems }
    );
    if (!treeRes.ok || !treeRes.data?.sha) {
      throw new Error(treeRes.errorMessage || 'สร้าง Git Tree บน GitHub ไม่สำเร็จ');
    }

    const timestampBkk = new Date().toLocaleString('th-TH', {
      timeZone: 'Asia/Bangkok',
      hour12: false,
    });
    const reasonTag = options?.reason || 'realtime-sync';
    const commitMsg = `sync(${reasonTag}): update ${snapshot.entries.length} files [${timestampBkk}]`;

    const commitRes = await githubApiRequest<{ sha?: string; html_url?: string }>(
      token,
      'POST',
      `${repoPath}/git/commits`,
      {
        message: commitMsg,
        tree: treeRes.data.sha,
        parents: [parentCommitSha],
      }
    );
    if (!commitRes.ok || !commitRes.data?.sha) {
      throw new Error(commitRes.errorMessage || 'สร้าง Commit บน GitHub ไม่สำเร็จ');
    }

    const patchRefRes = await githubApiRequest(
      token,
      'PATCH',
      `${repoPath}/git/refs/heads/${encodeURIComponent(branch)}`,
      {
        sha: commitRes.data.sha,
        force: false,
      }
    );
    if (!patchRefRes.ok) {
      throw new Error(patchRefRes.errorMessage || 'อัปเดต Branch บน GitHub ไม่สำเร็จ');
    }

    const commitUrl =
      commitRes.data.html_url || `https://github.com/${owner}/${repo}/commit/${commitRes.data.sha}`;

    persisted.githubLastSyncedHash = snapshot.hash;
    persisted.githubLastSyncAt = new Date().toISOString();
    persisted.githubLastCommitUrl = commitUrl;
    persisted.githubLastError = null;
    syncPersistence();

    return {
      ok: true,
      committed: true,
      syncedFilesCount: snapshot.entries.length,
      commitUrl,
    };
  } catch (err: any) {
    const errMsg = err?.message || 'ซิงค์ขึ้น GitHub ไม่สำเร็จ';
    persisted.githubLastError = errMsg;
    syncPersistence();
    return {
      ok: false,
      committed: false,
      syncedFilesCount: 0,
      error: errMsg,
    };
  } finally {
    githubRuntime.isSyncing = false;
    if (githubRuntime.pendingResync) {
      githubRuntime.pendingResync = false;
      scheduleGithubAutoSync('pending-change', 1200);
    }
  }
}

function scheduleGithubAutoSync(reason: string, delayMs = 2500) {
  if (!persisted.githubUploadAllowed) return;
  if (!persisted.githubToken || !persisted.githubRepo) return;
  if (reason === 'signal-event' && !persisted.githubSyncSignals) return;
  if (reason !== 'signal-event' && !persisted.githubAutoSyncCode) return;

  if (githubRuntime.debounceTimer) {
    clearTimeout(githubRuntime.debounceTimer);
  }
  githubRuntime.debounceTimer = setTimeout(() => {
    githubRuntime.debounceTimer = null;
    void syncWorkspaceToGithub({ force: false, reason });
  }, delayMs);
}

function startGithubWorkspaceWatchers() {
  const watchTargets = [
    'src',
    'public',
    'server.ts',
    'package.json',
    'index.html',
    'Dockerfile',
    'render.yaml',
    'README.md',
  ];

  for (const target of watchTargets) {
    const fullPath = path.join(__dirname, target);
    if (!fs.existsSync(fullPath)) continue;
    try {
      fs.watch(fullPath, { recursive: fs.statSync(fullPath).isDirectory() }, (_event, fname) => {
        const name = String(fname || '');
        if (name.includes('.data') || name.includes('node_modules') || name.endsWith('.zip')) {
          return;
        }
        scheduleGithubAutoSync('file-watch', 2500);
      });
    } catch {
      // Fallback polling interval covers filesystems where recursive watch isn't supported
    }
  }

  setInterval(() => {
    if (
      persisted.githubUploadAllowed &&
      persisted.githubToken &&
      persisted.githubRepo &&
      persisted.githubAutoSyncCode
    ) {
      void syncWorkspaceToGithub({ force: false, reason: 'auto-poll' });
    }
  }, 15000);
}

function buildGithubStatusResponse() {
  const owner = persisted.githubOwner.trim();
  const repo = sanitizeGithubRepoName(persisted.githubRepo);
  const snapshot = computeWorkspaceSnapshot();
  return {
    hasToken: Boolean(persisted.githubToken),
    connected: Boolean(persisted.githubToken && owner && repo),
    owner,
    repo,
    branch: persisted.githubBranch || 'main',
    privateRepo: persisted.githubPrivate,
    uploadAllowed: persisted.githubUploadAllowed,
    autoSyncCode: persisted.githubAutoSyncCode,
    syncSignals: persisted.githubSyncSignals,
    lastSyncAt: persisted.githubLastSyncAt,
    lastCommitUrl: persisted.githubLastCommitUrl,
    lastError: persisted.githubLastError,
    isSyncing: githubRuntime.isSyncing,
    fileCount: snapshot.entries.length,
    workspaceChanged: Boolean(
      persisted.githubToken && snapshot.hash !== persisted.githubLastSyncedHash
    ),
    repoUrl: owner && repo ? `https://github.com/${owner}/${repo}` : null,
  };
}

function roundTo(val: number, digits: number): number {
  const f = Math.pow(10, digits);
  return Math.round(val * f) / f;
}

function formatTimeLabel(date: Date): string {
  return date.toLocaleTimeString('th-TH', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Asia/Bangkok',
  });
}

function computeAwesomeOscillator(
  rawBars: Array<Omit<M5Candle, 'ao' | 'aoRising' | 'signal'>>
): M5Candle[] {
  const out: M5Candle[] = [];
  for (let i = 0; i < rawBars.length; i++) {
    const bar = rawBars[i];
    let ao = 0;
    // Standard MT5 Awesome Oscillator: SMA(Median, 5) - SMA(Median, 34), PLOT_DRAW_BEGIN = 33
    if (i >= 33) {
      let sum5 = 0;
      for (let k = i - 4; k <= i; k++) sum5 += rawBars[k].median;
      let sum34 = 0;
      for (let k = i - 33; k <= i; k++) sum34 += rawBars[k].median;
      ao = sum5 / 5 - sum34 / 34;
    }

    const prev = out[i - 1];
    const aoRising = i > 33 && prev ? ao >= prev.ao : true;
    let signal: 'BUY' | 'SELL' | null = null;
    if (i >= 34 && prev) {
      if (prev.ao <= 0 && ao > 0) signal = 'BUY';
      else if (prev.ao >= 0 && ao < 0) signal = 'SELL';
    }

    out.push({ ...bar, ao, aoRising, signal });
  }
  return out;
}

let cachedMarketCalibration: { cashBasis: number; qqqRatio: number; expiresAt: number } = {
  cashBasis: 0,
  qqqRatio: 0,
  expiresAt: 0,
};
const nyOffsetCache = new Map<number, number>();

function getXmServerOffsetSeconds(unixSec: number): number {
  // Cache per 6-hour block since NY DST only flips twice a year
  const cacheKey = Math.floor(unixSec / 21600);
  const cached = nyOffsetCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const dt = new Date(unixSec * 1000);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    timeZoneName: 'shortOffset',
  }).formatToParts(dt);
  const tzStr = parts.find((p) => p.type === 'timeZoneName')?.value || 'GMT-5';
  const match = tzStr.match(/GMT([+-]\d+)/);
  const nyOffsetHrs = match ? parseInt(match[1], 10) : -5;
  // XM MT5 Server Time = NY Close (17:00 NY = 00:00 Server) -> NY + 7h = EET (+2) / EEST (+3)
  const xmOffsetSec = (nyOffsetHrs + 7) * 3600;
  nyOffsetCache.set(cacheKey, xmOffsetSec);
  return xmOffsetSec;
}

const YAHOO_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
  Accept: 'application/json',
};

async function getLiveMarketCalibration(): Promise<{ cashBasis: number; qqqRatio: number }> {
  if (cachedMarketCalibration.expiresAt > Date.now()) {
    return {
      cashBasis: cachedMarketCalibration.cashBasis,
      qqqRatio: cachedMarketCalibration.qqqRatio,
    };
  }
  let nextCashBasis = cachedMarketCalibration.cashBasis;
  let nextQqqRatio = cachedMarketCalibration.qqqRatio;

  try {
    const [futRes, cashRes, qqqRes] = await Promise.all([
      fetch(
        'https://query1.finance.yahoo.com/v8/finance/chart/NQ%3DF?interval=15m&range=5d&includePrePost=true',
        { headers: YAHOO_HEADERS, signal: AbortSignal.timeout(5000) }
      ),
      fetch(
        'https://query1.finance.yahoo.com/v8/finance/chart/%5ENDX?interval=15m&range=5d&includePrePost=true',
        { headers: YAHOO_HEADERS, signal: AbortSignal.timeout(5000) }
      ),
      fetch(
        'https://query1.finance.yahoo.com/v8/finance/chart/QQQ?interval=15m&range=5d&includePrePost=true',
        { headers: YAHOO_HEADERS, signal: AbortSignal.timeout(5000) }
      ),
    ]);

    const [futJson, cashJson, qqqJson] = await Promise.all([
      futRes.ok ? futRes.json().catch(() => null) : null,
      cashRes.ok ? cashRes.json().catch(() => null) : null,
      qqqRes.ok ? qqqRes.json().catch(() => null) : null,
    ]);

    const cashResult = cashJson?.chart?.result?.[0];
    const cashTs: number[] = cashResult?.timestamp || [];
    const cashCloses: Array<number | null> = cashResult?.indicators?.quote?.[0]?.close || [];
    const cashMap = new Map<number, number>();
    for (let i = 0; i < cashTs.length; i++) {
      if (cashCloses[i] != null && Number(cashCloses[i]) > 0) {
        cashMap.set(cashTs[i], Number(cashCloses[i]));
      }
    }

    const futResult = futJson?.chart?.result?.[0];
    const futTs: number[] = futResult?.timestamp || [];
    const futCloses: Array<number | null> = futResult?.indicators?.quote?.[0]?.close || [];
    const diffs: number[] = [];
    for (let i = 0; i < futTs.length; i++) {
      if (futCloses[i] != null && cashMap.has(futTs[i])) {
        diffs.push(Number(futCloses[i]) - (cashMap.get(futTs[i]) as number));
      }
    }
    if (diffs.length >= 3) {
      const recent = diffs.slice(-20).sort((a, b) => a - b);
      const median = recent[Math.floor(recent.length / 2)];
      nextCashBasis = Math.round(median * 4) / 4;
    }

    const qqqResult = qqqJson?.chart?.result?.[0];
    const qqqTs: number[] = qqqResult?.timestamp || [];
    const qqqCloses: Array<number | null> = qqqResult?.indicators?.quote?.[0]?.close || [];
    const exactRatios: number[] = [];
    const futDerivedRatios: number[] = [];
    const futMap = new Map<number, number>();
    for (let i = 0; i < futTs.length; i++) {
      if (futCloses[i] != null && Number(futCloses[i]) > 0) {
        futMap.set(futTs[i], Number(futCloses[i]));
      }
    }
    for (let i = 0; i < qqqTs.length; i++) {
      const qClose = Number(qqqCloses[i]);
      if (!Number.isFinite(qClose) || qClose <= 0) continue;
      const ndxClose = cashMap.get(qqqTs[i]);
      if (ndxClose && ndxClose > 0) {
        exactRatios.push(ndxClose / qClose);
      } else {
        const futClose = futMap.get(qqqTs[i]);
        if (futClose && futClose > 0) {
          futDerivedRatios.push((futClose - nextCashBasis) / qClose);
        }
      }
    }
    const chosenRatios = exactRatios.length >= 3 ? exactRatios : futDerivedRatios;
    if (chosenRatios.length >= 3) {
      const recentRatios = chosenRatios.slice(-16).sort((a, b) => a - b);
      nextQqqRatio = recentRatios[Math.floor(recentRatios.length / 2)];
    }

    if (diffs.length >= 3 || chosenRatios.length >= 3) {
      cachedMarketCalibration = {
        cashBasis: nextCashBasis,
        qqqRatio: nextQqqRatio,
        expiresAt: Date.now() + 60000,
      };
      return { cashBasis: nextCashBasis, qqqRatio: nextQqqRatio };
    }
  } catch {
    // Keep previous cached calibration on transient upstream failure
  }

  cachedMarketCalibration = {
    cashBasis: nextCashBasis,
    qqqRatio: nextQqqRatio,
    expiresAt: Date.now() + 15000,
  };
  return { cashBasis: nextCashBasis, qqqRatio: nextQqqRatio };
}

async function getLiveCashBasis(): Promise<number> {
  const cal = await getLiveMarketCalibration();
  return cal.cashBasis;
}

interface Tail1mBar {
  ts: number;
  o: number;
  h: number;
  l: number;
  c: number;
  isExact: boolean;
}

interface RealtimeTailData {
  bars: Tail1mBar[];
  liveMeta: { price: number; timeSec: number; source: 'NDX' | 'QQQ' } | null;
}

async function fetchRealtimeTailData(qqqRatio: number): Promise<RealtimeTailData> {
  const [ndxRes, qqqRes] = await Promise.all([
    fetch(
      'https://query1.finance.yahoo.com/v8/finance/chart/%5ENDX?interval=1m&range=1d&includePrePost=true',
      { headers: YAHOO_HEADERS, cache: 'no-store', signal: AbortSignal.timeout(4500) }
    ).catch(() => null),
    qqqRatio > 0
      ? fetch(
          'https://query1.finance.yahoo.com/v8/finance/chart/QQQ?interval=1m&range=1d&includePrePost=true',
          { headers: YAHOO_HEADERS, cache: 'no-store', signal: AbortSignal.timeout(4500) }
        ).catch(() => null)
      : Promise.resolve(null),
  ]);

  const [ndxJson, qqqJson] = await Promise.all([
    ndxRes && ndxRes.ok ? ndxRes.json().catch(() => null) : null,
    qqqRes && qqqRes.ok ? qqqRes.json().catch(() => null) : null,
  ]);

  const byTs = new Map<number, Tail1mBar>();

  const qqqResult = qqqJson?.chart?.result?.[0];
  if (qqqResult && qqqRatio > 0) {
    const tsArr: number[] = qqqResult.timestamp || [];
    const quote = qqqResult.indicators?.quote?.[0] || {};
    const oArr: Array<number | null> = quote.open || [];
    const hArr: Array<number | null> = quote.high || [];
    const lArr: Array<number | null> = quote.low || [];
    const cArr: Array<number | null> = quote.close || [];
    for (let i = 0; i < tsArr.length; i++) {
      const o = oArr[i];
      const h = hArr[i];
      const l = lArr[i];
      const c = cArr[i];
      if (o == null || h == null || l == null || c == null) continue;
      byTs.set(tsArr[i], {
        ts: tsArr[i],
        o: Number(o) * qqqRatio,
        h: Number(h) * qqqRatio,
        l: Number(l) * qqqRatio,
        c: Number(c) * qqqRatio,
        isExact: false,
      });
    }
  }

  const ndxResult = ndxJson?.chart?.result?.[0];
  if (ndxResult) {
    const tsArr: number[] = ndxResult.timestamp || [];
    const quote = ndxResult.indicators?.quote?.[0] || {};
    const oArr: Array<number | null> = quote.open || [];
    const hArr: Array<number | null> = quote.high || [];
    const lArr: Array<number | null> = quote.low || [];
    const cArr: Array<number | null> = quote.close || [];
    for (let i = 0; i < tsArr.length; i++) {
      const o = oArr[i];
      const h = hArr[i];
      const l = lArr[i];
      const c = cArr[i];
      if (o == null || h == null || l == null || c == null) continue;
      byTs.set(tsArr[i], {
        ts: tsArr[i],
        o: Number(o),
        h: Number(h),
        l: Number(l),
        c: Number(c),
        isExact: true,
      });
    }
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const ndxMetaPrice = Number(ndxResult?.meta?.regularMarketPrice);
  const ndxMetaTime = Math.floor(Number(ndxResult?.meta?.regularMarketTime) || 0);
  const qqqMetaPrice = Number(qqqResult?.meta?.regularMarketPrice);
  const qqqMetaTime = Math.floor(Number(qqqResult?.meta?.regularMarketTime) || 0);

  const ndxMetaLive =
    Number.isFinite(ndxMetaPrice) && ndxMetaPrice > 0 && nowSec - ndxMetaTime <= 180;
  const qqqMetaLive =
    qqqRatio > 0 &&
    Number.isFinite(qqqMetaPrice) &&
    qqqMetaPrice > 0 &&
    nowSec - qqqMetaTime <= 180;

  let liveMeta: { price: number; timeSec: number; source: 'NDX' | 'QQQ' } | null = null;
  if (ndxMetaLive && (!qqqMetaLive || ndxMetaTime >= qqqMetaTime - 60)) {
    liveMeta = { price: ndxMetaPrice, timeSec: ndxMetaTime, source: 'NDX' };
  } else if (qqqMetaLive) {
    liveMeta = { price: qqqMetaPrice * qqqRatio, timeSec: qqqMetaTime, source: 'QQQ' };
  }

  const bars = [...byTs.values()].sort((a, b) => a.ts - b.ts);
  return { bars, liveMeta };
}

const YAHOO_AO_PARAMS: Record<
  AoTimeframe,
  { interval: string; range: string; maxAgeMinutes: number; cacheMs: number }
> = {
  M5: { interval: '5m', range: '5d', maxAgeMinutes: 20, cacheMs: 3000 },
};

async function fetchYahooAo(
  symbol: TradingSymbol,
  timeframe: AoTimeframe = 'M5'
): Promise<MarketFeedResult> {
  const mapping = YAHOO_SYMBOL_MAP[symbol];
  const cfg = YAHOO_AO_PARAMS[timeframe];
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    mapping.ticker
  )}?interval=${encodeURIComponent(cfg.interval)}&range=${encodeURIComponent(
    cfg.range
  )}&includePrePost=true`;

  const [res, cashBasis] = await Promise.all([
    fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(8000),
    }),
    getLiveCashBasis(),
  ]);

  if (!res.ok) {
    throw new Error(`Market feed ${timeframe} HTTP ${res.status}`);
  }

  const json = (await res.json()) as any;
  const result = json?.chart?.result?.[0];
  const metaPrice = Number(result?.meta?.regularMarketPrice) - cashBasis;
  const timestamps: number[] = result?.timestamp || [];
  const quote = result?.indicators?.quote?.[0] || {};
  const opens: Array<number | null> = quote.open || [];
  const highs: Array<number | null> = quote.high || [];
  const lows: Array<number | null> = quote.low || [];
  const closes: Array<number | null> = quote.close || [];

  const cleaned: Array<Omit<M5Candle, 'ao' | 'aoRising' | 'signal'>> = [];
  for (let i = 0; i < timestamps.length; i++) {
    const o = opens[i];
    const h = highs[i];
    const l = lows[i];
    const c = closes[i];
    if (o == null || h == null || l == null || c == null) continue;
    const dt = new Date(timestamps[i] * 1000);
    const open = roundTo(o - cashBasis, mapping.digits);
    const high = roundTo(h - cashBasis, mapping.digits);
    const low = roundTo(l - cashBasis, mapping.digits);
    const close = roundTo(c - cashBasis, mapping.digits);
    cleaned.push({
      index: cleaned.length,
      timeLabel: formatTimeLabel(dt),
      timestampIso: dt.toISOString(),
      open,
      high,
      low,
      close,
      median: (high + low) / 2,
    });
  }

  if (cleaned.length > 0 && Number.isFinite(metaPrice) && metaPrice > 0) {
    const last = cleaned[cleaned.length - 1];
    const ageMin = (Date.now() - new Date(last.timestampIso).getTime()) / 60000;
    if (ageMin <= cfg.maxAgeMinutes) {
      const liveClose = roundTo(metaPrice, mapping.digits);
      last.close = liveClose;
      last.high = Math.max(last.high, liveClose);
      last.low = Math.min(last.low, liveClose);
      last.median = (last.high + last.low) / 2;
    }
  }

  const warmupSlice = cleaned.slice(-180).map((b, idx) => ({ ...b, index: idx }));
  if (warmupSlice.length < 36) {
    throw new Error(`ข้อมูล ${timeframe} ไม่เพียงพอสำหรับคำนวณ AO`);
  }

  const bars = computeAwesomeOscillator(warmupSlice)
    .slice(-90)
    .map((b, idx) => ({ ...b, index: idx }));

  const latestBarTs = new Date(bars[bars.length - 1].timestampIso).getTime();
  const ageMinutes = (Date.now() - latestBarTs) / 60000;
  const marketState = ageMinutes <= cfg.maxAgeMinutes ? 'LIVE' : 'MARKET CLOSED';

  return {
    symbol,
    source: `XM US100Cash# ${timeframe}`,
    marketState,
    fetchedAt: new Date().toISOString(),
    bars,
  };
}

async function getLiveAoFeed(
  symbol: TradingSymbol,
  timeframe: AoTimeframe = 'M5'
): Promise<MarketFeedResult> {
  const cacheKey = `${symbol}:${timeframe}`;
  const cached = feedCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  const data = await fetchYahooAo(symbol, timeframe);

  feedCache.set(cacheKey, {
    expiresAt: Date.now() + YAHOO_AO_PARAMS[timeframe].cacheMs,
    data,
  });
  return data;
}

async function getLiveM5Feed(symbol: TradingSymbol): Promise<MarketFeedResult> {
  return getLiveAoFeed(symbol, 'M5');
}

function detectCisdServer(
  rawBars: Array<{
    index: number;
    timeLabel: string;
    timestampIso: string;
    open: number;
    high: number;
    low: number;
    close: number;
  }>
): {
  bars: M15CisdCandle[];
  segments: M15CisdSegment[];
  latestBearCisdLevel: number | null;
  latestBullCisdLevel: number | null;
  currentTrend: 'BUY' | 'SELL' | null;
  lastSignalInfo: LastCisdSignalInfo | null;
} {
  const n = rawBars.length;
  if (n === 0) {
    return {
      bars: [],
      segments: [],
      latestBearCisdLevel: null,
      latestBullCisdLevel: null,
      currentTrend: null,
      lastSignalInfo: null,
    };
  }

  const bodies = rawBars.map((b) => Math.abs(b.close - b.open));
  const bars: M15CisdCandle[] = [];
  const segments: M15CisdSegment[] = [];

  let bullLeg: {
    originIndex: number;
    originTimeLabel: string;
    open: number;
    extremeHigh: number;
    extremeLow: number;
    candles: number;
    bodySum: number;
  } | null = null;
  let bearLeg: {
    originIndex: number;
    originTimeLabel: string;
    open: number;
    extremeHigh: number;
    extremeLow: number;
    candles: number;
    bodySum: number;
  } | null = null;

  let activeBearCisd: {
    level: number;
    triggered: boolean;
    segmentIndex: number;
  } | null = null;
  let activeBullCisd: {
    level: number;
    triggered: boolean;
    segmentIndex: number;
  } | null = null;
  let currentTrend: 'BUY' | 'SELL' | null = null;

  const avgBodyAt = (idx: number): number => {
    const start = Math.max(0, idx - 14);
    let sum = 0;
    let count = 0;
    for (let k = start; k < idx; k++) {
      sum += bodies[k];
      count++;
    }
    return count > 0 ? sum / count : bodies[idx] || 1;
  };

  const recentHighBefore = (idx: number): number => {
    const start = Math.max(0, idx - 4);
    let maxH = -Infinity;
    for (let k = start; k < idx; k++) {
      if (rawBars[k].high > maxH) maxH = rawBars[k].high;
    }
    return maxH;
  };

  const recentLowBefore = (idx: number): number => {
    const start = Math.max(0, idx - 4);
    let minL = Infinity;
    for (let k = start; k < idx; k++) {
      if (rawBars[k].low < minL) minL = rawBars[k].low;
    }
    return minL;
  };

  for (let i = 0; i < n; i++) {
    const bar = rawBars[i];
    if (i === n - 1) {
      bars.push({
        ...bar,
        index: i,
        cisdSignal: null,
        cisdLevel: null,
        closedBelowCisd: false,
        closedAboveCisd: false,
        activeBearCisdLevel:
          currentTrend !== 'SELL' && activeBearCisd && !activeBearCisd.triggered
            ? activeBearCisd.level
            : null,
        activeBullCisdLevel:
          currentTrend !== 'BUY' && activeBullCisd && !activeBullCisd.triggered
            ? activeBullCisd.level
            : null,
      });
      continue;
    }

    const isBull = bar.close > bar.open;
    const isBear = bar.close < bar.open;
    const body = Math.abs(bar.close - bar.open);
    const avgBody = avgBodyAt(i);

    if (isBear && bullLeg) {
      const isValidLeg =
        bullLeg.candles >= 2 ||
        bullLeg.extremeHigh >= recentHighBefore(bullLeg.originIndex) ||
        bullLeg.bodySum >= avgBody * 0.45;
      if (isValidLeg) {
        const segIdx = segments.length;
        segments.push({
          id: `bear-cisd-${bullLeg.originIndex}-${bar.index}`,
          kind: 'bearish_break',
          level: bullLeg.open,
          originIndex: bullLeg.originIndex,
          originTimeLabel: bullLeg.originTimeLabel,
          endIndex: i,
          triggeredIndex: null,
          triggeredDirection: null,
        });
        activeBearCisd = { level: bullLeg.open, triggered: false, segmentIndex: segIdx };
      }
      bullLeg = null;
    }

    if (isBull && bearLeg) {
      const isValidLeg =
        bearLeg.candles >= 2 ||
        bearLeg.extremeLow <= recentLowBefore(bearLeg.originIndex) ||
        bearLeg.bodySum >= avgBody * 0.45;
      if (isValidLeg) {
        const segIdx = segments.length;
        segments.push({
          id: `bull-cisd-${bearLeg.originIndex}-${bar.index}`,
          kind: 'bullish_break',
          level: bearLeg.open,
          originIndex: bearLeg.originIndex,
          originTimeLabel: bearLeg.originTimeLabel,
          endIndex: i,
          triggeredIndex: null,
          triggeredDirection: null,
        });
        activeBullCisd = { level: bearLeg.open, triggered: false, segmentIndex: segIdx };
      }
      bearLeg = null;
    }

    if (isBull) {
      if (!bullLeg) {
        bullLeg = {
          originIndex: i,
          originTimeLabel: bar.timeLabel,
          open: bar.open,
          extremeHigh: bar.high,
          extremeLow: bar.low,
          candles: 1,
          bodySum: body,
        };
      } else {
        bullLeg.candles += 1;
        bullLeg.bodySum += body;
        bullLeg.extremeHigh = Math.max(bullLeg.extremeHigh, bar.high);
        bullLeg.extremeLow = Math.min(bullLeg.extremeLow, bar.low);
      }
    } else if (isBear) {
      if (!bearLeg) {
        bearLeg = {
          originIndex: i,
          originTimeLabel: bar.timeLabel,
          open: bar.open,
          extremeHigh: bar.high,
          extremeLow: bar.low,
          candles: 1,
          bodySum: body,
        };
      } else {
        bearLeg.candles += 1;
        bearLeg.bodySum += body;
        bearLeg.extremeHigh = Math.max(bearLeg.extremeHigh, bar.high);
        bearLeg.extremeLow = Math.min(bearLeg.extremeLow, bar.low);
      }
    }

    let cisdSignal: 'BUY' | 'SELL' | null = null;
    let cisdLevel: number | null = null;
    let closedBelowCisd = false;
    let closedAboveCisd = false;

    const bearBreached =
      activeBearCisd && !activeBearCisd.triggered && bar.close < activeBearCisd.level;
    const bullBreached =
      activeBullCisd && !activeBullCisd.triggered && bar.close > activeBullCisd.level;

    if (activeBearCisd && !activeBearCisd.triggered) {
      segments[activeBearCisd.segmentIndex].endIndex = i;
      if (bearBreached) {
        activeBearCisd.triggered = true;
        if (currentTrend !== 'SELL') {
          currentTrend = 'SELL';
          segments[activeBearCisd.segmentIndex].triggeredIndex = i;
          segments[activeBearCisd.segmentIndex].triggeredDirection = 'SELL';
          segments[activeBearCisd.segmentIndex].endIndex = i;
          closedBelowCisd = true;
          cisdSignal = 'SELL';
          cisdLevel = activeBearCisd.level;
        }
      }
    }

    if (activeBullCisd && !activeBullCisd.triggered) {
      segments[activeBullCisd.segmentIndex].endIndex = i;
      if (bullBreached) {
        activeBullCisd.triggered = true;
        if (currentTrend !== 'BUY') {
          currentTrend = 'BUY';
          segments[activeBullCisd.segmentIndex].triggeredIndex = i;
          segments[activeBullCisd.segmentIndex].triggeredDirection = 'BUY';
          segments[activeBullCisd.segmentIndex].endIndex = i;
          closedAboveCisd = true;
          if (!cisdSignal || isBull) {
            cisdSignal = 'BUY';
            cisdLevel = activeBullCisd.level;
          }
        }
      }
    }

    bars.push({
      ...bar,
      index: i,
      cisdSignal,
      cisdLevel,
      closedBelowCisd,
      closedAboveCisd,
      activeBearCisdLevel:
        currentTrend !== 'SELL' && activeBearCisd && !activeBearCisd.triggered
          ? activeBearCisd.level
          : null,
      activeBullCisdLevel:
        currentTrend !== 'BUY' && activeBullCisd && !activeBullCisd.triggered
          ? activeBullCisd.level
          : null,
    });
  }

  let lastSignalInfo: LastCisdSignalInfo | null = null;
  for (let k = bars.length - 1; k >= 0; k--) {
    const b = bars[k];
    if (b.cisdSignal && b.cisdLevel !== null) {
      lastSignalInfo = {
        signal: b.cisdSignal,
        level: b.cisdLevel,
        price: b.close,
        timeLabel: b.timeLabel,
        timestampIso: b.timestampIso,
      };
      break;
    }
  }

  const latestBar = bars[bars.length - 1];
  return {
    bars,
    segments,
    latestBearCisdLevel: latestBar?.activeBearCisdLevel ?? null,
    latestBullCisdLevel: latestBar?.activeBullCisdLevel ?? null,
    currentTrend,
    lastSignalInfo,
  };
}

const YAHOO_CISD_PARAMS: Record<
  CisdTimeframe,
  {
    interval: string;
    range: string;
    bucketMinutes: number;
    xmBucketHours?: number;
    maxAgeMinutes: number;
    cacheMs: number;
  }
> = {
  M5: { interval: '5m', range: '5d', bucketMinutes: 5, maxAgeMinutes: 25, cacheMs: 1500 },
  M15: { interval: '15m', range: '15d', bucketMinutes: 15, maxAgeMinutes: 45, cacheMs: 1500 },
};

function formatCisdTimeLabel(date: Date, _timeframe: CisdTimeframe): string {
  return formatTimeLabel(date);
}

async function fetchYahooCisd(
  symbol: TradingSymbol,
  timeframe: CisdTimeframe = 'M15'
): Promise<M15MarketFeedResult> {
  const mapping = YAHOO_SYMBOL_MAP[symbol];
  const tfCfg = YAHOO_CISD_PARAMS[timeframe];
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    mapping.ticker
  )}?interval=${encodeURIComponent(tfCfg.interval)}&range=${encodeURIComponent(
    tfCfg.range
  )}&includePrePost=true`;

  const calibration = await getLiveMarketCalibration();
  const { cashBasis, qqqRatio } = calibration;

  const [res, tailData] = await Promise.all([
    fetch(url, {
      headers: YAHOO_HEADERS,
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    }),
    symbol === 'US100'
      ? fetchRealtimeTailData(qqqRatio)
      : Promise.resolve<RealtimeTailData>({ bars: [], liveMeta: null }),
  ]);

  if (!res.ok) {
    throw new Error(`Market feed ${timeframe} HTTP ${res.status}`);
  }

  const json = (await res.json()) as any;
  const result = json?.chart?.result?.[0];
  const rawNqMetaPrice = Number(result?.meta?.regularMarketPrice);
  const rawNqMetaTime = Number(result?.meta?.regularMarketTime);
  const nqMetaPrice =
    Number.isFinite(rawNqMetaPrice) && rawNqMetaPrice > 0 ? rawNqMetaPrice - cashBasis : NaN;
  const nqMetaTimeSec =
    Number.isFinite(rawNqMetaTime) && rawNqMetaTime > 0 ? Math.floor(rawNqMetaTime) : 0;
  const timestamps: number[] = result?.timestamp || [];
  const quote = result?.indicators?.quote?.[0] || {};
  const opens: Array<number | null> = quote.open || [];
  const highs: Array<number | null> = quote.high || [];
  const lows: Array<number | null> = quote.low || [];
  const closes: Array<number | null> = quote.close || [];

  // Bucket ALL M15 (900s) timestamps cleanly onto XM MT5 server grid so Yahoo's
  // unaligned trailing regularMarketTime point folds into the currently forming bar instead of
  // shifting the forming bar to bars[n-2] and dropping newly closed candles to bars[n-3].
  const bucketSec = tfCfg.xmBucketHours
    ? tfCfg.xmBucketHours * 3600
    : tfCfg.bucketMinutes * 60;
  const buckets = new Map<
    number,
    {
      utcTs: number;
      xmTs: number;
      open: number;
      high: number;
      low: number;
      close: number;
    }
  >();

  let lastNqBucketXmTs = 0;
  let lastNqBucketUtcTs = 0;
  let lastNqRawTs = 0;

  for (let i = 0; i < timestamps.length; i++) {
    const o = opens[i];
    const h = highs[i];
    const l = lows[i];
    const c = closes[i];
    if (o == null || h == null || l == null || c == null) continue;
    const xmOffsetSec = getXmServerOffsetSeconds(timestamps[i]);
    const xmTs = timestamps[i] + xmOffsetSec;
    const bucketXmTs = Math.floor(xmTs / bucketSec) * bucketSec;
    const bucketUtcTs = bucketXmTs - xmOffsetSec;
    if (bucketXmTs > lastNqBucketXmTs) {
      lastNqBucketXmTs = bucketXmTs;
      lastNqBucketUtcTs = bucketUtcTs;
    }
    if (timestamps[i] > lastNqRawTs) {
      lastNqRawTs = timestamps[i];
    }
    const existing = buckets.get(bucketXmTs);
    if (!existing) {
      buckets.set(bucketXmTs, {
        utcTs: bucketUtcTs,
        xmTs: bucketXmTs,
        open: o - cashBasis,
        high: h - cashBasis,
        low: l - cashBasis,
        close: c - cashBasis,
      });
    } else {
      existing.high = Math.max(existing.high, h - cashBasis);
      existing.low = Math.min(existing.low, l - cashBasis);
      existing.close = c - cashBasis;
    }
  }

  // Stitch zero-delay 1m ^NDX (1:1 exact cash) and QQQ * ratio bars to eliminate Yahoo's
  // ~10-minute exchange delay on NQ=F CME futures so candle closes match MT5 immediately.
  if (tailData.bars.length > 0 && lastNqBucketXmTs > 0) {
    const nqLatestEffectiveTs = Math.max(lastNqRawTs, nqMetaTimeSec);
    const nqTailCutoffTs =
      nqLatestEffectiveTs >= lastNqBucketUtcTs && nqLatestEffectiveTs < lastNqBucketUtcTs + bucketSec
        ? nqLatestEffectiveTs
        : lastNqBucketUtcTs;

    for (const bar of tailData.bars) {
      const xmOffsetSec = getXmServerOffsetSeconds(bar.ts);
      const xmTs = bar.ts + xmOffsetSec;
      const bucketXmTs = Math.floor(xmTs / bucketSec) * bucketSec;
      if (bucketXmTs < lastNqBucketXmTs) continue;
      const bucketUtcTs = bucketXmTs - xmOffsetSec;
      const existing = buckets.get(bucketXmTs);
      if (!existing) {
        buckets.set(bucketXmTs, {
          utcTs: bucketUtcTs,
          xmTs: bucketXmTs,
          open: bar.o,
          high: bar.h,
          low: bar.l,
          close: bar.c,
        });
      } else {
        existing.high = Math.max(existing.high, bar.h);
        existing.low = Math.min(existing.low, bar.l);
        if (bucketXmTs > lastNqBucketXmTs || bar.ts + 60 >= nqTailCutoffTs || bar.isExact) {
          existing.close = bar.c;
        }
      }
    }
  }

  const sortedBuckets = [...buckets.values()].sort((a, b) => a.xmTs - b.xmTs);

  const chosenMetaPrice = tailData.liveMeta ? tailData.liveMeta.price : nqMetaPrice;
  const chosenMetaTimeSec = tailData.liveMeta ? tailData.liveMeta.timeSec : nqMetaTimeSec;

  if (sortedBuckets.length > 0 && Number.isFinite(chosenMetaPrice) && chosenMetaPrice > 0) {
    const lastBucket = sortedBuckets[sortedBuckets.length - 1];
    const nowSec = Math.floor(Date.now() / 1000);
    if (chosenMetaTimeSec > 0) {
      const metaXmOffsetSec = getXmServerOffsetSeconds(chosenMetaTimeSec);
      const metaXmTs = chosenMetaTimeSec + metaXmOffsetSec;
      const metaBucketXmTs = Math.floor(metaXmTs / bucketSec) * bucketSec;
      const metaBucketUtcTs = metaBucketXmTs - metaXmOffsetSec;
      const isLiveMeta = nowSec - chosenMetaTimeSec <= 180;

      if (metaBucketXmTs === lastBucket.xmTs && isLiveMeta) {
        lastBucket.close = chosenMetaPrice;
        lastBucket.high = Math.max(lastBucket.high, chosenMetaPrice);
        lastBucket.low = Math.min(lastBucket.low, chosenMetaPrice);
      } else if (metaBucketXmTs === lastBucket.xmTs + bucketSec && isLiveMeta) {
        // Candle boundary just rolled over; open the new forming bar cleanly so the
        // just-closed bar immediately sits at bars[n-2] for zero-delay CISD detection.
        sortedBuckets.push({
          utcTs: metaBucketUtcTs,
          xmTs: metaBucketXmTs,
          open: lastBucket.close,
          high: Math.max(lastBucket.close, chosenMetaPrice),
          low: Math.min(lastBucket.close, chosenMetaPrice),
          close: chosenMetaPrice,
        });
      }
    } else {
      const ageMin = (Date.now() - lastBucket.utcTs * 1000) / 60000;
      if (ageMin <= tfCfg.maxAgeMinutes) {
        lastBucket.close = chosenMetaPrice;
        lastBucket.high = Math.max(lastBucket.high, chosenMetaPrice);
        lastBucket.low = Math.min(lastBucket.low, chosenMetaPrice);
      }
    }
  }

  const cleaned = sortedBuckets.map((b, idx) => {
    const dt = new Date(b.utcTs * 1000);
    return {
      index: idx,
      timeLabel: formatCisdTimeLabel(dt, timeframe),
      timestampIso: dt.toISOString(),
      open: roundTo(b.open, mapping.digits),
      high: roundTo(b.high, mapping.digits),
      low: roundTo(b.low, mapping.digits),
      close: roundTo(b.close, mapping.digits),
    };
  });

  const recentSlice = cleaned.slice(-110).map((b, idx) => ({ ...b, index: idx }));
  if (recentSlice.length < 15) {
    throw new Error(`ข้อมูล ${timeframe} ไม่เพียงพอสำหรับตรวจจับระดับ CISD`);
  }

  const detected = detectCisdServer(recentSlice);
  const latestBarTs = new Date(
    detected.bars[detected.bars.length - 1].timestampIso
  ).getTime();
  const ageMinutes = (Date.now() - latestBarTs) / 60000;
  const marketState = ageMinutes <= tfCfg.maxAgeMinutes ? 'LIVE' : 'MARKET CLOSED';

  return {
    symbol,
    timeframe,
    source: `XM US100Cash# ${timeframe}`,
    marketState,
    fetchedAt: new Date().toISOString(),
    bars: detected.bars,
    segments: detected.segments,
    latestBearCisdLevel: detected.latestBearCisdLevel,
    latestBullCisdLevel: detected.latestBullCisdLevel,
    currentTrend: detected.currentTrend,
    lastSignalInfo: detected.lastSignalInfo,
  };
}

interface StreamOhlcBar {
  tsSec: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

const XM_BRIDGE_STALE_MS = 15000;

const xmBridgeState: {
  lastPushMs: number;
  broker: string;
  account: string;
  symbol: string;
  bid: number;
  ask: number;
  barsByTf: Record<CisdTimeframe, StreamOhlcBar[]>;
} = {
  lastPushMs: 0,
  broker: 'XM Global MT5',
  account: '',
  symbol: 'US100Cash#',
  bid: 0,
  ask: 0,
  barsByTf: { M5: [], M15: [] },
};

function isXmBridgeActive(): boolean {
  return (
    xmBridgeState.lastPushMs > 0 &&
    Date.now() - xmBridgeState.lastPushMs <= XM_BRIDGE_STALE_MS &&
    (xmBridgeState.barsByTf.M15.length >= 15 || xmBridgeState.barsByTf.M5.length >= 15)
  );
}

function getXmBridgeStatusSnapshot() {
  const now = Date.now();
  const connected = isXmBridgeActive();
  const ageSeconds =
    xmBridgeState.lastPushMs > 0 ? Math.max(0, Math.round((now - xmBridgeState.lastPushMs) / 1000)) : null;
  return {
    connected,
    lastPushAt: xmBridgeState.lastPushMs > 0 ? new Date(xmBridgeState.lastPushMs).toISOString() : null,
    ageSeconds,
    broker: xmBridgeState.broker,
    account: xmBridgeState.account,
    symbol: xmBridgeState.symbol,
    bid: xmBridgeState.bid,
    ask: xmBridgeState.ask,
    hasM5: xmBridgeState.barsByTf.M5.length >= 15,
    hasM15: xmBridgeState.barsByTf.M15.length >= 15,
  };
}

function buildCisdFeedFromBars(params: {
  symbol: TradingSymbol;
  timeframe: CisdTimeframe;
  rawBars: StreamOhlcBar[];
  source: string;
  feedProvider: 'xm_bridge' | 'cfd_ws';
  brokerSymbol?: string;
  livePrice?: number;
  livePriceTsSec?: number;
}): M15MarketFeedResult | null {
  const { symbol, timeframe, rawBars, source, feedProvider, brokerSymbol, livePrice, livePriceTsSec } =
    params;
  if (rawBars.length < 15) return null;

  const mapping = YAHOO_SYMBOL_MAP[symbol];
  const tfCfg = YAHOO_CISD_PARAMS[timeframe];
  const bucketSec = tfCfg.bucketMinutes * 60;

  const byBucket = new Map<number, StreamOhlcBar>();
  for (const b of rawBars) {
    if (
      !Number.isFinite(b.tsSec) ||
      !Number.isFinite(b.open) ||
      !Number.isFinite(b.high) ||
      !Number.isFinite(b.low) ||
      !Number.isFinite(b.close) ||
      b.close <= 0
    ) {
      continue;
    }
    const xmOffsetSec = getXmServerOffsetSeconds(b.tsSec);
    const xmTs = b.tsSec + xmOffsetSec;
    const bucketXmTs = Math.floor(xmTs / bucketSec) * bucketSec;
    const bucketUtcTs = bucketXmTs - xmOffsetSec;
    const existing = byBucket.get(bucketUtcTs);
    if (!existing) {
      byBucket.set(bucketUtcTs, {
        tsSec: bucketUtcTs,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
      });
    } else {
      existing.high = Math.max(existing.high, b.high);
      existing.low = Math.min(existing.low, b.low);
      existing.close = b.close;
    }
  }

  const sorted = [...byBucket.values()].sort((a, b) => a.tsSec - b.tsSec);
  if (sorted.length < 15) return null;

  // Fold live tick price onto current forming candle or open the newly rolled candle on boundary
  if (livePrice && Number.isFinite(livePrice) && livePrice > 0) {
    const tickSec = livePriceTsSec && livePriceTsSec > 0 ? livePriceTsSec : Math.floor(Date.now() / 1000);
    const xmOffsetSec = getXmServerOffsetSeconds(tickSec);
    const tickXmTs = tickSec + xmOffsetSec;
    const tickBucketXmTs = Math.floor(tickXmTs / bucketSec) * bucketSec;
    const tickBucketUtcTs = tickBucketXmTs - xmOffsetSec;
    const lastBar = sorted[sorted.length - 1];
    const lastXmTs = lastBar.tsSec + getXmServerOffsetSeconds(lastBar.tsSec);
    const lastBucketXmTs = Math.floor(lastXmTs / bucketSec) * bucketSec;

    if (tickBucketXmTs === lastBucketXmTs) {
      lastBar.close = livePrice;
      lastBar.high = Math.max(lastBar.high, livePrice);
      lastBar.low = Math.min(lastBar.low, livePrice);
    } else if (tickBucketXmTs > lastBucketXmTs && tickBucketXmTs - lastBucketXmTs <= bucketSec * 2) {
      sorted.push({
        tsSec: tickBucketUtcTs,
        open: lastBar.close,
        high: Math.max(lastBar.close, livePrice),
        low: Math.min(lastBar.close, livePrice),
        close: livePrice,
      });
    }
  }

  const recentSlice = sorted.slice(-110).map((b, idx) => {
    const dt = new Date(b.tsSec * 1000);
    return {
      index: idx,
      timeLabel: formatCisdTimeLabel(dt, timeframe),
      timestampIso: dt.toISOString(),
      open: roundTo(b.open, mapping.digits),
      high: roundTo(b.high, mapping.digits),
      low: roundTo(b.low, mapping.digits),
      close: roundTo(b.close, mapping.digits),
    };
  });

  if (recentSlice.length < 15) return null;

  const detected = detectCisdServer(recentSlice);
  const latestBarTs = new Date(detected.bars[detected.bars.length - 1].timestampIso).getTime();
  const ageMinutes = (Date.now() - latestBarTs) / 60000;
  const marketState =
    feedProvider === 'xm_bridge' || ageMinutes <= tfCfg.maxAgeMinutes ? 'LIVE' : 'MARKET CLOSED';

  return {
    symbol,
    timeframe,
    source,
    feedProvider,
    brokerSymbol,
    xmBridgeConnected: isXmBridgeActive(),
    cfdWsConnected: cfdStreamState.connected,
    marketState,
    fetchedAt: new Date().toISOString(),
    bars: detected.bars,
    segments: detected.segments,
    latestBearCisdLevel: detected.latestBearCisdLevel,
    latestBullCisdLevel: detected.latestBullCisdLevel,
    currentTrend: detected.currentTrend,
    lastSignalInfo: detected.lastSignalInfo,
  };
}

// Persistent Real-Time MT5 Forex CFD WebSocket Stream (zero Futures delay)
const CFD_BROKER_SYMBOLS = ['PEPPERSTONE:NAS100', 'BLACKBULL:NAS100', 'FOREXCOM:NAS100'] as const;

const cfdStreamState: {
  connected: boolean;
  brokerIndex: number;
  activeBrokerSymbol: string;
  lastMessageMs: number;
  lastTickMs: number;
  lastPrice: number;
  lastBid: number;
  lastAsk: number;
  lastTickSec: number;
  barsM5: Map<number, StreamOhlcBar>;
  barsM15: Map<number, StreamOhlcBar>;
  ws: any;
  reconnectTimer: NodeJS.Timeout | null;
} = {
  connected: false,
  brokerIndex: 0,
  activeBrokerSymbol: CFD_BROKER_SYMBOLS[0],
  lastMessageMs: 0,
  lastTickMs: 0,
  lastPrice: 0,
  lastBid: 0,
  lastAsk: 0,
  lastTickSec: 0,
  barsM5: new Map(),
  barsM15: new Map(),
  ws: null,
  reconnectTimer: null,
};

function packTvMessage(msg: string): string {
  return `~m~${msg.length}~m~${msg}`;
}

function sendTvPacket(ws: any, m: string, p: unknown[]) {
  if (!ws || ws.readyState !== 1) return;
  try {
    ws.send(packTvMessage(JSON.stringify({ m, p })));
  } catch {
    // Ignore write failure while closing
  }
}

function applyTvSeriesUpdate(targetMap: Map<number, StreamOhlcBar>, items: any[]) {
  if (!Array.isArray(items)) return;
  for (const item of items) {
    const v = item?.v;
    if (!Array.isArray(v) || v.length < 5) continue;
    const tsSec = Math.floor(Number(v[0]));
    const open = Number(v[1]);
    const high = Number(v[2]);
    const low = Number(v[3]);
    const close = Number(v[4]);
    if (
      !Number.isFinite(tsSec) ||
      !Number.isFinite(open) ||
      !Number.isFinite(high) ||
      !Number.isFinite(low) ||
      !Number.isFinite(close) ||
      close <= 0
    ) {
      continue;
    }
    targetMap.set(tsSec, { tsSec, open, high, low, close });
  }
  if (targetMap.size > 220) {
    const sortedKeys = [...targetMap.keys()].sort((a, b) => a - b);
    const removeCount = sortedKeys.length - 180;
    for (let i = 0; i < removeCount; i++) {
      targetMap.delete(sortedKeys[i]);
    }
  }
}

function scheduleCfdReconnect(delayMs = 1500, advanceBroker = false) {
  if (cfdStreamState.reconnectTimer) {
    clearTimeout(cfdStreamState.reconnectTimer);
  }
  if (advanceBroker) {
    cfdStreamState.brokerIndex = (cfdStreamState.brokerIndex + 1) % CFD_BROKER_SYMBOLS.length;
  }
  cfdStreamState.reconnectTimer = setTimeout(() => {
    cfdStreamState.reconnectTimer = null;
    connectCfdWebSocket();
  }, delayMs);
}

function connectCfdWebSocket() {
  const NodeWebSocket = (globalThis as any).WebSocket;
  if (typeof NodeWebSocket !== 'function') return;

  if (cfdStreamState.ws) {
    try {
      cfdStreamState.ws.close();
    } catch {
      // Ignore cleanup error
    }
    cfdStreamState.ws = null;
  }

  const sym = CFD_BROKER_SYMBOLS[cfdStreamState.brokerIndex] || CFD_BROKER_SYMBOLS[0];
  cfdStreamState.activeBrokerSymbol = sym;
  cfdStreamState.barsM5.clear();
  cfdStreamState.barsM15.clear();

  let ws: any;
  try {
    ws = new NodeWebSocket('wss://data.tradingview.com/socket.io/websocket?from=chart%2F', {
      headers: {
        Origin: 'https://www.tradingview.com',
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
      },
    });
  } catch {
    scheduleCfdReconnect(3000, true);
    return;
  }

  cfdStreamState.ws = ws;
  const suffix = Math.random().toString(36).slice(2, 8);
  const qs = `qs_${suffix}`;
  const cs5 = `cs5_${suffix}`;
  const cs15 = `cs15_${suffix}`;

  ws.onopen = () => {
    cfdStreamState.connected = true;
    cfdStreamState.lastMessageMs = Date.now();
    sendTvPacket(ws, 'set_auth_token', ['unauthorized_user_token']);
    sendTvPacket(ws, 'quote_create_session', [qs]);
    sendTvPacket(ws, 'quote_add_symbols', [qs, sym]);

    const resolvedSpec = `=${JSON.stringify({ symbol: sym, adjustment: 'splits' })}`;
    sendTvPacket(ws, 'chart_create_session', [cs5, '']);
    sendTvPacket(ws, 'resolve_symbol', [cs5, 'sds_sym_5', resolvedSpec]);
    sendTvPacket(ws, 'create_series', [cs5, 'sds_5', 's1', 'sds_sym_5', '5', 160, '']);

    sendTvPacket(ws, 'chart_create_session', [cs15, '']);
    sendTvPacket(ws, 'resolve_symbol', [cs15, 'sds_sym_15', resolvedSpec]);
    sendTvPacket(ws, 'create_series', [cs15, 'sds_15', 's1', 'sds_sym_15', '15', 140, '']);
  };

  ws.onmessage = (ev: any) => {
    const raw = String(ev?.data || '');
    cfdStreamState.lastMessageMs = Date.now();

    let pos = 0;
    while (pos < raw.length) {
      if (!raw.startsWith('~m~', pos)) break;
      const mEnd = raw.indexOf('~m~', pos + 3);
      if (mEnd < 0) break;
      const len = parseInt(raw.slice(pos + 3, mEnd), 10);
      if (!Number.isFinite(len) || len <= 0) break;
      const bodyStart = mEnd + 3;
      const body = raw.slice(bodyStart, bodyStart + len);
      pos = bodyStart + len;

      if (body.startsWith('~h~')) {
        try {
          ws.send(packTvMessage(body));
        } catch {
          // Ignore echo failure
        }
        continue;
      }

      try {
        const msg = JSON.parse(body) as { m?: string; p?: any[] };
        if (msg.m === 'qsd' && Array.isArray(msg.p) && msg.p[1]?.v) {
          const v = msg.p[1].v as { lp?: number; bid?: number; ask?: number; lp_time?: number };
          const nextBid = Number(v.bid);
          const nextAsk = Number(v.ask);
          const nextLp = Number(v.lp);
          if (Number.isFinite(nextBid) && nextBid > 0) cfdStreamState.lastBid = nextBid;
          if (Number.isFinite(nextAsk) && nextAsk > 0) cfdStreamState.lastAsk = nextAsk;
          const chosen =
            Number.isFinite(nextBid) && nextBid > 0
              ? nextBid
              : Number.isFinite(nextLp) && nextLp > 0
              ? nextLp
              : 0;
          if (chosen > 0) {
            cfdStreamState.lastPrice = chosen;
            cfdStreamState.lastTickMs = Date.now();
            cfdStreamState.lastTickSec =
              Number.isFinite(Number(v.lp_time)) && Number(v.lp_time) > 0
                ? Math.floor(Number(v.lp_time))
                : Math.floor(Date.now() / 1000);
          }
        } else if ((msg.m === 'timescale_update' || msg.m === 'du') && Array.isArray(msg.p)) {
          const payload = msg.p[1] || {};
          if (payload.sds_5?.s) {
            applyTvSeriesUpdate(cfdStreamState.barsM5, payload.sds_5.s);
          }
          if (payload.sds_15?.s) {
            applyTvSeriesUpdate(cfdStreamState.barsM15, payload.sds_15.s);
          }
        } else if (msg.m === 'symbol_error' || msg.m === 'series_error') {
          scheduleCfdReconnect(1500, true);
          return;
        }
      } catch {
        // Ignore non-JSON control payloads
      }
    }
  };

  ws.onerror = () => {
    cfdStreamState.connected = false;
  };

  ws.onclose = () => {
    cfdStreamState.connected = false;
    if (cfdStreamState.ws === ws) {
      cfdStreamState.ws = null;
      scheduleCfdReconnect(2000, false);
    }
  };
}

connectCfdWebSocket();

setInterval(() => {
  if (cfdStreamState.connected && Date.now() - cfdStreamState.lastMessageMs > 30000) {
    cfdStreamState.connected = false;
    scheduleCfdReconnect(1000, true);
  }
}, 10000);

function getCfdStreamBars(timeframe: CisdTimeframe): StreamOhlcBar[] {
  const sourceMap = timeframe === 'M5' ? cfdStreamState.barsM5 : cfdStreamState.barsM15;
  return [...sourceMap.values()].sort((a, b) => a.tsSec - b.tsSec);
}

async function getLiveCisdFeed(
  symbol: TradingSymbol,
  timeframe: CisdTimeframe = 'M15',
  forceFresh = false
): Promise<M15MarketFeedResult> {
  // Priority 1: XM MT5 Live Bridge EA (100% matching XM US100Cash# bars & Bid price)
  if (isXmBridgeActive()) {
    const rawBridgeBars = xmBridgeState.barsByTf[timeframe];

    const bridgeFeed = buildCisdFeedFromBars({
      symbol,
      timeframe,
      rawBars: rawBridgeBars,
      source: `XM MT5 Live Bridge (${xmBridgeState.symbol})`,
      feedProvider: 'xm_bridge',
      brokerSymbol: xmBridgeState.symbol,
      livePrice: xmBridgeState.bid > 0 ? xmBridgeState.bid : undefined,
      livePriceTsSec: Math.floor(xmBridgeState.lastPushMs / 1000),
    });
    if (bridgeFeed) {
      return bridgeFeed;
    }
  }

  // Priority 2: Real-Time Forex/MT5 CFD WebSocket Stream (NAS100 Cash, zero 10m delay)
  const cfdRawBars = getCfdStreamBars(timeframe);
  if (cfdRawBars.length >= 20) {
    const cfdLivePrice = cfdStreamState.lastBid > 0 ? cfdStreamState.lastBid : cfdStreamState.lastPrice;
    const cfdFeed = buildCisdFeedFromBars({
      symbol,
      timeframe,
      rawBars: cfdRawBars,
      source: `MT5 Forex CFD · NAS100 Cash (${cfdStreamState.activeBrokerSymbol})`,
      feedProvider: 'cfd_ws',
      brokerSymbol: cfdStreamState.activeBrokerSymbol,
      livePrice:
        cfdLivePrice > 0 && Date.now() - cfdStreamState.lastTickMs <= 120000
          ? cfdLivePrice
          : undefined,
      livePriceTsSec: cfdStreamState.lastTickSec,
    });
    if (cfdFeed) {
      return cfdFeed;
    }
  }

  // Priority 3: Yahoo calibrated fallback
  const cacheKey = `${symbol}:${timeframe}`;
  const bucketMs = YAHOO_CISD_PARAMS[timeframe].bucketMinutes * 60 * 1000;
  const nowMs = Date.now();
  const cached = cisdFeedCache.get(cacheKey);
  if (
    !forceFresh &&
    cached &&
    cached.expiresAt > nowMs &&
    Math.floor(cached.fetchedAtMs / bucketMs) === Math.floor(nowMs / bucketMs)
  ) {
    return cached.data;
  }

  const data = await fetchYahooCisd(symbol, timeframe);
  const enriched: M15MarketFeedResult = {
    ...data,
    feedProvider: 'yahoo_fallback',
    xmBridgeConnected: isXmBridgeActive(),
    cfdWsConnected: cfdStreamState.connected,
  };
  const fetchedAtMs = Date.now();
  cisdFeedCache.set(cacheKey, {
    expiresAt: fetchedAtMs + YAHOO_CISD_PARAMS[timeframe].cacheMs,
    fetchedAtMs,
    data: enriched,
  });
  return enriched;
}

async function getLiveM15Feed(symbol: TradingSymbol): Promise<M15MarketFeedResult> {
  return getLiveCisdFeed(symbol, 'M15');
}

async function getLiveTick(symbol: TradingSymbol): Promise<MarketTickResult> {
  const mapping = YAHOO_SYMBOL_MAP[symbol];

  // Priority 1: XM MT5 Live Bridge tick
  if (isXmBridgeActive() && xmBridgeState.bid > 0) {
    return {
      symbol,
      price: roundTo(xmBridgeState.bid, mapping.digits),
      bid: roundTo(xmBridgeState.bid, mapping.digits),
      ask: xmBridgeState.ask > 0 ? roundTo(xmBridgeState.ask, mapping.digits) : undefined,
      source: `XM MT5 Live Bridge (${xmBridgeState.symbol})`,
      feedProvider: 'xm_bridge',
      xmBridgeConnected: true,
      cfdWsConnected: cfdStreamState.connected,
      marketState: 'LIVE',
      fetchedAt: new Date().toISOString(),
    };
  }

  // Priority 2: Real-Time Forex/MT5 CFD WebSocket tick
  const cfdPrice = cfdStreamState.lastBid > 0 ? cfdStreamState.lastBid : cfdStreamState.lastPrice;
  if (cfdPrice > 0 && Date.now() - cfdStreamState.lastTickMs <= 60000) {
    return {
      symbol,
      price: roundTo(cfdPrice, mapping.digits),
      bid: cfdStreamState.lastBid > 0 ? roundTo(cfdStreamState.lastBid, mapping.digits) : undefined,
      ask: cfdStreamState.lastAsk > 0 ? roundTo(cfdStreamState.lastAsk, mapping.digits) : undefined,
      source: `MT5 Forex CFD · NAS100 Cash (${cfdStreamState.activeBrokerSymbol})`,
      feedProvider: 'cfd_ws',
      xmBridgeConnected: isXmBridgeActive(),
      cfdWsConnected: cfdStreamState.connected,
      marketState: 'LIVE',
      fetchedAt: new Date().toISOString(),
    };
  }

  const cached = tickCache.get(symbol);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  const { cashBasis, qqqRatio } = await getLiveMarketCalibration();

  if (symbol === 'US100') {
    const tailData = await fetchRealtimeTailData(qqqRatio);
    if (tailData.liveMeta) {
      const tickData: MarketTickResult = {
        symbol,
        price: roundTo(tailData.liveMeta.price, mapping.digits),
        source: 'XM US100Cash# Fallback',
        feedProvider: 'yahoo_fallback',
        xmBridgeConnected: isXmBridgeActive(),
        cfdWsConnected: cfdStreamState.connected,
        marketState: 'LIVE',
        fetchedAt: new Date().toISOString(),
      };
      tickCache.set(symbol, {
        expiresAt: Date.now() + 900,
        data: tickData,
      });
      return tickData;
    }
  }

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    mapping.ticker
  )}?interval=1m&range=1d&includePrePost=true`;

  const res = await fetch(url, {
    headers: YAHOO_HEADERS,
    signal: AbortSignal.timeout(5000),
  });

  if (!res.ok) {
    throw new Error(`Tick feed HTTP ${res.status}`);
  }

  const json = (await res.json()) as any;
  const result = json?.chart?.result?.[0];
  const meta = result?.meta || {};
  const timestamps: number[] = result?.timestamp || [];
  const closes: Array<number | null> = result?.indicators?.quote?.[0]?.close || [];

  let lastBarClose: number | null = null;
  for (let i = closes.length - 1; i >= 0; i--) {
    if (closes[i] != null) {
      lastBarClose = Number(closes[i]);
      break;
    }
  }

  const rawPrice = Number(meta.regularMarketPrice ?? lastBarClose ?? 0) - cashBasis;
  if (!Number.isFinite(rawPrice) || rawPrice <= 0) {
    throw new Error('ไม่มีราคาล่าสุดจากตลาดจริง');
  }

  const latestTs = timestamps.length > 0 ? timestamps[timestamps.length - 1] * 1000 : Date.now();
  const ageMin = (Date.now() - latestTs) / 60000;
  const marketState = ageMin <= 20 ? 'LIVE' : 'MARKET CLOSED';

  const tickData: MarketTickResult = {
    symbol,
    price: roundTo(rawPrice, mapping.digits),
    source: 'XM US100Cash# Fallback',
    feedProvider: 'yahoo_fallback',
    xmBridgeConnected: isXmBridgeActive(),
    cfdWsConnected: cfdStreamState.connected,
    marketState,
    fetchedAt: new Date().toISOString(),
  };

  tickCache.set(symbol, {
    expiresAt: Date.now() + 900,
    data: tickData,
  });
  return tickData;
}

async function sendNtfyPush(topicOrUrl: string, title: string, body: string): Promise<boolean> {
  const trimmed = topicOrUrl.trim();
  if (!trimmed) return false;
  const endpoint =
    trimmed.startsWith('http://') || trimmed.startsWith('https://')
      ? trimmed
      : `https://ntfy.sh/${encodeURIComponent(trimmed)}`;

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Title: title,
        Priority: 'high',
        Tags: 'chart_with_upwards_trend',
      },
      body,
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function formatSignedAo(val: number): string {
  const fixed = val.toFixed(3);
  return val > 0 ? `+${fixed}` : fixed;
}

function escapeTelegramHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatTelegramSignalMessage(params: {
  symbol: string;
  timeframe: string;
  strategy?: 'AO' | 'CISD';
  signal: 'BUY' | 'SELL';
  aoPrev: number;
  aoCurr: number;
  price?: number;
  cisdLevel?: number | null;
  mode: 'live' | 'sim';
  timestampIso?: string;
}): string {
  const badge = params.signal === 'BUY' ? '🟢 BUY' : '🔴 SELL';
  const modeLabel = params.mode === 'live' ? 'กราฟจริง' : 'แบบจำลอง';
  const timeDate = params.timestampIso ? new Date(params.timestampIso) : new Date();
  const timeText = timeDate.toLocaleTimeString('th-TH', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Asia/Bangkok',
  });

  if (params.strategy === 'CISD') {
    const condition =
      params.signal === 'SELL'
        ? 'ราคาปิดต่ำกว่าระดับ CISD 🔴⬇️'
        : 'ราคาปิดเหนือระดับ CISD 🟢⬆️';
    const priceText =
      typeof params.price === 'number' && Number.isFinite(params.price)
        ? params.price.toFixed(2)
        : '-';
    const cisdText =
      typeof params.cisdLevel === 'number' && Number.isFinite(params.cisdLevel)
        ? params.cisdLevel.toFixed(2)
        : '-';

    return [
      `<b>${badge} · CISD  |  ${escapeTelegramHtml(params.symbol)} (${escapeTelegramHtml(params.timeframe)})</b>`,
      '──────────────',
      `เงื่อนไข: ${condition}`,
      `ราคาปิดแท่ง: ${priceText}`,
      `ระดับ CISD: ${cisdText}`,
      `โหมด: ${modeLabel}`,
      `เวลาปิดแท่ง: ${timeText} น.`,
    ].join('\n');
  }

  const condition =
    params.signal === 'BUY'
      ? '⚡ AO ตัดเส้น 0 ขึ้น ทันที 🟢⬆️'
      : '⚡ AO ตัดเส้น 0 ลง ทันที 🔴⬇️';
  const priceLine =
    typeof params.price === 'number' && Number.isFinite(params.price) && params.price > 0
      ? `ราคาปัจจุบัน: ${params.price.toFixed(2)}`
      : null;

  return [
    `<b>${badge}  ·  ${escapeTelegramHtml(params.symbol)} (${escapeTelegramHtml(params.timeframe)})</b>`,
    '──────────────',
    `เงื่อนไข: ${condition}`,
    `ค่า AO: ${formatSignedAo(params.aoPrev)} → ${formatSignedAo(params.aoCurr)}`,
    ...(priceLine ? [priceLine] : []),
    `โหมด: ${modeLabel}`,
    `เวลา: ${timeText} น.`,
  ].join('\n');
}

function sanitizeTelegramToken(botToken: string): string {
  return botToken.trim().replace(/[^0-9A-Za-z:_-]/g, '');
}

async function fetchTelegramBotInfo(botToken: string): Promise<{
  ok: boolean;
  username?: string;
  botUrl?: string;
  error?: string;
}> {
  const cleanToken = sanitizeTelegramToken(botToken);
  if (!cleanToken) return { ok: false, error: 'กรุณากรอก Bot Token' };
  try {
    const res = await fetch(`https://api.telegram.org/bot${cleanToken}/getMe`, {
      signal: AbortSignal.timeout(6000),
    });
    const json = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      result?: { username?: string };
      description?: string;
    };
    if (!res.ok || !json.ok || !json.result?.username) {
      return {
        ok: false,
        error:
          res.status === 401
            ? 'Bot Token ไม่ถูกต้อง กรุณาตรวจสอบ Token จาก @BotFather'
            : json.description || `Telegram HTTP ${res.status}`,
      };
    }
    return {
      ok: true,
      username: json.result.username,
      botUrl: `https://t.me/${json.result.username}`,
    };
  } catch (err: any) {
    return { ok: false, error: err?.message || 'เชื่อมต่อ Telegram API ไม่สำเร็จ' };
  }
}

async function sendTelegramPush(
  botToken: string,
  chatId: string,
  text: string,
  parseMode?: 'HTML'
): Promise<{ ok: boolean; error?: string; botUrl?: string; botUsername?: string }> {
  const token = sanitizeTelegramToken(botToken);
  const chat = chatId.trim();
  if (!token || !chat) {
    return { ok: false, error: 'กรุณากรอก Bot Token และ Chat ID ของ Telegram' };
  }

  // Reject obvious bot username mistyped as personal Chat ID
  if (!/^-?\d+$/.test(chat) && !chat.startsWith('@')) {
    const info = await fetchTelegramBotInfo(token);
    return {
      ok: false,
      botUrl: info.botUrl,
      botUsername: info.username,
      error: `Chat ID "${chat}" ไม่ใช่ตัวเลขบัญชีผู้ใช้ (Chat ID ต้องเป็นตัวเลข เช่น 123456789) — กรุณาเปิดแชทบอทใน Telegram กด Start แล้วกดปุ่ม "ดึง Chat ID อัตโนมัติ"`,
    };
  }

  try {
    const res = await fetch(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chat,
          text,
          ...(parseMode ? { parse_mode: parseMode } : {}),
        }),
        signal: AbortSignal.timeout(6000),
      }
    );
    if (!res.ok) {
      const errBody = (await res.json().catch(() => ({}))) as { description?: string };
      const rawDesc = errBody.description || `Telegram HTTP ${res.status}`;
      const info = await fetchTelegramBotInfo(token);

      if (rawDesc.toLowerCase().includes('chat not found')) {
        return {
          ok: false,
          botUrl: info.botUrl,
          botUsername: info.username,
          error: `ไม่พบแชท (${chat}) — ต้องเข้าไปกดปุ่ม Start ในแชทบอทก่อน และตรวจสอบว่าเป็น Chat ID ตัวเลขที่ถูกต้อง`,
        };
      }
      if (rawDesc.toLowerCase().includes('blocked')) {
        return {
          ok: false,
          botUrl: info.botUrl,
          botUsername: info.username,
          error: 'บอทถูกบล็อกในแชทนี้ กรุณาปลดบล็อกและกด Start ในแชทบอทอีกครั้ง',
        };
      }
      if (res.status === 401) {
        return {
          ok: false,
          error: 'Bot Token ไม่ถูกต้อง กรุณาคัดลอก Token จาก @BotFather ใหม่อีกครั้ง',
        };
      }
      return {
        ok: false,
        botUrl: info.botUrl,
        botUsername: info.username,
        error: rawDesc,
      };
    }
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message || 'เชื่อมต่อ Telegram API ไม่สำเร็จ' };
  }
}

async function broadcastWebPush(payload: {
  title: string;
  body: string;
  tag: string;
  url: string;
}): Promise<number> {
  if (persisted.subscriptions.length === 0) return 0;

  let delivered = 0;
  const deadEndpoints = new Set<string>();
  const jsonPayload = JSON.stringify(payload);

  await Promise.all(
    persisted.subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(sub as webpushTypes.PushSubscription, jsonPayload);
        delivered++;
      } catch (err: any) {
        const status = err?.statusCode;
        if (status === 404 || status === 410) {
          deadEndpoints.add(sub.endpoint);
        }
      }
    })
  );

  if (deadEndpoints.size > 0) {
    persisted.subscriptions = persisted.subscriptions.filter(
      (s) => !deadEndpoints.has(s.endpoint)
    );
    syncPersistence();
  }

  return delivered;
}

async function runBackgroundMonitorCycle() {
  if ((!persisted.enabled && !persisted.m15Enabled) || monitorRuntime.isRunningCycle) return;
  monitorRuntime.isRunningCycle = true;
  monitorRuntime.lastCheckedMs = Date.now();
  monitorRuntime.lastCheckedAt = new Date().toISOString();

  try {
    for (const sym of persisted.symbols) {
      if (persisted.enabled) {
        const aoTargets: AoTimeframe[] = ['M5'];

        for (const aoTf of aoTargets) {
          try {
            const feed = await getLiveAoFeed(sym, aoTf);
            const bars = feed.bars;
            if (bars.length >= 3) {
              const maxAge = YAHOO_AO_PARAMS[aoTf].maxAgeMinutes;
              // Check running forming bar [0] immediately if aoImmediateCross is true, plus closed bar [1] fallback
              const candidatePairs: Array<{ curr: M5Candle; prev: M5Candle }> = [];
              if (persisted.aoImmediateCross) {
                candidatePairs.push({
                  curr: bars[bars.length - 1],
                  prev: bars[bars.length - 2],
                });
              }
              candidatePairs.push({
                curr: bars[bars.length - 2],
                prev: bars[bars.length - 3],
              });

              for (const { curr, prev } of candidatePairs) {
                if (!curr || !prev || !curr.signal) continue;
                const barAgeMinutes =
                  (Date.now() - new Date(curr.timestampIso).getTime()) / 60000;
                const dirMatch =
                  persisted.direction === 'both' ||
                  (persisted.direction === 'buy_only' && curr.signal === 'BUY') ||
                  (persisted.direction === 'sell_only' && curr.signal === 'SELL');

                if (barAgeMinutes > maxAge || !dirMatch) continue;

                const dedupeKey = `live-${aoTf}-AO-${sym}-${curr.timestampIso}-${curr.signal}`;
                if (monitorRuntime.dispatchedLiveSignalKeys.has(dedupeKey)) continue;
                markLiveSignalDispatched(dedupeKey);

                const title = `AO ${aoTf} ${curr.signal}: ${sym}`;
                const body = `${sym} ${aoTf} ${curr.signal} | AO ${prev.ao.toFixed(
                  3
                )} → ${curr.ao.toFixed(3)} | ราคา ${curr.close}`;

                const [deliveredWebPushCount, deliveredToNtfy] = await Promise.all([
                  broadcastWebPush({
                    title,
                    body,
                    tag: `ao-${aoTf}-${sym}-${curr.timestampIso}-${curr.signal}`,
                    url: '/',
                  }),
                  persisted.ntfyTopic
                    ? sendNtfyPush(persisted.ntfyTopic, title, body)
                    : Promise.resolve(false),
                ]);

                const shouldSendTelegram =
                  Boolean(persisted.telegramBotToken && persisted.telegramChatId) &&
                  (persisted.telegramMode === 'always' || deliveredWebPushCount === 0);

                const tgRes = shouldSendTelegram
                  ? await sendTelegramPush(
                      persisted.telegramBotToken,
                      persisted.telegramChatId,
                      formatTelegramSignalMessage({
                        symbol: sym,
                        timeframe: aoTf,
                        strategy: 'AO',
                        signal: curr.signal,
                        aoPrev: prev.ao,
                        aoCurr: curr.ao,
                        price: curr.close,
                        mode: 'live',
                        timestampIso: curr.timestampIso,
                      }),
                      'HTML'
                    )
                  : { ok: false };

                persisted.events.unshift({
                  id: `${aoTf}-${sym}-${curr.timestampIso}-${curr.signal}`,
                  timestamp: new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' }),
                  symbol: sym,
                  timeframe: aoTf,
                  strategy: 'AO',
                  signal: curr.signal,
                  aoPrev: prev.ao,
                  aoCurr: curr.ao,
                  price: curr.close,
                  deliveredToNtfy,
                  deliveredToTelegram: tgRes.ok,
                  deliveredWebPushCount,
                });
                persisted.events = persisted.events.slice(0, 30);
                syncPersistence();
                scheduleGithubAutoSync('signal-event', 1000);
              }
            }
          } catch {
            // Keep polling remaining AO timeframes
          }
        }
      }

      if (persisted.m15Enabled) {
        const cisdTargets =
          persisted.cisdTimeframes.length > 0
            ? persisted.cisdTimeframes
            : CISD_TIMEFRAME_ORDER;

        for (const cisdTf of cisdTargets) {
          if (cisdTf !== 'M15') continue;
          try {
            const cisdFeed = await getLiveCisdFeed(sym, cisdTf);
            const cisdBars = cisdFeed.bars;
            if (cisdBars.length >= 4) {
              const latestBarMs = new Date(
                cisdBars[cisdBars.length - 1].timestampIso
              ).getTime();
              const maxAge = YAHOO_CISD_PARAMS[cisdTf].maxAgeMinutes;
              // Check both the newly closed bar [n-2] and immediate prior closed bar [n-3]
              // so brief polls/wake-ups never miss a freshly closed CISD candle break.
              const candidateClosedBars = [
                cisdBars[cisdBars.length - 2],
                cisdBars[cisdBars.length - 3],
              ];

              for (const closedBar of candidateClosedBars) {
                if (!closedBar || !closedBar.cisdSignal) continue;
                const barMs = new Date(closedBar.timestampIso).getTime();
                const feedRelMinutes = (latestBarMs - barMs) / 60000;
                const wallAgeMinutes = (Date.now() - barMs) / 60000;
                const dirMatch =
                  persisted.m15Direction === 'both' ||
                  (persisted.m15Direction === 'buy_only' && closedBar.cisdSignal === 'BUY') ||
                  (persisted.m15Direction === 'sell_only' && closedBar.cisdSignal === 'SELL');

                const eventId = `${cisdTf}-CISD-${sym}-${closedBar.timestampIso}-${closedBar.cisdSignal}`;
                const legacyEventId = `${cisdTf}-${sym}-${closedBar.timestampIso}-${closedBar.cisdSignal}`;
                const dedupeKey = `live-${eventId}`;
                const alreadyRecorded = persisted.events.some(
                  (e) => e.id === eventId || e.id === legacyEventId
                );

                if (
                  feedRelMinutes <= maxAge &&
                  wallAgeMinutes <= 360 &&
                  dirMatch &&
                  !alreadyRecorded &&
                  !monitorRuntime.dispatchedLiveSignalKeys.has(dedupeKey)
                ) {
                  markLiveSignalDispatched(dedupeKey);
                  const condLabel =
                    closedBar.cisdSignal === 'SELL'
                      ? 'ปิดต่ำกว่าระดับ CISD'
                      : 'ปิดเหนือระดับ CISD';
                  const cisdTxt =
                    closedBar.cisdLevel !== null ? closedBar.cisdLevel.toFixed(2) : '-';
                  const title = `CISD ${cisdTf} ${closedBar.cisdSignal}: ${sym}`;
                  const body = `${sym} ${cisdTf} ${condLabel} | ปิด ${closedBar.close.toFixed(
                    2
                  )} (CISD ${cisdTxt})`;

                  const [deliveredWebPushCount, deliveredToNtfy] = await Promise.all([
                    broadcastWebPush({
                      title,
                      body,
                      tag: `cisd-${cisdTf}-${sym}-${closedBar.timestampIso}-${closedBar.cisdSignal}`,
                      url: `/?tf=${cisdTf}`,
                    }),
                    persisted.ntfyTopic
                      ? sendNtfyPush(persisted.ntfyTopic, title, body)
                      : Promise.resolve(false),
                  ]);

                  const shouldSendTelegram =
                    Boolean(persisted.telegramBotToken && persisted.telegramChatId) &&
                    (persisted.telegramMode === 'always' || deliveredWebPushCount === 0);

                  const tgRes = shouldSendTelegram
                    ? await sendTelegramPush(
                        persisted.telegramBotToken,
                        persisted.telegramChatId,
                        formatTelegramSignalMessage({
                          symbol: sym,
                          timeframe: cisdTf,
                          strategy: 'CISD',
                          signal: closedBar.cisdSignal,
                          aoPrev: 0,
                          aoCurr: 0,
                          price: closedBar.close,
                          cisdLevel: closedBar.cisdLevel,
                          mode: 'live',
                          timestampIso: closedBar.timestampIso,
                        }),
                        'HTML'
                      )
                    : { ok: false, error: undefined };

                  persisted.events.unshift({
                    id: eventId,
                    timestamp: new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' }),
                    symbol: sym,
                    timeframe: cisdTf,
                    strategy: 'CISD',
                    signal: closedBar.cisdSignal,
                    aoPrev: 0,
                    aoCurr: 0,
                    cisdLevel: closedBar.cisdLevel,
                    price: closedBar.close,
                    deliveredToNtfy,
                    deliveredToTelegram: tgRes.ok,
                    deliveredWebPushCount,
                    ...(tgRes.error ? { telegramError: tgRes.error } : {}),
                  });
                  persisted.events = persisted.events.slice(0, 30);
                  syncPersistence();
                  scheduleGithubAutoSync('signal-event', 1000);
                }
              }
            }
          } catch {
            // Keep polling remaining CISD timeframes
          }
        }
      }
    }
  } finally {
    monitorRuntime.isRunningCycle = false;
  }
}

setInterval(() => {
  void runBackgroundMonitorCycle();
}, 2000);

setTimeout(() => {
  void runBackgroundMonitorCycle();
}, 1200);

function generateXmLiveBridgeEaCode(ingestUrl: string): string {
  return `//+------------------------------------------------------------------+
//|                                       XM_MT5_LiveBridge_EA.mq5   |
//|         Real-Time XM US100Cash# -> Web CISD 2-Second Live Bridge |
//+------------------------------------------------------------------+
// วิธีติดตั้งบน MetaTrader 5 (XM):
// 1. เปิด MT5 -> Tools -> Options -> Expert Advisors
// 2. ติ๊ก "Allow WebRequest for listed URL:" แล้วเพิ่ม URL นี้:
//    ${ingestUrl}
// 3. นำไฟล์นี้ไปวางใน MQL5\\Experts แล้วลากใส่กราฟ US100Cash# (TF ใดก็ได้)
// 4. ระบบจะส่งแท่งเทียน M15 และราคา Bid/Ask จาก XM เข้าเว็บทุกๆ 2 วินาที
//+------------------------------------------------------------------+
#property copyright "Cisd เตือน"
#property version   "1.00"
#property strict

input string InpIngestUrl     = "${ingestUrl}";
input int    InpIntervalSec   = 2;
input int    InpBarsToSend    = 120;

int OnInit()
{
   EventSetTimer(MathMax(1, InpIntervalSec));
   PushMarketSnapshot();
   return(INIT_SUCCEEDED);
}

void OnDeinit(const int reason)
{
   EventKillTimer();
}

void OnTick()
{
   // Timer handles deterministic 2-second streaming cleanly without flooding
}

void OnTimer()
{
   PushMarketSnapshot();
}

string BuildRatesJson(ENUM_TIMEFRAMES tf, long serverOffsetSec, int count)
{
   MqlRates rates[];
   ArraySetAsSeries(rates, false);
   int copied = CopyRates(_Symbol, tf, 0, count, rates);
   if(copied <= 0) return "[]";

   int digits = (int)SymbolInfoInteger(_Symbol, SYMBOL_DIGITS);
   string out = "[";
   for(int i = 0; i < copied; i++)
   {
      if(i > 0) out += ",";
      long utcSec = (long)rates[i].time - serverOffsetSec;
      out += StringFormat(
         "{\\"time\\":%I64d,\\"open\\":%.*f,\\"high\\":%.*f,\\"low\\":%.*f,\\"close\\":%.*f}",
         utcSec,
         digits, rates[i].open,
         digits, rates[i].high,
         digits, rates[i].low,
         digits, rates[i].close
      );
   }
   out += "]";
   return out;
}

void PushMarketSnapshot()
{
   double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   if(bid <= 0) return;

   int digits = (int)SymbolInfoInteger(_Symbol, SYMBOL_DIGITS);
   long serverOffsetSec = (long)(TimeCurrent() - TimeGMT());
   string broker = AccountInfoString(ACCOUNT_COMPANY);
   string m5Json  = BuildRatesJson(PERIOD_M5,  serverOffsetSec, InpBarsToSend);
   string m15Json = BuildRatesJson(PERIOD_M15, serverOffsetSec, InpBarsToSend);

   string payload = StringFormat(
      "{\\"broker\\":\\"%s\\",\\"symbol\\":\\"%s\\",\\"bid\\":%.*f,\\"ask\\":%.*f,\\"barsM5\\":%s,\\"barsM15\\":%s}",
      broker,
      _Symbol,
      digits, bid,
      digits, ask,
      m5Json,
      m15Json
   );

   char data[];
   char result[];
   string headers = "Content-Type: application/json\\r\\n";
   string resHeaders = "";
   StringToCharArray(payload, data, 0, StringLen(payload), CP_UTF8);
   ResetLastError();
   WebRequest("POST", InpIngestUrl, headers, 1500, data, result, resHeaders);
}
//+------------------------------------------------------------------+
`;
}

function parseBridgeBarsInput(rawList: unknown, serverOffsetSec = 0): StreamOhlcBar[] {
  if (!Array.isArray(rawList)) return [];
  const parsed: StreamOhlcBar[] = [];
  for (const item of rawList) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    let tsSec = Number(rec.time ?? rec.tsSec ?? rec.timestamp);
    if (!Number.isFinite(tsSec) && typeof rec.timestampIso === 'string') {
      tsSec = Math.floor(new Date(rec.timestampIso).getTime() / 1000);
    }
    if (tsSec > 1e12) tsSec = Math.floor(tsSec / 1000);
    tsSec = Math.floor(tsSec - serverOffsetSec);
    const open = Number(rec.open);
    const high = Number(rec.high);
    const low = Number(rec.low);
    const close = Number(rec.close);
    if (
      !Number.isFinite(tsSec) ||
      tsSec <= 0 ||
      !Number.isFinite(open) ||
      !Number.isFinite(high) ||
      !Number.isFinite(low) ||
      !Number.isFinite(close) ||
      close <= 0
    ) {
      continue;
    }
    parsed.push({ tsSec, open, high, low, close });
  }
  return parsed.sort((a, b) => a.tsSec - b.tsSec);
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  app.get('/api/mt5/bridge-status', (_req, res) => {
    res.json({
      ...getXmBridgeStatusSnapshot(),
      cfdStream: {
        connected: cfdStreamState.connected,
        brokerSymbol: cfdStreamState.activeBrokerSymbol,
        lastTickAt:
          cfdStreamState.lastTickMs > 0 ? new Date(cfdStreamState.lastTickMs).toISOString() : null,
        lastPrice: cfdStreamState.lastPrice,
      },
    });
  });

  app.get('/api/mt5/bridge-ea', (req, res) => {
    const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https')
      .split(',')[0]
      .trim();
    const host = String(req.headers['x-forwarded-host'] || req.get('host') || 'localhost:3000')
      .split(',')[0]
      .trim();
    const ingestUrl = `${proto}://${host}/api/mt5/ingest`;
    const code = generateXmLiveBridgeEaCode(ingestUrl);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="XM_MT5_LiveBridge_EA.mq5"');
    res.send(code);
  });

  app.post('/api/mt5/ingest', (req, res) => {
    const body = req.body || {};
    const bid = Number(body.bid ?? body.price ?? 0);
    const ask = Number(body.ask ?? 0);
    const serverOffsetSec = Number.isFinite(Number(body.serverOffsetSec))
      ? Number(body.serverOffsetSec)
      : 0;
    const parsedM5 = parseBridgeBarsInput(
      body.barsM5 ?? (String(body.timeframe || '').toUpperCase() === 'M5' ? body.bars : undefined),
      serverOffsetSec
    );
    const parsedM15 = parseBridgeBarsInput(
      body.barsM15 ?? (String(body.timeframe || '').toUpperCase() === 'M15' ? body.bars : undefined),
      serverOffsetSec
    );

    if ((!Number.isFinite(bid) || bid <= 0) && parsedM15.length === 0 && parsedM5.length === 0) {
      res.status(400).json({ error: 'กรุณาส่งข้อมูลราคา bid หรือแท่งเทียนจาก MT5' });
      return;
    }

    xmBridgeState.lastPushMs = Date.now();
    if (typeof body.broker === 'string' && body.broker.trim()) {
      xmBridgeState.broker = body.broker.trim();
    }
    if (typeof body.account === 'string' && body.account.trim()) {
      xmBridgeState.account = body.account.trim();
    }
    if (typeof body.symbol === 'string' && body.symbol.trim()) {
      xmBridgeState.symbol = body.symbol.trim();
    }
    if (Number.isFinite(bid) && bid > 0) xmBridgeState.bid = bid;
    if (Number.isFinite(ask) && ask > 0) xmBridgeState.ask = ask;
    if (parsedM5.length >= 15) xmBridgeState.barsByTf.M5 = parsedM5.slice(-160);
    if (parsedM15.length >= 15) xmBridgeState.barsByTf.M15 = parsedM15.slice(-140);

    cisdFeedCache.clear();
    tickCache.clear();

    if (persisted.m15Enabled) {
      void runBackgroundMonitorCycle();
    }

    res.json({
      ok: true,
      connected: true,
      symbol: xmBridgeState.symbol,
      bid: xmBridgeState.bid,
      m5Bars: xmBridgeState.barsByTf.M5.length,
      m15Bars: xmBridgeState.barsByTf.M15.length,
    });
  });

  app.get('/api/health', async (_req, res) => {
    if (
      (persisted.enabled || persisted.m15Enabled) &&
      Date.now() - monitorRuntime.lastCheckedMs > 20000
    ) {
      void runBackgroundMonitorCycle();
    }
    res.json({
      ok: true,
      monitorEnabled: persisted.enabled,
      m15Enabled: persisted.m15Enabled,
      symbols: persisted.symbols,
      subscribersCount: persisted.subscriptions.length,
      lastCheckedAt: monitorRuntime.lastCheckedAt,
      xmBridgeConnected: isXmBridgeActive(),
      cfdWsConnected: cfdStreamState.connected,
    });
  });

  app.get('/api/market/tick', async (req, res) => {
    const rawSymbol = String(req.query.symbol || 'US100').toUpperCase();
    if (!(rawSymbol in YAHOO_SYMBOL_MAP)) {
      res.status(400).json({ error: 'ไม่รองรับสินทรัพย์นี้' });
      return;
    }
    try {
      const data = await getLiveTick(rawSymbol as TradingSymbol);
      res.json(data);
    } catch (err: any) {
      res.status(502).json({
        error: err?.message || 'ไม่สามารถดึงราคาเรียลไทม์ได้ในขณะนี้',
      });
    }
  });

  app.get('/api/market/m5', async (req, res) => {
    const rawSymbol = String(req.query.symbol || 'US100').toUpperCase();
    if (!(rawSymbol in YAHOO_SYMBOL_MAP)) {
      res.status(400).json({ error: 'ไม่รองรับสินทรัพย์นี้' });
      return;
    }
    try {
      const data = await getLiveAoFeed(rawSymbol as TradingSymbol, 'M5');
      res.json(data);
    } catch (err: any) {
      res.status(502).json({
        error: err?.message || 'ไม่สามารถดึงข้อมูลกราฟจริงได้ในขณะนี้',
      });
    }
  });

  app.get('/api/market/ao', async (req, res) => {
    const rawSymbol = String(req.query.symbol || 'US100').toUpperCase();
    const rawTf = String(req.query.tf || 'M5').toUpperCase() as AoTimeframe;
    if (!(rawSymbol in YAHOO_SYMBOL_MAP)) {
      res.status(400).json({ error: 'ไม่รองรับสินทรัพย์นี้' });
      return;
    }
    if (!AO_TIMEFRAME_ORDER.includes(rawTf)) {
      res.status(400).json({ error: 'AO รองรับเฉพาะ Timeframe M5 เท่านั้น' });
      return;
    }
    try {
      const data = await getLiveAoFeed(rawSymbol as TradingSymbol, rawTf);
      res.json(data);
    } catch (err: any) {
      res.status(502).json({
        error: err?.message || `ไม่สามารถดึงข้อมูลกราฟ AO ${rawTf} ได้ในขณะนี้`,
      });
    }
  });

  app.get('/api/market/m15', async (req, res) => {
    const rawSymbol = String(req.query.symbol || 'US100').toUpperCase();
    if (!(rawSymbol in YAHOO_SYMBOL_MAP)) {
      res.status(400).json({ error: 'ไม่รองรับสินทรัพย์นี้' });
      return;
    }
    try {
      const data = await getLiveCisdFeed(rawSymbol as TradingSymbol, 'M15');
      res.json(data);
    } catch (err: any) {
      res.status(502).json({
        error: err?.message || 'ไม่สามารถดึงข้อมูลกราฟ M15 ได้ในขณะนี้',
      });
    }
  });

  app.get('/api/market/cisd', async (req, res) => {
    const rawSymbol = String(req.query.symbol || 'US100').toUpperCase();
    const rawTf = String(req.query.tf || 'M15').toUpperCase() as CisdTimeframe;
    const forceFresh = req.query.fresh === '1';
    if (!(rawSymbol in YAHOO_SYMBOL_MAP)) {
      res.status(400).json({ error: 'ไม่รองรับสินทรัพย์นี้' });
      return;
    }
    if (!CISD_CHART_TIMEFRAMES.includes(rawTf)) {
      res.status(400).json({ error: 'ไม่รองรับ Timeframe นี้ (รองรับ M5 และ M15 เท่านั้น)' });
      return;
    }
    try {
      const data = await getLiveCisdFeed(rawSymbol as TradingSymbol, rawTf, forceFresh);
      res.json(data);
    } catch (err: any) {
      res.status(502).json({
        error: err?.message || `ไม่สามารถดึงข้อมูลกราฟ ${rawTf} ได้ในขณะนี้`,
      });
    }
  });

  app.get('/api/market/cisd-status', async (req, res) => {
    const rawSymbol = String(req.query.symbol || 'US100').toUpperCase();
    if (!(rawSymbol in YAHOO_SYMBOL_MAP)) {
      res.status(400).json({ error: 'ไม่รองรับสินทรัพย์นี้' });
      return;
    }
    const sym = rawSymbol as TradingSymbol;
    const statuses = await Promise.all(
      CISD_CHART_TIMEFRAMES.map(async (tf) => {
        try {
          const feed = await getLiveCisdFeed(sym, tf);
          const latestBar = feed.bars[feed.bars.length - 1];
          const closedBar = feed.bars[feed.bars.length - 2];
          const prevClosed = feed.bars[feed.bars.length - 3];
          const currentPrice = latestBar?.close ?? closedBar?.close ?? 0;
          const prevPrice = prevClosed?.close ?? latestBar?.open ?? currentPrice;
          const changePercent =
            prevPrice > 0 ? ((currentPrice - prevPrice) / prevPrice) * 100 : 0;

          const effectiveTrend =
            feed.currentTrend ??
            (latestBar && latestBar.close > latestBar.open
              ? 'BUY'
              : latestBar && latestBar.close < latestBar.open
              ? 'SELL'
              : null);

          return {
            timeframe: tf,
            ok: true,
            status: effectiveTrend === 'BUY' ? 'UP' : effectiveTrend === 'SELL' ? 'DOWN' : 'NEUTRAL',
            trendSource: feed.currentTrend ? 'CISD' : 'CANDLE',
            cisdSignal: feed.currentTrend,
            lastSignalInfo: feed.lastSignalInfo,
            lastClosedBarSignal: closedBar?.cisdSignal ?? null,
            currentPrice,
            candleOpen: latestBar?.open ?? currentPrice,
            candleBullish: latestBar ? latestBar.close >= latestBar.open : true,
            changePercent: Number(changePercent.toFixed(3)),
            latestBearCisdLevel: feed.latestBearCisdLevel,
            latestBullCisdLevel: feed.latestBullCisdLevel,
            marketState: feed.marketState,
            fetchedAt: feed.fetchedAt,
          };
        } catch (err: any) {
          return {
            timeframe: tf,
            ok: false,
            status: 'NEUTRAL' as const,
            trendSource: 'NONE' as const,
            cisdSignal: null,
            lastSignalInfo: null,
            lastClosedBarSignal: null,
            currentPrice: 0,
            candleOpen: 0,
            candleBullish: true,
            changePercent: 0,
            latestBearCisdLevel: null,
            latestBullCisdLevel: null,
            marketState: 'UNAVAILABLE',
            fetchedAt: new Date().toISOString(),
            error: err?.message || `โหลด ${tf} ไม่สำเร็จ`,
          };
        }
      })
    );

    res.json({
      symbol: sym,
      order: CISD_CHART_TIMEFRAMES,
      fetchedAt: new Date().toISOString(),
      timeframes: statuses,
    });
  });

  app.get('/api/push/vapid-public-key', (_req, res) => {
    res.json({ publicKey: persisted.vapidKeys.publicKey });
  });

  app.post('/api/push/subscribe', (req, res) => {
    const sub = req.body?.subscription as StoredPushSubscription | undefined;
    if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
      res.status(400).json({ error: 'ข้อมูล Push Subscription ไม่ถูกต้อง' });
      return;
    }

    const existsIdx = persisted.subscriptions.findIndex(
      (s) => s.endpoint === sub.endpoint
    );
    if (existsIdx >= 0) {
      persisted.subscriptions[existsIdx] = sub;
    } else {
      persisted.subscriptions.push(sub);
    }
    syncPersistence();
    res.json({ ok: true, subscribersCount: persisted.subscriptions.length });
  });

  app.post('/api/push/unsubscribe', (req, res) => {
    const endpoint = String(req.body?.endpoint || '');
    if (endpoint) {
      persisted.subscriptions = persisted.subscriptions.filter(
        (s) => s.endpoint !== endpoint
      );
      syncPersistence();
    }
    res.json({ ok: true, subscribersCount: persisted.subscriptions.length });
  });

  app.post('/api/push/test', async (req, res) => {
    const targetEndpoint = req.body?.endpoint ? String(req.body.endpoint) : null;
    const targets = targetEndpoint
      ? persisted.subscriptions.filter((s) => s.endpoint === targetEndpoint)
      : persisted.subscriptions;

    if (targets.length === 0) {
      res.status(400).json({ error: 'ยังไม่มีอุปกรณ์ที่เปิดรับการแจ้งเตือน' });
      return;
    }

    let okCount = 0;
    const payload = JSON.stringify({
      title: 'เชื่อมต่อแจ้งเตือนเข้ามือถือสำเร็จ',
      body: 'เซิร์ฟเวอร์เชื่อมต่อมือถือเครื่องนี้แล้ว พร้อมรับสัญญาณ CISD (M15) ทั้งโหมดจริงและจำลอง',
      tag: `mobile-test-${Date.now()}`,
      url: '/',
    });

    await Promise.all(
      targets.map(async (sub) => {
        try {
          await webpush.sendNotification(sub as webpushTypes.PushSubscription, payload);
          okCount++;
        } catch {
          // Ignore individual failures
        }
      })
    );

    if (okCount === 0) {
      res.status(502).json({ error: 'ส่งแจ้งเตือนทดสอบไม่สำเร็จ กรุณากดเชื่อมต่อใหม่อีกครั้ง' });
      return;
    }

    res.json({ ok: true, delivered: okCount });
  });

  app.get('/api/monitor/status', (_req, res) => {
    res.json({
      enabled: persisted.enabled,
      m15Enabled: persisted.m15Enabled,
      symbols: persisted.symbols,
      ntfyTopic: persisted.ntfyTopic,
      telegramHasToken: Boolean(persisted.telegramBotToken),
      telegramBotTokenMasked: maskTelegramToken(persisted.telegramBotToken),
      telegramConfigured: Boolean(
        persisted.telegramBotToken &&
          persisted.telegramChatId &&
          (/^-?\d+$/.test(persisted.telegramChatId) || persisted.telegramChatId.startsWith('@'))
      ),
      telegramChatId: persisted.telegramChatId,
      telegramMode: persisted.telegramMode,
      direction: persisted.direction,
      m15Direction: persisted.m15Direction,
      aoImmediateCross: persisted.aoImmediateCross,
      aoTimeframes: persisted.aoTimeframes,
      cisdTimeframes: persisted.cisdTimeframes,
      subscribersCount: persisted.subscriptions.length,
      lastCheckedAt: monitorRuntime.lastCheckedAt,
      events: persisted.events,
    });
  });

  app.post('/api/monitor/check-now', async (_req, res) => {
    cisdFeedCache.clear();
    const beforeLen = persisted.events.length;
    await runBackgroundMonitorCycle();
    res.json({
      ok: true,
      lastCheckedAt: monitorRuntime.lastCheckedAt,
      eventsCount: persisted.events.length,
      newEventsCount: Math.max(0, persisted.events.length - beforeLen),
      events: persisted.events,
    });
  });

  app.post('/api/monitor/config', (req, res) => {
    const body = req.body || {};
    if (typeof body.enabled === 'boolean') {
      persisted.enabled = body.enabled;
    }
    if (typeof body.m15Enabled === 'boolean') {
      persisted.m15Enabled = body.m15Enabled;
    }
    if (typeof body.aoImmediateCross === 'boolean') {
      persisted.aoImmediateCross = body.aoImmediateCross;
    }
    persisted.aoTimeframes = ['M5'];
    if (Array.isArray(body.cisdTimeframes)) {
      const validCisd = body.cisdTimeframes
        .map((t: unknown) => String(t).toUpperCase())
        .filter((t: string): t is CisdTimeframe =>
          CISD_TIMEFRAME_ORDER.includes(t as CisdTimeframe)
        );
      persisted.cisdTimeframes = validCisd;
    }
    if (Array.isArray(body.symbols)) {
      const valid = body.symbols
        .map((s: unknown) => String(s).toUpperCase())
        .filter((s: string): s is TradingSymbol => s in YAHOO_SYMBOL_MAP);
      if (valid.length > 0) {
        persisted.symbols = valid;
      }
    }
    if (typeof body.ntfyTopic === 'string') {
      persisted.ntfyTopic = body.ntfyTopic.trim();
    }
    if (body.clearTelegram === true) {
      persisted.telegramBotToken = '';
      persisted.telegramChatId = FIXED_TELEGRAM_CHAT_ID;
    } else {
      if (typeof body.telegramBotToken === 'string' && body.telegramBotToken.trim() !== '') {
        persisted.telegramBotToken = body.telegramBotToken.trim();
      }
      persisted.telegramChatId = FIXED_TELEGRAM_CHAT_ID;
    }
    if (body.telegramMode === 'fallback' || body.telegramMode === 'always') {
      persisted.telegramMode = body.telegramMode;
    }
    if (
      body.direction === 'both' ||
      body.direction === 'buy_only' ||
      body.direction === 'sell_only'
    ) {
      persisted.direction = body.direction;
    }
    if (
      body.m15Direction === 'both' ||
      body.m15Direction === 'buy_only' ||
      body.m15Direction === 'sell_only'
    ) {
      persisted.m15Direction = body.m15Direction;
    }

    syncPersistence();

    if (persisted.enabled || persisted.m15Enabled) {
      void runBackgroundMonitorCycle();
    }

    res.json({
      enabled: persisted.enabled,
      m15Enabled: persisted.m15Enabled,
      symbols: persisted.symbols,
      ntfyTopic: persisted.ntfyTopic,
      telegramHasToken: Boolean(persisted.telegramBotToken),
      telegramBotTokenMasked: maskTelegramToken(persisted.telegramBotToken),
      telegramConfigured: Boolean(
        persisted.telegramBotToken &&
          persisted.telegramChatId &&
          (/^-?\d+$/.test(persisted.telegramChatId) || persisted.telegramChatId.startsWith('@'))
      ),
      telegramChatId: persisted.telegramChatId,
      telegramMode: persisted.telegramMode,
      direction: persisted.direction,
      m15Direction: persisted.m15Direction,
      aoImmediateCross: persisted.aoImmediateCross,
      aoTimeframes: persisted.aoTimeframes,
      cisdTimeframes: persisted.cisdTimeframes,
      subscribersCount: persisted.subscriptions.length,
      lastCheckedAt: monitorRuntime.lastCheckedAt,
      events: persisted.events,
    });
  });

  app.post('/api/monitor/telegram-detect', async (req, res) => {
    const token = sanitizeTelegramToken(
      String(req.body?.telegramBotToken || persisted.telegramBotToken || '')
    );
    if (!token) {
      res.status(400).json({ error: 'กรุณากรอก Bot Token ก่อนดึง Chat ID' });
      return;
    }

    const botInfo = await fetchTelegramBotInfo(token);
    if (!botInfo.ok) {
      res.status(400).json({ error: botInfo.error || 'Bot Token ไม่ถูกต้อง' });
      return;
    }

    persisted.telegramBotToken = token;
    persisted.telegramChatId = FIXED_TELEGRAM_CHAT_ID;
    syncPersistence();

    try {
      const chatRes = await fetch(
        `https://api.telegram.org/bot${token}/getChat?chat_id=${encodeURIComponent(
          FIXED_TELEGRAM_CHAT_ID
        )}`,
        { signal: AbortSignal.timeout(6000) }
      );
      const chatJson = (await chatRes.json().catch(() => ({}))) as {
        ok?: boolean;
        description?: string;
        result?: { id?: number; title?: string; username?: string };
      };

      if (!chatRes.ok || !chatJson.ok) {
        res.status(400).json({
          ok: false,
          botUsername: botInfo.username,
          botUrl: botInfo.botUrl,
          error:
            chatJson.description ||
            `บอท @${botInfo.username} ยังไม่สามารถเข้าถึงแชท ${FIXED_TELEGRAM_CHAT_ID} ได้`,
        });
        return;
      }

      const label =
        chatJson.result?.title ||
        (chatJson.result?.username ? `@${chatJson.result.username}` : FIXED_TELEGRAM_CHAT_ID);

      res.json({
        ok: true,
        botUsername: botInfo.username,
        botUrl: botInfo.botUrl,
        detectedChatId: FIXED_TELEGRAM_CHAT_ID,
        detectedChatLabel: label,
      });
    } catch (err: any) {
      res.status(502).json({
        error: err?.message || 'ตรวจสอบข้อมูล Chat ID จาก Telegram ไม่สำเร็จ',
      });
    }
  });

  app.post('/api/monitor/test-push', async (req, res) => {
    const topic = String(req.body?.ntfyTopic || persisted.ntfyTopic || '').trim();
    if (!topic) {
      res.status(400).json({ error: 'กรุณากรอกชื่อ Topic ของ ntfy ก่อนทดสอบ' });
      return;
    }
    const ok = await sendNtfyPush(
      topic,
      'CISD Test Alert',
      'เชื่อมต่อการแจ้งเตือนอัตโนมัติเข้ามือถือ Android สำเร็จ'
    );
    if (!ok) {
      res.status(502).json({ error: 'ส่งสัญญาณทดสอบไปยัง ntfy ไม่สำเร็จ' });
      return;
    }
    res.json({ ok: true });
  });

  app.post('/api/monitor/test-telegram', async (req, res) => {
    const token = sanitizeTelegramToken(
      String(req.body?.telegramBotToken || persisted.telegramBotToken || '')
    );
    const chatId = FIXED_TELEGRAM_CHAT_ID;

    if (!token) {
      res.status(400).json({ error: 'กรุณากรอก Bot Token ของ Telegram' });
      return;
    }

    persisted.telegramBotToken = token;
    persisted.telegramChatId = chatId;
    syncPersistence();

    const tgRes = await sendTelegramPush(
      token,
      chatId,
      [
        '✅ ทดสอบระบบแจ้งเตือน CISD (M15)',
        '──────────────',
        'สถานะ: เชื่อมต่อ Telegram สำเร็จ',
        'สินทรัพย์: US100 (US 100 Index Cash)',
      ].join('\n')
    );
    if (!tgRes.ok) {
      res.status(502).json({
        error: tgRes.error || 'ส่งข้อความเข้า Telegram ไม่สำเร็จ',
        botUrl: tgRes.botUrl,
        botUsername: tgRes.botUsername,
      });
      return;
    }
    res.json({ ok: true });
  });

  app.post('/api/monitor/notify-signal', async (req, res) => {
    const body = req.body || {};
    const symbol = String(body.symbol || 'US100').toUpperCase();
    const timeframe = String(body.timeframe || 'M5').toUpperCase();
    const strategy = body.strategy === 'CISD' ? 'CISD' : 'AO';
    const signal = body.signal === 'SELL' ? 'SELL' : 'BUY';
    const aoPrev = Number(body.aoPrev ?? 0);
    const aoCurr = Number(body.aoCurr ?? 0);
    const price = Number(body.price ?? 0);
    const cisdLevel =
      body.cisdLevel !== undefined && body.cisdLevel !== null ? Number(body.cisdLevel) : null;
    const mode = body.mode === 'live' ? 'live' : 'sim';
    const timestampIso = String(body.timestampIso || new Date().toISOString());

    // M5 is strictly a display/chart view and must never trigger notifications
    if (timeframe === 'M5') {
      res.json({ ok: false, skipped: true, reason: 'm5_alerts_disabled' });
      return;
    }

    if (mode === 'live') {
      if (strategy === 'AO' && (!persisted.enabled || timeframe !== 'M5')) {
        res.json({ ok: false, skipped: true, reason: 'ao_disabled_or_non_m5' });
        return;
      }
      if (
        strategy === 'CISD' &&
        (!persisted.m15Enabled || !persisted.cisdTimeframes.includes(timeframe as CisdTimeframe))
      ) {
        res.json({ ok: false, skipped: true, reason: 'cisd_timeframe_disabled' });
        return;
      }
      const dedupeKey = `live-${timeframe}-${strategy}-${symbol}-${timestampIso}-${signal}`;
      if (monitorRuntime.dispatchedLiveSignalKeys.has(dedupeKey)) {
        const existingEv = persisted.events.find(
          (e) =>
            e.id === `${timeframe}-${strategy}-${symbol}-${timestampIso}-${signal}` ||
            e.id === `${timeframe}-${symbol}-${timestampIso}-${signal}`
        );
        res.json({
          ok: true,
          deduplicated: true,
          deliveredWebPushCount: existingEv?.deliveredWebPushCount ?? 0,
          deliveredToNtfy: existingEv?.deliveredToNtfy ?? false,
          deliveredToTelegram: existingEv?.deliveredToTelegram ?? false,
          telegramError: existingEv?.telegramError,
          telegramMissingToken: !persisted.telegramBotToken,
        });
        return;
      }
      markLiveSignalDispatched(dedupeKey);
    }

    const modePrefix = mode === 'sim' ? '[จำลอง] ' : '';
    let pushTitle = '';
    let pushBody = '';
    if (strategy === 'CISD') {
      const condLabel =
        signal === 'SELL' ? 'ปิดต่ำกว่าระดับ CISD' : 'ปิดเหนือระดับ CISD';
      const cisdTxt =
        cisdLevel !== null && Number.isFinite(cisdLevel) ? cisdLevel.toFixed(2) : '-';
      const priceTxt = Number.isFinite(price) && price > 0 ? price.toFixed(2) : '-';
      pushTitle = `${modePrefix}CISD ${timeframe} ${signal}: ${symbol}`;
      pushBody = `${symbol} ${timeframe} ${condLabel} | ปิด ${priceTxt} (CISD ${cisdTxt})`;
    } else {
      const condLabel = signal === 'BUY' ? 'AO ตัด 0 ขึ้น' : 'AO ตัด 0 ลง';
      const priceTxt = Number.isFinite(price) && price > 0 ? ` | ราคา ${price.toFixed(2)}` : '';
      pushTitle = `${modePrefix}AO ${timeframe} ${signal}: ${symbol}`;
      pushBody = `${symbol} ${timeframe} ${condLabel} | AO ${aoPrev.toFixed(3)} → ${aoCurr.toFixed(
        3
      )}${priceTxt}`;
    }

    const [deliveredWebPushCount, deliveredToNtfy] = await Promise.all([
      broadcastWebPush({
        title: pushTitle,
        body: pushBody,
        tag: `${mode}-${strategy.toLowerCase()}-${timeframe}-${symbol}-${Date.now()}`,
        url: strategy === 'CISD' ? `/?tf=${timeframe}` : '/',
      }),
      persisted.ntfyTopic
        ? sendNtfyPush(persisted.ntfyTopic, pushTitle, pushBody)
        : Promise.resolve(false),
    ]);

    const hasTelegram = Boolean(persisted.telegramBotToken && persisted.telegramChatId);
    const shouldSendTelegram =
      hasTelegram &&
      (mode === 'sim' || persisted.telegramMode === 'always' || deliveredWebPushCount === 0);

    const text = shouldSendTelegram
      ? formatTelegramSignalMessage({
          symbol,
          timeframe,
          strategy,
          signal,
          aoPrev,
          aoCurr,
          price,
          cisdLevel,
          mode,
          timestampIso,
        })
      : '';

    const tgRes = shouldSendTelegram
      ? await sendTelegramPush(
          persisted.telegramBotToken,
          persisted.telegramChatId,
          text,
          'HTML'
        )
      : { ok: false, error: undefined };

    persisted.events.unshift({
      id: `${mode}-${timeframe}-${symbol}-${Date.now()}`,
      timestamp: new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' }),
      symbol: (symbol in YAHOO_SYMBOL_MAP ? symbol : 'US100') as TradingSymbol,
      timeframe: timeframe || 'M5',
      strategy,
      signal,
      aoPrev,
      aoCurr,
      cisdLevel,
      price,
      deliveredToNtfy,
      deliveredToTelegram: tgRes.ok,
      deliveredWebPushCount,
      ...(tgRes.error ? { telegramError: tgRes.error } : {}),
    });
    persisted.events = persisted.events.slice(0, 30);
    syncPersistence();
    scheduleGithubAutoSync('signal-event', 1000);

    res.json({
      ok: deliveredWebPushCount > 0 || deliveredToNtfy || tgRes.ok,
      deliveredWebPushCount,
      deliveredToNtfy,
      deliveredToTelegram: tgRes.ok,
      telegramError: tgRes.error,
      telegramMissingToken: !persisted.telegramBotToken,
    });
  });

  app.get('/api/github/status', (_req, res) => {
    res.json(buildGithubStatusResponse());
  });

  app.post('/api/github/config', async (req, res) => {
    const body = req.body || {};

    if (body.clearGithub === true) {
      persisted.githubToken = '';
      persisted.githubOwner = '';
      persisted.githubUploadAllowed = false;
      persisted.githubLastSyncedHash = '';
      persisted.githubLastSyncAt = null;
      persisted.githubLastCommitUrl = null;
      persisted.githubLastError = null;
      syncPersistence();
      res.json({ ok: true, status: buildGithubStatusResponse() });
      return;
    }

    const incomingToken =
      typeof body.githubToken === 'string' && body.githubToken.trim()
        ? body.githubToken.trim()
        : persisted.githubToken;

    if (!incomingToken) {
      res.status(400).json({ error: 'กรุณากรอก GitHub Personal Access Token' });
      return;
    }

    const userRes = await fetchGithubAuthenticatedUser(incomingToken);
    if (!userRes.ok || !userRes.login) {
      res.status(400).json({ error: userRes.error || 'GitHub Token ไม่ถูกต้อง' });
      return;
    }

    persisted.githubToken = incomingToken;
    persisted.githubOwner =
      typeof body.githubOwner === 'string' && body.githubOwner.trim()
        ? body.githubOwner.trim()
        : userRes.login;
    persisted.githubRepo = sanitizeGithubRepoName(
      typeof body.githubRepo === 'string' && body.githubRepo.trim()
        ? body.githubRepo
        : persisted.githubRepo || 'ao-signal-studio'
    );
    persisted.githubBranch =
      typeof body.githubBranch === 'string' && body.githubBranch.trim()
        ? body.githubBranch.trim()
        : persisted.githubBranch || 'main';
    if (typeof body.githubPrivate === 'boolean') {
      persisted.githubPrivate = body.githubPrivate;
    }
    if (typeof body.githubUploadAllowed === 'boolean') {
      persisted.githubUploadAllowed = body.githubUploadAllowed;
    }
    if (typeof body.githubAutoSyncCode === 'boolean') {
      persisted.githubAutoSyncCode = body.githubAutoSyncCode;
    }
    if (typeof body.githubSyncSignals === 'boolean') {
      persisted.githubSyncSignals = body.githubSyncSignals;
    }
    persisted.githubLastError = null;
    syncPersistence();

    const shouldSyncImmediately =
      body.syncImmediately === true && persisted.githubUploadAllowed;
    let syncResult: Awaited<ReturnType<typeof syncWorkspaceToGithub>> | null = null;
    if (shouldSyncImmediately) {
      syncResult = await syncWorkspaceToGithub({
        force: body.forceSync !== false,
        reason: 'connect',
      });
      if (!syncResult.ok) {
        res.status(502).json({
          ok: false,
          error: syncResult.error || 'อัปโหลดขึ้น GitHub ไม่สำเร็จ',
          status: buildGithubStatusResponse(),
        });
        return;
      }
    } else if (persisted.githubUploadAllowed && persisted.githubAutoSyncCode) {
      scheduleGithubAutoSync('restore-check', 1200);
    }

    res.json({
      ok: true,
      syncResult,
      status: buildGithubStatusResponse(),
    });
  });

  app.post('/api/github/sync-now', async (req, res) => {
    if (!persisted.githubToken || !persisted.githubRepo) {
      res.status(400).json({ error: 'กรุณาเชื่อมต่อ GitHub.com ก่อนซิงค์' });
      return;
    }

    const explicitApproved = Boolean(req.body?.approved);
    if (!persisted.githubUploadAllowed && !explicitApproved) {
      res.status(403).json({
        ok: false,
        error: 'ยังไม่อนุญาตให้อัปโหลดขึ้น GitHub กรุณากดปุ่มอนุญาตอัปโหลดก่อน',
        status: buildGithubStatusResponse(),
      });
      return;
    }

    const result = await syncWorkspaceToGithub({
      force: true,
      reason: 'manual',
      approved: explicitApproved,
    });
    if (!result.ok) {
      res.status(502).json({
        ok: false,
        error: result.error || 'ซิงค์ขึ้น GitHub ไม่สำเร็จ',
        status: buildGithubStatusResponse(),
      });
      return;
    }

    res.json({
      ok: true,
      committed: result.committed,
      syncedFilesCount: result.syncedFilesCount,
      commitUrl: result.commitUrl,
      status: buildGithubStatusResponse(),
    });
  });

  app.get('/api/export/manifest', (_req, res) => {
    try {
      const files = collectDeployableFiles(__dirname);
      res.json({ ok: true, count: files.length, files });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'อ่านรายการไฟล์ไม่สำเร็จ' });
    }
  });

  app.get('/api/export/source.zip', (_req, res) => {
    try {
      const files = collectDeployableFiles(__dirname);
      const zipBuffer = buildZipBuffer(__dirname, files);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader(
        'Content-Disposition',
        'attachment; filename="ao-signal-studio-server.zip"'
      );
      res.setHeader('Content-Length', String(zipBuffer.length));
      res.send(zipBuffer);
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'สร้างไฟล์ดาวน์โหลดไม่สำเร็จ' });
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  const port = Number(process.env.PORT || 3000);
  app.listen(port, '0.0.0.0', () => {
    console.log(`Server listening on http://0.0.0.0:${port}`);
    startGithubWorkspaceWatchers();
  });
}

void startServer();
