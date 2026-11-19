import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  LayoutGrid,
  Play,
  Pause,
  SkipForward,
  RotateCcw,
  ArrowUpRight,
  ArrowDownRight,
  Bell,
  Volume2,
  VolumeX,
  Square,
  RefreshCw,
  Radio,
  Smartphone,
  Send,
  Download,
  Copy,
  Check,
  AlertCircle,
  CheckCircle2,
  X,
} from 'lucide-react';
import { SYMBOL_SPECS, type TradingSymbol } from '../lib/aoSimulator';
import {
  type CisdLevelSegment,
  type CisdTimeframe,
  type LastCisdSignalInfo,
  type M15CisdBar,
} from '../lib/cisdDetector';
import {
  CISD_TIMEFRAME_MAP,
  appendNextCisdBar,
  finalizeCisdBarAndOpenNext,
  generateInitialCisdSeries,
  planNextCisdCloseDelta,
  tickFormingCisdBar,
} from '../lib/m15CisdSimulator';
import type { SignalLogRecord } from '../lib/sheetsApi';
import type { AlertDirection } from '../lib/mql5Generator';
import {
  play10SecondSound,
  stop10SecondSound,
  unlockAudioAlert,
} from '../lib/audioAlert';
import {
  dispatchMobileSignalNotification,
  getExistingPushSubscription,
  sendTestWebPush,
  showLocalMobileNotification,
  subscribeDeviceToWebPush,
} from '../lib/webPushClient';
import cisdLogoImg from '../assets/images/cisd_brand_logo_1795106433027.jpg';
import cisdBannerImg from '../assets/images/cisd_alert_banner_1795106433758.jpg';

interface M15CisdChartViewProps {
  customPrefix: string;
  onSignalDetected: (record: SignalLogRecord) => void;
  recentSignals: SignalLogRecord[];
  onGoToSheets: () => void;
  onGoToTelegram: () => void;
  telegramSyncedReady?: boolean | null;
  isWebMode?: boolean;
  timeframe?: CisdTimeframe;
  onChangeTimeframe?: (tf: CisdTimeframe) => void;
  onOpenStatusWindow?: () => void;
}

interface LiveM15FeedResponse {
  symbol: TradingSymbol;
  timeframe?: CisdTimeframe;
  source: string;
  feedProvider?: 'xm_bridge' | 'cfd_ws' | 'yahoo_fallback';
  brokerSymbol?: string;
  xmBridgeConnected?: boolean;
  cfdWsConnected?: boolean;
  marketState: string;
  fetchedAt: string;
  bars: M15CisdBar[];
  segments: CisdLevelSegment[];
  latestBearCisdLevel: number | null;
  latestBullCisdLevel: number | null;
  currentTrend?: 'BUY' | 'SELL' | null;
  lastSignalInfo?: LastCisdSignalInfo | null;
}

interface XmBridgeStatusSnapshot {
  connected: boolean;
  lastPushAt: string | null;
  ageSeconds: number | null;
  broker: string;
  symbol: string;
  bid: number;
  ask: number;
  cfdStream?: {
    connected: boolean;
    brokerSymbol: string;
    lastTickAt: string | null;
    lastPrice: number;
  };
}

interface AlertToastFeedback {
  id: string;
  mode: 'live' | 'sim';
  timeframe: CisdTimeframe;
  signal: 'BUY' | 'SELL';
  price: number;
  cisdLevel: number | null;
  telegramDelivered: boolean;
  telegramMissingToken: boolean;
  telegramError?: string;
  mobileDelivered: boolean;
}

function formatMt5AxisDate(timestampIso: string, _timeframe: CisdTimeframe): string {
  const dt = new Date(timestampIso);
  if (Number.isNaN(dt.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Asia/Bangkok',
  }).formatToParts(dt);
  const day = parts.find((p) => p.type === 'day')?.value || '';
  const month = parts.find((p) => p.type === 'month')?.value || '';
  const hour = parts.find((p) => p.type === 'hour')?.value || '';
  const minute = parts.find((p) => p.type === 'minute')?.value || '';
  return `${day} ${month} ${hour}:${minute}`;
}

function getXmServerOffsetSec(): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    timeZoneName: 'shortOffset',
  }).formatToParts(new Date());
  const tzStr = parts.find((p) => p.type === 'timeZoneName')?.value || 'GMT-5';
  const match = tzStr.match(/GMT([+-]\d+)/);
  const nyOffsetHrs = match ? parseInt(match[1], 10) : -5;
  return (nyOffsetHrs + 7) * 3600;
}

function formatTimeframeCountdown(timeframe: CisdTimeframe): string {
  const tfMeta = CISD_TIMEFRAME_MAP[timeframe] || CISD_TIMEFRAME_MAP.M15;
  const intervalSec = tfMeta.minutes * 60;
  const nowSec = Math.floor(Date.now() / 1000);
  const xmSec = nowSec + getXmServerOffsetSec();
  const remaining = intervalSec - (xmSec % intervalSec);
  const hh = Math.floor(remaining / 3600);
  const mm = String(Math.floor((remaining % 3600) / 60)).padStart(2, '0');
  const ss = String(remaining % 60).padStart(2, '0');
  if (hh > 0) {
    return `${String(hh).padStart(2, '0')}:${mm}:${ss}`;
  }
  return `${mm}:${ss}`;
}

export const M15CisdChartView: React.FC<M15CisdChartViewProps> = ({
  customPrefix,
  onSignalDetected,
  onGoToTelegram,
  telegramSyncedReady,
  isWebMode = false,
  timeframe: controlledTimeframe,
  onOpenStatusWindow,
}) => {
  const activeTimeframe: CisdTimeframe = controlledTimeframe ?? 'M15';

  const [feedMode, setFeedMode] = useState<'live' | 'sim'>('live');
  const symbol: TradingSymbol = 'US100';
  const [directionFilter, setDirectionFilter] = useState<AlertDirection>('both');
  const [seriesState, setSeriesState] = useState(() =>
    generateInitialCisdSeries('US100', activeTimeframe)
  );
  const [marketState, setMarketState] = useState<string>('');
  const [isLoadingLive, setIsLoadingLive] = useState(false);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [barCountdown, setBarCountdown] = useState<string>(() =>
    formatTimeframeCountdown(activeTimeframe)
  );

  const [isPlaying, setIsPlaying] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [soundSecondsLeft, setSoundSecondsLeft] = useState(0);
  const [tickFlash, setTickFlash] = useState<'up' | 'down' | null>(null);
  const [lastTickTime, setLastTickTime] = useState<string | null>(null);
  const [simTickStep, setSimTickStep] = useState(0);
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const [mobileNotifyReady, setMobileNotifyReady] = useState<boolean>(() =>
    typeof window !== 'undefined' &&
    'Notification' in window &&
    Notification.permission === 'granted'
  );
  const [mobileNotifyBusy, setMobileNotifyBusy] = useState(false);
  const [mobileNotifyHint, setMobileNotifyHint] = useState<string | null>(null);
  const [mobileNotifySuccess, setMobileNotifySuccess] = useState<string | null>(null);
  const [serverM15Enabled, setServerM15Enabled] = useState<boolean>(true);
  const [serverSubscribersCount, setServerSubscribersCount] = useState<number>(0);
  const [serverLastCheckedAt, setServerLastCheckedAt] = useState<string | null>(null);
  const [togglingServerMonitor, setTogglingServerMonitor] = useState<boolean>(false);
  const [feedProvider, setFeedProvider] = useState<
    'xm_bridge' | 'cfd_ws' | 'yahoo_fallback' | null
  >(null);
  const [brokerSymbolLabel, setBrokerSymbolLabel] = useState<string>('');
  const [xmBridgeStatus, setXmBridgeStatus] = useState<XmBridgeStatusSnapshot | null>(null);
  const [copiedBridgeUrl, setCopiedBridgeUrl] = useState(false);
  const [alertToast, setAlertToast] = useState<AlertToastFeedback | null>(null);

  const countdownRef = useRef<number | null>(null);
  const tickFlashTimerRef = useRef<number | null>(null);
  const simPlanRef = useRef<{ open: number; targetClose: number; step: number } | null>(null);
  const simStepFnRef = useRef<() => void>(() => {});
  const alertedLiveBarsRef = useRef<Set<string>>(new Set());
  const lastKnownClosedIsoRef = useRef<Partial<Record<CisdTimeframe, string>>>({});
  const prevRolloverBucketRef = useRef<number | null>(null);
  const fetchLiveCisdBarsFnRef = useRef<
    (
      sym: TradingSymbol,
      tf: CisdTimeframe,
      opts?: { updateChart?: boolean; fresh?: boolean }
    ) => Promise<void>
  >(async () => {});
  const barsRef = useRef<M15CisdBar[]>(seriesState.bars);
  barsRef.current = seriesState.bars;
  const spec = SYMBOL_SPECS[symbol];

  useEffect(() => {
    setBarCountdown(formatTimeframeCountdown(activeTimeframe));
    const id = window.setInterval(() => {
      setBarCountdown(formatTimeframeCountdown(activeTimeframe));
      if (feedMode === 'live') {
        const xmSec = Math.floor(Date.now() / 1000) + getXmServerOffsetSec();
        const currM15 = Math.floor(xmSec / 900);
        const prev = prevRolloverBucketRef.current;
        prevRolloverBucketRef.current = currM15;
        if (prev !== null && currM15 !== prev) {
          void fetchLiveCisdBarsFnRef.current(symbol, 'M15', {
            updateChart: true,
            fresh: true,
          });
        }
      } else {
        prevRolloverBucketRef.current = null;
      }
    }, 1000);
    return () => window.clearInterval(id);
  }, [activeTimeframe, feedMode, symbol]);

  const stopAudioAndTimer = () => {
    stop10SecondSound();
    if (countdownRef.current !== null) {
      window.clearInterval(countdownRef.current);
      countdownRef.current = null;
    }
    setSoundSecondsLeft(0);
  };

  useEffect(() => {
    return () => {
      stopAudioAndTimer();
      if (tickFlashTimerRef.current !== null) {
        window.clearTimeout(tickFlashTimerRef.current);
      }
    };
  }, []);

  const trigger10sSound = useCallback(
    (signal: 'BUY' | 'SELL', forcePlay = false) => {
      if (!soundEnabled && !forcePlay) return;
      unlockAudioAlert();
      stopAudioAndTimer();
      setSoundSecondsLeft(10);
      countdownRef.current = window.setInterval(() => {
        setSoundSecondsLeft((prev) => {
          if (prev <= 1) {
            if (countdownRef.current !== null) {
              window.clearInterval(countdownRef.current);
              countdownRef.current = null;
            }
            return 0;
          }
          return prev - 1;
        });
      }, 1000);

      play10SecondSound(signal === 'BUY' ? 'buy' : 'sell', () => {
        if (countdownRef.current !== null) {
          window.clearInterval(countdownRef.current);
          countdownRef.current = null;
        }
        setSoundSecondsLeft(0);
      });
    },
    [soundEnabled]
  );

  useEffect(() => {
    if (typeof window !== 'undefined' && 'serviceWorker' in navigator) {
      void navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
    void getExistingPushSubscription()
      .then((sub) => {
        if (
          sub ||
          (typeof window !== 'undefined' &&
            'Notification' in window &&
            Notification.permission === 'granted')
        ) {
          setMobileNotifyReady(true);
        }
      })
      .catch(() => {});
  }, []);

  const syncServerMonitorStatus = useCallback(async () => {
    try {
      const r = await fetch('/api/monitor/status');
      if (!r.ok) return;
      const data = await r.json();
      if (typeof data.m15Enabled === 'boolean') {
        setServerM15Enabled(data.m15Enabled);
      }
      if (typeof data.subscribersCount === 'number') {
        setServerSubscribersCount(data.subscribersCount);
      }
      if (typeof data.lastCheckedAt === 'string') {
        setServerLastCheckedAt(data.lastCheckedAt);
      }
      if (
        data.m15Direction === 'both' ||
        data.m15Direction === 'buy_only' ||
        data.m15Direction === 'sell_only'
      ) {
        setDirectionFilter(data.m15Direction);
      }
    } catch {
      // Ignore transient network errors
    }
  }, []);

  const handleToggleServerMonitor = async () => {
    const nextEnabled = !serverM15Enabled;
    setTogglingServerMonitor(true);
    try {
      const res = await fetch('/api/monitor/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          m15Enabled: nextEnabled,
          cisdTimeframes: ['M15'],
        }),
      });
      if (res.ok) {
        const data = await res.json();
        setServerM15Enabled(Boolean(data.m15Enabled));
        if (typeof data.lastCheckedAt === 'string') {
          setServerLastCheckedAt(data.lastCheckedAt);
        }
      }
    } catch {
      // Ignore transient failure
    } finally {
      setTogglingServerMonitor(false);
    }
  };

  const handleEnableMobileNotify = async () => {
    unlockAudioAlert();
    setMobileNotifyBusy(true);
    setMobileNotifyHint(null);
    setMobileNotifySuccess(null);
    try {
      if (!serverM15Enabled) {
        await fetch('/api/monitor/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            m15Enabled: true,
            cisdTimeframes: ['M15'],
          }),
        }).catch(() => {});
        setServerM15Enabled(true);
      }

      const sub = await subscribeDeviceToWebPush();
      setMobileNotifyReady(true);

      let pushedViaServer = false;
      try {
        await sendTestWebPush(sub.endpoint);
        pushedViaServer = true;
      } catch {
        pushedViaServer = false;
      }

      if (!pushedViaServer) {
        await showLocalMobileNotification({
          title: `เปิดแจ้งเตือน US100 M15 สำเร็จ`,
          body: 'เซิร์ฟเวอร์เฝ้ากราฟ US100 M15 อัตโนมัติพร้อมแจ้งเตือนเข้ามือถือเครื่องนี้แล้ว',
          tag: `cisd-mobile-ready-${Date.now()}`,
          url: `/?tf=M15`,
        });
      }

      setMobileNotifySuccess(
        'เปิดแจ้งเตือนเข้ามือถือและทดสอบส่งข้อความสำเร็จแล้ว พร้อมรับสัญญาณ US100 M15 อัตโนมัติ'
      );
      void syncServerMonitorStatus();
    } catch (err: any) {
      if (
        typeof window !== 'undefined' &&
        'Notification' in window &&
        Notification.permission === 'granted'
      ) {
        setMobileNotifyReady(true);
        const shown = await showLocalMobileNotification({
          title: `เปิดแจ้งเตือน US100 M15 สำเร็จ`,
          body: 'เซิร์ฟเวอร์เฝ้ากราฟ US100 M15 อัตโนมัติพร้อมแจ้งเตือนเข้ามือถือเครื่องนี้แล้ว',
          tag: `cisd-mobile-ready-${Date.now()}`,
          url: `/?tf=M15`,
        });
        if (shown) {
          setMobileNotifySuccess('ส่งแจ้งเตือนทดสอบเข้าอุปกรณ์นี้สำเร็จแล้ว');
        }
      } else {
        const insideIframe =
          typeof window !== 'undefined' && window.self !== window.top;
        setMobileNotifyHint(
          insideIframe
            ? 'หน้าเว็บกำลังเปิดอยู่ในกรอบพรีวิว (Chrome บล็อก Popup แจ้งเตือนในกรอบ) กรุณากด "เปิดเต็มจอในแท็บใหม่" ด้านล่าง แล้วกดปุ่มรับแจ้งเตือนอีกครั้ง'
            : err?.message ||
                'เบราว์เซอร์นี้ยังไม่อนุญาตแจ้งเตือน (แนะนำกดอนุญาต Notification หรือรับแจ้งเตือนผ่าน Telegram)'
        );
      }
    } finally {
      setMobileNotifyBusy(false);
    }
  };

  const handleTestSound = () => {
    unlockAudioAlert();
    setSoundEnabled(true);
    trigger10sSound('SELL', true);
  };

  const emitCisdAlert = useCallback(
    (
      sym: TradingSymbol,
      tf: CisdTimeframe,
      signal: 'BUY' | 'SELL',
      cisdLevel: number | null,
      closePrice: number,
      timeLabel: string,
      timestampIso: string,
      sourceTag: string,
      mode: 'live' | 'sim'
    ) => {
      const symSpec = SYMBOL_SPECS[sym];
      const timeStr = new Date(timestampIso).toLocaleString('th-TH', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });
      const conditionText =
        signal === 'SELL' ? 'ราคาปิดต่ำกว่าระดับ CISD' : 'ราคาปิดเหนือระดับ CISD';

      trigger10sSound(signal);

      const toastId = `${mode}-${tf}-${timestampIso}-${Date.now()}`;
      setAlertToast({
        id: toastId,
        mode,
        timeframe: tf,
        signal,
        price: closePrice,
        cisdLevel,
        telegramDelivered: false,
        telegramMissingToken: false,
        mobileDelivered: false,
      });

      void dispatchMobileSignalNotification({
        symbol: sym,
        timeframe: tf,
        strategy: 'CISD',
        signal,
        aoPrev: 0,
        aoCurr: 0,
        price: closePrice,
        cisdLevel,
        mode,
        timestampIso,
        prefix: customPrefix,
      }).then((result) => {
        setAlertToast((prev) =>
          prev && prev.id === toastId
            ? {
                ...prev,
                telegramDelivered: result.deliveredToTelegram,
                telegramMissingToken: Boolean(result.telegramMissingToken),
                telegramError: result.telegramError,
                mobileDelivered:
                  result.deliveredWebPushCount > 0 || result.localNotificationShown,
              }
            : prev
        );
      });

      onSignalDetected({
        id: `${tf}-${sym}-${timestampIso}-${Math.random().toString(36).slice(2, 7)}`,
        timestamp: timeStr,
        symbol: sym,
        timeframe: tf,
        signal,
        aoPrev: cisdLevel ?? closePrice,
        aoCurr: closePrice,
        price: closePrice,
        pushStatus: sourceTag,
        note:
          cisdLevel !== null
            ? `${conditionText} (${cisdLevel.toFixed(symSpec.digits)})`
            : conditionText,
        syncedToSheet: false,
      });
    },
    [customPrefix, onSignalDetected, trigger10sSound]
  );

  useEffect(() => {
    void syncServerMonitorStatus();
    const id = window.setInterval(() => {
      void syncServerMonitorStatus();
    }, 10000);
    return () => window.clearInterval(id);
  }, [syncServerMonitorStatus]);

  const fetchLiveCisdBars = useCallback(
    async (
      targetSymbol: TradingSymbol,
      targetTf: CisdTimeframe,
      options?: { updateChart?: boolean; fresh?: boolean; showSpinner?: boolean }
    ) => {
      const updateChart = options?.updateChart ?? true;
      const freshParam = options?.fresh ? '&fresh=1' : '';
      const showSpinner = options?.showSpinner ?? false;
      if (updateChart && (showSpinner || barsRef.current.length === 0)) {
        setIsLoadingLive(true);
      }
      if (updateChart) {
        setLiveError(null);
      }
      try {
        const res = await fetch(
          `/api/market/cisd?symbol=${encodeURIComponent(targetSymbol)}&tf=${encodeURIComponent(
            targetTf
          )}${freshParam}`
        );
        if (!res.ok) {
          const errBody = await res.json().catch(() => ({}));
          throw new Error(errBody.error || `ดึงข้อมูลกราฟจริง ${targetTf} ไม่สำเร็จ`);
        }
        const data = (await res.json()) as LiveM15FeedResponse;
        if (updateChart) {
          setSeriesState({
            bars: data.bars,
            segments: data.segments,
            latestBearCisdLevel: data.latestBearCisdLevel,
            latestBullCisdLevel: data.latestBullCisdLevel,
            currentTrend: data.currentTrend ?? null,
            lastSignalInfo: data.lastSignalInfo ?? null,
          });
          setMarketState(data.marketState);
          if (data.feedProvider) setFeedProvider(data.feedProvider);
          if (data.brokerSymbol) setBrokerSymbolLabel(data.brokerSymbol);
        }

        // Closed bar is ALWAYS bars[length - 2]; also inspect [length - 3] if a 2s rollover jumped quickly
        const latestClosedBar = data.bars[data.bars.length - 2];
        const priorClosedBar = data.bars[data.bars.length - 3];
        if (latestClosedBar) {
          const prevClosedIso = lastKnownClosedIsoRef.current[targetTf];
          lastKnownClosedIsoRef.current[targetTf] = latestClosedBar.timestampIso;
          const isJustClosed =
            prevClosedIso !== undefined && prevClosedIso !== latestClosedBar.timestampIso;
          const tfMinutes = CISD_TIMEFRAME_MAP[targetTf]?.minutes || 15;
          const candidates = isJustClosed
            ? [latestClosedBar, priorClosedBar]
            : [latestClosedBar];

          for (const closedBar of candidates) {
            if (!closedBar || !closedBar.cisdSignal) continue;
            const barCloseMs =
              new Date(closedBar.timestampIso).getTime() + tfMinutes * 60000;
            const closeAgeMinutes = (Date.now() - barCloseMs) / 60000;
            const withinTimingWindow = isJustClosed
              ? closeAgeMinutes <= tfMinutes * 2
              : closeAgeMinutes >= -0.5 && closeAgeMinutes <= tfMinutes;

            if (withinTimingWindow) {
              const key = `${targetTf}-${targetSymbol}-${closedBar.timestampIso}-${closedBar.cisdSignal}`;
              const shouldNotify =
                directionFilter === 'both' ||
                (directionFilter === 'buy_only' && closedBar.cisdSignal === 'BUY') ||
                (directionFilter === 'sell_only' && closedBar.cisdSignal === 'SELL');

              if (shouldNotify && !alertedLiveBarsRef.current.has(key)) {
                alertedLiveBarsRef.current.add(key);
                emitCisdAlert(
                  targetSymbol,
                  targetTf,
                  closedBar.cisdSignal,
                  closedBar.cisdLevel,
                  closedBar.close,
                  closedBar.timeLabel,
                  closedBar.timestampIso,
                  `Live ${targetTf} CISD`,
                  'live'
                );
              }
            }
          }
        }
      } catch (err: any) {
        if (updateChart) {
          setLiveError(err?.message || `เชื่อมต่อฟีดกราฟจริง ${targetTf} ไม่สำเร็จ`);
        }
      } finally {
        if (updateChart) {
          setIsLoadingLive(false);
        }
      }
    },
    [directionFilter, emitCisdAlert]
  );

  fetchLiveCisdBarsFnRef.current = fetchLiveCisdBars;

  const fetchLiveTick = useCallback(async (targetSymbol: TradingSymbol) => {
    try {
      const res = await fetch(
        `/api/market/tick?symbol=${encodeURIComponent(targetSymbol)}`
      );
      if (!res.ok) return;
      const tick = (await res.json()) as {
        symbol: TradingSymbol;
        price: number;
        feedProvider?: 'xm_bridge' | 'cfd_ws' | 'yahoo_fallback';
        marketState: string;
        fetchedAt: string;
      };
      if (!Number.isFinite(tick.price) || tick.price <= 0) return;

      setMarketState(tick.marketState);
      if (tick.feedProvider) setFeedProvider(tick.feedProvider);
      setLastTickTime(
        new Date(tick.fetchedAt).toLocaleTimeString('th-TH', {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false,
        })
      );

      setSeriesState((prev) => {
        if (prev.bars.length === 0) return prev;
        const lastIdx = prev.bars.length - 1;
        const lastBar = prev.bars[lastIdx];
        if (tick.price !== lastBar.close) {
          setTickFlash(tick.price > lastBar.close ? 'up' : 'down');
          if (tickFlashTimerRef.current !== null) {
            window.clearTimeout(tickFlashTimerRef.current);
          }
          tickFlashTimerRef.current = window.setTimeout(() => {
            setTickFlash(null);
          }, 700);
        }
        const updatedLast: M15CisdBar = {
          ...lastBar,
          close: tick.price,
          high: Math.max(lastBar.high, tick.price),
          low: Math.min(lastBar.low, tick.price),
        };
        const nextBars = [...prev.bars.slice(0, lastIdx), updatedLast];
        return {
          ...prev,
          bars: nextBars,
        };
      });
    } catch {
      // Transient tick error; bar polling keeps state consistent
    }
  }, []);

  const fetchBridgeStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/mt5/bridge-status');
      if (!res.ok) return;
      const status = (await res.json()) as XmBridgeStatusSnapshot;
      setXmBridgeStatus(status);
    } catch {
      // Ignore transient bridge status errors
    }
  }, []);

  useEffect(() => {
    void fetchBridgeStatus();
    const bridgeId = window.setInterval(() => {
      void fetchBridgeStatus();
    }, 4000);
    return () => window.clearInterval(bridgeId);
  }, [fetchBridgeStatus]);

  useEffect(() => {
    if (feedMode !== 'live') return;
    const pollCisdM15 = (showSpinner = false) => {
      void fetchLiveCisdBars(symbol, 'M15', {
        updateChart: true,
        showSpinner,
      });
    };
    pollCisdM15(true);
    const barPollId = window.setInterval(() => {
      pollCisdM15(false);
    }, 2000);
    const tickPollId = window.setInterval(() => {
      void fetchLiveTick(symbol);
    }, 2000);
    return () => {
      window.clearInterval(barPollId);
      window.clearInterval(tickPollId);
    };
  }, [feedMode, symbol, activeTimeframe, fetchLiveCisdBars, fetchLiveTick]);

  const handleChangeFeedMode = (nextMode: 'live' | 'sim') => {
    setIsPlaying(false);
    setFeedMode(nextMode);
    setHoveredIdx(null);
    setLiveError(null);
    simPlanRef.current = null;
    setSimTickStep(0);
    if (nextMode === 'sim') {
      setSeriesState(generateInitialCisdSeries(symbol, activeTimeframe));
      setMarketState('');
    }
  };

  const handleDirectionChange = async (nextDir: AlertDirection) => {
    setDirectionFilter(nextDir);
    try {
      await fetch('/api/monitor/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          m15Direction: nextDir,
        }),
      });
    } catch {
      // Non-blocking sync
    }
  };

  const triggerTickFlash = useCallback((prevClose: number, nextClose: number) => {
    if (nextClose === prevClose) return;
    setTickFlash(nextClose > prevClose ? 'up' : 'down');
    if (tickFlashTimerRef.current !== null) {
      window.clearTimeout(tickFlashTimerRef.current);
    }
    tickFlashTimerRef.current = window.setTimeout(() => {
      setTickFlash(null);
    }, 550);
  }, []);

  const notifyIfClosedBarTriggered = useCallback(
    (closedBar: M15CisdBar | undefined, sourceTag: string) => {
      if (!closedBar || !closedBar.cisdSignal) return;
      const shouldNotify =
        directionFilter === 'both' ||
        (directionFilter === 'buy_only' && closedBar.cisdSignal === 'BUY') ||
        (directionFilter === 'sell_only' && closedBar.cisdSignal === 'SELL');

      if (shouldNotify) {
        emitCisdAlert(
          symbol,
          activeTimeframe,
          closedBar.cisdSignal,
          closedBar.cisdLevel,
          closedBar.close,
          closedBar.timeLabel,
          closedBar.timestampIso,
          sourceTag,
          'sim'
        );
      }
    },
    [activeTimeframe, directionFilter, emitCisdAlert, symbol]
  );

  const advanceBar = (forceSignal?: 'BUY' | 'SELL') => {
    simPlanRef.current = null;
    setSimTickStep(0);
    const prevLast = barsRef.current[barsRef.current.length - 1];
    const nextResult = appendNextCisdBar(
      barsRef.current,
      symbol,
      forceSignal,
      activeTimeframe
    );
    barsRef.current = nextResult.bars;
    setSeriesState(nextResult);

    // Closed bar is ALWAYS bars[length - 2]; bars[length - 1] is the newly opened forming candle
    const latestClosed = nextResult.bars[nextResult.bars.length - 2];
    if (prevLast && latestClosed) {
      triggerTickFlash(prevLast.close, latestClosed.close);
    }
    notifyIfClosedBarTriggered(latestClosed, `Sim ${activeTimeframe} CISD`);
  };

  const stepSimTick = () => {
    const currentBars = barsRef.current;
    if (currentBars.length === 0) return;
    const openBar = currentBars[currentBars.length - 1];

    if (!simPlanRef.current) {
      const delta = planNextCisdCloseDelta(
        openBar.timestampIso,
        symbol,
        activeTimeframe
      );
      simPlanRef.current = {
        open: openBar.open,
        targetClose: openBar.open + delta,
        step: 1,
      };
    }

    const plan = simPlanRef.current;
    const delta = plan.targetClose - plan.open;

    if (plan.step < 4) {
      // Intrabar ticks (1..3): candle moves visibly, may pierce CISD while unclosed, NEVER alerts yet!
      const fraction = plan.step === 1 ? 0.36 : plan.step === 2 ? 1.12 : 0.88;
      const intrabarPrice = plan.open + delta * fraction;
      triggerTickFlash(openBar.close, intrabarPrice);
      const tickedResult = tickFormingCisdBar(currentBars, intrabarPrice, symbol);
      barsRef.current = tickedResult.bars;
      setSeriesState(tickedResult);
      setSimTickStep(plan.step);
      plan.step += 1;
      return;
    }

    // Tick 4 (Close Candle): lock final close, open next forming candle, and check ONLY the newly closed bar
    triggerTickFlash(openBar.close, plan.targetClose);
    const closedResult = finalizeCisdBarAndOpenNext(
      currentBars,
      plan.targetClose,
      symbol,
      activeTimeframe
    );
    barsRef.current = closedResult.bars;
    setSeriesState(closedResult);
    simPlanRef.current = null;
    setSimTickStep(0);

    const newlyClosedBar = closedResult.bars[closedResult.bars.length - 2];
    notifyIfClosedBarTriggered(newlyClosedBar, `Sim ${activeTimeframe} CISD`);
  };

  simStepFnRef.current = stepSimTick;

  useEffect(() => {
    if (feedMode !== 'sim' || !isPlaying) return;
    const timer = window.setInterval(() => {
      simStepFnRef.current();
    }, 280);
    return () => window.clearInterval(timer);
  }, [feedMode, isPlaying]);

  // Show last 72 M15 candles with generous right-side chart shift whitespace
  const visibleSliceCount = 72;
  const visibleStartIdx = Math.max(0, seriesState.bars.length - visibleSliceCount);
  const visibleBars = useMemo(
    () => seriesState.bars.slice(visibleStartIdx),
    [seriesState.bars, visibleStartIdx]
  );

  const visibleSegments = useMemo(() => {
    // Last bar (length - 1) is ALWAYS the open forming candle; never lock bold CISD line until closed!
    const lastClosedGlobalIdx = seriesState.bars.length - 2;

    return seriesState.segments
      .filter((seg) => {
        if (seg.triggeredIndex === null || seg.triggeredDirection === null) return false;
        if (seg.triggeredIndex > lastClosedGlobalIdx) return false;
        if (seg.triggeredIndex < visibleStartIdx) return false;
        if (directionFilter === 'sell_only' && seg.triggeredDirection !== 'SELL') return false;
        if (directionFilter === 'buy_only' && seg.triggeredDirection !== 'BUY') return false;
        return true;
      })
      .slice(-6)
      .map((seg) => ({
        ...seg,
        visStart: Math.max(0, seg.originIndex - visibleStartIdx),
        visTrigger: Math.min(
          visibleBars.length - 1,
          (seg.triggeredIndex ?? seg.endIndex) - visibleStartIdx
        ),
      }));
  }, [
    seriesState.segments,
    seriesState.bars.length,
    visibleStartIdx,
    visibleBars.length,
    directionFilter,
  ]);

  const openFormingBar = seriesState.bars[seriesState.bars.length - 1];
  const intrabarTestingDir: 'BUY' | 'SELL' | null =
    directionFilter !== 'buy_only' &&
    openFormingBar?.activeBearCisdLevel !== null &&
    openFormingBar?.activeBearCisdLevel !== undefined &&
    openFormingBar.close < openFormingBar.activeBearCisdLevel
      ? 'SELL'
      : directionFilter !== 'sell_only' &&
        openFormingBar?.activeBullCisdLevel !== null &&
        openFormingBar?.activeBullCisdLevel !== undefined &&
        openFormingBar.close > openFormingBar.activeBullCisdLevel
      ? 'BUY'
      : null;

  const activeWatchSegments = useMemo(() => {
    const out: Array<{
      id: string;
      direction: 'BUY' | 'SELL';
      level: number;
      visStart: number;
      visEnd: number;
      isTesting: boolean;
    }> = [];

    if (seriesState.latestBearCisdLevel !== null && directionFilter !== 'buy_only') {
      const seg = [...seriesState.segments]
        .reverse()
        .find(
          (s) =>
            s.kind === 'bearish_break' &&
            s.triggeredIndex === null &&
            s.level === seriesState.latestBearCisdLevel
        );
      out.push({
        id: seg?.id || `watch-bear-${seriesState.latestBearCisdLevel}`,
        direction: 'SELL',
        level: seriesState.latestBearCisdLevel,
        visStart: seg ? Math.max(0, seg.originIndex - visibleStartIdx) : Math.max(0, visibleBars.length - 8),
        visEnd: Math.max(0, visibleBars.length - 1),
        isTesting: intrabarTestingDir === 'SELL',
      });
    }

    if (seriesState.latestBullCisdLevel !== null && directionFilter !== 'sell_only') {
      const seg = [...seriesState.segments]
        .reverse()
        .find(
          (s) =>
            s.kind === 'bullish_break' &&
            s.triggeredIndex === null &&
            s.level === seriesState.latestBullCisdLevel
        );
      out.push({
        id: seg?.id || `watch-bull-${seriesState.latestBullCisdLevel}`,
        direction: 'BUY',
        level: seriesState.latestBullCisdLevel,
        visStart: seg ? Math.max(0, seg.originIndex - visibleStartIdx) : Math.max(0, visibleBars.length - 8),
        visEnd: Math.max(0, visibleBars.length - 1),
        isTesting: intrabarTestingDir === 'BUY',
      });
    }

    return out;
  }, [
    seriesState.latestBearCisdLevel,
    seriesState.latestBullCisdLevel,
    seriesState.segments,
    directionFilter,
    visibleStartIdx,
    visibleBars.length,
    intrabarTestingDir,
  ]);

  const chartMetrics = useMemo(() => {
    const highs = visibleBars.map((b) => b.high);
    const lows = visibleBars.map((b) => b.low);
    for (const seg of visibleSegments) {
      highs.push(seg.level);
      lows.push(seg.level);
    }
    for (const watch of activeWatchSegments) {
      highs.push(watch.level);
      lows.push(watch.level);
    }
    const maxPrice = Math.max(...highs);
    const minPrice = Math.min(...lows);
    const span = maxPrice - minPrice || spec.stepSize;
    return {
      priceTop: maxPrice + span * 0.14,
      priceBottom: minPrice - span * 0.14,
    };
  }, [visibleBars, visibleSegments, activeWatchSegments, spec.stepSize]);

  const activeBar =
    hoveredIdx !== null && visibleBars[hoveredIdx]
      ? visibleBars[hoveredIdx]
      : visibleBars[visibleBars.length - 1];

  const latestClosedBar = visibleBars[visibleBars.length - 1];

  const detectedInVisible = visibleBars.filter((b, idx) => {
    if (idx === visibleBars.length - 1) return false;
    if (!b.cisdSignal) return false;
    if (directionFilter === 'sell_only') return b.cisdSignal === 'SELL';
    if (directionFilter === 'buy_only') return b.cisdSignal === 'BUY';
    return true;
  }).length;

  // Geometry matching MT5 Black Terminal Layout (single clean candlestick pane)
  const svgW = 860;
  const priceH = 420;
  const xAxisY = priceH;
  const totalH = xAxisY + 26;

  const padL = 8;
  const padR = isWebMode ? 8 : 96;
  const plotLeft = padL;
  const plotRight = svgW - padR;
  const totalPlotW = plotRight - plotLeft;

  const activeCandlesW = totalPlotW * 0.7;
  const slotW = activeCandlesW / Math.max(1, visibleBars.length);
  const candleW = Math.max(3.0, Math.min(5.4, slotW * 0.6));

  const priceToY = (p: number) => {
    const ratio =
      (chartMetrics.priceTop - p) / (chartMetrics.priceTop - chartMetrics.priceBottom);
    return 18 + ratio * (priceH - 34);
  };

  const latestCloseY = priceToY(latestClosedBar.close);
  const priceTickRatios = [0.06, 0.21, 0.36, 0.51, 0.66, 0.81, 0.94];

  return (
    <section className="space-y-6">
      {/* Compact Visual Brand Card: New Cisd เตือน Logo & M15 Breakout Artwork */}
      <div className="relative overflow-hidden rounded-2xl border border-slate-800/80 bg-[#090d16] text-white shadow-sm">
        <div className="pointer-events-none absolute inset-y-0 right-0 w-full sm:w-3/5 opacity-75">
          <img
            src={cisdBannerImg}
            alt="Cisd เตือน กราฟ US100 M15 Real-Time"
            referrerPolicy="no-referrer"
            className="h-full w-full object-cover object-center"
          />
          <div className="absolute inset-0 bg-gradient-to-r from-[#090d16] via-[#090d16]/85 to-transparent" />
        </div>
        <div className="relative z-10 flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6 sm:py-4">
          <div className="flex items-center gap-3.5">
            <img
              src={cisdLogoImg}
              alt="โลโก้ Cisd เตือน"
              referrerPolicy="no-referrer"
              className="h-12 w-12 shrink-0 rounded-xl object-cover ring-1 ring-amber-400/35 shadow-md"
            />
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-bold tracking-tight text-white sm:text-lg">
                  Cisd เตือน
                </h2>
                <span className="inline-flex items-center gap-1 rounded-md bg-emerald-500/15 px-2 py-0.5 text-[11px] font-semibold text-emerald-300 ring-1 ring-emerald-400/25">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  M15 LIVE
                </span>
              </div>
              <p className="mt-0.5 text-xs text-slate-300">
                สแกนโครงสร้าง US100 M15 ทุก 2 วินาที · ส่งแจ้งเตือน Telegram (8217822307) & มือถือ
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 text-xs text-amber-200/90 font-mono tabular-nums">
            <span className="rounded-lg bg-slate-900/80 px-2.5 py-1.5 ring-1 ring-white/10">
              US100Cash# · {activeTimeframe}
            </span>
          </div>
        </div>
      </div>

      {/* Control Toolbar (M15 Only) */}
      <div className="flex flex-col gap-3.5 rounded-xl border border-slate-200/90 bg-white p-4 sm:p-5 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap items-center gap-3.5">
          {/* Live vs Sim Switch */}
          <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-1">
            <button
              type="button"
              onClick={() => handleChangeFeedMode('live')}
              className={`inline-flex h-9 items-center gap-1.5 rounded-md px-3.5 text-[13px] font-medium whitespace-nowrap shrink-0 transition-colors ${
                feedMode === 'live'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <Radio className="h-3.5 w-3.5 text-emerald-600" />
              กราฟจริง {activeTimeframe}
            </button>
            <button
              type="button"
              onClick={() => handleChangeFeedMode('sim')}
              className={`h-9 rounded-md px-3.5 text-[13px] font-medium whitespace-nowrap shrink-0 transition-colors ${
                feedMode === 'sim'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              จำลอง {activeTimeframe}
            </button>
          </div>

          {/* Unboxed Asset Metadata */}
          <div className="flex items-center gap-2 text-[13px] text-slate-600">
            <span className="font-semibold text-slate-900">US100</span>
            <span aria-hidden="true" className="text-slate-300">·</span>
            <span className="font-medium text-amber-700">{activeTimeframe} · CISD</span>
            <span aria-hidden="true" className="text-slate-300">·</span>
            <span className="text-slate-500">{spec.label}</span>
          </div>

          {onOpenStatusWindow && !isWebMode && (
            <button
              type="button"
              onClick={onOpenStatusWindow}
              className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-blue-200 bg-blue-50 px-3 text-xs font-semibold text-blue-700 whitespace-nowrap shrink-0 transition-colors hover:bg-blue-100"
            >
              <LayoutGrid className="h-3.5 w-3.5" />
              สถานะ M15 (ขึ้น/ลง)
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label="ทิศทางแจ้งเตือน CISD"
            value={directionFilter}
            onChange={(e) => void handleDirectionChange(e.target.value as AlertDirection)}
            className="h-10 rounded-lg border border-slate-200 bg-white px-3 text-[13px] font-medium text-slate-700 focus:border-blue-600 focus:outline-none"
          >
            <option value="both">เตือนทั้งขาขึ้น & ขาลง</option>
            <option value="sell_only">เฉพาะปิดต่ำกว่า CISD (SELL)</option>
            <option value="buy_only">เฉพาะปิดเหนือ CISD (BUY)</option>
          </select>

          {feedMode === 'live' ? (
            <button
              type="button"
              onClick={() =>
                void fetchLiveCisdBars(symbol, activeTimeframe, {
                  updateChart: true,
                  fresh: true,
                })
              }
              disabled={isLoadingLive}
              className="inline-flex h-10 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3.5 text-[13px] font-medium text-slate-700 whitespace-nowrap shrink-0 transition-colors hover:bg-slate-50 disabled:opacity-50"
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${isLoadingLive ? 'animate-spin' : ''}`}
              />
              รีเฟรชกราฟจริง
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={() => advanceBar('BUY')}
                className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-emerald-600 px-3.5 text-[13px] font-medium text-white whitespace-nowrap shrink-0 transition-colors hover:bg-emerald-700"
              >
                <ArrowUpRight className="h-4 w-4" />
                ทดสอบปิดเหนือ CISD
              </button>

              <button
                type="button"
                onClick={() => advanceBar('SELL')}
                className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-amber-500 px-3.5 text-[13px] font-medium text-slate-950 whitespace-nowrap shrink-0 transition-colors hover:bg-amber-400"
              >
                <ArrowDownRight className="h-4 w-4" />
                ทดสอบปิดต่ำกว่า CISD
              </button>

              <button
                type="button"
                onClick={() => {
                  unlockAudioAlert();
                  setIsPlaying((p) => !p);
                }}
                className={`inline-flex h-10 items-center gap-1.5 rounded-lg px-3.5 text-[13px] font-medium whitespace-nowrap shrink-0 transition-colors ${
                  isPlaying
                    ? 'bg-slate-900 text-white hover:bg-slate-800'
                    : 'border border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                }`}
              >
                {isPlaying ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                {isPlaying ? 'หยุด' : 'เล่น'}
              </button>

              <button
                type="button"
                onClick={() => {
                  unlockAudioAlert();
                  advanceBar();
                }}
                aria-label={`แท่งถัดไป ${activeTimeframe}`}
                className="inline-flex h-10 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3.5 text-[13px] font-medium text-slate-700 whitespace-nowrap shrink-0 transition-colors hover:bg-slate-50"
              >
                <SkipForward className="h-3.5 w-3.5" />
                ถัดไป
              </button>

              <button
                type="button"
                onClick={() => {
                  setIsPlaying(false);
                  simPlanRef.current = null;
                  setSimTickStep(0);
                  stopAudioAndTimer();
                  setSeriesState(generateInitialCisdSeries(symbol, activeTimeframe));
                }}
                aria-label={`รีเซ็ตกราฟ ${activeTimeframe}`}
                className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-500 transition-colors hover:bg-slate-50 hover:text-slate-800"
              >
                <RotateCcw className="h-4 w-4" />
              </button>
            </>
          )}

          <button
            type="button"
            onClick={() => {
              unlockAudioAlert();
              if (soundEnabled) stopAudioAndTimer();
              setSoundEnabled((s) => !s);
            }}
            aria-label="สลับเสียงเตือน 10 วินาที"
            className={`inline-flex h-10 items-center gap-1.5 rounded-lg border px-3.5 text-[13px] font-medium whitespace-nowrap shrink-0 transition-colors ${
              soundEnabled
                ? 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                : 'border-slate-200 bg-slate-100 text-slate-500'
            }`}
          >
            {soundEnabled ? (
              <Volume2 className="h-4 w-4 text-blue-600" />
            ) : (
              <VolumeX className="h-4 w-4" />
            )}
            เสียง 10 วิ
          </button>

          <button
            type="button"
            onClick={handleTestSound}
            aria-label="ทดสอบเสียงเตือน"
            className="inline-flex h-10 items-center gap-1.5 rounded-lg border border-blue-200 bg-blue-50/70 px-3.5 text-[13px] font-medium text-blue-700 whitespace-nowrap shrink-0 transition-colors hover:bg-blue-100"
          >
            <Bell className="h-3.5 w-3.5" />
            ทดสอบเสียง
          </button>

          <button
            type="button"
            onClick={() => void handleEnableMobileNotify()}
            disabled={mobileNotifyBusy}
            aria-label="เปิดแจ้งเตือนเข้ามือถือ"
            className={`inline-flex h-10 items-center gap-1.5 rounded-lg border px-3.5 text-[13px] font-medium whitespace-nowrap shrink-0 transition-colors disabled:opacity-60 ${
              mobileNotifyReady
                ? 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
            }`}
          >
            <Smartphone className="h-3.5 w-3.5" />
            {mobileNotifyReady ? 'แจ้งเตือนมือถือ (เปิด)' : 'แจ้งเตือนเข้ามือถือ'}
          </button>

          <button
            type="button"
            onClick={onGoToTelegram}
            aria-label="เปิดหน้าเชื่อมต่อ Telegram"
            className={`inline-flex h-10 items-center gap-1.5 rounded-lg border px-3.5 text-[13px] font-medium whitespace-nowrap shrink-0 transition-colors ${
              telegramSyncedReady
                ? 'border-sky-200 bg-sky-50 text-sky-800 hover:bg-sky-100'
                : 'border-amber-200 bg-amber-50 text-amber-800 hover:bg-amber-100'
            }`}
          >
            <Send className="h-3.5 w-3.5" />
            {telegramSyncedReady ? 'Telegram (เชื่อมต่อแล้ว)' : 'เชื่อมต่อ Telegram'}
          </button>

          {soundSecondsLeft > 0 && (
            <button
              type="button"
              onClick={stopAudioAndTimer}
              className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-amber-600 px-3.5 text-[13px] font-medium text-white whitespace-nowrap shrink-0 transition-colors hover:bg-amber-700"
            >
              <Square className="h-3.5 w-3.5" />
              หยุด ({soundSecondsLeft}s)
            </button>
          )}
        </div>
      </div>

      {telegramSyncedReady === false && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900">
          <div className="flex items-center gap-2">
            <AlertCircle className="h-4 w-4 shrink-0 text-amber-600" />
            <span>
              <strong>ยังไม่ได้ใส่ Telegram Bot Token บนเซิร์ฟเวอร์</strong> (แชท{' '}
              <span className="font-mono font-semibold">8217822307</span> พร้อมรับข้อความแล้ว — กรุณาบันทึก Bot Token 1 ครั้งเพื่อให้แจ้งเตือนจริงทั้งกราฟจริงและจำลอง)
            </span>
          </div>
          <button
            type="button"
            onClick={onGoToTelegram}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-amber-600 px-3 text-xs font-semibold text-white hover:bg-amber-700"
          >
            <Send className="h-3.5 w-3.5" />
            ใส่ Bot Token ทันที
          </button>
        </div>
      )}

      {alertToast && (
        <div
          className={`flex flex-wrap items-start justify-between gap-3 rounded-xl border px-4 py-3 text-xs shadow-xs ${
            alertToast.signal === 'BUY'
              ? 'border-emerald-200 bg-emerald-50 text-emerald-950'
              : 'border-amber-200 bg-amber-50 text-amber-950'
          }`}
        >
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2 font-semibold text-[13px]">
              {alertToast.signal === 'BUY' ? (
                <ArrowUpRight className="h-4 w-4 text-emerald-700" />
              ) : (
                <ArrowDownRight className="h-4 w-4 text-amber-700" />
              )}
              <span>
                {alertToast.mode === 'sim' ? '[จำลอง] ' : '[กราฟจริง] '}
                CISD {alertToast.timeframe} {alertToast.signal} · ราคาปิด {alertToast.price.toFixed(spec.digits)}
                {alertToast.cisdLevel !== null ? ` (CISD ${alertToast.cisdLevel.toFixed(spec.digits)})` : ''}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-3 text-[11px]">
              <span className="inline-flex items-center gap-1">
                {alertToast.telegramDelivered ? (
                  <>
                    <CheckCircle2 className="h-3.5 w-3.5 text-sky-600" />
                    <span className="text-sky-800 font-medium">
                      ส่งเข้า Telegram (8217822307) แล้ว
                    </span>
                  </>
                ) : alertToast.telegramMissingToken ? (
                  <button
                    type="button"
                    onClick={onGoToTelegram}
                    className="inline-flex items-center gap-1 font-semibold text-rose-700 underline"
                  >
                    <AlertCircle className="h-3.5 w-3.5" />
                    ยังไม่ได้ใส่ Bot Token (คลิกเพื่อตั้งค่า Telegram)
                  </button>
                ) : (
                  <span className="text-slate-600">
                    {alertToast.telegramError || 'กำลังส่งเข้า Telegram...'}
                  </span>
                )}
              </span>
              <span className="text-slate-300">·</span>
              <span className="inline-flex items-center gap-1 text-slate-700">
                <Smartphone className="h-3.5 w-3.5" />
                {alertToast.mobileDelivered
                  ? 'เด้งแจ้งเตือนมือถือแล้ว'
                  : 'เสียงเตือน 10 วิทำงานแล้ว (กด "แจ้งเตือนเข้ามือถือ" เพื่อรับ Popup)'}
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setAlertToast(null)}
            aria-label="ปิดการแจ้งเตือน"
            className="rounded p-1 text-slate-500 hover:bg-black/5 hover:text-slate-800"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {mobileNotifyHint && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-xs text-amber-800">
          {mobileNotifyHint}
        </div>
      )}

      {liveError && feedMode === 'live' && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-2.5 text-xs text-rose-800">
          {liveError}
        </div>
      )}

      {/* Full-Width MT5 Black CISD Chart */}
      <div className="flex flex-col rounded-xl border border-neutral-800 bg-black p-3 sm:p-4 text-neutral-200 shadow-sm">
          {/* Top Readout Strip */}
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2 border-b border-neutral-900 px-1 pb-2 text-xs">
            <div className="flex flex-wrap items-center gap-2.5">
              <span className="font-semibold text-[#1e90ff]">
                US100Cash# · {activeTimeframe} · CISD
              </span>
              {feedMode === 'live' && (
                <span className="inline-flex items-center gap-1.5 text-neutral-300">
                  <span
                    className={`h-2 w-2 rounded-full ${
                      marketState === 'MARKET CLOSED'
                        ? 'bg-neutral-500'
                        : 'bg-emerald-400 animate-pulse'
                    }`}
                  />
                  {marketState === 'MARKET CLOSED'
                    ? 'ตลาดปิด (ล่าสุด)'
                    : feedProvider === 'xm_bridge'
                    ? `XM MT5 Live Bridge · สด 2 วิ${lastTickTime ? ` · ${lastTickTime}` : ''}`
                    : feedProvider === 'cfd_ws'
                    ? `MT5 Forex CFD (NAS100 Cash${brokerSymbolLabel ? ` · ${brokerSymbolLabel}` : ''}) · สด 2 วิ${
                        lastTickTime ? ` · ${lastTickTime}` : ''
                      }`
                    : `MT5 เรียลไทม์ (2s)${lastTickTime ? ` · ${lastTickTime}` : ''}`}
                </span>
              )}
              {feedMode === 'sim' && (
                <span className="inline-flex items-center gap-1.5 text-neutral-300">
                  <span
                    className={`h-2 w-2 rounded-full ${
                      isPlaying ? 'bg-amber-400 animate-pulse' : 'bg-neutral-500'
                    }`}
                  />
                  {isPlaying
                    ? `จำลองกำลังวิ่ง (${Math.max(1, simTickStep)}/4 รอปิดแท่ง)`
                    : 'โหมดจำลอง'}
                </span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-3 font-mono text-[11px] tabular-nums">
              <span className="text-neutral-400">{activeBar.timeLabel}</span>
              <span className="hidden sm:inline text-neutral-400">
                O {activeBar.open.toFixed(spec.digits)} · H {activeBar.high.toFixed(spec.digits)} · L {activeBar.low.toFixed(spec.digits)}
              </span>
              <span
                className={`font-medium transition-colors ${
                  tickFlash === 'up'
                    ? 'text-sky-400'
                    : tickFlash === 'down'
                    ? 'text-rose-400'
                    : 'text-neutral-100'
                }`}
              >
                C {activeBar.close.toFixed(spec.digits)}
              </span>
              {intrabarTestingDir && hoveredIdx === null && (
                <span className="font-semibold text-amber-300">
                  ทะลุ CISD รอปิดแท่ง...
                </span>
              )}
              {activeBar.closedBelowCisd && (
                <span className="font-semibold text-yellow-400">
                  ปิดต่ำกว่า CISD
                </span>
              )}
              {activeBar.closedAboveCisd && (
                <span className="font-semibold text-emerald-400">
                  ปิดเหนือ CISD
                </span>
              )}
            </div>
          </div>

          {/* Interactive MT5 Candlestick SVG */}
          <div className="relative w-full overflow-x-auto">
            <svg
              viewBox={`0 0 ${svgW} ${totalH}`}
              className="h-auto w-full min-w-[600px] select-none"
              role="img"
              aria-label={`กราฟราคา US100 Timeframe ${activeTimeframe} พร้อมเส้นระดับ CISD และสัญลักษณ์เมื่อปิดทะลุ CISD`}
            >
              <rect x={0} y={0} width={svgW} height={totalH} fill="#000000" />

              {!isWebMode && (
                <>
                  <line
                    x1={plotRight}
                    y1={0}
                    x2={plotRight}
                    y2={xAxisY}
                    stroke="#3a3a3a"
                    strokeWidth="1"
                  />

                  {priceTickRatios.map((ratio, idx) => {
                    const y = 18 + ratio * (priceH - 34);
                    const priceVal =
                      chartMetrics.priceTop -
                      ratio * (chartMetrics.priceTop - chartMetrics.priceBottom);
                    return (
                      <g key={`m15-p-tick-${idx}`}>
                        <line
                          x1={plotRight}
                          y1={y}
                          x2={plotRight + 4}
                          y2={y}
                          stroke="#525252"
                          strokeWidth="1"
                        />
                        <text
                          x={plotRight + 7}
                          y={y + 4}
                          fontSize="12"
                          fill="#9ca3af"
                          className="font-mono tabular-nums"
                        >
                          {priceVal.toFixed(spec.digits)}
                        </text>
                      </g>
                    );
                  })}
                </>
              )}

              {/* Bottom X-axis line */}
              <line
                x1={plotLeft}
                y1={xAxisY}
                x2={plotRight}
                y2={xAxisY}
                stroke="#4b5563"
                strokeWidth="1"
              />

              {/* Bold Triggered CISD Horizontal Lines (matching user screenshots) */}
              {visibleSegments.map((seg, segIdx) => {
                const yLvl = priceToY(seg.level);
                const xOriginCenter = plotLeft + 6 + seg.visStart * slotW + slotW / 2;
                const xTriggerCenter = plotLeft + 6 + seg.visTrigger * slotW + slotW / 2;
                const x1 = xOriginCenter - candleW * 0.4;
                const x2 = xTriggerCenter + candleW * 0.4;
                const lineColor =
                  seg.triggeredDirection === 'SELL' ? '#facc15' : '#22e53b';
                const isLatest = segIdx === visibleSegments.length - 1;

                return (
                  <line
                    key={seg.id}
                    x1={x1}
                    y1={yLvl}
                    x2={x2}
                    y2={yLvl}
                    stroke={lineColor}
                    strokeWidth="3.2"
                    strokeLinecap="round"
                    opacity={isLatest ? 0.98 : 0.72}
                  />
                );
              })}

              {/* Active Watching (Untriggered) CISD Lines so trader sees exact live break level */}
              {activeWatchSegments.map((watch) => {
                const yLvl = priceToY(watch.level);
                const xOriginCenter = plotLeft + 6 + watch.visStart * slotW + slotW / 2;
                const xEndCenter = plotLeft + 6 + watch.visEnd * slotW + slotW / 2;
                const x1 = xOriginCenter - candleW * 0.4;
                const x2 = Math.min(plotRight - 4, xEndCenter + slotW * 3.5);
                const lineColor = watch.direction === 'SELL' ? '#facc15' : '#22e53b';
                const labelText = `${watch.direction === 'SELL' ? 'CISD ลง' : 'CISD ขึ้น'} ${watch.level.toFixed(
                  spec.digits
                )}`;

                return (
                  <g key={watch.id}>
                    <line
                      x1={x1}
                      y1={yLvl}
                      x2={x2}
                      y2={yLvl}
                      stroke={lineColor}
                      strokeWidth={watch.isTesting ? '2.4' : '1.6'}
                      strokeDasharray="5 4"
                      opacity={watch.isTesting ? 1 : 0.85}
                    />
                    <text
                      x={x2 + 4}
                      y={yLvl + 3.5}
                      fontSize="10.5"
                      fontWeight="600"
                      fill={lineColor}
                      className="font-mono tabular-nums"
                    >
                      {labelText}
                    </text>
                  </g>
                );
              })}

              {/* Candlesticks */}
              {visibleBars.map((bar, idx) => {
                const xCenter = plotLeft + 6 + idx * slotW + slotW / 2;
                const isBull = bar.close >= bar.open;
                const bodyColor = isBull ? '#1e88e5' : '#e5e7eb';
                const wickColor = isBull ? '#38bdf8' : '#e5e7eb';
                const yHigh = priceToY(bar.high);
                const yLow = priceToY(bar.low);
                const yOpen = priceToY(bar.open);
                const yClose = priceToY(bar.close);
                const bodyTop = Math.min(yOpen, yClose);
                const bodyH = Math.max(1.5, Math.abs(yClose - yOpen));

                const isHovered = hoveredIdx === idx;
                const showXTick = idx === 2 || idx === 22 || idx === 42 || idx === 62;

                return (
                  <g
                    key={`${bar.timestampIso}-${idx}`}
                    onMouseEnter={() => setHoveredIdx(idx)}
                    onMouseLeave={() => setHoveredIdx(null)}
                    className="cursor-crosshair"
                  >
                    <rect
                      x={xCenter - slotW / 2}
                      y={0}
                      width={slotW}
                      height={xAxisY}
                      fill="transparent"
                    />

                    {isHovered && (
                      <g>
                        <line
                          x1={xCenter}
                          y1={0}
                          x2={xCenter}
                          y2={xAxisY}
                          stroke="#525252"
                          strokeWidth="1"
                          strokeDasharray="3 3"
                        />
                        <line
                          x1={plotLeft}
                          y1={yClose}
                          x2={plotRight}
                          y2={yClose}
                          stroke="#525252"
                          strokeWidth="1"
                          strokeDasharray="3 3"
                        />
                      </g>
                    )}

                    {/* Wick */}
                    <line
                      x1={xCenter}
                      y1={yHigh}
                      x2={xCenter}
                      y2={yLow}
                      stroke={wickColor}
                      strokeWidth="1"
                    />

                    {/* Body */}
                    <rect
                      x={xCenter - candleW / 2}
                      y={bodyTop}
                      width={candleW}
                      height={bodyH}
                      fill={bodyColor}
                    />

                    {/* X-axis tick + MT5 timestamp */}
                    {showXTick && (
                      <g>
                        <line
                          x1={xCenter}
                          y1={xAxisY}
                          x2={xCenter}
                          y2={xAxisY + 4}
                          stroke="#525252"
                          strokeWidth="1"
                        />
                        <text
                          x={xCenter}
                          y={xAxisY + 18}
                          textAnchor="middle"
                          fontSize="11.5"
                          fill="#9ca3af"
                          className="font-sans tabular-nums"
                        >
                          {formatMt5AxisDate(bar.timestampIso, activeTimeframe)}
                        </text>
                      </g>
                    )}
                  </g>
                );
              })}

              {/* Top-left MT5 Watermark */}
              <text
                x={plotLeft + 8}
                y={22}
                fontSize="14"
                fontWeight="700"
                fill="#1e88e5"
                className="font-sans"
              >
                US100Cash#
                <tspan fill="#9ca3af" fontWeight="400" fontSize="13">
                  {' '}
                  ▾ {activeTimeframe} (CISD)
                </tspan>
              </text>
              <text
                x={plotLeft + 8}
                y={39}
                fontSize="12.5"
                fill="#9ca3af"
                className="font-sans"
              >
                US 100 Index Cash
              </text>

              {/* Current Bid/Close Price Line + Right MT5 Badge (flashes on live tick like MT5) */}
              <line
                x1={plotLeft}
                y1={latestCloseY - 1.5}
                x2={svgW}
                y2={latestCloseY - 1.5}
                stroke={tickFlash === 'up' ? '#2563eb' : '#b91c1c'}
                strokeWidth="0.95"
                opacity={0.9}
              />
              <line
                x1={plotLeft}
                y1={latestCloseY}
                x2={plotRight}
                y2={latestCloseY}
                stroke={
                  tickFlash === 'up'
                    ? '#38bdf8'
                    : tickFlash === 'down'
                    ? '#f87171'
                    : '#6b7280'
                }
                strokeWidth="0.95"
                opacity={0.85}
              />

              {!isWebMode && (
                <g
                  transform={`translate(${plotRight + 2}, ${Math.min(
                    Math.max(latestCloseY - 12, 6),
                    priceH - 38
                  )})`}
                >
                  <rect
                    x={0}
                    y={0}
                    width={padR - 4}
                    height={33}
                    fill={
                      tickFlash === 'up'
                        ? '#1d4ed8'
                        : tickFlash === 'down'
                        ? '#b91c1c'
                        : '#404040'
                    }
                    stroke={
                      tickFlash === 'up'
                        ? '#60a5fa'
                        : tickFlash === 'down'
                        ? '#f87171'
                        : '#525252'
                    }
                    strokeWidth="0.75"
                  />
                  <text
                    x={6}
                    y={14}
                    fontSize="12.5"
                    fontWeight="600"
                    fill="#ffffff"
                    className="font-mono tabular-nums"
                  >
                    {latestClosedBar.close.toFixed(spec.digits)}
                  </text>
                  <text
                    x={6}
                    y={28}
                    fontSize="11.5"
                    fill="#e5e7eb"
                    className="font-mono tabular-nums"
                  >
                    {feedMode === 'live'
                      ? barCountdown
                      : isPlaying
                      ? `00:${String(Math.max(1, 4 - simTickStep) * 3).padStart(2, '0')}`
                      : 'SIM'}
                  </text>
                </g>
              )}
            </svg>
          </div>
      </div>

      {/* Server Auto-Monitor US100 M15 + One-Tap Mobile Push Card (matching user screenshot) */}
      <div className="rounded-2xl border border-slate-200/90 bg-white p-4 sm:p-5 space-y-3.5">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <span
              className={`h-2.5 w-2.5 shrink-0 rounded-full ${
                serverM15Enabled ? 'bg-emerald-500 animate-pulse' : 'bg-emerald-500/50'
              }`}
            />
            <span className="text-sm font-semibold text-slate-900 truncate">
              เซิร์ฟเวอร์เฝ้ากราฟ US100 M15 อัตโนมัติ
            </span>
          </div>

          <button
            type="button"
            disabled={togglingServerMonitor}
            onClick={() => void handleToggleServerMonitor()}
            title="แตะเพื่อสลับเปิด/พักชั่วคราว การเฝ้ากราฟ M15 บนเซิร์ฟเวอร์"
            className={`shrink-0 text-xs font-medium transition-colors disabled:opacity-50 ${
              serverM15Enabled
                ? 'text-emerald-700 hover:text-emerald-800'
                : 'text-slate-500 hover:text-slate-800'
            }`}
          >
            {togglingServerMonitor
              ? 'กำลังสลับ...'
              : serverM15Enabled
              ? 'กำลังทำงาน'
              : 'พักชั่วคราว'}
          </button>
        </div>

        <button
          type="button"
          disabled={mobileNotifyBusy}
          onClick={() => void handleEnableMobileNotify()}
          className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-60"
        >
          <Bell className="h-4 w-4 shrink-0" />
          {mobileNotifyBusy
            ? 'กำลังเชื่อมต่อแจ้งเตือนเข้ามือถือ...'
            : mobileNotifyReady
            ? 'รับแจ้งเตือนเข้ามือถือ (เปิดอยู่ · กดทดสอบ)'
            : 'รับแจ้งเตือนเข้ามือถือ (ไม่ต้องลงแอป)'}
        </button>

        {mobileNotifySuccess && (
          <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
            <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
            <span>{mobileNotifySuccess}</span>
          </div>
        )}

        {mobileNotifyHint && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            <span>{mobileNotifyHint}</span>
            {typeof window !== 'undefined' && window.self !== window.top && (
              <a
                href={window.location.href}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex h-7 items-center rounded-md bg-amber-600 px-2.5 text-[11px] font-semibold text-white hover:bg-amber-700"
              >
                เปิดเต็มจอในแท็บใหม่
              </a>
            )}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-500">
          <span>
            {serverSubscribersCount > 0
              ? `อุปกรณ์รับ Push เชื่อมต่ออยู่ ${serverSubscribersCount} เครื่อง`
              : 'แจ้งเตือนผ่านเบราว์เซอร์, มือถือ (PWA) และ Telegram (8217822307)'}
          </span>
          {serverLastCheckedAt && (
            <span className="font-mono tabular-nums">
              สแกนล่าสุด{' '}
              {new Date(serverLastCheckedAt).toLocaleTimeString('th-TH', {
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                hour12: false,
                timeZone: 'Asia/Bangkok',
              })}
            </span>
          )}
        </div>
      </div>

      {/* 4-Column Summary Strip (shown in Studio mode only) */}
      {!isWebMode && (
        <div className="grid grid-cols-2 gap-4 rounded-xl border border-slate-200/90 bg-white p-5 sm:p-6 lg:grid-cols-4 lg:gap-0 lg:divide-x lg:divide-slate-100">
          <div className="lg:pr-6">
            <p className="text-xs font-medium text-slate-500">สินทรัพย์ · ไทม์เฟรม</p>
            <p className="mt-1.5 text-lg font-semibold text-slate-900 tabular-nums">
              {symbol} · {activeTimeframe}
            </p>
          </div>
          <div className="lg:px-6">
            <p className="text-xs font-medium text-slate-500">ระดับ CISD เตือนขาลง (SELL)</p>
            <p className="mt-1.5 font-mono text-lg font-semibold text-amber-600 tabular-nums">
              {seriesState.latestBearCisdLevel !== null
                ? seriesState.latestBearCisdLevel.toFixed(spec.digits)
                : 'รอโครงสร้างใหม่'}
            </p>
          </div>
          <div className="lg:px-6">
            <p className="text-xs font-medium text-slate-500">ระดับ CISD เตือนขาขึ้น (BUY)</p>
            <p className="mt-1.5 font-mono text-lg font-semibold text-emerald-700 tabular-nums">
              {seriesState.latestBullCisdLevel !== null
                ? seriesState.latestBullCisdLevel.toFixed(spec.digits)
                : 'รอโครงสร้างใหม่'}
            </p>
          </div>
          <div className="lg:pl-6">
            <p className="text-xs font-medium text-slate-500">จุดเปลี่ยนเทรนด์บนกราฟ</p>
            <p className="mt-1.5 text-lg font-semibold text-slate-900 tabular-nums">
              {detectedInVisible} ครั้ง
            </p>
          </div>
        </div>
      )}

      {/* XM MT5 Live Bridge Card (Direct EA stream or Automatic Real-Time Forex CFD WebSocket) */}
      <div className="rounded-xl border border-slate-200/90 bg-white p-5 sm:p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="space-y-1.5 max-w-2xl">
            <div className="flex flex-wrap items-center gap-2.5">
              <h3 className="text-sm font-semibold text-slate-900">
                XM MT5 Live Bridge (XM_MT5_LiveBridge_EA.mq5)
              </h3>
              <span
                className={`inline-flex items-center gap-1.5 text-xs font-semibold ${
                  xmBridgeStatus?.connected ? 'text-emerald-700' : 'text-sky-700'
                }`}
              >
                <span
                  className={`h-2 w-2 rounded-full ${
                    xmBridgeStatus?.connected
                      ? 'bg-emerald-500 animate-pulse'
                      : xmBridgeStatus?.cfdStream?.connected
                      ? 'bg-sky-500 animate-pulse'
                      : 'bg-amber-500'
                  }`}
                />
                {xmBridgeStatus?.connected
                  ? `เชื่อมต่อ XM MT5 แล้ว (${xmBridgeStatus.symbol} · Bid ${xmBridgeStatus.bid.toFixed(
                      spec.digits
                    )})`
                  : xmBridgeStatus?.cfdStream?.connected
                  ? `ใช้ฟีด Forex MT5 CFD สดอัตโนมัติทุก 2 วิ (${xmBridgeStatus.cfdStream.brokerSymbol})`
                  : 'กำลังเชื่อมต่อฟีดตลาด Forex MT5 CFD...'}
              </span>
            </div>
            <p className="text-xs leading-relaxed text-slate-600">
              เนื่องจากเซิร์ฟเวอร์ภายนอกไม่สามารถล็อกอินเข้าบัญชี MT5 ของโบรกเกอร์ XM โดยตรงได้หากไม่มีเทอร์มินัล MT5 รันอยู่ — หากต้องการราคาและสเปรดตรงกับ{' '}
              <span className="font-mono font-semibold text-slate-800">US100Cash#</span> บน XM MT5 ของคุณ 100% สามารถดาวน์โหลด{' '}
              <span className="font-mono font-medium text-slate-800">XM_MT5_LiveBridge_EA.mq5</span>{' '}
              ไปติดบนกราฟ MT5 เพื่อส่งแท่ง M15 และราคา Bid เข้าเว็บทุก 2 วินาที (หากไม่ได้ติด ระบบจะใช้ฟีด Forex MT5 CFD แบบ Real-Time ให้อัตโนมัติ)
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <a
              href="/api/mt5/bridge-ea"
              download="XM_MT5_LiveBridge_EA.mq5"
              className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-slate-900 px-4 text-xs font-semibold text-white whitespace-nowrap transition-colors hover:bg-slate-800"
            >
              <Download className="h-4 w-4" />
              ดาวน์โหลด XM_MT5_LiveBridge_EA.mq5
            </a>

            <button
              type="button"
              onClick={() => {
                const ingestUrl = `${window.location.origin}/api/mt5/ingest`;
                void navigator.clipboard?.writeText(ingestUrl).catch(() => {});
                setCopiedBridgeUrl(true);
                window.setTimeout(() => setCopiedBridgeUrl(false), 1800);
              }}
              className="inline-flex h-10 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3.5 text-xs font-medium text-slate-700 whitespace-nowrap transition-colors hover:bg-slate-50"
            >
              {copiedBridgeUrl ? (
                <>
                  <Check className="h-3.5 w-3.5 text-emerald-600" />
                  คัดลอก URL แล้ว
                </>
              ) : (
                <>
                  <Copy className="h-3.5 w-3.5" />
                  คัดลอก WebRequest URL
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
};
