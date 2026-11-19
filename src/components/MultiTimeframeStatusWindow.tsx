import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowDownRight,
  ArrowUpRight,
  ChevronRight,
  Minus,
  Radio,
  RefreshCw,
} from 'lucide-react';
import { SYMBOL_SPECS, type TradingSymbol } from '../lib/aoSimulator';
import {
  CISD_TIMEFRAME_ORDER,
  type CisdTimeframe,
  type LastCisdSignalInfo,
} from '../lib/cisdDetector';
import {
  CISD_TIMEFRAME_MAP,
  generateInitialCisdSeries,
} from '../lib/m15CisdSimulator';

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
    return CISD_TIMEFRAME_ORDER.map((tf) => {
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
      const ordered = CISD_TIMEFRAME_ORDER.map((tf) => byTf.get(tf)).filter(
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
        overallLabel = 'M15 เป็นขาขึ้นชัดเจน';
        overallTone = 'up';
      } else if (downCount === items.length) {
        overallLabel = 'M15 เป็นขาลงชัดเจน';
        overallTone = 'down';
      } else if (upCount > downCount) {
        overallLabel = 'ภาพรวมโน้มเอียงฝั่งขึ้น';
        overallTone = 'up';
      } else if (downCount > upCount) {
        overallLabel = 'ภาพรวมโน้มเอียงฝั่งลง';
        overallTone = 'down';
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
    <section className="space-y-4">
      {errorMsg && mode === 'live' && (
        <div className="rounded-xl border border-rose-200/80 bg-rose-50/70 px-4 py-3 text-xs text-rose-800">
          {errorMsg}
        </div>
      )}

      {/* Single Calm Status Card */}
      <div className="overflow-hidden rounded-2xl border border-slate-200/80 bg-white">
        {/* Top Controls Row */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 bg-slate-50/50 px-4 py-3.5 sm:px-6">
          <div className="flex items-center gap-1 rounded-lg bg-slate-200/70 p-1">
            <button
              type="button"
              onClick={() => setMode('live')}
              className={`inline-flex h-9 items-center gap-1.5 rounded-md px-3.5 text-[13px] font-medium whitespace-nowrap shrink-0 transition-colors ${
                mode === 'live'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <Radio className="h-3.5 w-3.5 text-emerald-600" />
              กราฟจริง
            </button>
            <button
              type="button"
              onClick={() => setMode('sim')}
              className={`h-9 rounded-md px-3.5 text-[13px] font-medium whitespace-nowrap shrink-0 transition-colors ${
                mode === 'sim'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              จำลอง
            </button>
          </div>

          <div className="flex items-center gap-3">
            {lastUpdated && (
              <span className="font-mono text-xs text-slate-400 tabular-nums whitespace-nowrap">
                อัปเดต {lastUpdated}
              </span>
            )}
            <button
              type="button"
              onClick={handleRefresh}
              disabled={isLoading}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200/90 bg-white px-3 text-xs font-medium text-slate-700 whitespace-nowrap shrink-0 transition-colors hover:bg-slate-50 disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${isLoading ? 'animate-spin' : ''}`} />
              รีเฟรช
            </button>
          </div>
        </div>

        {/* Calm Overall Summary Strip */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-5 py-4 sm:px-6">
          <div className="flex items-center gap-2.5">
            <span
              className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
                summary.overallTone === 'up'
                  ? 'bg-emerald-100/80 text-emerald-700'
                  : summary.overallTone === 'down'
                  ? 'bg-rose-100/80 text-rose-700'
                  : 'bg-slate-100 text-slate-600'
              }`}
            >
              {summary.overallTone === 'up' ? (
                <ArrowUpRight className="h-4 w-4" />
              ) : summary.overallTone === 'down' ? (
                <ArrowDownRight className="h-4 w-4" />
              ) : (
                <Minus className="h-4 w-4" />
              )}
            </span>
            <div>
              <p className="text-[11px] font-medium text-slate-400">
                ภาพรวม CISD (M15)
              </p>
              <p
                className={`text-sm font-semibold ${
                  summary.overallTone === 'up'
                    ? 'text-emerald-800'
                    : summary.overallTone === 'down'
                    ? 'text-rose-800'
                    : 'text-slate-700'
                }`}
              >
                {summary.overallLabel}
              </p>
            </div>
          </div>

          <div className="inline-flex items-center gap-3 text-xs font-semibold tabular-nums whitespace-nowrap">
            <span className="text-emerald-700">ขาขึ้น {summary.upCount}</span>
            <span aria-hidden="true" className="text-slate-300">
              ·
            </span>
            <span className="text-rose-700">ขาลง {summary.downCount}</span>
          </div>
        </div>

        {/* Mobile & Tablet (< lg): Spacious, Calm Full-Width Rows */}
        <div className="divide-y divide-slate-100 lg:hidden">
          {CISD_TIMEFRAME_ORDER.map((tf) => {
            const item = items.find((i) => i.timeframe === tf);
            const meta = CISD_TIMEFRAME_MAP[tf];
            const isUp = item?.status === 'UP';
            const isDown = item?.status === 'DOWN';

            return (
              <button
                key={`row-${tf}`}
                type="button"
                onClick={() => onSelectTimeframeForChart(tf)}
                className={`flex min-h-[72px] w-full items-center justify-between gap-4 px-5 py-4 text-left transition-colors focus-visible:outline-2 focus-visible:outline-blue-600 ${
                  isUp
                    ? 'bg-emerald-50/40 hover:bg-emerald-50/75'
                    : isDown
                    ? 'bg-rose-50/40 hover:bg-rose-50/75'
                    : 'bg-white hover:bg-slate-50'
                }`}
              >
                <div className="flex items-center gap-3.5 min-w-0">
                  {isLoading && !item ? (
                    <span className="h-11 w-11 shrink-0 animate-pulse rounded-full bg-slate-200/80" />
                  ) : isUp ? (
                    <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-emerald-100/90 text-emerald-700">
                      <ArrowUpRight className="h-5 w-5" />
                    </span>
                  ) : isDown ? (
                    <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-rose-100/90 text-rose-700">
                      <ArrowDownRight className="h-5 w-5" />
                    </span>
                  ) : (
                    <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-500">
                      <Minus className="h-5 w-5" />
                    </span>
                  )}

                  <div className="min-w-0">
                    <span className="block font-mono text-base font-bold tracking-tight text-slate-900">
                      {tf}
                    </span>
                    <span className="mt-0.5 block text-[13px] text-slate-500 truncate">
                      {meta.thName}
                    </span>
                  </div>
                </div>

                <div className="flex items-center gap-2.5 shrink-0">
                  <span
                    className={`text-[15px] font-semibold whitespace-nowrap ${
                      isLoading && !item
                        ? 'text-slate-400'
                        : isUp
                        ? 'text-emerald-800'
                        : isDown
                        ? 'text-rose-800'
                        : 'text-slate-500'
                    }`}
                  >
                    {isLoading && !item
                      ? 'กำลังโหลด...'
                      : isUp
                      ? 'ขาขึ้น'
                      : isDown
                      ? 'ขาลง'
                      : 'รอสัญญาณ'}
                  </span>
                  <ChevronRight className="h-4 w-4 text-slate-300" />
                </div>
              </button>
            );
          })}
        </div>

        {/* Desktop (lg+): Clean Single M15 Tile */}
        <div className="hidden lg:grid lg:grid-cols-1 lg:gap-4 lg:p-6">
          {CISD_TIMEFRAME_ORDER.map((tf) => {
            const item = items.find((i) => i.timeframe === tf);
            const meta = CISD_TIMEFRAME_MAP[tf];
            const isUp = item?.status === 'UP';
            const isDown = item?.status === 'DOWN';

            return (
              <button
                key={`tile-${tf}`}
                type="button"
                onClick={() => onSelectTimeframeForChart(tf)}
                className={`group flex flex-col items-center justify-between rounded-2xl border px-4 py-6 text-center transition-colors focus-visible:outline-2 focus-visible:outline-blue-600 ${
                  isUp
                    ? 'border-emerald-200/70 bg-emerald-50/45 hover:bg-emerald-50/80'
                    : isDown
                    ? 'border-rose-200/70 bg-rose-50/45 hover:bg-rose-50/80'
                    : 'border-slate-200/80 bg-slate-50/60 hover:bg-slate-100/70'
                }`}
              >
                <div>
                  <span className="block font-mono text-lg font-bold tracking-tight text-slate-900">
                    {tf}
                  </span>
                  <span className="mt-0.5 block text-xs text-slate-500">
                    {meta.thName}
                  </span>
                </div>

                <div className="my-5 flex items-center justify-center">
                  {isLoading && !item ? (
                    <span className="h-12 w-12 animate-pulse rounded-full bg-slate-200/80" />
                  ) : isUp ? (
                    <span className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100/90 text-emerald-700 transition-transform group-hover:scale-105">
                      <ArrowUpRight className="h-6 w-6" />
                    </span>
                  ) : isDown ? (
                    <span className="flex h-12 w-12 items-center justify-center rounded-full bg-rose-100/90 text-rose-700 transition-transform group-hover:scale-105">
                      <ArrowDownRight className="h-6 w-6" />
                    </span>
                  ) : (
                    <span className="flex h-12 w-12 items-center justify-center rounded-full bg-slate-200/80 text-slate-500">
                      <Minus className="h-6 w-6" />
                    </span>
                  )}
                </div>

                <span
                  className={`text-[15px] font-semibold whitespace-nowrap ${
                    isLoading && !item
                      ? 'text-slate-400'
                      : isUp
                      ? 'text-emerald-800'
                      : isDown
                      ? 'text-rose-800'
                      : 'text-slate-500'
                  }`}
                >
                  {isLoading && !item
                    ? 'กำลังโหลด...'
                    : isUp
                    ? 'ขาขึ้น'
                    : isDown
                    ? 'ขาลง'
                    : 'รอสัญญาณ'}
                </span>
              </button>
            );
          })}
        </div>

        {/* Quiet Single-Line Hint */}
        <div className="border-t border-slate-100 bg-slate-50/40 px-5 py-3 text-center text-xs text-slate-400 sm:text-left">
          แตะที่ Timeframe เพื่อเปิดดูกราฟแท่งเทียน
        </div>
      </div>
    </section>
  );
};
