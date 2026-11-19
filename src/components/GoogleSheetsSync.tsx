import React, { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import type { User } from 'firebase/auth';
import {
  Check,
  CheckCircle2,
  FileSpreadsheet,
  FolderPlus,
  Link2,
  LogOut,
  RefreshCw,
  UploadCloud,
  ExternalLink,
  Plus,
} from 'lucide-react';
import {
  getAccessToken,
  googleSignIn,
  initAuth,
  logout,
} from '../lib/googleAuth';
import {
  SignalLogRecord,
  SpreadsheetMetadata,
  appendSignalRows,
  createSignalSpreadsheet,
  extractSpreadsheetId,
  getSpreadsheetMetadata,
  readSheetValues,
} from '../lib/sheetsApi';
import { ConfirmDialog } from './ConfirmDialog';

interface GoogleSheetsSyncProps {
  pendingSignals: SignalLogRecord[];
  onMarkSignalsSynced: (ids: string[]) => void;
  onAddManualTestSignal: () => void;
}

type PendingMutation =
  | { type: 'create'; title: string }
  | { type: 'append'; records: SignalLogRecord[]; sheetTitle: string }
  | null;

export const GoogleSheetsSync: React.FC<GoogleSheetsSyncProps> = ({
  pendingSignals,
  onMarkSignalsSynced,
  onAddManualTestSignal,
}) => {
  const [needsAuth, setNeedsAuth] = useState(true);
  const [user, setUser] = useState<User | null>(null);
  const [isLoggingIn, setIsLoggingIn] = useState(false);

  const [sheetUrlInput, setSheetUrlInput] = useState('');
  const [newSheetTitle, setNewSheetTitle] = useState('AO M5 Signal Logbook');
  const [spreadsheet, setSpreadsheet] = useState<SpreadsheetMetadata | null>(null);
  const [selectedTab, setSelectedTab] = useState<string>('');
  const [sheetRows, setSheetRows] = useState<string[][]>([]);

  const [isLoadingSheet, setIsLoadingSheet] = useState(false);
  const [isMutating, setIsMutating] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  const [pendingMutation, setPendingMutation] = useState<PendingMutation>(null);
  const [manualAddedFeedback, setManualAddedFeedback] = useState(false);
  const [recentAddedIds, setRecentAddedIds] = useState<Set<string>>(() => new Set());
  const [syncSuccessInfo, setSyncSuccessInfo] = useState<{
    count: number;
    sheetTitle: string;
    token: number;
  } | null>(null);

  const manualFeedbackTimerRef = useRef<number | null>(null);
  const syncSuccessTimerRef = useRef<number | null>(null);
  const knownSignalIdsRef = useRef<Set<string>>(new Set(pendingSignals.map((s) => s.id)));

  useEffect(() => {
    const newIds: string[] = [];
    for (const sig of pendingSignals) {
      if (!knownSignalIdsRef.current.has(sig.id)) {
        knownSignalIdsRef.current.add(sig.id);
        newIds.push(sig.id);
      }
    }
    if (newIds.length === 0) return;

    setRecentAddedIds((prev) => {
      const next = new Set(prev);
      for (const id of newIds) next.add(id);
      return next;
    });

    const timer = window.setTimeout(() => {
      setRecentAddedIds((prev) => {
        const next = new Set(prev);
        for (const id of newIds) next.delete(id);
        return next;
      });
    }, 1400);

    return () => window.clearTimeout(timer);
  }, [pendingSignals]);

  useEffect(() => {
    return () => {
      if (manualFeedbackTimerRef.current !== null) {
        window.clearTimeout(manualFeedbackTimerRef.current);
      }
      if (syncSuccessTimerRef.current !== null) {
        window.clearTimeout(syncSuccessTimerRef.current);
      }
    };
  }, []);

  const handleAddManualClick = () => {
    onAddManualTestSignal();
    setManualAddedFeedback(true);
    if (manualFeedbackTimerRef.current !== null) {
      window.clearTimeout(manualFeedbackTimerRef.current);
    }
    manualFeedbackTimerRef.current = window.setTimeout(() => {
      setManualAddedFeedback(false);
      manualFeedbackTimerRef.current = null;
    }, 1300);
  };

  useEffect(() => {
    const unsub = initAuth(
      (authedUser) => {
        setUser(authedUser);
        setNeedsAuth(false);
      },
      (maybeUser) => {
        setUser(maybeUser);
        setNeedsAuth(true);
      }
    );
    return () => unsub();
  }, []);

  const handleLogin = async () => {
    setIsLoggingIn(true);
    setErrorMsg(null);
    try {
      const result = await googleSignIn();
      setUser(result.user);
      setNeedsAuth(false);
    } catch (err: any) {
      setErrorMsg(err?.message || 'ไม่สามารถเข้าสู่ระบบ Google ได้');
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleLogout = async () => {
    await logout();
    setUser(null);
    setNeedsAuth(true);
    setSpreadsheet(null);
    setSelectedTab('');
    setSheetRows([]);
    setStatusMsg(null);
  };

  const requireToken = (): string | null => {
    const token = getAccessToken();
    if (!token) {
      setNeedsAuth(true);
      setErrorMsg('เซสชันการเชื่อมต่อ Google Sheets หมดอายุ กรุณาเข้าสู่ระบบใหม่อีกครั้ง');
      return null;
    }
    return token;
  };

  const loadRowsForTab = async (
    token: string,
    spreadsheetId: string,
    tabTitle: string
  ) => {
    setIsLoadingSheet(true);
    setErrorMsg(null);
    try {
      const rows = await readSheetValues(token, spreadsheetId, tabTitle);
      setSheetRows(rows);
    } catch (err: any) {
      if (err?.status === 401) {
        setNeedsAuth(true);
      }
      setErrorMsg(err?.message || 'ไม่สามารถอ่านข้อมูลจาก Google Sheet ได้');
    } finally {
      setIsLoadingSheet(false);
    }
  };

  const handleConnectExisting = async (e: React.FormEvent) => {
    e.preventDefault();
    const token = requireToken();
    if (!token) return;

    const id = extractSpreadsheetId(sheetUrlInput);
    if (!id) {
      setErrorMsg('กรุณากรอก URL หรือ Spreadsheet ID ของ Google Sheets');
      return;
    }

    setIsLoadingSheet(true);
    setErrorMsg(null);
    setStatusMsg(null);

    try {
      const meta = await getSpreadsheetMetadata(token, id);
      setSpreadsheet(meta);
      const firstTab = meta.sheets[0]?.title || '';
      setSelectedTab(firstTab);
      if (firstTab) {
        await loadRowsForTab(token, meta.spreadsheetId, firstTab);
      }
      setStatusMsg(`เชื่อมต่อไฟล์ “${meta.title}” สำเร็จ`);
    } catch (err: any) {
      if (err?.status === 401) setNeedsAuth(true);
      setErrorMsg(err?.message || 'ไม่พบ Spreadsheet หรือไม่มีสิทธิ์เข้าถึง');
    } finally {
      setIsLoadingSheet(false);
    }
  };

  const handleSelectTab = async (tabTitle: string) => {
    setSelectedTab(tabTitle);
    const token = requireToken();
    if (!token || !spreadsheet) return;
    await loadRowsForTab(token, spreadsheet.spreadsheetId, tabTitle);
  };

  const handleRefreshSheet = async () => {
    const token = requireToken();
    if (!token || !spreadsheet || !selectedTab) return;
    await loadRowsForTab(token, spreadsheet.spreadsheetId, selectedTab);
  };

  const executeConfirmedMutation = async () => {
    if (!pendingMutation) return;
    const token = requireToken();
    if (!token) {
      setPendingMutation(null);
      return;
    }

    setIsMutating(true);
    setErrorMsg(null);
    setStatusMsg(null);

    try {
      if (pendingMutation.type === 'create') {
        const meta = await createSignalSpreadsheet(token, pendingMutation.title);
        setSpreadsheet(meta);
        const firstTab = meta.sheets[0]?.title || '';
        setSelectedTab(firstTab);
        setSheetUrlInput(meta.spreadsheetUrl);
        if (firstTab) {
          await loadRowsForTab(token, meta.spreadsheetId, firstTab);
        }
        setStatusMsg(`สร้าง Google Sheet “${meta.title}” พร้อมคอลัมน์บันทึกสัญญาณแล้ว`);
      } else if (pendingMutation.type === 'append' && spreadsheet) {
        const updatedCount = await appendSignalRows(
          token,
          spreadsheet.spreadsheetId,
          pendingMutation.sheetTitle,
          pendingMutation.records
        );
        onMarkSignalsSynced(pendingMutation.records.map((r) => r.id));
        await loadRowsForTab(
          token,
          spreadsheet.spreadsheetId,
          pendingMutation.sheetTitle
        );
        setStatusMsg(
          `บันทึกสัญญาณจำนวน ${updatedCount} แถวลงแท็บ “${pendingMutation.sheetTitle}” เรียบร้อยแล้ว`
        );
        setSyncSuccessInfo({
          count: updatedCount,
          sheetTitle: pendingMutation.sheetTitle,
          token: Date.now(),
        });
        if (syncSuccessTimerRef.current !== null) {
          window.clearTimeout(syncSuccessTimerRef.current);
        }
        syncSuccessTimerRef.current = window.setTimeout(() => {
          setSyncSuccessInfo(null);
          syncSuccessTimerRef.current = null;
        }, 3500);
      }
    } catch (err: any) {
      if (err?.status === 401) setNeedsAuth(true);
      setErrorMsg(err?.message || 'เกิดข้อผิดพลาดระหว่างการบันทึกข้อมูลลง Google Sheets');
    } finally {
      setIsMutating(false);
      setPendingMutation(null);
    }
  };

  const unsyncedSignals = pendingSignals.filter((s) => !s.syncedToSheet);

  if (needsAuth) {
    return (
      <section className="rounded-xl border border-slate-200/90 bg-white p-10 sm:p-12">
        <div className="mx-auto max-w-md text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-slate-100 text-slate-700">
            <FileSpreadsheet className="h-6 w-6" />
          </div>
          <h2 className="mt-4 text-lg font-semibold text-slate-900">
            เชื่อมต่อ Google Sheets
          </h2>
          <p className="mt-2 text-[13px] leading-relaxed text-slate-600">
            เข้าสู่ระบบด้วยบัญชี Google เพื่อบันทึกและดูประวัติสัญญาณ AO M5 แบบเป็นระเบียบ
          </p>

          {errorMsg && (
            <div className="mt-4 rounded-lg border border-rose-200 bg-rose-50 px-4 py-2.5 text-xs text-rose-800">
              {errorMsg}
            </div>
          )}

          <div className="mt-6 flex justify-center">
            <button
              type="button"
              onClick={handleLogin}
              disabled={isLoggingIn}
              className="gsi-material-button"
            >
              <div className="gsi-material-button-state" />
              <div className="gsi-material-button-content-wrapper">
                <div className="gsi-material-button-icon">
                  <svg
                    version="1.1"
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 48 48"
                    style={{ display: 'block' }}
                  >
                    <path
                      fill="#EA4335"
                      d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
                    />
                    <path
                      fill="#4285F4"
                      d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
                    />
                    <path
                      fill="#FBBC05"
                      d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
                    />
                    <path
                      fill="#34A853"
                      d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
                    />
                    <path fill="none" d="M0 0h48v48H0z" />
                  </svg>
                </div>
                <span className="gsi-material-button-contents">
                  {isLoggingIn ? 'กำลังเข้าสู่ระบบ...' : 'Sign in with Google'}
                </span>
              </div>
            </button>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="space-y-6">
      {/* Account & Spreadsheet Connection Header */}
      <div className="rounded-xl border border-slate-200/90 bg-white p-5 sm:p-6">
        <div className="flex flex-col gap-3 border-b border-slate-100 pb-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              Google Sheets
            </h2>
            <p className="mt-0.5 text-[13px] text-slate-600">
              {user?.displayName || 'Google User'} · {user?.email}
            </p>
          </div>

          <button
            type="button"
            onClick={handleLogout}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3.5 text-xs font-medium text-slate-700 whitespace-nowrap transition-colors hover:bg-slate-50"
          >
            <LogOut className="h-3.5 w-3.5" />
            ออกจากระบบ
          </button>
        </div>

        {/* Two ways to connect: Create New OR Connect Existing */}
        <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-2">
          {/* Create New Sheet */}
          <div className="rounded-xl bg-slate-50/90 p-4">
            <label
              htmlFor="new-sheet-title"
              className="block text-[13px] font-medium text-slate-700"
            >
              สร้างไฟล์ใหม่
            </label>
            <div className="mt-2.5 flex gap-2">
              <input
                id="new-sheet-title"
                type="text"
                value={newSheetTitle}
                onChange={(e) => setNewSheetTitle(e.target.value)}
                placeholder="AO M5 Signal Logbook"
                className="h-10 flex-1 rounded-lg border border-slate-200 bg-white px-3.5 text-[13px] text-slate-900 focus:border-blue-600 focus:outline-none"
              />
              <button
                type="button"
                disabled={!newSheetTitle.trim() || isMutating}
                onClick={() =>
                  setPendingMutation({
                    type: 'create',
                    title: newSheetTitle.trim(),
                  })
                }
                className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-blue-600 px-4 text-[13px] font-medium text-white whitespace-nowrap transition-colors hover:bg-blue-700 disabled:opacity-50"
              >
                <FolderPlus className="h-4 w-4" />
                สร้างใหม่
              </button>
            </div>
          </div>

          {/* Connect Existing Sheet */}
          <form
            onSubmit={handleConnectExisting}
            className="rounded-xl bg-slate-50/90 p-4"
          >
            <label
              htmlFor="existing-sheet-url"
              className="block text-[13px] font-medium text-slate-700"
            >
              เชื่อมต่อไฟล์ที่มีอยู่ (URL / ID)
            </label>
            <div className="mt-2.5 flex gap-2">
              <input
                id="existing-sheet-url"
                type="text"
                value={sheetUrlInput}
                onChange={(e) => setSheetUrlInput(e.target.value)}
                placeholder="https://docs.google.com/spreadsheets/d/..."
                className="h-10 flex-1 rounded-lg border border-slate-200 bg-white px-3.5 font-mono text-xs text-slate-900 focus:border-blue-600 focus:outline-none"
              />
              <button
                type="submit"
                disabled={isLoadingSheet}
                className="inline-flex h-10 items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-4 text-[13px] font-medium text-slate-800 whitespace-nowrap transition-colors hover:bg-slate-100 disabled:opacity-50"
              >
                <Link2 className="h-4 w-4" />
                เชื่อมต่อ
              </button>
            </div>
          </form>
        </div>

        <AnimatePresence mode="wait">
          {errorMsg && (
            <motion.div
              key={`err-${errorMsg}`}
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.2 }}
              className="mt-4 rounded-lg border border-rose-200 bg-rose-50 px-4 py-2.5 text-xs text-rose-800"
            >
              {errorMsg}
            </motion.div>
          )}
          {statusMsg && (
            <motion.div
              key={`ok-${statusMsg}`}
              initial={{ opacity: 0, y: -6, scale: 0.99 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
              className="mt-4 flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-xs text-emerald-800"
            >
              <motion.span
                initial={{ scale: 0.5, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ type: 'spring', stiffness: 420, damping: 22 }}
                className="inline-flex shrink-0 text-emerald-600"
              >
                <CheckCircle2 className="h-4 w-4" />
              </motion.span>
              <span>{statusMsg}</span>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Pending Signals Queue & Sheet Viewer */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12 items-start">
        {/* Local Signal Queue ready to sync */}
        <div className="lg:col-span-4 rounded-xl border border-slate-200 bg-white p-5">
          <div className="flex items-center justify-between border-b border-slate-100 pb-3">
            <h3 className="flex items-center gap-1.5 text-sm font-semibold text-slate-900">
              <span>คิวรอบันทึก</span>
              <motion.span
                key={unsyncedSignals.length}
                initial={{ scale: 1.18, color: '#059669' }}
                animate={{ scale: 1, color: '#0f172a' }}
                transition={{ duration: 0.28, ease: 'easeOut' }}
                className="tabular-nums"
              >
                ({unsyncedSignals.length})
              </motion.span>
            </h3>
            <motion.button
              type="button"
              whileTap={{ scale: 0.96 }}
              onClick={handleAddManualClick}
              className={`inline-flex h-8 items-center gap-1 rounded-lg border px-2.5 text-xs font-medium transition-colors ${
                manualAddedFeedback
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                  : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
              }`}
            >
              <AnimatePresence mode="wait" initial={false}>
                {manualAddedFeedback ? (
                  <motion.span
                    key="added"
                    initial={{ scale: 0.6, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    exit={{ scale: 0.6, opacity: 0 }}
                    transition={{ duration: 0.16 }}
                    className="inline-flex items-center gap-1"
                  >
                    <Check className="h-3.5 w-3.5 text-emerald-600" />
                    เพิ่มแล้ว
                  </motion.span>
                ) : (
                  <motion.span
                    key="idle"
                    initial={{ scale: 0.9, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    exit={{ scale: 0.9, opacity: 0 }}
                    transition={{ duration: 0.16 }}
                    className="inline-flex items-center gap-1"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    เพิ่มตัวอย่าง
                  </motion.span>
                )}
              </AnimatePresence>
            </motion.button>
          </div>

          <AnimatePresence mode="wait" initial={false}>
            {unsyncedSignals.length === 0 ? (
              syncSuccessInfo ? (
                <motion.div
                  key={`synced-${syncSuccessInfo.token}`}
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.97 }}
                  transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
                  className="py-7 text-center"
                >
                  <div className="relative mx-auto flex h-10 w-10 items-center justify-center">
                    <motion.span
                      initial={{ scale: 0.7, opacity: 0.6 }}
                      animate={{ scale: 1.55, opacity: 0 }}
                      transition={{ duration: 0.9, ease: 'easeOut' }}
                      className="absolute inset-0 rounded-full bg-emerald-200"
                    />
                    <motion.div
                      initial={{ scale: 0.6, opacity: 0 }}
                      animate={{ scale: 1, opacity: 1 }}
                      transition={{ type: 'spring', stiffness: 400, damping: 20 }}
                      className="relative flex h-10 w-10 items-center justify-center rounded-full bg-emerald-50 text-emerald-600"
                    >
                      <CheckCircle2 className="h-5 w-5" />
                    </motion.div>
                  </div>
                  <p className="mt-2.5 text-xs font-medium text-emerald-700">
                    ส่งลง Google Sheets สำเร็จ
                  </p>
                  <p className="mt-0.5 text-[11px] text-slate-500">
                    บันทึกแล้ว {syncSuccessInfo.count} รายการใน “{syncSuccessInfo.sheetTitle}”
                  </p>
                </motion.div>
              ) : (
                <motion.div
                  key="empty-queue"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.2 }}
                  className="py-8 text-center"
                >
                  <p className="text-xs text-slate-400">ยังไม่มีสัญญาณค้างส่ง</p>
                </motion.div>
              )
            ) : (
              <motion.div
                key="queue-list"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.18 }}
                className="mt-3 space-y-2.5"
              >
                <ul className="divide-y divide-slate-100 max-h-72 overflow-y-auto">
                  <AnimatePresence initial={false}>
                    {unsyncedSignals.map((sig) => {
                      const isNewlyAdded = recentAddedIds.has(sig.id);
                      return (
                        <motion.li
                          key={sig.id}
                          layout
                          initial={{ opacity: 0, y: -10, scale: 0.98 }}
                          animate={{
                            opacity: 1,
                            y: 0,
                            scale: 1,
                            backgroundColor: isNewlyAdded
                              ? ['rgba(236, 253, 245, 0.9)', 'rgba(236, 253, 245, 0)']
                              : 'rgba(255, 255, 255, 0)',
                          }}
                          exit={{ opacity: 0, x: 14, scale: 0.97 }}
                          transition={{
                            duration: 0.24,
                            ease: [0.16, 1, 0.3, 1],
                            backgroundColor: { duration: 1.2, ease: 'easeOut' },
                          }}
                          className="rounded-md px-1.5 py-2.5 text-xs"
                        >
                          <div className="flex items-center justify-between">
                            <span className="font-semibold text-slate-900">
                              <span
                                className={
                                  sig.signal === 'BUY'
                                    ? 'text-emerald-700'
                                    : 'text-rose-700'
                                }
                              >
                                {sig.signal}
                              </span>{' '}
                              · {sig.symbol} · {sig.timeframe}
                            </span>
                            <span className="font-mono text-slate-500 tabular-nums">
                              {sig.price}
                            </span>
                          </div>
                          <p className="mt-1 font-mono text-[11px] text-slate-400 tabular-nums">
                            AO {sig.aoPrev.toFixed(5)} → {sig.aoCurr.toFixed(5)}
                          </p>
                        </motion.li>
                      );
                    })}
                  </AnimatePresence>
                </ul>

                <button
                  type="button"
                  disabled={!spreadsheet || !selectedTab || isMutating}
                  onClick={() => {
                    if (!spreadsheet || !selectedTab) return;
                    setPendingMutation({
                      type: 'append',
                      records: unsyncedSignals,
                      sheetTitle: selectedTab,
                    });
                  }}
                  className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 text-xs font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <UploadCloud className="h-4 w-4" />
                  {spreadsheet
                    ? `บันทึก ${unsyncedSignals.length} รายการลง Sheet`
                    : 'เชื่อมต่อ Sheet ก่อนบันทึก'}
                </button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Connected Google Sheet Data Grid */}
        <div className="lg:col-span-8 rounded-xl border border-slate-200/90 bg-white overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-4">
            <div className="flex flex-wrap items-center gap-3">
              <h3 className="text-[15px] font-semibold text-slate-900">
                {spreadsheet ? spreadsheet.title : 'ตารางข้อมูล Google Sheets'}
              </h3>
              {spreadsheet && (
                <a
                  href={spreadsheet.spreadsheetUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs font-semibold text-blue-600 hover:underline"
                >
                  เปิดไฟล์
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              )}
              <AnimatePresence>
                {syncSuccessInfo && (
                  <motion.span
                    key={`badge-${syncSuccessInfo.token}`}
                    initial={{ opacity: 0, scale: 0.9, y: -2 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.92 }}
                    transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
                    className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700"
                  >
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    อัปเดต +{syncSuccessInfo.count} แถว
                  </motion.span>
                )}
              </AnimatePresence>
            </div>

            {spreadsheet && (
              <div className="flex items-center gap-2">
                <select
                  aria-label="เลือกแท็บชีต"
                  value={selectedTab}
                  onChange={(e) => handleSelectTab(e.target.value)}
                  className="h-9 rounded-lg border border-slate-200 bg-white px-3 text-xs font-medium text-slate-800 focus:border-blue-600 focus:outline-none"
                >
                  {spreadsheet.sheets.map((tab) => (
                    <option key={tab.sheetId} value={tab.title}>
                      {tab.title}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={handleRefreshSheet}
                  disabled={isLoadingSheet}
                  className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-50"
                >
                  <RefreshCw
                    className={`h-3.5 w-3.5 ${isLoadingSheet ? 'animate-spin' : ''}`}
                  />
                  รีเฟรช
                </button>
              </div>
            )}
          </div>

          {!spreadsheet ? (
            <div className="p-12 text-center">
              <p className="text-[13px] text-slate-500">
                สร้างไฟล์ใหม่หรือวางลิงก์ Google Sheet ด้านบนเพื่อดูและบันทึกข้อมูล
              </p>
            </div>
          ) : isLoadingSheet ? (
            <div className="p-5 space-y-2.5">
              {[0, 1, 2, 3].map((row) => (
                <div
                  key={row}
                  className="h-10 w-full animate-pulse rounded bg-slate-100"
                />
              ))}
            </div>
          ) : sheetRows.length === 0 ? (
            <div className="p-12 text-center">
              <p className="text-[13px] text-slate-500">
                แท็บ “{selectedTab}” ยังไม่มีข้อมูล
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left text-[13px]">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-xs text-slate-600">
                    {(sheetRows[0] || []).map((header, idx) => (
                      <th
                        key={idx}
                        className="px-4 py-3 font-semibold whitespace-nowrap"
                      >
                        {header}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {sheetRows.slice(1).map((row, rIdx, dataRows) => {
                    const isFreshSyncedRow =
                      syncSuccessInfo !== null &&
                      syncSuccessInfo.sheetTitle === selectedTab &&
                      rIdx >= dataRows.length - syncSuccessInfo.count;

                    return (
                      <motion.tr
                        key={
                          isFreshSyncedRow
                            ? `fresh-${rIdx}-${syncSuccessInfo?.token}`
                            : `row-${rIdx}`
                        }
                        initial={
                          isFreshSyncedRow
                            ? {
                                opacity: 0.4,
                                backgroundColor: 'rgba(16, 185, 129, 0.16)',
                              }
                            : false
                        }
                        animate={
                          isFreshSyncedRow
                            ? {
                                opacity: 1,
                                backgroundColor: 'rgba(16, 185, 129, 0)',
                              }
                            : undefined
                        }
                        transition={{ duration: 1.6, ease: 'easeOut' }}
                        className="hover:bg-slate-50/80"
                      >
                        {row.map((cell, cIdx) => {
                          const isSignalCol = cIdx === 3;
                          const isNumeric = cIdx >= 4 && cIdx <= 6;
                          return (
                            <td
                              key={cIdx}
                              className={`px-4 py-3 whitespace-nowrap ${
                                isNumeric ? 'font-mono text-xs tabular-nums text-right' : ''
                              } ${
                                isSignalCol && cell === 'BUY'
                                  ? 'font-semibold text-emerald-700'
                                  : isSignalCol && cell === 'SELL'
                                  ? 'font-semibold text-rose-700'
                                  : 'text-slate-700'
                              }`}
                            >
                              {cell}
                            </td>
                          );
                        })}
                      </motion.tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Mandatory Explicit Confirmation Modal before creating or mutating Google Sheets */}
      <ConfirmDialog
        open={pendingMutation !== null}
        isBusy={isMutating}
        title={
          pendingMutation?.type === 'create'
            ? `ยืนยันการสร้าง Google Sheet “${pendingMutation.title}”`
            : 'ยืนยันการบันทึกสัญญาณลง Google Sheets'
        }
        description={
          pendingMutation?.type === 'create'
            ? 'ระบบจะสร้างไฟล์ Google Spreadsheet ใหม่ในบัญชี Google ของคุณ พร้อมหัวตารางสำหรับเก็บสัญญาณ AO M5'
            : `ระบบจะเพิ่มแถวข้อมูลสัญญาณ AO M5 จำนวน ${
                pendingMutation?.type === 'append'
                  ? pendingMutation.records.length
                  : 0
              } รายการ ต่อท้ายข้อมูลเดิมในแท็บ “${
                pendingMutation?.type === 'append'
                  ? pendingMutation.sheetTitle
                  : ''
              }”`
        }
        details={
          pendingMutation?.type === 'create'
            ? [
                `ชื่อไฟล์: ${pendingMutation.title}`,
                `ชื่อแท็บเริ่มต้น: AO_M5_Signals`,
                `คอลัมน์: Timestamp, Symbol, Timeframe, Signal, AO Previous, AO Current, Close Price, Push Status, Notes`,
              ]
            : pendingMutation?.type === 'append'
            ? pendingMutation.records.map(
                (r) =>
                  `${r.timestamp} | ${r.symbol} ${r.timeframe} ${r.signal} | AO ${r.aoPrev.toFixed(
                    5
                  )} -> ${r.aoCurr.toFixed(5)} | Price ${r.price}`
              )
            : undefined
        }
        confirmLabel={
          pendingMutation?.type === 'create'
            ? 'ยืนยันสร้าง Spreadsheet'
            : 'ยืนยันบันทึกลง Sheet'
        }
        onConfirm={executeConfirmedMutation}
        onCancel={() => setPendingMutation(null)}
      />
    </section>
  );
};
