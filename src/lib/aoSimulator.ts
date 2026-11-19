export type TradingSymbol = 'US100';
export type AoTimeframe = 'M5';

export const AO_TIMEFRAME_ORDER: AoTimeframe[] = ['M5'];

export const AO_TIMEFRAME_MINUTES: Record<AoTimeframe, number> = {
  M5: 5,
};

export interface SymbolSpec {
  symbol: TradingSymbol;
  basePrice: number;
  stepSize: number;
  digits: number;
  label: string;
}

export const SYMBOL_SPECS: Record<TradingSymbol, SymbolSpec> = {
  US100: {
    symbol: 'US100',
    basePrice: 27726.62,
    stepSize: 22.0,
    digits: 2,
    label: 'US 100 Index Cash',
  },
};

export interface M5Bar {
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

function roundToDigits(value: number, digits: number): number {
  const factor = Math.pow(10, digits);
  return Math.round(value * factor) / factor;
}

function formatM5Time(date: Date): string {
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/**
 * Exact Bill Williams Awesome Oscillator formula:
 * AO = SMA(Median Price, 5) - SMA(Median Price, 34)
 * where Median Price = (High + Low) / 2
 */
export function recalculateAwesomeOscillator(rawBars: Omit<M5Bar, 'ao' | 'aoRising' | 'signal'>[]): M5Bar[] {
  const result: M5Bar[] = [];

  for (let i = 0; i < rawBars.length; i++) {
    const bar = rawBars[i];
    let ao = 0;

    if (i >= 33) {
      let sum5 = 0;
      for (let k = i - 4; k <= i; k++) {
        sum5 += rawBars[k].median;
      }
      let sum34 = 0;
      for (let k = i - 33; k <= i; k++) {
        sum34 += rawBars[k].median;
      }
      ao = sum5 / 5 - sum34 / 34;
    }

    const prevBar = result[i - 1];
    const aoRising = i > 33 && prevBar ? ao >= prevBar.ao : true;

    let signal: 'BUY' | 'SELL' | null = null;
    if (i >= 34 && prevBar) {
      if (prevBar.ao <= 0 && ao > 0) {
        signal = 'BUY';
      } else if (prevBar.ao >= 0 && ao < 0) {
        signal = 'SELL';
      }
    }

    result.push({
      ...bar,
      ao,
      aoRising,
      signal,
    });
  }

  return result;
}

export function generateInitialSeries(
  symbol: TradingSymbol,
  count = 100,
  timeframe: AoTimeframe = 'M5'
): M5Bar[] {
  const spec = SYMBOL_SPECS[symbol];
  const tfMin = AO_TIMEFRAME_MINUTES[timeframe] || 5;
  const intervalMs = tfMin * 60 * 1000;
  const step = spec.stepSize;
  const rawBars: Omit<M5Bar, 'ao' | 'aoRising' | 'signal'>[] = [];

  const roundedMs = Math.floor(Date.now() / intervalMs) * intervalMs;
  let price = spec.basePrice;

  for (let i = 0; i < count; i++) {
    const barTime = new Date(roundedMs - (count - 1 - i) * intervalMs);
    // Sinusoidal + realistic momentum cycles so AO naturally crosses zero a couple times
    const wave =
      Math.sin(i * 0.24) * step * 0.85 +
      Math.cos(i * 0.11) * step * 0.45;
    const micro = ((Math.sin(i * 1.7 + symbol.length + tfMin) + 1) * 0.5 - 0.5) * step * 0.5;
    const open = roundToDigits(price, spec.digits);
    const close = roundToDigits(open + wave + micro, spec.digits);
    const wickUp = Math.abs(Math.sin(i * 2.1)) * step * 0.55 + step * 0.12;
    const wickDown = Math.abs(Math.cos(i * 1.9)) * step * 0.55 + step * 0.12;
    const high = roundToDigits(Math.max(open, close) + wickUp, spec.digits);
    const low = roundToDigits(Math.min(open, close) - wickDown, spec.digits);
    const median = (high + low) / 2;

    rawBars.push({
      index: i,
      timeLabel: formatM5Time(barTime),
      timestampIso: barTime.toISOString(),
      open,
      high,
      low,
      close,
      median,
    });

    price = close;
  }

  return recalculateAwesomeOscillator(rawBars);
}

export function planNextM5CloseDelta(
  barTimestampOrIndex: string | number,
  symbol: TradingSymbol = 'US100',
  timeframe: AoTimeframe = 'M5'
): number {
  const spec = SYMBOL_SPECS[symbol];
  const tfMin = AO_TIMEFRAME_MINUTES[timeframe] || 5;
  const step = spec.stepSize;
  const waveIdx =
    typeof barTimestampOrIndex === 'string'
      ? Math.round(new Date(barTimestampOrIndex).getTime() / (tfMin * 60 * 1000))
      : barTimestampOrIndex;
  return (
    Math.sin(waveIdx * 0.56) * step * 1.25 +
    Math.sin(waveIdx * 1.7) * step * 0.22
  );
}

/**
 * Updates the currently forming candle intrabar (allows immediate AO cross detection).
 */
export function tickFormingM5Bar(
  existingBars: M5Bar[],
  nextPrice: number,
  symbol: TradingSymbol = 'US100'
): M5Bar[] {
  const spec = SYMBOL_SPECS[symbol];
  if (existingBars.length === 0) return generateInitialSeries(symbol);

  const rawBars: Omit<M5Bar, 'ao' | 'aoRising' | 'signal'>[] = existingBars.map(
    ({ ao: _ao, aoRising: _r, signal: _s, ...rest }, idx) => {
      if (idx !== existingBars.length - 1) return rest;
      const clampedClose = roundToDigits(nextPrice, spec.digits);
      const nextHigh = roundToDigits(Math.max(rest.high, clampedClose), spec.digits);
      const nextLow = roundToDigits(Math.min(rest.low, clampedClose), spec.digits);
      return {
        ...rest,
        close: clampedClose,
        high: nextHigh,
        low: nextLow,
        median: (nextHigh + nextLow) / 2,
      };
    }
  );
  return recalculateAwesomeOscillator(rawBars);
}

/**
 * Closes the current forming M5 candle at `finalClose` and opens the next forming bar.
 */
export function finalizeM5BarAndOpenNext(
  existingBars: M5Bar[],
  finalClose: number,
  symbol: TradingSymbol = 'US100',
  timeframe: AoTimeframe = 'M5'
): M5Bar[] {
  const spec = SYMBOL_SPECS[symbol];
  const tfMin = AO_TIMEFRAME_MINUTES[timeframe] || 5;
  if (existingBars.length === 0) return generateInitialSeries(symbol, 100, timeframe);

  const rawBars: Omit<M5Bar, 'ao' | 'aoRising' | 'signal'>[] = existingBars.map(
    ({ ao: _ao, aoRising: _r, signal: _s, ...rest }, idx) => {
      if (idx !== existingBars.length - 1) return rest;
      const closedVal = roundToDigits(finalClose, spec.digits);
      const nextHigh = roundToDigits(Math.max(rest.high, rest.open, closedVal), spec.digits);
      const nextLow = roundToDigits(Math.min(rest.low, rest.open, closedVal), spec.digits);
      return {
        ...rest,
        close: closedVal,
        high: nextHigh,
        low: nextLow,
        median: (nextHigh + nextLow) / 2,
      };
    }
  );

  const lastClosed = rawBars[rawBars.length - 1];
  const nextDate = new Date(new Date(lastClosed.timestampIso).getTime() + tfMin * 60 * 1000);
  rawBars.push({
    index: lastClosed.index + 1,
    timeLabel: formatM5Time(nextDate),
    timestampIso: nextDate.toISOString(),
    open: lastClosed.close,
    high: lastClosed.close,
    low: lastClosed.close,
    close: lastClosed.close,
    median: lastClosed.close,
  });

  const trimmed = rawBars.slice(-110).map((b, idx) => ({ ...b, index: idx }));
  return recalculateAwesomeOscillator(trimmed);
}

export function appendNextM5Bar(
  existingBars: M5Bar[],
  symbol: TradingSymbol,
  forceCross?: 'BUY' | 'SELL',
  timeframe: AoTimeframe = 'M5'
): M5Bar[] {
  const spec = SYMBOL_SPECS[symbol];
  const tfMin = AO_TIMEFRAME_MINUTES[timeframe] || 5;
  const intervalMs = tfMin * 60 * 1000;
  const closedPrefix = existingBars.slice(0, -1);
  const rawBars: Omit<M5Bar, 'ao' | 'aoRising' | 'signal'>[] = (
    closedPrefix.length >= 35 ? closedPrefix : existingBars
  ).map(({ ao: _ao, aoRising: _r, signal: _s, ...rest }) => rest);

  const last = rawBars[rawBars.length - 1];
  const lastDate = new Date(last.timestampIso);
  const nextDate = new Date(lastDate.getTime() + intervalMs);
  const idx = last.index + 1;

  if (forceCross) {
    const prevCalculated = recalculateAwesomeOscillator(rawBars);
    const currentAo = prevCalculated[prevCalculated.length - 1].ao;

    let sum4 = 0;
    for (let k = rawBars.length - 4; k < rawBars.length; k++) {
      sum4 += rawBars[k].median;
    }
    let sum33 = 0;
    for (let k = rawBars.length - 33; k < rawBars.length; k++) {
      sum33 += rawBars[k].median;
    }
    const mZero = (sum33 / 34 - sum4 / 5) / (29 / 170);
    const offset = spec.stepSize * 0.55;
    const targetMedian = forceCross === 'BUY' ? mZero + offset : mZero - offset;

    const pushExactMedianBar = (
      barIdx: number,
      barDate: Date,
      openVal: number,
      desiredMedian: number
    ) => {
      const closeVal = roundToDigits(2 * desiredMedian - openVal, spec.digits);
      const highVal = roundToDigits(Math.max(openVal, closeVal) + spec.stepSize * 0.15, spec.digits);
      const lowVal = roundToDigits(Math.min(openVal, closeVal) - spec.stepSize * 0.15, spec.digits);
      rawBars.push({
        index: barIdx,
        timeLabel: formatM5Time(barDate),
        timestampIso: barDate.toISOString(),
        open: openVal,
        high: highVal,
        low: lowVal,
        close: closeVal,
        median: (highVal + lowVal) / 2,
      });
      return closeVal;
    };

    if ((forceCross === 'BUY' && currentAo >= 0) || (forceCross === 'SELL' && currentAo <= 0)) {
      const preOffset = forceCross === 'BUY' ? -spec.stepSize * 0.45 : spec.stepSize * 0.45;
      const preMedian = mZero + preOffset;
      const preClose = pushExactMedianBar(idx, nextDate, last.close, preMedian);

      const nextDate2 = new Date(nextDate.getTime() + intervalMs);
      let sum4b = 0;
      for (let k = rawBars.length - 4; k < rawBars.length; k++) sum4b += rawBars[k].median;
      let sum33b = 0;
      for (let k = rawBars.length - 33; k < rawBars.length; k++) sum33b += rawBars[k].median;
      const mZero2 = (sum33b / 34 - sum4b / 5) / (29 / 170);
      const crossMedian =
        forceCross === 'BUY' ? mZero2 + spec.stepSize * 0.65 : mZero2 - spec.stepSize * 0.65;
      pushExactMedianBar(idx + 1, nextDate2, preClose, crossMedian);
    } else {
      pushExactMedianBar(idx, nextDate, last.close, targetMedian);
    }
  } else {
    const delta = planNextM5CloseDelta(nextDate.toISOString(), symbol, timeframe);
    const open = last.close;
    const close = roundToDigits(open + delta, spec.digits);
    const wickUp = Math.abs(Math.sin(idx * 2.1)) * spec.stepSize * 0.45 + spec.stepSize * 0.1;
    const wickDown = Math.abs(Math.cos(idx * 1.9)) * spec.stepSize * 0.45 + spec.stepSize * 0.1;
    const high = roundToDigits(Math.max(open, close) + wickUp, spec.digits);
    const low = roundToDigits(Math.min(open, close) - wickDown, spec.digits);

    rawBars.push({
      index: idx,
      timeLabel: formatM5Time(nextDate),
      timestampIso: nextDate.toISOString(),
      open,
      high,
      low,
      close,
      median: (high + low) / 2,
    });
  }

  // Open a fresh forming bar right after the newly closed bar
  const latestClosed = rawBars[rawBars.length - 1];
  const openNextDate = new Date(new Date(latestClosed.timestampIso).getTime() + intervalMs);
  rawBars.push({
    index: latestClosed.index + 1,
    timeLabel: formatM5Time(openNextDate),
    timestampIso: openNextDate.toISOString(),
    open: latestClosed.close,
    high: latestClosed.close,
    low: latestClosed.close,
    close: latestClosed.close,
    median: latestClosed.close,
  });

  // Keep sliding window of 110 bars so SMA(34) stays warmed up for all visible bars
  const trimmed = rawBars.slice(-110).map((b, i) => ({ ...b, index: i }));
  return recalculateAwesomeOscillator(trimmed);
}
