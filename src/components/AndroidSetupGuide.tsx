import React, { useEffect, useState } from 'react';
import {
  CheckCircle2,
  Circle,
  Smartphone,
  ShieldCheck,
  Volume2,
  Square,
  Download,
} from 'lucide-react';
import {
  download10SecondWav,
  play10SecondSound,
  stop10SecondSound,
} from '../lib/audioAlert';

const SETUP_STEPS = [
  {
    id: 'step-1',
    title: '01. คัดลอก MetaQuotes ID บนมือถือ Android',
    detail: 'MT5 มือถือ → ☰ → Settings → Messages → จดรหัส 8 หลัก',
  },
  {
    id: 'step-2',
    title: '02. ใส่รหัสใน MT5 บนคอมพิวเตอร์ / VPS',
    detail: 'MT5 PC → Tools → Options → Notifications → ใส่ MetaQuotes ID แล้วกด Test',
  },
  {
    id: 'step-3',
    title: '03. ตั้งเสียงแจ้งเตือนยาว 10 วินาทีบน Android',
    detail: 'Settings มือถือ → Apps → MetaTrader 5 → Notifications → Sound → เลือก ao_alert_10s.wav',
  },
  {
    id: 'step-4',
    title: '04. คอมไพล์ .mq5 และปิดโหมดประหยัดแบต',
    detail: 'วางไฟล์ .mq5 ใน MetaEditor (F4) แล้วกด F7 · ตั้ง Battery ของ MT5 เป็น Unrestricted',
  },
];

export const AndroidSetupGuide: React.FC = () => {
  const [metaQuotesId, setMetaQuotesId] = useState('');
  const [completed, setCompleted] = useState<Record<string, boolean>>({});
  const [isPlaying10s, setIsPlaying10s] = useState(false);

  useEffect(() => {
    return () => {
      stop10SecondSound();
    };
  }, []);

  const normalizedId = metaQuotesId.trim().toUpperCase();
  const isValidFormat = /^[0-9A-F]{8}$/.test(normalizedId);

  const toggleStep = (id: string) => {
    setCompleted((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const handleTogglePlay = () => {
    if (isPlaying10s) {
      stop10SecondSound();
      setIsPlaying10s(false);
    } else {
      setIsPlaying10s(true);
      play10SecondSound('general', () => setIsPlaying10s(false));
    }
  };

  const doneCount = SETUP_STEPS.filter((s) => completed[s.id]).length;

  const progressPercent = Math.round((doneCount / SETUP_STEPS.length) * 100);

  return (
    <section className="grid grid-cols-1 gap-6 lg:grid-cols-12 items-start">
      {/* Checklist Steps */}
      <div className="lg:col-span-8 rounded-xl border border-slate-200/90 bg-white p-6">
        <div className="border-b border-slate-100 pb-4">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                ขั้นตอนติดตั้งบน Android และ MetaTrader 5
              </h2>
              <p className="mt-0.5 text-xs text-slate-500">
                คลิกแต่ละข้อเพื่อเช็กรายการที่ทำเสร็จแล้ว
              </p>
            </div>
            <span className="font-mono text-xs font-semibold text-slate-700 tabular-nums">
              เสร็จแล้ว {doneCount} / {SETUP_STEPS.length}
            </span>
          </div>
          <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
            <div
              className="h-full rounded-full bg-emerald-600 transition-all duration-300"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
        </div>

        <div className="mt-3 divide-y divide-slate-100">
          {SETUP_STEPS.map((step) => {
            const isChecked = !!completed[step.id];
            return (
              <div key={step.id} className="py-3.5">
                <button
                  type="button"
                  onClick={() => toggleStep(step.id)}
                  className="flex w-full items-start gap-3.5 rounded-lg p-2 -mx-2 text-left transition-colors hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-blue-600"
                >
                  {isChecked ? (
                    <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" />
                  ) : (
                    <Circle className="mt-0.5 h-5 w-5 shrink-0 text-slate-300" />
                  )}
                  <div>
                    <h3
                      className={`text-[15px] font-semibold ${
                        isChecked ? 'text-slate-400 line-through' : 'text-slate-900'
                      }`}
                    >
                      {step.title}
                    </h3>
                    <p className="mt-1 text-[13px] leading-relaxed text-slate-600">
                      {step.detail}
                    </p>
                  </div>
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {/* Right Column: 10s Audio Generator + MetaQuotes ID Validator */}
      <div className="lg:col-span-4 space-y-5">
        <div className="rounded-xl border border-slate-200/90 bg-white p-5 sm:p-6 space-y-3.5">
          <div className="flex items-center gap-2">
            <Volume2 className="h-4 w-4 text-blue-600" />
            <h3 className="text-[15px] font-semibold text-slate-900">
              ไฟล์เสียงเตือน 10 วินาที
            </h3>
          </div>
          <p className="text-[13px] leading-relaxed text-slate-600">
            ดาวน์โหลดไปตั้งเป็นเสียงแจ้งเตือนของแอป MetaTrader 5 บน Android เพื่อให้ได้ยินชัดไม่พลาดสัญญาณ
          </p>

          <div className="flex flex-wrap gap-2.5 pt-1">
            <button
              type="button"
              onClick={handleTogglePlay}
              className="inline-flex h-10 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3.5 text-[13px] font-medium text-slate-700 transition-colors hover:bg-slate-50"
            >
              {isPlaying10s ? (
                <>
                  <Square className="h-4 w-4 text-rose-600" />
                  หยุดฟัง
                </>
              ) : (
                <>
                  <Volume2 className="h-4 w-4 text-blue-600" />
                  ฟังตัวอย่าง
                </>
              )}
            </button>
            <button
              type="button"
              onClick={() => download10SecondWav('general')}
              className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-blue-600 px-4 text-[13px] font-medium text-white transition-colors hover:bg-blue-700"
            >
              <Download className="h-4 w-4" />
              ดาวน์โหลด .wav
            </button>
          </div>
        </div>

        <div className="rounded-xl border border-slate-200/90 bg-white p-5 sm:p-6 space-y-3.5">
          <div className="flex items-center gap-2">
            <Smartphone className="h-4 w-4 text-slate-600" />
            <h3 className="text-[15px] font-semibold text-slate-900">
              ตรวจสอบรหัส MetaQuotes ID
            </h3>
          </div>
          <p className="text-xs leading-relaxed text-slate-500">
            กรอกรหัส 8 หลักจากแอป MT5 เพื่อตรวจความถูกต้องของรูปแบบตัวอักษร
          </p>

          <input
            id="mq-id-input"
            type="text"
            maxLength={10}
            value={metaQuotesId}
            onChange={(e) => setMetaQuotesId(e.target.value)}
            placeholder="เช่น 8F4C2A19"
            className="h-10 w-full rounded-lg border border-slate-200 px-3.5 font-mono text-sm uppercase tracking-wider text-slate-900 focus:border-blue-600 focus:outline-none"
          />

          {normalizedId.length > 0 && (
            <div
              className={`rounded-lg border px-3.5 py-2.5 text-xs ${
                isValidFormat
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                  : 'border-amber-200 bg-amber-50 text-amber-800'
              }`}
            >
              {isValidFormat ? (
                <div className="flex items-center gap-2 font-medium">
                  <ShieldCheck className="h-4 w-4 shrink-0 text-emerald-700" />
                  <span>รูปแบบถูกต้อง ({normalizedId})</span>
                </div>
              ) : (
                <span>กรุณากรอกตัวเลขหรือตัวอักษร A–F ให้ครบ 8 หลัก</span>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
};

