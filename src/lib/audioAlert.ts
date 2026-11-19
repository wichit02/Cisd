export type AlertToneKind = 'general' | 'buy' | 'sell';

const SAMPLE_RATE = 22050;
const DURATION_SECONDS = 10;

function writeString(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

/**
 * Generates a high-clarity, loud 10-second 16-bit PCM WAV trading chime.
 */
export function build10SecondWavBlob(kind: AlertToneKind = 'general'): Blob {
  const numSamples = SAMPLE_RATE * DURATION_SECONDS;
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);

  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + numSamples * 2, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  writeString(view, 36, 'data');
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  view.setUint32(40, numSamples * 2, true);

  // Bright, cutting bell frequencies clearly audible on phone and laptop speakers
  const notes =
    kind === 'buy'
      ? [880.0, 1174.66, 1567.98] // A5 -> D6 -> G6 (bright ascending)
      : kind === 'sell'
      ? [1174.66, 880.0, 659.25] // D6 -> A5 -> E5 (clear descending)
      : [1046.5, 1318.51, 1567.98]; // C6 -> E6 -> G6

  for (let i = 0; i < numSamples; i++) {
    const t = i / SAMPLE_RATE;
    const cycleT = t % 1.0; // 1 repeat per second x 10s
    let sample = 0;

    if (cycleT < 0.72) {
      const noteIdx = Math.min(2, Math.floor(cycleT / 0.22));
      const localT = cycleT - noteIdx * 0.22;
      const freq = notes[noteIdx];

      const attack = Math.min(1, localT / 0.008);
      const decay = Math.exp(-localT * 4.8);
      const env = attack * decay;

      sample =
        (0.62 * Math.sin(2 * Math.PI * freq * t) +
          0.26 * Math.sin(2 * Math.PI * freq * 2 * t) +
          0.12 * Math.sin(2 * Math.PI * freq * 3 * t)) *
        env *
        0.92;
    }

    if (t > DURATION_SECONDS - 0.15) {
      sample *= Math.max(0, (DURATION_SECONDS - t) / 0.15);
    }

    const clamped = Math.max(-0.98, Math.min(0.98, sample));
    view.setInt16(44 + i * 2, Math.round(clamped * 32767), true);
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

export function download10SecondWav(kind: AlertToneKind = 'general'): void {
  const blob = build10SecondWavBlob(kind);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download =
    kind === 'buy'
      ? 'ao_buy_alert_10s.wav'
      : kind === 'sell'
      ? 'ao_sell_alert_10s.wav'
      : 'ao_alert_10s.wav';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

let sharedAudioCtx: AudioContext | null = null;
let activeSourceNode: AudioBufferSourceNode | null = null;
let activeAudioEl: HTMLAudioElement | null = null;
let activeAudioUrl: string | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return null;
  if (!sharedAudioCtx) {
    sharedAudioCtx = new Ctx();
  }
  return sharedAudioCtx;
}

export function unlockAudioAlert(): void {
  const ctx = getAudioContext();
  if (ctx && ctx.state === 'suspended') {
    void ctx.resume().catch(() => {});
  }
}

export function stop10SecondSound(): void {
  if (activeSourceNode) {
    try {
      activeSourceNode.onended = null;
      activeSourceNode.stop();
      activeSourceNode.disconnect();
    } catch {
      // Ignore already stopped source
    }
    activeSourceNode = null;
  }
  if (activeAudioEl) {
    activeAudioEl.onended = null;
    activeAudioEl.pause();
    activeAudioEl.currentTime = 0;
    activeAudioEl = null;
  }
  if (activeAudioUrl) {
    URL.revokeObjectURL(activeAudioUrl);
    activeAudioUrl = null;
  }
}

export function play10SecondSound(
  kind: AlertToneKind = 'general',
  onEnded?: () => void
): () => void {
  stop10SecondSound();
  const blob = build10SecondWavBlob(kind);
  const ctx = getAudioContext();

  if (ctx) {
    void (async () => {
      try {
        if (ctx.state === 'suspended') {
          await ctx.resume();
        }
        const arrBuf = await blob.arrayBuffer();
        const audioBuffer = await ctx.decodeAudioData(arrBuf.slice(0));
        const src = ctx.createBufferSource();
        const gain = ctx.createGain();
        gain.gain.value = 1.0;
        src.buffer = audioBuffer;
        src.connect(gain);
        gain.connect(ctx.destination);
        activeSourceNode = src;
        src.onended = () => {
          if (activeSourceNode === src) {
            activeSourceNode = null;
            onEnded?.();
          }
        };
        src.start(0);
        return;
      } catch {
        // Fallback to HTMLAudioElement below
      }

      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.volume = 1.0;
      activeAudioEl = audio;
      activeAudioUrl = url;
      audio.onended = () => {
        stop10SecondSound();
        onEnded?.();
      };
      audio.play().catch(() => {
        stop10SecondSound();
        onEnded?.();
      });
    })();
    return stop10SecondSound;
  }

  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  audio.volume = 1.0;
  activeAudioEl = audio;
  activeAudioUrl = url;

  audio.onended = () => {
    stop10SecondSound();
    onEnded?.();
  };

  audio.play().catch(() => {
    stop10SecondSound();
    onEnded?.();
  });

  return stop10SecondSound;
}
