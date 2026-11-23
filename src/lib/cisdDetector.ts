export type CisdSignalType = 'BUY' | 'SELL';

export interface RawOhlcBar {
  index: number;
  timeLabel: string;
  timestampIso: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface CisdLevelSegment {
  id: string;
  /** 'bearish_break' = CISD line from up-delivery open (triggers SELL when closed below); 'bullish_break' = CISD line from down-delivery open (triggers BUY when closed above) */
  kind: 'bearish_break' | 'bullish_break';
  level: number;
  originIndex: number;
  originTimeLabel: string;
  endIndex: number;
  triggeredIndex: number | null;
  triggeredDirection: CisdSignalType | null;
}

export interface M15CisdBar extends RawOhlcBar {
  cisdSignal: CisdSignalType | null;
  cisdLevel: number | null;
  closedBelowCisd: boolean;
  closedAboveCisd: boolean;
  activeBearCisdLevel: number | null;
  activeBullCisdLevel: number | null;
}

export type CisdTimeframe = 'M5' | 'M15';

export const CISD_TIMEFRAME_ORDER: CisdTimeframe[] = ['M15'];
export const ALL_CISD_CHART_TIMEFRAMES: CisdTimeframe[] = ['M15', 'M5'];

export interface LastCisdSignalInfo {
  signal: CisdSignalType;
  level: number;
  price: number;
  timeLabel: string;
  timestampIso: string;
}

export interface CisdDetectionResult {
  bars: M15CisdBar[];
  segments: CisdLevelSegment[];
  latestBearCisdLevel: number | null;
  latestBullCisdLevel: number | null;
  currentTrend: CisdSignalType | null;
  lastSignalInfo: LastCisdSignalInfo | null;
}

interface PendingLeg {
  originIndex: number;
  originTimeLabel: string;
  open: number;
  extremeHigh: number;
  extremeLow: number;
  candles: number;
  bodySum: number;
}

interface ActiveCisdTarget {
  id: string;
  level: number;
  originIndex: number;
  originTimeLabel: string;
  triggered: boolean;
  triggeredIndex: number | null;
  segmentIndex: number;
}

export interface DetectCisdOptions {
  /** Set true on live feeds where the final candle is still open/forming */
  excludeLastBar?: boolean;
}

export function detectCisdOnBars(
  rawBars: RawOhlcBar[],
  options?: DetectCisdOptions
): CisdDetectionResult {
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

  const excludeLastBar = Boolean(options?.excludeLastBar);
  const bodies = rawBars.map((b) => Math.abs(b.close - b.open));
  const bars: M15CisdBar[] = [];
  const segments: CisdLevelSegment[] = [];

  let bullLeg: PendingLeg | null = null;
  let bearLeg: PendingLeg | null = null;

  let activeBearCisd: ActiveCisdTarget | null = null;
  let activeBullCisd: ActiveCisdTarget | null = null;
  let currentTrend: CisdSignalType | null = null;
  let lastSignalInfo: LastCisdSignalInfo | null = null;

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
    const isOpenFormingBar = excludeLastBar && i === n - 1;

    if (isOpenFormingBar) {
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

    // Finalize pending bullish leg when a bearish candle closes -> sets Bearish CISD watch level
    if (isBear && bullLeg) {
      const isValidLeg =
        bullLeg.candles >= 2 ||
        bullLeg.extremeHigh >= recentHighBefore(bullLeg.originIndex) ||
        bullLeg.bodySum >= avgBody * 0.45;

      if (isValidLeg) {
        const segId = `bear-cisd-${bullLeg.originIndex}-${bar.index}`;
        const segIdx = segments.length;
        segments.push({
          id: segId,
          kind: 'bearish_break',
          level: bullLeg.open,
          originIndex: bullLeg.originIndex,
          originTimeLabel: bullLeg.originTimeLabel,
          endIndex: i,
          triggeredIndex: null,
          triggeredDirection: null,
        });
        activeBearCisd = {
          id: segId,
          level: bullLeg.open,
          originIndex: bullLeg.originIndex,
          originTimeLabel: bullLeg.originTimeLabel,
          triggered: false,
          triggeredIndex: null,
          segmentIndex: segIdx,
        };
      }
      bullLeg = null;
    }

    // Finalize pending bearish leg when a bullish candle closes -> sets Bullish CISD watch level
    if (isBull && bearLeg) {
      const isValidLeg =
        bearLeg.candles >= 2 ||
        bearLeg.extremeLow <= recentLowBefore(bearLeg.originIndex) ||
        bearLeg.bodySum >= avgBody * 0.45;

      if (isValidLeg) {
        const segId = `bull-cisd-${bearLeg.originIndex}-${bar.index}`;
        const segIdx = segments.length;
        segments.push({
          id: segId,
          kind: 'bullish_break',
          level: bearLeg.open,
          originIndex: bearLeg.originIndex,
          originTimeLabel: bearLeg.originTimeLabel,
          endIndex: i,
          triggeredIndex: null,
          triggeredDirection: null,
        });
        activeBullCisd = {
          id: segId,
          level: bearLeg.open,
          originIndex: bearLeg.originIndex,
          originTimeLabel: bearLeg.originTimeLabel,
          triggered: false,
          triggeredIndex: null,
          segmentIndex: segIdx,
        };
      }
      bearLeg = null;
    }

    // Accumulate consecutive delivery blocks
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

    let cisdSignal: CisdSignalType | null = null;
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
          activeBearCisd.triggeredIndex = i;
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
          activeBullCisd.triggeredIndex = i;
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

    if (cisdSignal && cisdLevel !== null) {
      lastSignalInfo = {
        signal: cisdSignal,
        level: cisdLevel,
        price: bar.close,
        timeLabel: bar.timeLabel,
        timestampIso: bar.timestampIso,
      };
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
