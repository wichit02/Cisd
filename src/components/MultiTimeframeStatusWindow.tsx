import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowDownRight,
  ArrowUpRight,
  Bell,
  BellOff,
  ChevronRight,
  Minus,
  Radio,
  RefreshCw,
} from 'lucide-react';
import { SYMBOL_SPECS, type TradingSymbol } from '../lib/aoSimulator';
import {
  ALL_CISD_CHART_TIMEFRAMES,
  type CisdTimeframe,
  type LastCisdSignalInfo,
} from '../lib/cisdDetector';
import {
  CISD_TIMEFRAME_MAP,
  generateInitialCisdSeries,
} from '../lib/m15CisdSimulator';
import cisdLogoImg from '../assets/images/cisd_brand_logo_1795106433027.jpg';

export interface TimeframeStatusItem {
  timeframe: CisdTimeframe;
  ok: boolean;
  status: 'UP' | 'DOWN' | 'NEUTRAL';
  trendSource: 'CISD' | 'CANDLE' | 'NONE';
  cisdSignal: 'BUY' | 'SELL' | null;
  lastSignalInfo: LastCisdSignalInfo | null;
  lastClosedBarSignal: 'BUY' | 'SELL' | null;
  currentPrice: number;
  candleOpen: number;
  candleBullish: boolean;
  changePercent: number;
  latestBearCisdLevel: number | null;
  latestBullCisdLevel: number | null;
  marketState: string;
  fetchedAt: string;
  error?: string;
}

interface MultiTimeframeStatusWindowProps {
  selectedTimeframe: CisdTimeframe;
  onSelectTimeframeForChart: (tf: CisdTimeframe) => void;
  isWebMode?: boolean;
}

export const MultiTimeframeStatusWindow: React.FC<
  MultiTimeframeStatusWindowProps
> = ({ onSelectTimeframeForChart }) => {
  const symbol: TradingSymbol = 'US100';
  const spec = SYMBOL_SPECS[symbol];

  const [mode, setMode] = useState<'live' | 'sim'>('live');
  const [items, setItems] = useState<TimeframeStatusItem[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);

  const buildSimStatuses = useCallback((): TimeframeStatusItem[] => {
    const nowIso = new Date().toISOString();
    return ALL_CISD_CHART_TIMEFRAMES.map((tf) => {
      const series = generateInitialCisdSeries(symbol, tf, 96);
      const latestBar = series.bars[series.bars.length - 1];
      const closedBar = series.bars[series.bars.length - 2];
      const prevClosed = series.bars[series.bars.length - 3];
      const currentPrice = latestBar?.close ?? closedBar?.close ?? spec.basePrice;
      const prevPrice = prevClosed?.close ?? latestBar?.open ?? currentPrice;
      const changePercent =
        prevPrice > 0 ? ((currentPrice - prevPrice) / prevPrice) * 100 : 0;

      const effectiveTrend =
        series.currentTrend ??
        (latestBar && latestBar.close > latestBar.open
          ? 'BUY'
          : latestBar && latestBar.close < latestBar.open
          ? 'SELL'
          : null);

      return {
        timeframe: tf,
        ok: true,
        status:
          effectiveTrend === 'BUY'
            ? 'UP'
            : effectiveTrend === 'SELL'
            ? 'DOWN'
            : 'NEUTRAL',
        trendSource: series.currentTrend ? 'CISD' : 'CANDLE',
        cisdSignal: series.currentTrend,
        lastSignalInfo: series.lastSignalInfo,
        lastClosedBarSignal: closedBar?.cisdSignal ?? null,
        currentPrice,
        candleOpen: latestBar?.open ?? currentPrice,
        candleBullish: latestBar ? latestBar.close >= latestBar.open : true,
        changePercent: Number(changePercent.toFixed(3)),
        latestBearCisdLevel: series.latestBearCisdLevel,
        latestBullCisdLevel: series.latestBullCisdLevel,
        marketState: 'SIM',
        fetchedAt: nowIso,
      };
    });
  }, [spec.basePrice, symbol]);

  const fetchLiveStatuses = useCallback(async () => {
    setIsLoading(true);
    setErrorMsg(null);
    try {
      const res = await fetch(
        `/api/market/cisd-status?symbol=${encodeURIComponent(symbol)}`
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'ดึงสถานะ Timeframe ไม่สำเร็จ');
      }
      const data = (await res.json()) as {
        timeframes: TimeframeStatusItem[];
        fetchedAt: string;
      };
      const byTf = new Map(data.timeframes.map((t) => [t.timeframe, t]));
      const ordered = ALL_CISD_CHART_TIMEFRAMES.map((tf) => byTf.get(tf)).filter(
        (v): v is TimeframeStatusItem => Boolean(v)
      );
      setItems(ordered);
      setLastUpdated(
        new Date(data.fetchedAt || Date.now()).toLocaleTimeString('th-TH', {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false,
        })
      );
    } catch (err: any) {
      setErrorMsg(err?.message || 'ไม่สามารถเชื่อมต่อข้อมูลตลาดจริงได้');
    } finally {
      setIsLoading(false);
    }
  }, [symbol]);

  useEffect(() => {
    if (mode === 'sim') {
      setItems(buildSimStatuses());
      setIsLoading(false);
      setErrorMsg(null);
      setLastUpdated(
        new Date().toLocaleTimeString('th-TH', {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false,
        })
      );
      return;
    }

    void fetchLiveStatuses();
    const timer = window.setInterval(() => {
      void fetchLiveStatuses();
    }, 2000);
    return () => window.clearInterval(timer);
  }, [mode, fetchLiveStatuses, buildSimStatuses]);

  const summary = useMemo(() => {
    let upCount = 0;
    let downCount = 0;
    for (const item of items) {
      if (item.status === 'UP') upCount += 1;
      else if (item.status === 'DOWN') downCount += 1;
    }

    let overallLabel = 'กำลังโหลดข้อมูล';
    let overallTone: 'up' | 'down' | 'mixed' = 'mixed';
    if (items.length > 0) {
      if (upCount === items.length) {
        overallLabel = 'M15 & M5 เป็นขาขึ้นทั้งคู่';
        overallTone = 'up';
      } else if (downCount === items.length) {
        overallLabel = 'M15 & M5 เป็นขาลงทั้งคู่';
        overallTone = 'down';
      } else if (upCount > downCount) {
        overallLabel = 'ภาพรวมโน้มเอียงฝั่งขึ้น';
        overallTone = 'up';
      } else if (downCount > upCount) {
        overallLabel = 'ภาพรวมโน้มเอียงฝั่งลง';
        overallTone = 'down';
      } else if (upCount > 0 && downCount > 0) {
        overallLabel = 'M15 และ M5 ทิศทางสวนทางกัน';
        overallTone = 'mixed';
      } else {
        overallLabel = 'รอสัญญาณยืนยันทิศทาง';
        overallTone = 'mixed';
      }
    }

    return { upCount, downCount, overallLabel, overallTone };
  }, [items]);

  const handleRefresh = () => {
    if (mode === 'live') {
      void fetchLiveStatuses();
    } else {
      setItems(buildSimStatuses());
      setLastUpdated(
        new Date().toLocaleTimeString('th-TH', {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false,
        })
      );
    }
  };

  return (
    <section className="space-y-5">
      {errorMsg && mode === 'live' && (
        <div className="rounded-xl border border-rose-200/70 bg-rose-50/60 px-4 py-3.5 text-sm text-rose-800">
          {errorMsg}
        </div>
      )}

      {/* Soft Obsidian Brand Banner matching Cisd เตือน theme */}
      <div className="rounded-2xl border border-slate-700/60 bg-gradient-to-r from-[#111726] via-[#151d30] to-[#1a2338] px-5 py-4 text-slate-100 shadow-xs sm:px-6 sm:py-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3.5">
            <img
              src={cisdLogoImg}
              alt="โลโก้ Cisd เตือน"
              referrerPolicy="no-referrer"
              className="h-11 w-11 shrink-0 rounded-xl object-cover ring-1 ring-amber-300/30"
            />
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-base font-semibold tracking-tight text-slate-100 sm:text-lg">
                  Cisd เตือน · สรุปทิศทาง M15 และ M5
                </h2>
                <span className="inline-flex items-center gap-1.5 rounded-md bg-slate-800/80 px-2.5 py-0.5 text-xs font-medium text-amber-200/90 ring-1 ring-amber-300/20">
                  US100Cash#
                </span>
              </div>
              <p className="mt-1 text-sm text-slate-300/90">
                มุมมองเปรียบเทียบแนวโน้ม M15 (เปิดแจ้งเตือน) และ M5 (ดูกราฟอย่างเดียว) แบบสบายตา
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 text-xs font-medium text-slate-300/90 sm:text-sm">
            {lastUpdated && (
              <span className="rounded-lg bg-slate-900/60 px-3 py-1.5 font-mono tabular-nums ring-1 ring-white/10">
                อัปเดต {lastUpdated}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Main Low-Contrast Status Container */}
      <div className="overflow-hidden rounded-2xl border border-slate-200/80 bg-[#f9fafc]">
        {/* Top Controls Row */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200/70 bg-slate-100/60 px-5 py-4 sm:px-6">
          <div className="flex items-center gap-1.5 rounded-xl bg-slate-200/65 p-1">
            <button
              type="button"
              onClick={() => setMode('live')}
              className={`inline-flex h-10 items-center gap-2 rounded-lg px-4 text-sm font-medium whitespace-nowrap shrink-0 transition-colors ${
                mode === 'live'
                  ? 'bg-[#fcfdfe] text-slate-800 shadow-xs'
                  : 'text-slate-600 hover:text-slate-800'
              }`}
            >
              <Radio className="h-4 w-4 text-emerald-600/90" />
              กราฟจริง
            </button>
            <button
              type="button"
              onClick={() => setMode('sim')}
              className={`h-10 rounded-lg px-4 text-sm font-medium whitespace-nowrap shrink-0 transition-colors ${
                mode === 'sim'
                  ? 'bg-[#fcfdfe] text-slate-800 shadow-xs'
                  : 'text-slate-600 hover:text-slate-800'
              }`}
            >
              จำลอง
            </button>
          </div>

          <button
            type="button"
            onClick={handleRefresh}
            disabled={isLoading}
            className="inline-flex h-10 items-center gap-2 rounded-xl border border-slate-200/80 bg-[#fcfdfe] px-4 text-sm font-medium text-slate-700 whitespace-nowrap shrink-0 transition-colors hover:bg-slate-100/80 disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 text-slate-500 ${isLoading ? 'animate-spin' : ''}`} />
            รีเฟรชข้อมูล
          </button>
        </div>

        {/* Soft Overall Summary Strip */}
        <div className="flex flex-col gap-3 border-b border-slate-200/70 bg-[#fcfdfe] px-5 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <div className="flex items-center gap-3.5">
            <span
              className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${
                summary.overallTone === 'up'
                  ? 'bg-emerald-100/65 text-emerald-700/90'
                  : summary.overallTone === 'down'
                  ? 'bg-rose-100/65 text-rose-700/90'
                  : 'bg-slate-200/65 text-slate-600'
              }`}
            >
              {summary.overallTone === 'up' ? (
                <ArrowUpRight className="h-5 w-5" />
              ) : summary.overallTone === 'down' ? (
                <ArrowDownRight className="h-5 w-5" />
              ) : (
                <Minus className="h-5 w-5" />
              )}
            </span>
            <div>
              <p className="text-xs font-medium text-slate-500 sm:text-sm">
                ภาพรวม CISD (M15 · M5)
              </p>
              <p
                className={`mt-0.5 text-base font-semibold sm:text-lg ${
                  summary.overallTone === 'up'
                    ? 'text-emerald-800/90'
                    : summary.overallTone === 'down'
                    ? 'text-rose-800/90'
                    : 'text-slate-700'
                }`}
              >
                {summary.overallLabel}
              </p>
            </div>
          </div>

          <div className="inline-flex items-center gap-3.5 self-start rounded-xl border border-slate-200/70 bg-slate-100/60 px-4 py-2 text-sm font-semibold tabular-nums whitespace-nowrap sm:self-auto">
            <span className="text-emerald-700/90">ขาขึ้น {summary.upCount}</span>
            <span aria-hidden="true" className="text-slate-300">
              |
            </span>
            <span className="text-rose-700/90">ขาลง {summary.downCount}</span>
          </div>
        </div>

        {/* Timeframe Cards (Responsive 1-col mobile -> 2-col desktop, soft pastel/slate palette + larger readable text) */}
        <div className="grid grid-cols-1 gap-4 p-4 sm:p-6 md:grid-cols-2">
          {ALL_CISD_CHART_TIMEFRAMES.map((tf) => {
            const item = items.find((i) => i.timeframe === tf);
            const meta = CISD_TIMEFRAME_MAP[tf];
            const isUp = item?.status === 'UP';
            const isDown = item?.status === 'DOWN';
            const isSilentTf = tf === 'M5';

            const activeCisdWatch = isUp
              ? item?.latestBearCisdLevel
              : isDown
              ? item?.latestBullCisdLevel
              : item?.latestBullCisdLevel ?? item?.latestBearCisdLevel;

            const activeWatchLabel = isUp
              ? 'แนว CISD กลับตัวลง'
              : isDown
              ? 'แนว CISD กลับตัวขึ้น'
              : 'ระดับ CISD เฝ้าดู';

            return (
              <button
                key={`status-card-${tf}`}
                type="button"
                onClick={() => onSelectTimeframeForChart(tf)}
                className={`group flex flex-col justify-between rounded-2xl border p-5 sm:p-6 text-left transition-colors focus-visible:outline-2 focus-visible:outline-blue-600 ${
                  isUp
                    ? 'border-emerald-200/75 bg-emerald-50/45 hover:bg-emerald-50/75'
                    : isDown
                    ? 'border-rose-200/75 bg-rose-50/45 hover:bg-rose-50/75'
                    : 'border-slate-200/80 bg-[#fcfdfe] hover:bg-slate-100/70'
                }`}
              >
                {/* Top Row: Timeframe + Alert Mode Badge */}
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2.5">
                      <span className="font-mono text-xl font-bold tracking-tight text-slate-800 sm:text-2xl">
                        {tf}
                      </span>
                      <span className="rounded-lg bg-slate-200/60 px-2.5 py-0.5 text-xs font-medium text-slate-600 sm:text-sm">
                        {meta.thName}
                      </span>
                    </div>

                    <div className="mt-2 inline-flex items-center gap-1.5 text-sm text-slate-600">
                      {isSilentTf ? (
                        <>
                          <BellOff className="h-4 w-4 text-slate-500" />
                          <span>ดูกราฟอย่างเดียว (ไม่แจ้งเตือน)</span>
                        </>
                      ) : (
                        <>
                          <Bell className="h-4 w-4 text-amber-600/90" />
                          <span>เปิดแจ้งเตือน Telegram & มือถือ</span>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Soft Circular Direction Icon */}
                  {isLoading && !item ? (
                    <span className="h-12 w-12 shrink-0 animate-pulse rounded-2xl bg-slate-200/70" />
                  ) : isUp ? (
                    <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-emerald-100/75 text-emerald-700/90 transition-transform group-hover:scale-105">
                      <ArrowUpRight className="h-6 w-6" />
                    </span>
                  ) : isDown ? (
                    <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-rose-100/75 text-rose-700/90 transition-transform group-hover:scale-105">
                      <ArrowDownRight className="h-6 w-6" />
                    </span>
                  ) : (
                    <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-slate-200/70 text-slate-500">
                      <Minus className="h-6 w-6" />
                    </span>
                  )}
                </div>

                {/* Middle Row: Large Readable Trend Status + Live Price */}
                <div className="my-5 flex flex-wrap items-baseline justify-between gap-3 rounded-xl border border-slate-200/60 bg-white/75 px-4 py-3.5">
                  <div>
                    <p className="text-xs font-medium text-slate-500 sm:text-sm">
                      ทิศทางล่าสุด
                    </p>
                    <p
                      className={`mt-0.5 text-lg font-bold tracking-tight sm:text-xl ${
                        isLoading && !item
                          ? 'text-slate-400'
                          : isUp
                          ? 'text-emerald-700/95'
                          : isDown
                          ? 'text-rose-700/95'
                          : 'text-slate-600'
                      }`}
                    >
                      {isLoading && !item
                        ? 'กำลังโหลด...'
                        : isUp
                        ? 'ขาขึ้น (BUY)'
                        : isDown
                        ? 'ขาลง (SELL)'
                        : 'รอสัญญาณ'}
                    </p>
                  </div>

                  <div className="text-right">
                    <p className="text-xs font-medium text-slate-500 sm:text-sm">
                      ราคาปัจจุบัน
                    </p>
                    <p className="mt-0.5 font-mono text-base font-semibold text-slate-800 tabular-nums sm:text-lg">
                      {item && item.currentPrice > 0
                        ? item.currentPrice.toFixed(spec.digits)
                        : '—'}
                    </p>
                  </div>
                </div>

                {/* Bottom Row: CISD Watch Level + Open Chart Prompt */}
                <div className="flex flex-wrap items-center justify-between gap-2 pt-1 text-sm text-slate-600">
                  <span className="font-medium">
                    {activeCisdWatch !== null && activeCisdWatch !== undefined ? (
                      <>
                        {activeWatchLabel}:{' '}
                        <span className="font-mono font-semibold text-slate-700 tabular-nums">
                          {activeCisdWatch.toFixed(spec.digits)}
                        </span>
                      </>
                    ) : (
                      'รอสร้างแนวโครงสร้าง CISD ใหม่'
                    )}
                  </span>

                  <span className="inline-flex items-center gap-1 font-medium text-slate-700 group-hover:text-slate-900">
                    เปิดกราฟ {tf}
                    <ChevronRight className="h-4 w-4 text-slate-400 transition-transform group-hover:translate-x-0.5" />
                  </span>
                </div>
              </button>
            );
          })}
        </div>

        {/* Calm Footer Hint */}
        <div className="border-t border-slate-200/70 bg-slate-100/50 px-5 py-3.5 text-center text-sm text-slate-600 sm:px-6 sm:text-left">
          แตะที่การ์ด <span className="font-semibold text-slate-700">M15</span> หรือ{' '}
          <span className="font-semibold text-slate-700">M5</span> เพื่อเปิดดูกราฟแท่งเทียนแบบละเอียดได้ทันที
        </div>
      </div>
    </section>
  );
};
