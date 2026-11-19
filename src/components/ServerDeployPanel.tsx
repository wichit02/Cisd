import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Cloud,
  Copy,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  FileArchive,
  GitBranch,
  KeyRound,
  Lock,
  Server,
  ShieldCheck,
  ShieldOff,
  Terminal,
  Unlink,
  UploadCloud,
} from 'lucide-react';
import {
  clearSavedGithubConfig,
  loadSavedGithubConfig,
  saveGithubConfigLocally,
} from '../lib/githubStorage';

interface GithubSyncStatus {
  hasToken: boolean;
  connected: boolean;
  owner: string;
  repo: string;
  branch: string;
  privateRepo: boolean;
  uploadAllowed: boolean;
  autoSyncCode: boolean;
  syncSignals: boolean;
  lastSyncAt: string | null;
  lastCommitUrl: string | null;
  lastError: string | null;
  isSyncing: boolean;
  fileCount: number;
  workspaceChanged: boolean;
  repoUrl: string | null;
}

interface ServerDeployPanelProps {
  onPreviewWebMode?: () => void;
}

export const ServerDeployPanel: React.FC<ServerDeployPanelProps> = ({
  onPreviewWebMode,
}) => {
  const [fileCount, setFileCount] = useState<number | null>(null);
  const [filesPreview, setFilesPreview] = useState<string[]>([]);
  const [downloading, setDownloading] = useState(false);
  const [downloadErr, setDownloadErr] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // GitHub real-time sync states
  const [ghStatus, setGhStatus] = useState<GithubSyncStatus | null>(null);
  const [ghToken, setGhToken] = useState('');
  const [showGhToken, setShowGhToken] = useState(false);
  const [ghOwner, setGhOwner] = useState('');
  const [ghRepo, setGhRepo] = useState('ao-signal-studio');
  const [ghBranch, setGhBranch] = useState('main');
  const [ghPrivate, setGhPrivate] = useState(true);
  const [ghUploadAllowed, setGhUploadAllowed] = useState(false);
  const [ghAutoSyncCode, setGhAutoSyncCode] = useState(true);
  const [ghSyncSignals, setGhSyncSignals] = useState(true);
  const [ghSaving, setGhSaving] = useState(false);
  const [ghTogglingAllow, setGhTogglingAllow] = useState(false);
  const [ghSyncingNow, setGhSyncingNow] = useState(false);
  const [ghFeedback, setGhFeedback] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);

  const loadGithubStatus = useCallback(async (hydrateFields = false) => {
    try {
      const res = await fetch('/api/github/status');
      if (!res.ok) return;
      const data = (await res.json()) as GithubSyncStatus;
      setGhStatus(data);
      setGhUploadAllowed(Boolean(data.uploadAllowed));
      if (hydrateFields) {
        const saved = loadSavedGithubConfig();
        setGhOwner(data.owner || saved?.githubOwner || '');
        setGhRepo(data.repo || saved?.githubRepo || 'ao-signal-studio');
        setGhBranch(data.branch || saved?.githubBranch || 'main');
        setGhPrivate(
          typeof data.privateRepo === 'boolean'
            ? data.privateRepo
            : saved?.githubPrivate ?? true
        );
        setGhUploadAllowed(
          typeof data.uploadAllowed === 'boolean'
            ? data.uploadAllowed
            : saved?.githubUploadAllowed ?? false
        );
        setGhAutoSyncCode(
          typeof data.autoSyncCode === 'boolean'
            ? data.autoSyncCode
            : saved?.githubAutoSyncCode ?? true
        );
        setGhSyncSignals(
          typeof data.syncSignals === 'boolean'
            ? data.syncSignals
            : saved?.githubSyncSignals ?? true
        );
        if (saved?.githubToken) {
          setGhToken(saved.githubToken);
        }
      }
    } catch {
      // Ignore transient polling failures
    }
  }, []);

  useEffect(() => {
    fetch('/api/export/manifest')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.ok) {
          setFileCount(data.count);
          if (Array.isArray(data.files)) {
            setFilesPreview(data.files);
          }
        }
      })
      .catch(() => {});

    void loadGithubStatus(true);
    const timer = window.setInterval(() => {
      void loadGithubStatus(false);
    }, 8000);
    return () => window.clearInterval(timer);
  }, [loadGithubStatus]);

  const handleCopy = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setCopiedId(id);
    window.setTimeout(() => setCopiedId(null), 1800);
  };

  const handleDownloadZip = async () => {
    setDownloading(true);
    setDownloadErr(null);
    try {
      const res = await fetch('/api/export/source.zip');
      if (!res.ok) throw new Error('ดาวน์โหลดแพ็กเกจซอร์สโค้ดไม่สำเร็จ');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'ao-signal-studio-server.zip';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err: any) {
      setDownloadErr(err?.message || 'ดาวน์โหลดไม่สำเร็จ');
    } finally {
      setDownloading(false);
    }
  };

  const handleSaveGithubConnection = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedToken = ghToken.trim();
    if (!trimmedToken && !ghStatus?.hasToken) {
      setGhFeedback({
        type: 'error',
        text: 'กรุณาวาง GitHub Personal Access Token (สิทธิ์ repo) ก่อนเชื่อมต่อ',
      });
      return;
    }

    setGhSaving(true);
    setGhFeedback(null);
    try {
      const res = await fetch('/api/github/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(trimmedToken ? { githubToken: trimmedToken } : {}),
          githubOwner: ghOwner.trim(),
          githubRepo: ghRepo.trim() || 'ao-signal-studio',
          githubBranch: ghBranch.trim() || 'main',
          githubPrivate: ghPrivate,
          githubUploadAllowed: ghUploadAllowed,
          githubAutoSyncCode: ghAutoSyncCode,
          githubSyncSignals: ghSyncSignals,
          syncImmediately: false,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        if (json.status) setGhStatus(json.status);
        throw new Error(json.error || 'เชื่อมต่อ GitHub ไม่สำเร็จ');
      }

      const nextStatus = json.status as GithubSyncStatus;
      setGhStatus(nextStatus);
      setGhOwner(nextStatus.owner || ghOwner);
      setGhRepo(nextStatus.repo || ghRepo);
      setGhUploadAllowed(Boolean(nextStatus.uploadAllowed));

      const effectiveToken = trimmedToken || loadSavedGithubConfig()?.githubToken || '';
      if (effectiveToken) {
        saveGithubConfigLocally({
          githubToken: effectiveToken,
          githubOwner: nextStatus.owner,
          githubRepo: nextStatus.repo,
          githubBranch: nextStatus.branch,
          githubPrivate: nextStatus.privateRepo,
          githubUploadAllowed: nextStatus.uploadAllowed,
          githubAutoSyncCode: nextStatus.autoSyncCode,
          githubSyncSignals: nextStatus.syncSignals,
        });
      }

      setGhFeedback({
        type: 'success',
        text: nextStatus.uploadAllowed
          ? `บันทึกการเชื่อมต่อ GitHub (${nextStatus.owner}/${nextStatus.repo}) เรียบร้อยแล้ว`
          : `เชื่อมต่อ GitHub (${nextStatus.owner}/${nextStatus.repo}) สำเร็จ — ยังไม่อัปโหลดจนกว่าจะกดปุ่ม "อนุญาตอัปโหลด"`,
      });
    } catch (err: any) {
      setGhFeedback({
        type: 'error',
        text: err?.message || 'เชื่อมต่อ GitHub ไม่สำเร็จ',
      });
    } finally {
      setGhSaving(false);
    }
  };

  const handleToggleUploadPermission = async () => {
    const trimmedToken = ghToken.trim();
    if (!trimmedToken && !ghStatus?.hasToken) {
      setGhFeedback({
        type: 'error',
        text: 'กรุณากรอก GitHub Token และบันทึกการเชื่อมต่อก่อนกดอนุญาตอัปโหลด',
      });
      return;
    }

    const nextAllowed = !ghUploadAllowed;
    setGhTogglingAllow(true);
    setGhFeedback(null);
    try {
      const res = await fetch('/api/github/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(trimmedToken ? { githubToken: trimmedToken } : {}),
          githubOwner: ghOwner.trim(),
          githubRepo: ghRepo.trim() || 'ao-signal-studio',
          githubBranch: ghBranch.trim() || 'main',
          githubPrivate: ghPrivate,
          githubUploadAllowed: nextAllowed,
          githubAutoSyncCode: ghAutoSyncCode,
          githubSyncSignals: ghSyncSignals,
          syncImmediately: false,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        if (json.status) setGhStatus(json.status);
        throw new Error(json.error || 'อัปเดตสิทธิ์อัปโหลดไม่สำเร็จ');
      }

      const nextStatus = json.status as GithubSyncStatus;
      setGhStatus(nextStatus);
      setGhUploadAllowed(Boolean(nextStatus.uploadAllowed));
      setGhOwner(nextStatus.owner || ghOwner);
      setGhRepo(nextStatus.repo || ghRepo);

      const effectiveToken = trimmedToken || loadSavedGithubConfig()?.githubToken || '';
      if (effectiveToken) {
        saveGithubConfigLocally({
          githubToken: effectiveToken,
          githubOwner: nextStatus.owner,
          githubRepo: nextStatus.repo,
          githubBranch: nextStatus.branch,
          githubPrivate: nextStatus.privateRepo,
          githubUploadAllowed: nextStatus.uploadAllowed,
          githubAutoSyncCode: nextStatus.autoSyncCode,
          githubSyncSignals: nextStatus.syncSignals,
        });
      }

      setGhFeedback({
        type: 'success',
        text: nextStatus.uploadAllowed
          ? 'อนุญาตให้อัปโหลดขึ้น GitHub แล้ว — สามารถกดอัปโหลดตอนนี้หรือซิงค์อัตโนมัติได้เลย'
          : 'ปิดการอนุญาตอัปโหลดขึ้น GitHub แล้ว ระบบจะไม่อัปโหลดไฟล์หรือสัญญาณจนกว่าจะกดอนุญาตใหม่',
      });
    } catch (err: any) {
      setGhFeedback({
        type: 'error',
        text: err?.message || 'เปลี่ยนสถานะอนุญาตอัปโหลดไม่สำเร็จ',
      });
    } finally {
      setGhTogglingAllow(false);
    }
  };

  const handleSyncGithubNow = async () => {
    if (!ghUploadAllowed) {
      setGhFeedback({
        type: 'error',
        text: 'กรุณากดปุ่ม "อนุญาตอัปโหลด" ก่อนส่งไฟล์ขึ้น GitHub',
      });
      return;
    }

    setGhSyncingNow(true);
    setGhFeedback(null);
    try {
      const res = await fetch('/api/github/sync-now', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approved: true }),
      });
      const json = await res.json();
      if (json.status) setGhStatus(json.status);
      if (!res.ok || !json.ok) {
        throw new Error(json.error || 'อัปโหลดขึ้น GitHub ไม่สำเร็จ');
      }
      setGhFeedback({
        type: 'success',
        text: `อัปโหลดทั้งหมด ${json.syncedFilesCount} ไฟล์ (รวมโค้ดและข้อมูลสัญญาณ) ขึ้น GitHub เรียบร้อยแล้ว`,
      });
    } catch (err: any) {
      setGhFeedback({
        type: 'error',
        text: err?.message || 'อัปโหลดขึ้น GitHub ไม่สำเร็จ',
      });
    } finally {
      setGhSyncingNow(false);
    }
  };

  const handleDisconnectGithub = async () => {
    setGhSaving(true);
    setGhFeedback(null);
    try {
      const res = await fetch('/api/github/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clearGithub: true }),
      });
      const json = await res.json();
      if (json.status) setGhStatus(json.status);
      clearSavedGithubConfig();
      setGhToken('');
      setGhOwner('');
      setGhUploadAllowed(false);
      setGhFeedback({
        type: 'success',
        text: 'ยกเลิกการเชื่อมต่อ GitHub.com แล้ว (ข้อมูลเดิมบน GitHub ยังอยู่ครบ)',
      });
    } catch {
      setGhFeedback({
        type: 'error',
        text: 'ยกเลิกการเชื่อมต่อไม่สำเร็จ',
      });
    } finally {
      setGhSaving(false);
    }
  };

  const formattedLastSync = ghStatus?.lastSyncAt
    ? new Date(ghStatus.lastSyncAt).toLocaleString('th-TH', {
        timeZone: 'Asia/Bangkok',
        hour12: false,
      })
    : null;

  const runCommands = `npm install
cp .env.example .env
npm run build
NODE_ENV=production npm start`;

  const envTemplate = `NODE_ENV=production
PORT=3000
TELEGRAM_BOT_TOKEN=ใส่_Bot_Token_จาก_BotFather
TELEGRAM_CHAT_ID=8217822307
TELEGRAM_MODE=always`;

  return (
    <div className="space-y-6">
      {/* Top Full-Width Section: Direct Real-Time GitHub.com Sync */}
      <section className="rounded-xl border border-slate-200/90 bg-white p-6">
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-100 pb-4">
          <div className="flex items-start gap-3.5">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-slate-900 text-white">
              <GitBranch className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                เชื่อมต่อ GitHub.com (ควบคุมด้วยปุ่มอนุญาตอัปโหลด)
              </h2>
              <p className="mt-1 text-[13px] leading-relaxed text-slate-600">
                เชื่อม Repository ไว้ได้โดยยังไม่ส่งไฟล์อัตโนมัติ — ระบบจะอัปโหลดโค้ดและบันทึกสัญญาณ{' '}
                <code className="font-mono text-xs text-slate-800">data/signals-log.json</code>{' '}
                ก็ต่อเมื่อคุณกดปุ่ม <strong>อนุญาตอัปโหลด</strong> แล้วเท่านั้น
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3 text-[13px]">
            {onPreviewWebMode && (
              <button
                type="button"
                onClick={onPreviewWebMode}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-blue-200 bg-blue-50 px-3.5 text-xs font-medium text-blue-700 whitespace-nowrap transition-colors hover:bg-blue-100"
              >
                <Eye className="h-4 w-4" />
                ดูตัวอย่างหน้าเว็บออนไลน์
              </button>
            )}
            {ghStatus?.connected ? (
              ghUploadAllowed ? (
                <span className="inline-flex items-center gap-1.5 font-semibold text-emerald-700">
                  <CheckCircle2 className="h-4 w-4" />
                  {ghStatus.isSyncing ? 'กำลังอัปโหลด...' : 'อนุญาตอัปโหลดแล้ว'}
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 font-semibold text-amber-700">
                  <ShieldOff className="h-4 w-4" />
                  เชื่อมต่อแล้ว (ยังไม่อนุญาตอัปโหลด)
                </span>
              )
            ) : (
              <span className="text-xs font-medium text-slate-500">ยังไม่เชื่อมต่อ GitHub</span>
            )}
          </div>
        </div>

        <form onSubmit={(e) => void handleSaveGithubConnection(e)} className="mt-5 space-y-4">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
            {/* GitHub Token Input */}
            <div className="lg:col-span-5 space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="flex items-center gap-1.5 text-xs font-semibold text-slate-700">
                  <KeyRound className="h-3.5 w-3.5 text-slate-500" />
                  <span>GitHub Personal Access Token (สิทธิ์ repo)</span>
                </label>
                <a
                  href="https://github.com/settings/tokens/new?scopes=repo&description=AO-Signal-Studio"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-[11px] font-medium text-blue-600 hover:underline"
                >
                  สร้าง Token ด่วน <ExternalLink className="h-3 w-3" />
                </a>
              </div>
              <div className="relative">
                <input
                  type={showGhToken ? 'text' : 'password'}
                  value={ghToken}
                  onChange={(e) => setGhToken(e.target.value)}
                  placeholder={
                    ghStatus?.hasToken
                      ? '•••••••••••• (บันทึกไว้แล้ว หรือวาง Token ใหม่)'
                      : 'ghp_xxxxxxxxxxxxxxxxxxxx'
                  }
                  className="h-10 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 pr-10 font-mono text-xs text-slate-900 placeholder:text-slate-400 focus:border-blue-500 focus:bg-white focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => setShowGhToken((v) => !v)}
                  className="absolute inset-y-0 right-2 flex items-center px-1 text-slate-400 hover:text-slate-600"
                  aria-label="สลับการแสดง Token"
                >
                  {showGhToken ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </button>
              </div>
            </div>

            {/* Repo Name */}
            <div className="lg:col-span-3 space-y-1.5">
              <label className="block text-xs font-semibold text-slate-700">
                ชื่อ Repository (สร้างใหม่ให้อัตโนมัติถ้ายังไม่มี)
              </label>
              <input
                type="text"
                value={ghRepo}
                onChange={(e) => setGhRepo(e.target.value)}
                placeholder="ao-signal-studio"
                className="h-10 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 font-mono text-xs text-slate-900 focus:border-blue-500 focus:bg-white focus:outline-none"
              />
            </div>

            {/* Owner (optional auto-detect) */}
            <div className="lg:col-span-2 space-y-1.5">
              <label className="block text-xs font-semibold text-slate-700">
                ชื่อผู้ใช้ GitHub
              </label>
              <input
                type="text"
                value={ghOwner}
                onChange={(e) => setGhOwner(e.target.value)}
                placeholder="ดึงจาก Token อัตโนมัติ"
                className="h-10 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 font-mono text-xs text-slate-900 placeholder:text-slate-400 focus:border-blue-500 focus:bg-white focus:outline-none"
              />
            </div>

            {/* Branch */}
            <div className="lg:col-span-2 space-y-1.5">
              <label className="block text-xs font-semibold text-slate-700">Branch</label>
              <input
                type="text"
                value={ghBranch}
                onChange={(e) => setGhBranch(e.target.value)}
                placeholder="main"
                className="h-10 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 font-mono text-xs text-slate-900 focus:border-blue-500 focus:bg-white focus:outline-none"
              />
            </div>
          </div>

          {/* Sync Options */}
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border border-slate-100 bg-slate-50 px-4 py-3 text-xs text-slate-700">
            <label className="inline-flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={ghPrivate}
                onChange={(e) => setGhPrivate(e.target.checked)}
                className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
              />
              <Lock className="h-3.5 w-3.5 text-slate-500" />
              <span>สร้างเป็น Private Repository</span>
            </label>

            <label className="inline-flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={ghAutoSyncCode}
                onChange={(e) => setGhAutoSyncCode(e.target.checked)}
                className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
              />
              <span>อัปโหลดไฟล์โค้ดทั้งหมดอัตโนมัติแบบเรียลไทม์เมื่อมีการแก้ไข</span>
            </label>

            <label className="inline-flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={ghSyncSignals}
                onChange={(e) => setGhSyncSignals(e.target.checked)}
                className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
              />
              <span>
                บันทึกข้อมูลสัญญาณ M15 ล่าสุด (<code className="font-mono">data/signals-log.json</code>) ขึ้น GitHub อัตโนมัติ
              </span>
            </label>
          </div>

          {/* Action Buttons & Live Status */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2.5">
              <button
                type="submit"
                disabled={ghSaving || ghTogglingAllow || ghSyncingNow}
                className="inline-flex h-10 items-center gap-2 rounded-lg bg-slate-900 px-4 text-xs font-semibold text-white transition-colors hover:bg-slate-800 disabled:opacity-60"
              >
                <GitBranch className="h-4 w-4" />
                {ghSaving
                  ? 'กำลังบันทึก...'
                  : ghStatus?.connected
                  ? 'บันทึกการเชื่อมต่อ GitHub'
                  : 'เชื่อมต่อ GitHub.com'}
              </button>

              <button
                type="button"
                disabled={ghSaving || ghTogglingAllow || ghSyncingNow}
                onClick={() => void handleToggleUploadPermission()}
                className={`inline-flex h-10 items-center gap-2 rounded-lg px-4 text-xs font-semibold transition-colors disabled:opacity-60 ${
                  ghUploadAllowed
                    ? 'bg-emerald-600 text-white hover:bg-emerald-700'
                    : 'border border-amber-300 bg-amber-50 text-amber-900 hover:bg-amber-100'
                }`}
              >
                {ghUploadAllowed ? (
                  <>
                    <ShieldCheck className="h-4 w-4" />
                    อนุญาตอัปโหลดแล้ว (คลิกเพื่อปิด)
                  </>
                ) : (
                  <>
                    <ShieldCheck className="h-4 w-4" />
                    อนุญาตอัปโหลดขึ้น GitHub
                  </>
                )}
              </button>

              {ghStatus?.connected && (
                <>
                  <button
                    type="button"
                    disabled={ghSaving || ghTogglingAllow || ghSyncingNow || !ghUploadAllowed}
                    onClick={() => void handleSyncGithubNow()}
                    className="inline-flex h-10 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-4 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <UploadCloud
                      className={`h-4 w-4 ${ghSyncingNow ? 'animate-pulse' : ''}`}
                    />
                    {ghSyncingNow ? 'กำลังอัปโหลด...' : 'อัปโหลดขึ้น GitHub ตอนนี้'}
                  </button>

                  <button
                    type="button"
                    disabled={ghSaving || ghTogglingAllow || ghSyncingNow}
                    onClick={() => void handleDisconnectGithub()}
                    className="inline-flex h-10 items-center gap-1.5 rounded-lg border border-rose-200 bg-white px-3.5 text-xs font-medium text-rose-700 transition-colors hover:bg-rose-50 disabled:opacity-60"
                  >
                    <Unlink className="h-3.5 w-3.5" />
                    ยกเลิกเชื่อมต่อ
                  </button>
                </>
              )}
            </div>

            {ghStatus?.connected && ghStatus.repoUrl && (
              <div className="flex flex-wrap items-center gap-4 text-xs text-slate-600">
                <span>
                  จำนวนไฟล์ที่ซิงค์:{' '}
                  <strong className="font-mono text-slate-900">
                    {ghStatus.fileCount}
                  </strong>
                </span>
                {formattedLastSync && (
                  <span>
                    อัปเดตล่าสุด:{' '}
                    <strong className="font-mono text-slate-900">
                      {formattedLastSync} น.
                    </strong>
                  </span>
                )}
                <a
                  href={ghStatus.repoUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 font-medium text-blue-600 hover:underline"
                >
                  เปิดดู Repo <ExternalLink className="h-3.5 w-3.5" />
                </a>
                {ghStatus.lastCommitUrl && (
                  <a
                    href={ghStatus.lastCommitUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 font-medium text-emerald-700 hover:underline"
                  >
                    Commit ล่าสุด <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                )}
              </div>
            )}
          </div>

          {ghFeedback && (
            <div
              className={`flex items-start gap-2 rounded-lg border px-3.5 py-2.5 text-xs ${
                ghFeedback.type === 'success'
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                  : 'border-rose-200 bg-rose-50 text-rose-800'
              }`}
            >
              {ghFeedback.type === 'success' ? (
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
              ) : (
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              )}
              <span>{ghFeedback.text}</span>
            </div>
          )}

          {ghStatus?.lastError && !ghFeedback && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-xs text-amber-800">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>สถานะซิงค์ล่าสุด: {ghStatus.lastError}</span>
            </div>
          )}

          <p className="text-xs leading-relaxed text-slate-600">
            ความปลอดภัย: ระบบตัดไฟล์ลับ (<code className="font-mono">.env</code>,{' '}
            <code className="font-mono">.data/</code>, Bot Token และ GitHub Token)
            ออกก่อนอัปโหลดขึ้น GitHub ทุกครั้งเพื่อไม่ให้รหัสผ่านรั่วไหล
          </p>
        </form>
      </section>

      {/* Bottom Grid: ZIP Download & 24/7 Cloud Hosting Guide */}
      <section className="grid grid-cols-1 gap-6 lg:grid-cols-12 items-start">
        {/* Left: One-click ZIP Download & Run Commands */}
        <div className="lg:col-span-7 space-y-5 rounded-xl border border-slate-200/90 bg-white p-6">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-4">
            <div className="flex items-center gap-2.5">
              <FileArchive className="h-5 w-5 text-blue-600" />
              <div>
                <h2 className="text-base font-semibold text-slate-900">
                  ดาวน์โหลดซอร์สโค้ด (.zip) ขึ้น Server เอง
                </h2>
                <p className="mt-0.5 text-[13px] text-slate-600">
                  แพ็กเกจเต็มพร้อมไฟล์ server.ts, หน้าเว็บ React, Dockerfile และ render.yaml
                </p>
              </div>
            </div>
            {fileCount !== null && (
              <span className="font-mono text-xs font-medium text-slate-600 tabular-nums">
                {fileCount} ไฟล์
              </span>
            )}
          </div>

          <div className="rounded-xl bg-blue-50/70 p-4 sm:p-5 space-y-3.5">
            <p className="text-[13px] text-slate-700 leading-relaxed">
              ไฟล์ <strong>.zip</strong> นี้ตัดข้อมูลชั่วคราว (<code>node_modules</code>,{' '}
              <code>.data</code>, และ secret ส่วนตัว) ออกเรียบร้อยแล้ว สามารถแตกไฟล์ไปติดตั้งบน{' '}
              <strong>Render, Railway, Fly.io, Docker</strong> หรือ <strong>VPS</strong> ได้ทันที
            </p>
            <button
              type="button"
              disabled={downloading}
              onClick={() => void handleDownloadZip()}
              className="inline-flex h-10 items-center gap-2 rounded-lg bg-blue-600 px-5 text-[13px] font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-60"
            >
              <Download className="h-4 w-4" />
              {downloading
                ? 'กำลังเตรียมไฟล์ .zip...'
                : 'ดาวน์โหลดโค้ดทั้งหมด (ao-signal-studio-server.zip)'}
            </button>
            {downloadErr && (
              <p className="text-xs text-rose-700">{downloadErr}</p>
            )}
          </div>

          {/* Commands to Run on Any Server */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-800">
                <Terminal className="h-3.5 w-3.5 text-slate-500" />
                <span>คำสั่งติดตั้งและรันจริง (Node.js 22+)</span>
              </div>
              <button
                type="button"
                onClick={() => void handleCopy('cmds', runCommands)}
                className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:underline"
              >
                {copiedId === 'cmds' ? (
                  <>
                    <Check className="h-3.5 w-3.5" />
                    คัดลอกแล้ว
                  </>
                ) : (
                  <>
                    <Copy className="h-3.5 w-3.5" />
                    คัดลอกคำสั่ง
                  </>
                )}
              </button>
            </div>
            <pre className="overflow-x-auto rounded-lg bg-slate-900 p-3.5 font-mono text-xs text-slate-100 leading-relaxed">
              {runCommands}
            </pre>
            <p className="text-[11px] text-slate-500">
              หมายเหตุ: หากเซิร์ฟเวอร์ใช้ Node 18 หรือ 20 ให้รันด้วย{' '}
              <code className="font-mono text-slate-700">
                NODE_ENV=production npx tsx server.ts
              </code>
            </p>
          </div>

          {/* .env Template */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-800">
                ค่า Environment Variables (.env) เพื่อให้แจ้งเตือนไม่หลุดเมื่อรีสตาร์ท
              </span>
              <button
                type="button"
                onClick={() => void handleCopy('env', envTemplate)}
                className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:underline"
              >
                {copiedId === 'env' ? (
                  <>
                    <Check className="h-3.5 w-3.5" />
                    คัดลอกแล้ว
                  </>
                ) : (
                  <>
                    <Copy className="h-3.5 w-3.5" />
                    คัดลอก .env
                  </>
                )}
              </button>
            </div>
            <pre className="overflow-x-auto rounded-lg bg-slate-900 p-3.5 font-mono text-xs text-emerald-300 leading-relaxed">
              {envTemplate}
            </pre>
          </div>
        </div>

        {/* Right: Free 24/7 Cloud Hosting Guide + File List */}
        <div className="lg:col-span-5 space-y-5">
          <div className="rounded-xl border border-slate-200/90 bg-white p-5 sm:p-6 space-y-3.5">
            <div className="flex items-center gap-2">
              <Cloud className="h-4 w-4 text-blue-600" />
              <h3 className="text-[15px] font-semibold text-slate-900">
                วิธีนำไปรันฟรี 24 ชม. บน Render / Railway
              </h3>
            </div>
            <ol className="space-y-2.5 text-[13px] text-slate-600 list-decimal list-inside leading-relaxed">
              <li>
                เชื่อมต่อ <strong>GitHub.com</strong> ด้านบนเพื่อให้โค้ดทั้งหมดอัปโหลดขึ้น Repo อัตโนมัติ
                (หรือแตกไฟล์ <strong>.zip</strong> อัปโหลดขึ้นเองก็ได้)
              </li>
              <li>
                ไปที่ <strong>Render.com</strong> → New Web Service → เลือก Repo ที่ซิงค์ไว้ (ระบบจะอ่าน{' '}
                <code className="font-mono text-slate-800">render.yaml</code> และ Deploy ให้อัตโนมัติทุกครั้งที่โค้ดอัปเดต)
              </li>
              <li>
                ใส่ค่า <code className="font-mono text-slate-800">TELEGRAM_BOT_TOKEN</code> และ{' '}
                <code className="font-mono text-slate-800">TELEGRAM_CHAT_ID</code> ใน{' '}
                <strong>Environment Variables</strong>
              </li>
              <li>
                ตั้ง <strong>UptimeRobot</strong> (ฟรี) ให้เรียก{' '}
                <code className="font-mono text-slate-800">https://โดเมนของคุณ/api/health</code>{' '}
                ทุก 5 นาที เพื่อกัน Render Free Tier หลับ ระบบจะได้เฝ้า M15 และส่งเข้า Telegram ตลอด 24 ชม.
              </li>
            </ol>
          </div>

          <div className="rounded-xl border border-slate-200/90 bg-white p-5 sm:p-6 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Server className="h-4 w-4 text-slate-600" />
                <h3 className="text-[15px] font-semibold text-slate-900">
                  ไฟล์โค้ดที่จะถูกซิงค์ขึ้น GitHub
                </h3>
              </div>
              <span className="font-mono text-xs text-slate-500 tabular-nums">
                {filesPreview.length} + signals-log.json
              </span>
            </div>
            {filesPreview.length > 0 ? (
              <div className="max-h-56 overflow-y-auto rounded-lg bg-slate-50 p-3.5 font-mono text-xs text-slate-700 space-y-1">
                {filesPreview.map((file) => (
                  <div key={file}>{file}</div>
                ))}
                <div className="text-blue-700 font-medium">data/signals-log.json (อัปเดตสัญญาณ M15)</div>
              </div>
            ) : (
              <p className="text-[13px] text-slate-500">กำลังโหลดรายการไฟล์...</p>
            )}
          </div>
        </div>
      </section>
    </div>
  );
};
