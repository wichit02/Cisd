import React, { useEffect, useState } from 'react';
import { MotionConfig } from 'motion/react';
import { ArrowLeft, Download } from 'lucide-react';
import { M15CisdChartView } from './components/M15CisdChartView';
import { MultiTimeframeStatusWindow } from './components/MultiTimeframeStatusWindow';
import { Mql5Studio } from './components/Mql5Studio';
import { AndroidSetupGuide } from './components/AndroidSetupGuide';
import { GoogleSheetsSync } from './components/GoogleSheetsSync';
import { TelegramConfig } from './components/TelegramConfig';
import { ServerDeployPanel } from './components/ServerDeployPanel';
import {
  DEFAULT_MQL5_CONFIG,
  Mql5Config,
  generateMql5Code,
  getMql5Filename,
} from './lib/mql5Generator';
import { CISD_TIMEFRAME_ORDER, type CisdTimeframe } from './lib/cisdDetector';
import type { SignalLogRecord } from './lib/sheetsApi';
import {
  OfflineIndicator,
  PWAInstallButton,
} from './components/PWAInstallButton';
import {
  loadSavedTelegramConfig,
  saveTelegramConfigLocally,
  SYSTEM_TELEGRAM_CHAT_ID,
} from './lib/telegramStorage';
import { loadSavedGithubConfig } from './lib/githubStorage';
import cisdLogoImg from './assets/images/cisd_brand_logo_1795106433027.jpg';

type ActiveSection =
  | 'm15'
  | 'mtf'
  | 'mql5'
  | 'android'
  | 'telegram'
  | 'sheets'
  | 'deploy';

const NAV_ITEMS: Array<{ id: ActiveSection; label: string }> = [
  { id: 'm15', label: 'กราฟ CISD' },
  { id: 'mtf', label: 'สถานะ M15' },
  { id: 'mql5', label: 'โค้ด MQL5' },
  { id: 'android', label: 'ตั้งค่ามือถือ' },
  { id: 'telegram', label: 'Telegram' },
  { id: 'sheets', label: 'Google Sheets' },
  { id: 'deploy', label: 'นำขึ้น Server' },
];

const SECTION_DESCRIPTIONS: Record<ActiveSection, string> = {
  m15: 'ตรวจสอบแท่งเทียนระบบ CISD Timeframe M15 พร้อมขีดเส้นและแจ้งเตือนทันที',
  mtf: 'สรุปทิศทางขึ้นหรือลงของระบบ CISD Timeframe M15 ดูง่าย สบายตา',
  mql5: 'ปรับแต่งเงื่อนไขและดาวน์โหลดโค้ด MQL5 พร้อมใช้งานใน MetaTrader 5',
  android: 'คู่มือตั้งค่า MetaTrader 5 บน Android และดาวน์โหลดไฟล์เสียงแจ้งเตือนความยาว 10 วินาที',
  telegram: 'เชื่อมต่อบอท Telegram เพื่อรับสัญญาณ CISD (M15) เข้าแชทอัตโนมัติ',
  sheets: 'เชื่อมต่อบัญชี Google เพื่อบันทึกประวัติสัญญาณ CISD ลง Google Sheets',
  deploy: 'ซิงค์โค้ดขึ้น GitHub และดาวน์โหลดแพ็กเกจสำหรับนำไปรันเฝ้ากราฟ 24 ชั่วโมงบน Server',
};

function parseInitialCisdTimeframe(): CisdTimeframe {
  if (typeof window === 'undefined') return 'M15';
  const raw = new URLSearchParams(window.location.search).get('tf')?.toUpperCase();
  if (raw && CISD_TIMEFRAME_ORDER.includes(raw as CisdTimeframe)) {
    return raw as CisdTimeframe;
  }
  return 'M15';
}

export default function App() {
  const [cisdTimeframe, setCisdTimeframe] = useState<CisdTimeframe>(
    parseInitialCisdTimeframe
  );
  const [activeSection, setActiveSection] = useState<ActiveSection>(() => {
    if (typeof window === 'undefined') return 'm15';
    const params = new URLSearchParams(window.location.search);
    const view = params.get('tab')?.toLowerCase();
    if (view === 'mtf') return 'mtf';
    if (view === 'telegram') return 'telegram';
    return 'm15';
  });
  const [mql5Config, setMql5Config] = useState<Mql5Config>(DEFAULT_MQL5_CONFIG);
  const [signals, setSignals] = useState<SignalLogRecord[]>([]);
  const [telegramSyncedReady, setTelegramSyncedReady] = useState<boolean | null>(null);
  const [devPreviewWeb, setDevPreviewWeb] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    const params = new URLSearchParams(window.location.search);
    return params.get('view') === 'web';
  });

  const forceStudio =
    typeof window !== 'undefined' &&
    ['1', 'true'].includes(
      new URLSearchParams(window.location.search).get('studio') || ''
    );
  const isWebMode = (import.meta.env.PROD && !forceStudio) || devPreviewWeb;

  useEffect(() => {
    let cancelled = false;
    const syncSavedTelegram = async () => {
      const saved = loadSavedTelegramConfig();
      if (saved && !cancelled) {
        setMql5Config((prev) => ({
          ...prev,
          enableTelegram: true,
          telegramBotToken: prev.telegramBotToken || saved.telegramBotToken,
          telegramChatId: SYSTEM_TELEGRAM_CHAT_ID,
        }));
      }
      try {
        const res = await fetch('/api/monitor/status');
        if (!res.ok) return;
        const status = await res.json();
        if (status.telegramConfigured) {
          if (!cancelled) {
            setMql5Config((prev) => ({
              ...prev,
              enableTelegram: true,
              telegramChatId: SYSTEM_TELEGRAM_CHAT_ID,
            }));
            if (saved && saved.telegramChatId !== SYSTEM_TELEGRAM_CHAT_ID) {
              saveTelegramConfigLocally({
                ...saved,
                telegramChatId: SYSTEM_TELEGRAM_CHAT_ID,
              });
            }
          }
          if (!cancelled) setTelegramSyncedReady(true);
          return;
        }
        if (saved) {
          const restoreRes = await fetch('/api/monitor/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              ...saved,
              telegramChatId: SYSTEM_TELEGRAM_CHAT_ID,
            }),
          });
          if (restoreRes.ok) {
            const restored = await restoreRes.json();
            if (!cancelled) setTelegramSyncedReady(Boolean(restored.telegramConfigured));
            return;
          }
        }
        if (!cancelled) setTelegramSyncedReady(false);
      } catch {
        // Ignore transient startup network errors
      }
    };
    void syncSavedTelegram();

    const syncSavedGithub = async () => {
      const savedGithub = loadSavedGithubConfig();
      if (!savedGithub) return;
      try {
        const res = await fetch('/api/github/status');
        if (!res.ok) return;
        const status = await res.json();
        if (status.connected) return;
        await fetch('/api/github/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...savedGithub,
            syncImmediately: false,
          }),
        });
      } catch {
        // Ignore transient startup network errors
      }
    };
    void syncSavedGithub();

    return () => {
      cancelled = true;
    };
  }, []);

  const handleSignalDetected = (record: SignalLogRecord) => {
    setSignals((prev) => [record, ...prev].slice(0, 50));
  };

  const handleMarkSignalsSynced = (ids: string[]) => {
    const idSet = new Set(ids);
    setSignals((prev) =>
      prev.map((item) =>
        idSet.has(item.id) ? { ...item, syncedToSheet: true } : item
      )
    );
  };

  const handleAddManualTestSignal = () => {
    const isBuy = signals.length % 2 === 0;
    const nowStr = new Date().toLocaleString('th-TH', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });

    handleSignalDetected({
      id: `sample-${Date.now()}`,
      timestamp: nowStr,
      symbol: 'US100',
      timeframe: cisdTimeframe,
      signal: isBuy ? 'BUY' : 'SELL',
      aoPrev: isBuy ? 27180.25 : 27245.5,
      aoCurr: isBuy ? 27210.5 : 27205.75,
      price: isBuy ? 27210.5 : 27205.75,
      pushStatus: 'Android Push Sent',
      note: isBuy ? 'ราคาปิดเหนือระดับ CISD' : 'ราคาปิดต่ำกว่าระดับ CISD',
      syncedToSheet: false,
    });
  };

  const handleQuickDownload = () => {
    const code = generateMql5Code(mql5Config);
    const filename = getMql5Filename(mql5Config);
    const blob = new Blob([code], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const unsyncedCount = signals.filter((s) => !s.syncedToSheet).length;

  return (
    <MotionConfig reducedMotion="user">
      <div className="min-h-screen flex flex-col bg-[#f6f8fb] text-slate-900">
      {/* Studio Top Bar: hidden on deployed online web view to match clean live UI */}
      {!isWebMode && (
        <header className="border-b border-slate-200/80 bg-white">
          <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 lg:gap-6 px-4 py-3.5 sm:px-6 lg:px-8">
            {/* Zone 1: New Brand Logo & Cisd เตือน wordmark */}
            <a
              href="#top"
              onClick={(e) => {
                e.preventDefault();
                setActiveSection('m15');
              }}
              className="inline-flex items-center gap-2.5 text-base font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0"
            >
              <img
                src={cisdLogoImg}
                alt="โลโก้ Cisd เตือน"
                referrerPolicy="no-referrer"
                className="h-8 w-8 rounded-lg object-cover ring-1 ring-slate-900/15 shadow-xs"
              />
              <span>Cisd เตือน</span>
            </a>

            {/* Zone 2: concise single-line nav links */}
            <nav
              aria-label="เมนูหลัก"
              className="hidden md:flex items-center gap-3.5 lg:gap-4 text-[13px] font-medium"
            >
              {NAV_ITEMS.map((item) => {
                const isActive = activeSection === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setActiveSection(item.id)}
                    className={`relative py-2 whitespace-nowrap shrink-0 border-b-2 transition-colors focus-visible:outline-2 focus-visible:outline-blue-600 ${
                      isActive
                        ? 'border-blue-600 font-semibold text-slate-900'
                        : 'border-transparent text-slate-600 hover:text-slate-900 hover:border-slate-300'
                    }`}
                  >
                    {item.label}
                    {item.id === 'sheets' && unsyncedCount > 0 ? (
                      <span className="ml-1 font-mono text-xs text-blue-600 tabular-nums">
                        ({unsyncedCount})
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </nav>

            {/* Zone 3: 1 primary action + optional PWA install */}
            <div className="flex items-center gap-2.5 shrink-0">
              <PWAInstallButton />
              <button
                type="button"
                onClick={handleQuickDownload}
                className="inline-flex h-10 items-center gap-2 rounded-lg bg-blue-600 px-4 text-[13px] font-medium text-white whitespace-nowrap shrink-0 transition-colors hover:bg-blue-700 focus-visible:outline-2 focus-visible:outline-blue-600"
              >
                <Download className="h-4 w-4" />
                ดาวน์โหลด .mq5
              </button>
            </div>
          </div>

          {/* Mobile Nav Switcher */}
          <div className="flex md:hidden items-center gap-1.5 overflow-x-auto border-t border-slate-100 px-4 py-2">
            {NAV_ITEMS.map((item) => {
              const isActive = activeSection === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setActiveSection(item.id)}
                  className={`h-10 rounded-lg px-3.5 text-xs font-medium whitespace-nowrap shrink-0 transition-colors ${
                    isActive
                      ? 'bg-slate-900 text-white'
                      : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                  }`}
                >
                  {item.label}
                  {item.id === 'sheets' && unsyncedCount > 0
                    ? ` (${unsyncedCount})`
                    : ''}
                </button>
              );
            })}
          </div>
        </header>
      )}

      {/* Main Workspace */}
      <main
        id="top"
        className={`mx-auto w-full max-w-6xl flex-1 px-4 sm:px-6 lg:px-8 ${
          isWebMode ? 'py-6' : 'py-8'
        }`}
      >
        {/* Dev preview exit pill (only visible when previewing web mode inside Dev Studio) */}
        {devPreviewWeb && !import.meta.env.PROD && (
          <div className="mb-3 flex items-center justify-between rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-900">
            <span>กำลังดูตัวอย่างหน้าตาเว็บจริง (เมื่อนำขึ้น GitHub / Server ออนไลน์)</span>
            <button
              type="button"
              onClick={() => {
                setDevPreviewWeb(false);
                setActiveSection('deploy');
              }}
              className="inline-flex items-center gap-1 font-semibold text-blue-700 hover:underline"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              กลับหน้า Studio
            </button>
          </div>
        )}

        {/* Back button when opening sub-views outside the 3 main Web Mode tabs */}
        {isWebMode &&
          activeSection !== 'm15' &&
          activeSection !== 'mtf' &&
          activeSection !== 'telegram' && (
          <div className="mb-4">
            <button
              type="button"
              onClick={() => setActiveSection('m15')}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              กลับหน้ากราฟ
            </button>
          </div>
        )}

        {/* Clean Minimal Title + Web Mode Chart Switcher */}
        <div
          className={`${
            isWebMode ? 'mb-5' : 'mb-7'
          } flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between`}
        >
          <div>
            {isWebMode && (
              <div className="mb-2 inline-flex items-center gap-2">
                <img
                  src={cisdLogoImg}
                  alt="โลโก้ Cisd เตือน"
                  referrerPolicy="no-referrer"
                  className="h-7 w-7 rounded-lg object-cover ring-1 ring-slate-900/15 shadow-xs"
                />
                <span className="text-sm font-bold tracking-tight text-slate-900">
                  Cisd เตือน
                </span>
              </div>
            )}
            <h1 className="text-xl font-bold tracking-tight text-slate-900 sm:text-2xl text-balance">
              {activeSection === 'mtf'
                ? 'สรุปสถานะ Cisd เตือน (M15)'
                : activeSection === 'telegram'
                ? 'เชื่อมต่อ Telegram แจ้งเตือน Cisd เตือน'
                : `Cisd เตือน · Timeframe ${cisdTimeframe}`}
            </h1>
            <p className="mt-1.5 text-[13px] leading-relaxed text-slate-600">
              {isWebMode
                ? activeSection === 'mtf'
                  ? 'CISD · US100 · M15'
                  : activeSection === 'telegram'
                  ? 'ใช้ Bot Token และ Chat ID เดิมบนเซิร์ฟเวอร์ พร้อมทดสอบส่งข้อความและเช็กประวัติแจ้งเตือน'
                  : `MetaTrader 5 · US100 ${cisdTimeframe} · CISD (ขาขึ้น / ขาลง)`
                : SECTION_DESCRIPTIONS[activeSection]}
            </p>
          </div>

          {isWebMode &&
            (activeSection === 'm15' ||
              activeSection === 'mtf' ||
              activeSection === 'telegram') && (
            <div className="inline-flex flex-wrap items-center gap-1 self-start rounded-lg bg-slate-200/75 p-1">
              <button
                type="button"
                onClick={() => setActiveSection('m15')}
                className={`h-9 rounded-md px-3 text-[13px] font-medium whitespace-nowrap transition-colors ${
                  activeSection === 'm15'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                กราฟ CISD ({cisdTimeframe})
              </button>
              <button
                type="button"
                onClick={() => setActiveSection('mtf')}
                className={`h-9 rounded-md px-3 text-[13px] font-medium whitespace-nowrap transition-colors ${
                  activeSection === 'mtf'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                สถานะ M15
              </button>
              <button
                type="button"
                onClick={() => setActiveSection('telegram')}
                className={`inline-flex h-9 items-center gap-1.5 rounded-md px-3 text-[13px] font-medium whitespace-nowrap transition-colors ${
                  activeSection === 'telegram'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <span
                  className={`h-2 w-2 rounded-full ${
                    telegramSyncedReady ? 'bg-emerald-500' : 'bg-amber-500'
                  }`}
                />
                เชื่อมต่อ Telegram
              </button>
            </div>
          )}
        </div>

        {/* Active Workspace View */}
        {activeSection === 'm15' && (
          <M15CisdChartView
            customPrefix={mql5Config.customPrefix}
            onSignalDetected={handleSignalDetected}
            recentSignals={signals}
            onGoToSheets={() => setActiveSection('sheets')}
            onGoToTelegram={() => setActiveSection('telegram')}
            telegramSyncedReady={telegramSyncedReady}
            isWebMode={isWebMode}
            timeframe={cisdTimeframe}
            onChangeTimeframe={setCisdTimeframe}
            onOpenStatusWindow={() => setActiveSection('mtf')}
          />
        )}

        {activeSection === 'mtf' && (
          <MultiTimeframeStatusWindow
            selectedTimeframe={cisdTimeframe}
            onSelectTimeframeForChart={(tf) => {
              setCisdTimeframe(tf);
              setActiveSection('m15');
            }}
            isWebMode={isWebMode}
          />
        )}

        {activeSection === 'mql5' && (
          <Mql5Studio config={mql5Config} onChangeConfig={setMql5Config} />
        )}

        {activeSection === 'android' && <AndroidSetupGuide />}

        {activeSection === 'telegram' && (
          <TelegramConfig
            mql5Config={mql5Config}
            onUpdateMql5Config={setMql5Config}
            onConfiguredChange={setTelegramSyncedReady}
          />
        )}

        {activeSection === 'sheets' && (
          <GoogleSheetsSync
            pendingSignals={signals}
            onMarkSignalsSynced={handleMarkSignalsSynced}
            onAddManualTestSignal={handleAddManualTestSignal}
          />
        )}

        {activeSection === 'deploy' && (
          <ServerDeployPanel
            onPreviewWebMode={() => {
              setDevPreviewWeb(true);
              setActiveSection('m15');
            }}
          />
        )}
      </main>

      {/* Quiet Clean Footer (shown in Studio mode only) */}
      {!isWebMode && (
        <footer className="border-t border-slate-200/80 bg-white py-5">
          <div className="mx-auto flex max-w-6xl items-center justify-between px-4 text-xs text-slate-500 sm:px-6 lg:px-8">
            <span className="inline-flex items-center gap-2 font-medium text-slate-700">
              <img
                src={cisdLogoImg}
                alt="โลโก้ Cisd เตือน"
                referrerPolicy="no-referrer"
                className="h-5 w-5 rounded object-cover ring-1 ring-slate-900/10"
              />
              Cisd เตือน
            </span>
            <span>US100 · M15 (US 100 Index Cash)</span>
          </div>
        </footer>
      )}
        <OfflineIndicator />
      </div>
    </MotionConfig>
  );
}
