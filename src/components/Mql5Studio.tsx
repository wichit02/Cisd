import React, { useEffect, useMemo, useState } from 'react';
import { Check, Copy, Download, Code2, Volume2, Square } from 'lucide-react';
import {
  Mql5Config,
  generateMql5Code,
  getMql5Filename,
} from '../lib/mql5Generator';
import {
  download10SecondWav,
  play10SecondSound,
  stop10SecondSound,
} from '../lib/audioAlert';

interface Mql5StudioProps {
  config: Mql5Config;
  onChangeConfig: (next: Mql5Config) => void;
}

export const Mql5Studio: React.FC<Mql5StudioProps> = ({
  config,
  onChangeConfig,
}) => {
  const [copied, setCopied] = useState(false);
  const [isPlaying10s, setIsPlaying10s] = useState(false);

  useEffect(() => {
    return () => {
      stop10SecondSound();
    };
  }, []);

  const code = useMemo(() => generateMql5Code(config), [config]);
  const filename = useMemo(() => getMql5Filename(config), [config]);

  const handleTogglePreview10s = () => {
    if (isPlaying10s) {
      stop10SecondSound();
      setIsPlaying10s(false);
    } else {
      setIsPlaying10s(true);
      play10SecondSound('general', () => setIsPlaying10s(false));
    }
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback textarea copy
      const ta = document.createElement('textarea');
      ta.value = code;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleDownload = () => {
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

  return (
    <section className="grid grid-cols-1 gap-6 lg:grid-cols-12 items-start">
      {/* Configuration Column */}
      <div className="lg:col-span-4 rounded-xl border border-slate-200/90 bg-white p-5 sm:p-6 space-y-6">
        <div className="border-b border-slate-100 pb-3.5">
          <h2 className="text-[15px] font-semibold text-slate-900">
            1. ตั้งค่าเงื่อนไขสัญญาณ MQL5
          </h2>
          <p className="mt-0.5 text-xs text-slate-500">
            เลือกโหมดไฟล์ ทิศทาง และกรอบเวลาที่ต้องการให้โค้ดทำงาน
          </p>
        </div>

        {/* Artifact Type */}
        <div className="space-y-2">
          <label className="block text-[13px] font-medium text-slate-700">
            ประเภทไฟล์
          </label>
          <div className="grid grid-cols-2 gap-1 rounded-lg bg-slate-100 p-1">
            <button
              type="button"
              onClick={() =>
                onChangeConfig({ ...config, artifactType: 'indicator' })
              }
              className={`h-9 rounded-md px-3 text-[13px] font-medium whitespace-nowrap transition-colors ${
                config.artifactType === 'indicator'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Indicator
            </button>
            <button
              type="button"
              onClick={() => onChangeConfig({ ...config, artifactType: 'ea' })}
              className={`h-9 rounded-md px-3 text-[13px] font-medium whitespace-nowrap transition-colors ${
                config.artifactType === 'ea'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              EA (หลายสินทรัพย์)
            </button>
          </div>
        </div>

        {/* Alert Direction */}
        <div className="space-y-2">
          <label className="block text-[13px] font-medium text-slate-700">
            สัญญาณที่แจ้งเตือน
          </label>
          <div className="grid grid-cols-3 gap-1 rounded-lg bg-slate-100 p-1">
            <button
              type="button"
              onClick={() =>
                onChangeConfig({ ...config, alertDirection: 'both' })
              }
              className={`h-9 rounded-md px-2 text-xs font-medium whitespace-nowrap transition-colors ${
                config.alertDirection === 'both'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              BUY &amp; SELL
            </button>
            <button
              type="button"
              onClick={() =>
                onChangeConfig({ ...config, alertDirection: 'buy_only' })
              }
              className={`h-9 rounded-md px-2 text-xs font-medium whitespace-nowrap transition-colors ${
                config.alertDirection === 'buy_only'
                  ? 'bg-white text-emerald-700 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              เฉพาะ BUY
            </button>
            <button
              type="button"
              onClick={() =>
                onChangeConfig({ ...config, alertDirection: 'sell_only' })
              }
              className={`h-9 rounded-md px-2 text-xs font-medium whitespace-nowrap transition-colors ${
                config.alertDirection === 'sell_only'
                  ? 'bg-white text-rose-700 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              เฉพาะ SELL
            </button>
          </div>
        </div>

        {/* Timeframe Lock */}
        <div className="space-y-2">
          <label className="block text-[13px] font-medium text-slate-700">
            กรอบเวลา AO
          </label>
          <div className="grid grid-cols-2 gap-1 rounded-lg bg-slate-100 p-1">
            {(['M5', 'CURRENT'] as const).map((tfOpt) => {
              const currentTarget = config.lockM5 ? 'M5' : 'CURRENT';
              const isSelected = currentTarget === tfOpt;
              return (
                <button
                  key={tfOpt}
                  type="button"
                  onClick={() =>
                    onChangeConfig({
                      ...config,
                      targetTimeframe: tfOpt,
                      lockM5: tfOpt === 'M5',
                    })
                  }
                  className={`h-9 rounded-md px-3 text-[13px] font-medium whitespace-nowrap transition-colors ${
                    isSelected
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {tfOpt === 'M5' ? 'ล็อก M5' : 'ตามชาร์ต'}
                </button>
              );
            })}
          </div>
        </div>

        {/* Trigger Confirmation */}
        <div className="space-y-2">
          <label className="block text-[13px] font-medium text-slate-700">
            จังหวะเตือน
          </label>
          <div className="grid grid-cols-2 gap-1 rounded-lg bg-slate-100 p-1">
            <button
              type="button"
              onClick={() =>
                onChangeConfig({ ...config, triggerMode: 'live_bar' })
              }
              className={`h-9 rounded-md px-2.5 text-[13px] font-medium whitespace-nowrap transition-colors ${
                config.triggerMode === 'live_bar'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              ตัดปุ๊บเตือนทันที [0]
            </button>
            <button
              type="button"
              onClick={() =>
                onChangeConfig({ ...config, triggerMode: 'closed_bar' })
              }
              className={`h-9 rounded-md px-2.5 text-[13px] font-medium whitespace-nowrap transition-colors ${
                config.triggerMode === 'closed_bar'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              รอปิดแท่ง [1]
            </button>
          </div>
        </div>

        {/* 10-Second Mobile Sound Mode */}
        <div className="space-y-2.5 border-t border-slate-100 pt-5">
          <h3 className="text-[13px] font-semibold text-slate-900">
            2. เสียงแจ้งเตือน 10 วินาที
          </h3>
          <div className="grid grid-cols-2 gap-1 rounded-lg bg-slate-100 p-1">
            <button
              type="button"
              onClick={() =>
                onChangeConfig({ ...config, pushDurationMode: 'custom_sound_10s' })
              }
              className={`h-9 rounded-md px-2 text-xs font-medium whitespace-nowrap transition-colors ${
                config.pushDurationMode === 'custom_sound_10s'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              ไฟล์เสียง 10 วิ
            </button>
            <button
              type="button"
              onClick={() =>
                onChangeConfig({ ...config, pushDurationMode: 'repeat_push_10s' })
              }
              className={`h-9 rounded-md px-2 text-xs font-medium whitespace-nowrap transition-colors ${
                config.pushDurationMode === 'repeat_push_10s'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              ส่งซ้ำ 4 ครั้ง (~10 วิ)
            </button>
          </div>

          <div className="flex flex-wrap gap-2 pt-1">
            <button
              type="button"
              onClick={handleTogglePreview10s}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50"
            >
              {isPlaying10s ? (
                <>
                  <Square className="h-3.5 w-3.5 text-rose-600" />
                  หยุดฟัง
                </>
              ) : (
                <>
                  <Volume2 className="h-3.5 w-3.5 text-blue-600" />
                  ฟัง 10 วิ
                </>
              )}
            </button>
            <button
              type="button"
              onClick={() => download10SecondWav('general')}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50"
            >
              <Download className="h-3.5 w-3.5" />
              โหลดไฟล์เสียง .wav
            </button>
          </div>
        </div>

        {/* Multi-symbol input for EA */}
        {config.artifactType === 'ea' && (
          <div className="space-y-1.5">
            <label
              htmlFor="ea-watchlist"
              className="block text-[13px] font-medium text-slate-700"
            >
              สินทรัพย์ (คั่นด้วย ,)
            </label>
            <input
              id="ea-watchlist"
              type="text"
              value={config.watchlistSymbols}
              onChange={(e) =>
                onChangeConfig({ ...config, watchlistSymbols: e.target.value })
              }
              placeholder="US100"
              className="h-10 w-full rounded-lg border border-slate-200 px-3 font-mono text-[13px] text-slate-900 focus:border-blue-600 focus:outline-none"
            />
          </div>
        )}

        {/* Prefix Input */}
        <div className="space-y-1.5">
          <label
            htmlFor="msg-prefix"
            className="block text-[13px] font-medium text-slate-700"
          >
            คำนำหน้าข้อความแจ้งเตือน
          </label>
          <input
            id="msg-prefix"
            type="text"
            value={config.customPrefix}
            onChange={(e) =>
              onChangeConfig({ ...config, customPrefix: e.target.value })
            }
            placeholder="AO M5"
            className="h-10 w-full rounded-lg border border-slate-200 px-3 font-mono text-[13px] text-slate-900 focus:border-blue-600 focus:outline-none"
          />
        </div>

        {/* Channels */}
        <div className="space-y-1.5 border-t border-slate-100 pt-5">
          <h3 className="pb-1 text-[13px] font-semibold text-slate-900">
            3. ช่องทางรับแจ้งเตือน
          </h3>
          <label className="flex min-h-[38px] items-center justify-between rounded-lg px-2 -mx-2 text-[13px] text-slate-700 cursor-pointer hover:bg-slate-50">
            <span>Push เข้ามือถือ Android</span>
            <input
              type="checkbox"
              checked={config.enablePush}
              onChange={(e) =>
                onChangeConfig({ ...config, enablePush: e.target.checked })
              }
              className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-600"
            />
          </label>
          <label className="flex min-h-[38px] items-center justify-between rounded-lg px-2 -mx-2 text-[13px] text-slate-700 cursor-pointer hover:bg-slate-50">
            <span>Popup บนหน้าจอ MT5</span>
            <input
              type="checkbox"
              checked={config.enablePopup}
              onChange={(e) =>
                onChangeConfig({ ...config, enablePopup: e.target.checked })
              }
              className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-600"
            />
          </label>
          <label className="flex min-h-[38px] items-center justify-between rounded-lg px-2 -mx-2 text-[13px] text-slate-700 cursor-pointer hover:bg-slate-50">
            <span>เสียงเตือนบนคอมฯ</span>
            <input
              type="checkbox"
              checked={config.enableSound}
              onChange={(e) =>
                onChangeConfig({ ...config, enableSound: e.target.checked })
              }
              className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-600"
            />
          </label>
          <label className="flex min-h-[38px] items-center justify-between rounded-lg px-2 -mx-2 text-[13px] text-slate-700 cursor-pointer hover:bg-slate-50">
            <span>ส่งคู่ขนานไป Telegram</span>
            <input
              type="checkbox"
              checked={config.enableTelegram}
              onChange={(e) =>
                onChangeConfig({ ...config, enableTelegram: e.target.checked })
              }
              className="h-4 w-4 rounded border-slate-300 text-sky-600 focus:ring-sky-600"
            />
          </label>

          {config.enableTelegram && (
            <div className="space-y-2 pt-1">
              <label
                htmlFor="tg-bot-token"
                className="block text-xs font-medium text-slate-600"
              >
                Telegram Bot Token &amp; Chat ID
              </label>
              <input
                id="tg-bot-token"
                type="password"
                autoComplete="off"
                value={config.telegramBotToken}
                onChange={(e) =>
                  onChangeConfig({
                    ...config,
                    telegramBotToken: e.target.value.trim(),
                  })
                }
                placeholder="Bot Token (จาก @BotFather)"
                className="h-9 w-full rounded-lg border border-slate-200 px-3 font-mono text-xs text-slate-900 focus:border-sky-600 focus:outline-none"
              />
              <input
                id="tg-chat-id"
                type="text"
                autoComplete="off"
                value={config.telegramChatId || '8217822307'}
                onChange={(e) =>
                  onChangeConfig({
                    ...config,
                    telegramChatId: e.target.value.trim() || '8217822307',
                  })
                }
                placeholder="8217822307"
                className="h-9 w-full rounded-lg border border-slate-200 px-3 font-mono text-xs text-slate-900 focus:border-sky-600 focus:outline-none"
              />
              {config.artifactType === 'indicator' ? (
                <div className="flex items-center justify-between gap-2 rounded-lg bg-amber-50 px-2.5 py-2 text-[11px] text-amber-800">
                  <span>ส่ง Telegram ใน MT5 ต้องใช้โหมด EA</span>
                  <button
                    type="button"
                    onClick={() =>
                      onChangeConfig({ ...config, artifactType: 'ea' })
                    }
                    className="shrink-0 font-semibold text-amber-900 underline"
                  >
                    สลับเป็น EA
                  </button>
                </div>
              ) : (
                <p className="text-[11px] text-slate-500">
                  เพิ่ม <span className="font-mono">https://api.telegram.org</span> ใน MT5 → Tools → Options → Expert Advisors → Allow WebRequest
                </p>
              )}
            </div>
          )}

          <label className="flex items-center justify-between text-xs text-slate-700 cursor-pointer">
            <span>ส่งคู่ขนานไป LINE Notify</span>
            <input
              type="checkbox"
              checked={config.enableLineNotify}
              onChange={(e) =>
                onChangeConfig({ ...config, enableLineNotify: e.target.checked })
              }
              className="h-4 w-4 rounded border-slate-300 text-emerald-600 focus:ring-emerald-600"
            />
          </label>

          {config.enableLineNotify && (
            <div className="space-y-2 pt-1">
              <label
                htmlFor="line-notify-token"
                className="block text-xs font-medium text-slate-600"
              >
                LINE Notify Token
              </label>
              <input
                id="line-notify-token"
                type="password"
                autoComplete="off"
                value={config.lineNotifyToken}
                onChange={(e) =>
                  onChangeConfig({
                    ...config,
                    lineNotifyToken: e.target.value.trim(),
                  })
                }
                placeholder="วาง Token ที่นี่"
                className="h-9 w-full rounded-lg border border-slate-200 px-3 font-mono text-xs text-slate-900 focus:border-emerald-600 focus:outline-none"
              />
              {config.artifactType === 'indicator' ? (
                <div className="flex items-center justify-between gap-2 rounded-lg bg-amber-50 px-2.5 py-2 text-[11px] text-amber-800">
                  <span>ส่ง LINE ใน MT5 ต้องใช้โหมด EA</span>
                  <button
                    type="button"
                    onClick={() =>
                      onChangeConfig({ ...config, artifactType: 'ea' })
                    }
                    className="shrink-0 font-semibold text-amber-900 underline"
                  >
                    สลับเป็น EA
                  </button>
                </div>
              ) : (
                <p className="text-[11px] text-slate-500">
                  เพิ่ม <span className="font-mono">https://notify-api.line.me</span> ใน MT5 → Tools → Options → Expert Advisors → Allow WebRequest
                </p>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Code Viewer Column */}
      <div className="lg:col-span-8 flex flex-col rounded-xl border border-slate-200/90 bg-white overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-slate-50/80 px-5 py-4">
          <div className="flex items-center gap-2.5">
            <Code2 className="h-4 w-4 text-slate-600" />
            <span className="font-mono text-sm font-semibold text-slate-900">
              {filename}
            </span>
            <span className="text-xs text-slate-500">
              · MQL5 · UTF-8
            </span>
          </div>

          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={handleCopy}
              className="inline-flex h-10 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-4 text-[13px] font-medium text-slate-700 whitespace-nowrap transition-colors hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-blue-600"
            >
              {copied ? (
                <>
                  <Check className="h-4 w-4 text-emerald-600" />
                  คัดลอกแล้ว
                </>
              ) : (
                <>
                  <Copy className="h-4 w-4" />
                  คัดลอกโค้ด
                </>
              )}
            </button>

            <button
              type="button"
              onClick={handleDownload}
              className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-blue-600 px-4 text-[13px] font-medium text-white whitespace-nowrap transition-colors hover:bg-blue-700 focus-visible:outline-2 focus-visible:outline-blue-600"
            >
              <Download className="h-4 w-4" />
              ดาวน์โหลด {filename}
            </button>
          </div>
        </div>

        <pre className="max-h-[680px] overflow-auto bg-slate-950 p-5 sm:p-6 font-mono text-[13px] leading-relaxed text-slate-100 tabular-nums">
          <code>{code}</code>
        </pre>
      </div>
    </section>
  );
};
