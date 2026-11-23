import { SYMBOL_SPECS, type TradingSymbol } from './aoSimulator';
import {
  type CisdDetectionResult,
  type CisdTimeframe,
  type M15CisdBar,
  type RawOhlcBar,
  detectCisdOnBars,
} from './cisdDetector';

export interface CisdTimeframeConfig {
  id: CisdTimeframe;
  label: string;
  thName: string;
  minutes: number;
  stepMult: number;
}

export const CISD_TIMEFRAMES: CisdTimeframeConfig[] = [
  { id: 'M5', label: 'M5', thName: '5 นาที', minutes: 5, stepMult: 0.95 },
  { id: 'M15', label: 'M15', thName: '15 นาที', minutes: 15, stepMult: 1.45 },
];

export const CISD_TIMEFRAME_MAP: Record<CisdTimeframe, CisdTimeframeConfig> =
  CISD_TIMEFRAMES.reduce(
    (acc, item) => {
      acc[item.id] = item;
      return acc;
    },
    {} as Record<CisdTimeframe, CisdTimeframeConfig>
  );

function roundToDigits(value: number, digits: number): number {
  const factor = Math.pow(10, digits);
  return Math.round(value * factor) / factor;
}

function formatBarTime(date: Date, _timeframe: CisdTimeframe): string {
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

// 34-bar symmetric 2-swing CISD cycle (net sum = 0.00):
// Phase A (5 bull): Swing 1 Up (+4.40)
// Phase B (3 bear): Pullback 1 (-1.90, holds above Swing 1 open)
// Phase C (5 bull): Swing 2 Up (+4.40 -> Higher High +6.90, sets Bearish CISD at +2.50)
// Phase D (4 bear): Reversal & CISD SELL (-5.60 -> closes at +1.30 < +2.50 on bar 4)
// Phase E (5 bear): Swing 1 Down (-4.40 -> -3.10)
// Phase F (3 bull): Bounce 1 (+1.90 -> -1.20, holds below Swing 1 high)
// Phase G (5 bear): Swing 2 Down (-4.40 -> Lower Low -5.60, sets Bullish CISD at -1.20)
// Phase H (4 bull): Reversal & CISD BUY (+5.60 -> closes at 0.00 > -1.20 on bar 4)
const TWO_SWING_CISD_PATTERN = [
  0.90, 1.05, 0.95, 0.85, 0.65,
  -0.65, -0.70, -0.55,
  0.85, 1.05, 1.00, 0.85, 0.65,
  -1.15, -1.35, -1.45, -1.65,
  -0.95, -1.05, -0.90, -0.85, -0.65,
  0.65, 0.70, 0.55,
  -0.85, -1.05, -1.00, -0.85, -0.65,
  1.15, 1.35, 1.45, 1.65,
];

function getTimeframePhaseShift(timeframe: CisdTimeframe): number {
  return timeframe === 'M5' ? 11 : 7;
}

export function generateInitialCisdSeries(
  symbol: TradingSymbol = 'US100',
  timeframe: CisdTimeframe = 'M15',
  count = 96
): CisdDetectionResult {
  const spec = SYMBOL_SPECS[symbol];
  const tfMeta = CISD_TIMEFRAME_MAP[timeframe] || CISD_TIMEFRAME_MAP.M15;
  const barStep = spec.stepSize * tfMeta.stepMult;
  const intervalMs = tfMeta.minutes * 60 * 1000;
  const rawBars: RawOhlcBar[] = [];

  const nowMs = Math.floor(Date.now() / intervalMs) * intervalMs;
  let price = spec.basePrice - barStep * 2.2;

  for (let i = 0; i < count; i++) {
    const barTime = new Date(nowMs - (count - 1 - i) * intervalMs);
    const delta = planNextCisdCloseDelta(barTime.toISOString(), symbol, timeframe);
    const open = roundToDigits(price, spec.digits);
    const close = roundToDigits(open + delta, spec.digits);
    const wickUp =
      Math.abs(Math.sin(i * 2.1 + getTimeframePhaseShift(timeframe))) * barStep * 0.36 +
      barStep * 0.1;
    const wickDown =
      Math.abs(Math.cos(i * 1.7 + getTimeframePhaseShift(timeframe))) * barStep * 0.36 +
      barStep * 0.1;
    const high = roundToDigits(Math.max(open, close) + wickUp, spec.digits);
    const low = roundToDigits(Math.min(open, close) - wickDown, spec.digits);

    rawBars.push({
      index: i,
      timeLabel: formatBarTime(barTime, timeframe),
      timestampIso: barTime.toISOString(),
      open,
      high,
      low,
      close,
    });

    price = close;
  }

  return detectCisdOnBars(rawBars, { excludeLastBar: true });
}

export function generateInitialM15Series(
  symbol: TradingSymbol = 'US100',
  count = 96
): CisdDetectionResult {
  return generateInitialCisdSeries(symbol, 'M15', count);
}

export function planNextCisdCloseDelta(
  barTimestampOrIndex: string | number,
  symbol: TradingSymbol = 'US100',
  timeframe: CisdTimeframe = 'M15'
): number {
  const spec = SYMBOL_SPECS[symbol];
  const tfMeta = CISD_TIMEFRAME_MAP[timeframe] || CISD_TIMEFRAME_MAP.M15;
  const barStep = spec.stepSize * tfMeta.stepMult;
  const intervalMs = tfMeta.minutes * 60 * 1000;
  const waveIdx =
    typeof barTimestampOrIndex === 'string'
      ? Math.round(new Date(barTimestampOrIndex).getTime() / intervalMs)
      : barTimestampOrIndex;
  const len = TWO_SWING_CISD_PATTERN.length;
  const shifted = waveIdx + getTimeframePhaseShift(timeframe);
  const phase = ((shifted % len) + len) % len;
  return TWO_SWING_CISD_PATTERN[phase] * barStep;
}

export function planNextM15CloseDelta(
  barTimestampOrIndex: string | number,
  symbol: TradingSymbol = 'US100'
): number {
  return planNextCisdCloseDelta(barTimestampOrIndex, symbol, 'M15');
}

export function tickFormingCisdBar(
  existingBars: M15CisdBar[],
  nextPrice: number,
  symbol: TradingSymbol = 'US100',
  timeframe: CisdTimeframe = 'M15'
): CisdDetectionResult {
  const spec = SYMBOL_SPECS[symbol];
  if (existingBars.length === 0) {
    return generateInitialCisdSeries(symbol, timeframe);
  }

  const rawBars: RawOhlcBar[] = existingBars.map((b, idx) => {
    if (idx !== existingBars.length - 1) {
      return {
        index: idx,
        timeLabel: b.timeLabel,
        timestampIso: b.timestampIso,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
      };
    }
    const clampedClose = roundToDigits(nextPrice, spec.digits);
    return {
      index: idx,
      timeLabel: b.timeLabel,
      timestampIso: b.timestampIso,
      open: b.open,
      high: roundToDigits(Math.max(b.high, clampedClose), spec.digits),
      low: roundToDigits(Math.min(b.low, clampedClose), spec.digits),
      close: clampedClose,
    };
  });

  return detectCisdOnBars(rawBars, { excludeLastBar: true });
}

export const tickFormingM15Bar = tickFormingCisdBar;

export function finalizeCisdBarAndOpenNext(
  existingBars: M15CisdBar[],
  finalClose: number,
  symbol: TradingSymbol = 'US100',
  timeframe: CisdTimeframe = 'M15'
): CisdDetectionResult {
  const spec = SYMBOL_SPECS[symbol];
  const tfMeta = CISD_TIMEFRAME_MAP[timeframe] || CISD_TIMEFRAME_MAP.M15;
  const intervalMs = tfMeta.minutes * 60 * 1000;
  if (existingBars.length === 0) {
    return generateInitialCisdSeries(symbol, timeframe);
  }

  const rawBars: RawOhlcBar[] = existingBars.map((b, idx) => {
    if (idx !== existingBars.length - 1) {
      return {
        index: idx,
        timeLabel: b.timeLabel,
        timestampIso: b.timestampIso,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
      };
    }
    const closedVal = roundToDigits(finalClose, spec.digits);
    return {
      index: idx,
      timeLabel: b.timeLabel,
      timestampIso: b.timestampIso,
      open: b.open,
      high: roundToDigits(Math.max(b.high, b.open, closedVal), spec.digits),
      low: roundToDigits(Math.min(b.low, b.open, closedVal), spec.digits),
      close: closedVal,
    };
  });

  const lastClosed = rawBars[rawBars.length - 1];
  const nextDate = new Date(new Date(lastClosed.timestampIso).getTime() + intervalMs);
  rawBars.push({
    index: rawBars.length,
    timeLabel: formatBarTime(nextDate, timeframe),
    timestampIso: nextDate.toISOString(),
    open: lastClosed.close,
    high: lastClosed.close,
    low: lastClosed.close,
    close: lastClosed.close,
  });

  const trimmed = rawBars.slice(-110).map((b, idx) => ({ ...b, index: idx }));
  return detectCisdOnBars(trimmed, { excludeLastBar: true });
}

export function finalizeM15BarAndOpenNext(
  existingBars: M15CisdBar[],
  finalClose: number,
  symbol: TradingSymbol = 'US100'
): CisdDetectionResult {
  return finalizeCisdBarAndOpenNext(existingBars, finalClose, symbol, 'M15');
}

export function appendNextCisdBar(
  existingBars: M15CisdBar[],
  symbol: TradingSymbol = 'US100',
  forceSignal?: 'BUY' | 'SELL',
  timeframe: CisdTimeframe = 'M15'
): CisdDetectionResult {
  const spec = SYMBOL_SPECS[symbol];
  const tfMeta = CISD_TIMEFRAME_MAP[timeframe] || CISD_TIMEFRAME_MAP.M15;
  const barStep = spec.stepSize * tfMeta.stepMult;
  const intervalMs = tfMeta.minutes * 60 * 1000;

  const closedPrefix = existingBars.slice(0, -1);
  const rawBars: RawOhlcBar[] = (closedPrefix.length >= 20 ? closedPrefix : existingBars).map((b) => ({
    index: b.index,
    timeLabel: b.timeLabel,
    timestampIso: b.timestampIso,
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
  }));

  const pushClosedBar = (open: number, close: number, wickExtra = 0) => {
    const last = rawBars[rawBars.length - 1];
    const nextDate = new Date(new Date(last.timestampIso).getTime() + intervalMs);
    const high = roundToDigits(Math.max(open, close) + barStep * 0.22 + wickExtra, spec.digits);
    const low = roundToDigits(Math.min(open, close) - barStep * 0.22 - wickExtra, spec.digits);
    rawBars.push({
      index: rawBars.length,
      timeLabel: formatBarTime(nextDate, timeframe),
      timestampIso: nextDate.toISOString(),
      open: roundToDigits(open, spec.digits),
      high,
      low,
      close: roundToDigits(close, spec.digits),
    });
  };

  const pushRelativeSteps = (deltas: number[]) => {
    let cursor = rawBars[rawBars.length - 1].close;
    for (const d of deltas) {
      const next = roundToDigits(cursor + d, spec.digits);
      pushClosedBar(cursor, next, barStep * 0.06);
      cursor = next;
    }
  };

  const latestState = () => {
    const res = detectCisdOnBars(rawBars, { excludeLastBar: false });
    const trend =
      [...res.bars].reverse().find((b) => b.cisdSignal !== null)?.cisdSignal ?? null;
    const last = res.bars[res.bars.length - 1];
    return {
      trend,
      bearLevel: last?.activeBearCisdLevel ?? null,
      bullLevel: last?.activeBullCisdLevel ?? null,
    };
  };

  if (forceSignal === 'SELL') {
    // Build a full 2-swing bullish rally (Swing 1 Up -> Pullback -> Swing 2 Up) before CISD SELL
    let state = latestState();
    const startPrice = rawBars[rawBars.length - 1].close;
    const minSwing1Rise =
      state.bullLevel !== null && state.bullLevel > startPrice
        ? Math.max(barStep * 4.2, state.bullLevel - startPrice + barStep * 1.4)
        : barStep * 4.2;

    // Swing 1 Up (4 bullish candles, ensuring any prior bear trend flips cleanly)
    const swing1Weights = [0.22, 0.28, 0.27, 0.23];
    pushRelativeSteps(swing1Weights.map((w) => minSwing1Rise * w));

    // Pullback 1 (3 bearish candles, ~42% retracement so it holds well above Swing 1 origin)
    const pullbackDrop = minSwing1Rise * 0.42;
    pushRelativeSteps([-pullbackDrop * 0.34, -pullbackDrop * 0.38, -pullbackDrop * 0.28]);

    // Swing 2 Up (4 bullish candles pushing to a new Higher High)
    const swing2Rise = Math.max(barStep * 4.0, pullbackDrop + barStep * 2.2);
    pushRelativeSteps([swing2Rise * 0.24, swing2Rise * 0.29, swing2Rise * 0.27, swing2Rise * 0.2]);

    state = latestState();
    if (state.trend !== 'BUY') {
      // Ensure trend is BUY prior to the breakdown if no bull CISD had formed yet
      const s = rawBars[rawBars.length - 1].close;
      const targetBull = state.bullLevel ?? s;
      pushClosedBar(s, Math.max(s + barStep * 0.5, targetBull + barStep * 0.55), barStep * 0.05);
      state = latestState();
    }

    // Reversal leg down: 2 initial turning candles + breach candle closing below Swing 2 CISD level
    pushRelativeSteps([-barStep * 1.15, -barStep * 1.3]);
    state = latestState();
    const prevClose = rawBars[rawBars.length - 1].close;
    const targetLevel = state.bearLevel ?? prevClose;
    const breachClose = roundToDigits(
      Math.min(prevClose - barStep * 0.5, targetLevel - barStep * 0.65),
      spec.digits
    );
    pushClosedBar(prevClose, breachClose, barStep * 0.14);
  } else if (forceSignal === 'BUY') {
    // Build a full 2-swing bearish decline (Swing 1 Down -> Bounce -> Swing 2 Down) before CISD BUY
    let state = latestState();
    const startPrice = rawBars[rawBars.length - 1].close;
    const minSwing1Drop =
      state.bearLevel !== null && state.bearLevel < startPrice
        ? Math.max(barStep * 4.2, startPrice - state.bearLevel + barStep * 1.4)
        : barStep * 4.2;

    // Swing 1 Down (4 bearish candles)
    const swing1Weights = [0.22, 0.28, 0.27, 0.23];
    pushRelativeSteps(swing1Weights.map((w) => -minSwing1Drop * w));

    // Bounce 1 (3 bullish candles, ~42% retracement holding below Swing 1 high)
    const bounceRise = minSwing1Drop * 0.42;
    pushRelativeSteps([bounceRise * 0.34, bounceRise * 0.38, bounceRise * 0.28]);

    // Swing 2 Down (4 bearish candles pushing to a new Lower Low)
    const swing2Drop = Math.max(barStep * 4.0, bounceRise + barStep * 2.2);
    pushRelativeSteps([-swing2Drop * 0.24, -swing2Drop * 0.29, -swing2Drop * 0.27, -swing2Drop * 0.2]);

    state = latestState();
    if (state.trend !== 'SELL') {
      const s = rawBars[rawBars.length - 1].close;
      const targetBear = state.bearLevel ?? s;
      pushClosedBar(s, Math.min(s - barStep * 0.5, targetBear - barStep * 0.55), barStep * 0.05);
      state = latestState();
    }

    // Reversal leg up: 2 initial turning candles + breach candle closing above Swing 2 CISD level
    pushRelativeSteps([barStep * 1.15, barStep * 1.3]);
    state = latestState();
    const prevClose = rawBars[rawBars.length - 1].close;
    const targetLevel = state.bullLevel ?? prevClose;
    const breachClose = roundToDigits(
      Math.max(prevClose + barStep * 0.5, targetLevel + barStep * 0.65),
      spec.digits
    );
    pushClosedBar(prevClose, breachClose, barStep * 0.14);
  } else {
    const last = rawBars[rawBars.length - 1];
    const delta = planNextCisdCloseDelta(last.timestampIso, symbol, timeframe);
    pushClosedBar(last.close, last.close + delta);
  }

  const latestClosed = rawBars[rawBars.length - 1];
  const openNextDate = new Date(new Date(latestClosed.timestampIso).getTime() + intervalMs);
  rawBars.push({
    index: rawBars.length,
    timeLabel: formatBarTime(openNextDate, timeframe),
    timestampIso: openNextDate.toISOString(),
    open: latestClosed.close,
    high: latestClosed.close,
    low: latestClosed.close,
    close: latestClosed.close,
  });

  const trimmed = rawBars.slice(-110).map((b, idx) => ({ ...b, index: idx }));
  return detectCisdOnBars(trimmed, { excludeLastBar: true });
}

export function appendNextM15Bar(
  existingBars: M15CisdBar[],
  symbol: TradingSymbol = 'US100',
  forceSignal?: 'BUY' | 'SELL'
): CisdDetectionResult {
  return appendNextCisdBar(existingBars, symbol, forceSignal, 'M15');
}
