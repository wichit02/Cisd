export type Mql5ArtifactType = 'indicator' | 'ea';
export type AlertDirection = 'both' | 'buy_only' | 'sell_only';
export type TriggerMode = 'closed_bar' | 'live_bar';
export type PushDurationMode = 'custom_sound_10s' | 'repeat_push_10s';
export type Mql5TimeframeTarget = 'M5' | 'CURRENT';

export interface Mql5Config {
  artifactType: Mql5ArtifactType;
  alertDirection: AlertDirection;
  lockM5: boolean;
  targetTimeframe?: Mql5TimeframeTarget;
  triggerMode: TriggerMode;
  pushDurationMode: PushDurationMode;
  enablePush: boolean;
  enablePopup: boolean;
  enableSound: boolean;
  enableLineNotify: boolean;
  lineNotifyToken: string;
  enableTelegram: boolean;
  telegramBotToken: string;
  telegramChatId: string;
  soundFile: string;
  customPrefix: string;
  watchlistSymbols: string;
  drawZeroLine: boolean;
}

export const DEFAULT_MQL5_CONFIG: Mql5Config = {
  artifactType: 'indicator',
  alertDirection: 'both',
  lockM5: true,
  targetTimeframe: 'M5',
  triggerMode: 'live_bar',
  pushDurationMode: 'custom_sound_10s',
  enablePush: true,
  enablePopup: true,
  enableSound: true,
  enableLineNotify: false,
  lineNotifyToken: '',
  enableTelegram: false,
  telegramBotToken: '',
  telegramChatId: '8217822307',
  soundFile: 'ao_alert_10s.wav',
  customPrefix: 'AO M5',
  watchlistSymbols: 'US100',
  drawZeroLine: true,
};

export function getMql5Filename(config: Mql5Config): string {
  return config.artifactType === 'indicator'
    ? 'AO_ZeroCross_Push.mq5'
    : 'AO_ZeroCross_Push_EA.mq5';
}

export function generateMql5Code(config: Mql5Config): string {
  const effectiveTarget: Mql5TimeframeTarget =
    config.targetTimeframe === 'CURRENT' || !config.lockM5 ? 'CURRENT' : 'M5';
  const timeframeExpr = effectiveTarget === 'M5' ? 'PERIOD_M5' : 'PERIOD_CURRENT';
  const prevIdx = config.triggerMode === 'closed_bar' ? 2 : 1;
  const currIdx = config.triggerMode === 'closed_bar' ? 1 : 0;
  const checkBuy = config.alertDirection !== 'sell_only';
  const checkSell = config.alertDirection !== 'buy_only';
  const repeatCount = config.pushDurationMode === 'repeat_push_10s' ? 4 : 1;
  const repeatIntervalSec = 3; // 4 ครั้ง ห่างกัน 3 วินาที = ดังต่อเนื่อง ~10 วินาที (ไม่เกินลิมิต MetaQuotes 10 ครั้ง/นาที)
  const escapedLineToken = config.lineNotifyToken.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const escapedTgToken = config.telegramBotToken.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const escapedTgChatId = config.telegramChatId.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const escapedPrefix = config.customPrefix.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

  if (config.artifactType === 'indicator') {
    return `//+------------------------------------------------------------------+
//|                                          AO_ZeroCross_Push.mq5   |
//|                    Awesome Oscillator Zero-Line Cross Notifier   |
//|                  M5 Push Notification for MetaTrader 5 Android   |
//+------------------------------------------------------------------+
#property copyright "Cisd เตือน"
#property version   "1.10"
#property indicator_separate_window
#property indicator_buffers 2
#property indicator_plots   1
#property indicator_type1   DRAW_COLOR_HISTOGRAM
#property indicator_color1  clrGreen, clrRed
#property indicator_width1  1
${config.drawZeroLine ? '#property indicator_level1  0.0\n#property indicator_levelcolor clrSlateGray\n#property indicator_levelstyle STYLE_DOT' : ''}

//--- Input Parameters
input ENUM_TIMEFRAMES InpTimeframe         = ${timeframeExpr}; // กรอบเวลาที่ตรวจจับสัญญาณ
input bool            InpAlertBuy          = ${checkBuy};       // แจ้งเตือน BUY (AO ตัดเส้น 0 ขึ้น)
input bool            InpAlertSell         = ${checkSell};       // แจ้งเตือน SELL (AO ตัดเส้น 0 ลง)
input bool            InpConfirmClose      = ${config.triggerMode === 'closed_bar'};       // รอยืนยันปิดแท่งเทียนก่อนแจ้งเตือน
input bool            InpSendPush          = ${config.enablePush};       // ส่ง Push Notification เข้ามือถือ Android
input int             InpPushRepeatCount   = ${repeatCount};          // จำนวนครั้งที่ส่ง Push ต่อ 1 สัญญาณ (1=ใช้เสียง 10 วิบนมือถือ, 4=ยิงซ้ำ ~10 วิ)
input int             InpPushIntervalSec   = ${repeatIntervalSec};          // ระยะห่างการส่งซ้ำ (วินาที)
input bool            InpShowPopup         = ${config.enablePopup};       // แสดง Popup Alert บนหน้าจอ MT5
input bool            InpPlaySound         = ${config.enableSound};       // เล่นเสียงแจ้งเตือนบนคอมพิวเตอร์
input string          InpSoundFile         = "${config.soundFile}"; // ไฟล์เสียง 10 วินาที (วางใน MT5/Sounds)
input string          InpMsgPrefix         = "${escapedPrefix}";    // ข้อความนำหน้าการแจ้งเตือน
// หมายเหตุ: MT5 อนุญาตให้ใช้ WebRequest (ส่งเข้า Telegram / LINE) เฉพาะในโหมด EA เท่านั้น (Indicator เรียก WebRequest ไม่ได้)

//--- Indicator Buffers & Handles
double   AOBuffer[];
double   AOColorBuffer[];
int      aoMonitorHandle = INVALID_HANDLE;
int      aoChartHandle   = INVALID_HANDLE;
datetime lastSignalBarTime = 0;
int      lastSignalDir     = 0; // 0=none, 1=BUY, -1=SELL

//--- Repeat Push Queue State (non-blocking)
int      pendingPushRemaining = 0;
datetime nextPushAt = 0;
string   pendingPushMessage = "";

//+------------------------------------------------------------------+
//| Custom indicator initialization function                         |
//+------------------------------------------------------------------+
int OnInit()
{
   SetIndexBuffer(0, AOBuffer, INDICATOR_DATA);
   SetIndexBuffer(1, AOColorBuffer, INDICATOR_COLOR_INDEX);
   PlotIndexSetString(0, PLOT_LABEL, "AO");
   PlotIndexSetInteger(0, PLOT_DRAW_BEGIN, 33);
   PlotIndexSetDouble(0, PLOT_EMPTY_VALUE, EMPTY_VALUE);
   IndicatorSetInteger(INDICATOR_DIGITS, _Digits + 1);
   IndicatorSetString(INDICATOR_SHORTNAME,
      StringFormat("AO (%s)", StringSubstr(EnumToString(InpTimeframe), 7)));

   // Handle สำหรับแสดงกราฟ AO บนชาร์ตปัจจุบัน (ค่ามาตรฐาน MT5: Fast=5, Slow=34, Median Price)
   aoChartHandle = iAO(_Symbol, PERIOD_CURRENT);
   // Handle สำหรับตรวจจับการตัดเส้น 0 ตาม Timeframe ที่กำหนด (ล็อก M5)
   aoMonitorHandle = iAO(_Symbol, InpTimeframe);

   if(aoChartHandle == INVALID_HANDLE || aoMonitorHandle == INVALID_HANDLE)
   {
      Print("Error creating iAO handle: ", GetLastError());
      return(INIT_FAILED);
   }

   if(InpPushRepeatCount > 1)
      EventSetTimer(1);

   return(INIT_SUCCEEDED);
}

//+------------------------------------------------------------------+
//| Custom indicator deinitialization function                       |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
   EventKillTimer();
   if(aoChartHandle != INVALID_HANDLE)   IndicatorRelease(aoChartHandle);
   if(aoMonitorHandle != INVALID_HANDLE) IndicatorRelease(aoMonitorHandle);
}

//+------------------------------------------------------------------+
//| Send Notification Helper                                         |
//+------------------------------------------------------------------+
void DispatchSignalAlert(const string direction, const double prevVal, const double currVal)
{
   double price = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   string tfName = StringSubstr(EnumToString(InpTimeframe), 7);
   int aoDigits = _Digits + 1;
   string msg = StringFormat(
      "%s | %s %s %s | AO: %s -> %s | Price: %s",
      InpMsgPrefix,
      _Symbol,
      tfName,
      direction,
      DoubleToString(prevVal, aoDigits),
      DoubleToString(currVal, aoDigits),
      DoubleToString(price, _Digits)
   );

   if(InpSendPush)
   {
      if(!SendNotification(msg))
         Print("SendNotification failed. Check MetaQuotes ID in Tools->Options->Notifications. Err=", GetLastError());

      if(InpPushRepeatCount > 1)
      {
         pendingPushMessage = msg;
         pendingPushRemaining = MathMin(InpPushRepeatCount, 5) - 1;
         nextPushAt = TimeLocal() + MathMax(2, InpPushIntervalSec);
      }
   }
   if(InpShowPopup) Alert(msg);
   if(InpPlaySound && InpSoundFile != "") PlaySound(InpSoundFile);
}

//+------------------------------------------------------------------+
//| Timer for ~10s repeat push notifications                         |
//+------------------------------------------------------------------+
void OnTimer()
{
   if(pendingPushRemaining <= 0 || !InpSendPush)
      return;

   datetime nowLocal = TimeLocal();
   if(nowLocal >= nextPushAt)
   {
      int pingNumber = MathMin(InpPushRepeatCount, 5) - pendingPushRemaining + 1;
      string repeatMsg = StringFormat("[%d/%d] %s", pingNumber, MathMin(InpPushRepeatCount, 5), pendingPushMessage);
      SendNotification(repeatMsg);
      pendingPushRemaining--;
      nextPushAt = nowLocal + MathMax(2, InpPushIntervalSec);
   }
}

//+------------------------------------------------------------------+
//| Custom indicator iteration function                              |
//+------------------------------------------------------------------+
int OnCalculate(const int rates_total,
                const int prev_calculated,
                const datetime &time[],
                const double &open[],
                const double &high[],
                const double &low[],
                const double &close[],
                const long &tick_volume[],
                const long &volume[],
                const int &spread[])
{
   if(rates_total < 36) return(0);

   int to_copy = (prev_calculated == 0) ? rates_total : (rates_total - prev_calculated + 1);
   if(to_copy < 2) to_copy = 2;
   if(to_copy > rates_total) to_copy = rates_total;

   double tmp[];
   ArraySetAsSeries(tmp, true);
   int copied = CopyBuffer(aoChartHandle, 0, 0, to_copy, tmp);
   if(copied <= 0)
      return(prev_calculated);

   int start = rates_total - copied;
   if(start < 0) start = 0;

   for(int i = start; i < rates_total; i++)
   {
      int shift = rates_total - 1 - i;
      double val = tmp[shift];
      if(i < 33 || val == EMPTY_VALUE)
      {
         AOBuffer[i] = EMPTY_VALUE;
         AOColorBuffer[i] = 0.0;
      }
      else
      {
         AOBuffer[i] = val;
         AOColorBuffer[i] = (val >= 0.0) ? 0.0 : 1.0;
      }
   }

   //--- ตรวจสอบแท่งเทียน Timeframe เป้าหมาย (แจ้งเตือนทันทีเมื่อตัด 0 ไม่ต้องรอปิดแท่งเมื่อ InpConfirmClose=false)
   datetime currentBarTime = iTime(_Symbol, InpTimeframe, 0);
   if(currentBarTime == 0)
      return(rates_total);
   if(currentBarTime != lastSignalBarTime)
   {
      lastSignalBarTime = currentBarTime;
      lastSignalDir = 0;
   }
   if(InpConfirmClose && lastSignalDir == 99)
      return(rates_total);

   double aoValues[3];
   ArraySetAsSeries(aoValues, true);
   if(CopyBuffer(aoMonitorHandle, 0, 0, 3, aoValues) < 3)
      return(rates_total);

   int idxPrev = InpConfirmClose ? 2 : 1;
   int idxCurr = InpConfirmClose ? 1 : 0;

   double aoPrev = aoValues[idxPrev];
   double aoCurr = aoValues[idxCurr];

   //--- BUY ALERT: AO ตัดเส้น 0 ขึ้น (ลบ -> บวก)
   if(InpAlertBuy && aoPrev <= 0.0 && aoCurr > 0.0 && lastSignalDir != 1 && lastSignalDir != 99)
   {
      DispatchSignalAlert("BUY", aoPrev, aoCurr);
      lastSignalDir = InpConfirmClose ? 99 : 1;
   }
   //--- SELL ALERT: AO ตัดเส้น 0 ลง (บวก -> ลบ)
   else if(InpAlertSell && aoPrev >= 0.0 && aoCurr < 0.0 && lastSignalDir != -1 && lastSignalDir != 99)
   {
      DispatchSignalAlert("SELL", aoPrev, aoCurr);
      lastSignalDir = InpConfirmClose ? 99 : -1;
   }
   else if(InpConfirmClose)
   {
      lastSignalDir = 99;
   }

   return(rates_total);
}
//+------------------------------------------------------------------+
`;
  }

  return `//+------------------------------------------------------------------+
//|                                       AO_ZeroCross_Push_EA.mq5   |
//|                Multi-Symbol AO Zero-Line Cross Push Notifier EA  |
//|                  M5 Push Notification for MetaTrader 5 Android   |
//+------------------------------------------------------------------+
#property copyright "Cisd เตือน"
#property version   "1.10"
#property strict

//--- Input Parameters
input string          InpSymbols           = "${config.watchlistSymbols}"; // รายชื่อสินทรัพย์คั่นด้วยจุลภาค (ว่าง = ใช้สินทรัพย์บนชาร์ต)
input ENUM_TIMEFRAMES InpTimeframe         = ${timeframeExpr}; // กรอบเวลาที่ตรวจจับสัญญาณ
input bool            InpAlertBuy          = ${checkBuy};       // แจ้งเตือน BUY (AO ตัดเส้น 0 ขึ้น)
input bool            InpAlertSell         = ${checkSell};       // แจ้งเตือน SELL (AO ตัดเส้น 0 ลง)
input bool            InpConfirmClose      = ${config.triggerMode === 'closed_bar'};       // รอยืนยันปิดแท่งเทียนก่อนแจ้งเตือน
input bool            InpSendPush          = ${config.enablePush};       // ส่ง Push Notification เข้ามือถือ Android
input int             InpPushRepeatCount   = ${repeatCount};          // จำนวนครั้งที่ส่ง Push ต่อ 1 สัญญาณ (1=ใช้เสียง 10 วิบนมือถือ, 4=ยิงซ้ำ ~10 วิ)
input int             InpPushIntervalSec   = ${repeatIntervalSec};          // ระยะห่างการส่งซ้ำ (วินาที)
input bool            InpShowPopup         = ${config.enablePopup};       // แสดง Popup Alert บนหน้าจอ MT5
input bool            InpPlaySound         = ${config.enableSound};       // เล่นเสียงแจ้งเตือนบนคอมพิวเตอร์
input string          InpSoundFile         = "${config.soundFile}"; // ไฟล์เสียง 10 วินาที (วางใน MT5/Sounds)
input string          InpMsgPrefix         = "${escapedPrefix}";    // ข้อความนำหน้าการแจ้งเตือน
input bool            InpEnableLineNotify  = ${config.enableLineNotify}; // ส่งแจ้งเตือนคู่ขนานไป LINE
input string          InpLineNotifyToken   = "${escapedLineToken}";       // LINE Notify Token
input string          InpLineNotifyUrl     = "https://notify-api.line.me/api/notify"; // LINE Notify Endpoint (เพิ่มใน MT5 Allow WebRequest)
input bool            InpEnableTelegram    = ${config.enableTelegram}; // ส่งแจ้งเตือนคู่ขนานไป Telegram
input string          InpTelegramBotToken  = "${escapedTgToken}";       // Telegram Bot Token (@BotFather)
input string          InpTelegramChatId    = "${escapedTgChatId}";      // Telegram Chat ID

struct SymbolWatcher
{
   string   symbol;
   int      aoHandle;
   datetime lastBarTime;
   int      lastSignalDir;
};

SymbolWatcher watchers[];

//--- Repeat Push Queue State (non-blocking)
int      pendingPushRemaining = 0;
datetime nextPushAt = 0;
string   pendingPushMessage = "";

//+------------------------------------------------------------------+
//| Expert initialization function                                   |
//+------------------------------------------------------------------+
int OnInit()
{
   string rawList = InpSymbols;
   StringTrimLeft(rawList);
   StringTrimRight(rawList);

   string symbolNames[];
   if(rawList == "")
   {
      ArrayResize(symbolNames, 1);
      symbolNames[0] = _Symbol;
   }
   else
   {
      int count = StringSplit(rawList, ',', symbolNames);
      for(int i = 0; i < count; i++)
      {
         StringTrimLeft(symbolNames[i]);
         StringTrimRight(symbolNames[i]);
      }
   }

   int validCount = 0;
   for(int i = 0; i < ArraySize(symbolNames); i++)
   {
      if(symbolNames[i] == "") continue;
      if(!SymbolSelect(symbolNames[i], true))
      {
         Print("Warning: Symbol not found in Market Watch: ", symbolNames[i]);
         continue;
      }

      int handle = iAO(symbolNames[i], InpTimeframe);
      if(handle == INVALID_HANDLE)
      {
         Print("Failed to create iAO handle for ", symbolNames[i]);
         continue;
      }

      ArrayResize(watchers, validCount + 1);
      watchers[validCount].symbol = symbolNames[i];
      watchers[validCount].aoHandle = handle;
      watchers[validCount].lastBarTime = 0;
      watchers[validCount].lastSignalDir = 0;
      validCount++;
   }

   if(validCount == 0)
   {
      Print("No valid symbols configured.");
      return(INIT_FAILED);
   }

   EventSetTimer(1);
   PrintFormat("AO ZeroCross EA started: monitoring %d symbol(s) on %s",
               validCount, EnumToString(InpTimeframe));
   return(INIT_SUCCEEDED);
}

//+------------------------------------------------------------------+
//| Expert deinitialization function                                 |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
   EventKillTimer();
   for(int i = 0; i < ArraySize(watchers); i++)
   {
      if(watchers[i].aoHandle != INVALID_HANDLE)
         IndicatorRelease(watchers[i].aoHandle);
   }
}

//+------------------------------------------------------------------+
//| Send Notification Helper                                         |
//+------------------------------------------------------------------+
void DispatchSignalAlert(const string sym, const string direction, const double prevVal, const double currVal)
{
   int digits = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
   double price = SymbolInfoDouble(sym, SYMBOL_BID);
   string tfName = StringSubstr(EnumToString(InpTimeframe), 7);

   string msg = StringFormat(
      "%s | %s %s %s | AO: %.5f -> %.5f | Price: %s",
      InpMsgPrefix,
      sym,
      tfName,
      direction,
      prevVal,
      currVal,
      DoubleToString(price, digits)
   );

   if(InpSendPush)
   {
      if(!SendNotification(msg))
         Print("SendNotification failed for ", sym, ". Err=", GetLastError());

      if(InpPushRepeatCount > 1)
      {
         pendingPushMessage = msg;
         pendingPushRemaining = MathMin(InpPushRepeatCount, 5) - 1;
         nextPushAt = TimeLocal() + MathMax(2, InpPushIntervalSec);
      }
   }
   if(InpShowPopup) Alert(msg);
   if(InpPlaySound && InpSoundFile != "") PlaySound(InpSoundFile);
   if(InpEnableLineNotify && InpLineNotifyToken != "") SendLineNotify(msg);
   if(InpEnableTelegram && InpTelegramBotToken != "" && InpTelegramChatId != "")
   {
      int aoDigits = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS) + 1;
      string tgHeader = (direction == "BUY") ? "🟢 BUY" : "🔴 SELL";
      string tgAction = (direction == "BUY") ? "AO ตัดเส้น 0 ขึ้น 🟢⬆️" : "AO ตัดเส้น 0 ลง 🔴⬇️";
      string timeText = TimeToString(TimeLocal(), TIME_MINUTES);
      string tgMsg = StringFormat(
         "<b>%s  ·  %s (%s)</b>\\n──────────────\\nเงื่อนไข: %s\\nค่า AO: %s → %s\\nโหมด: กราฟจริง (MT5)\\nเวลา: %s น.",
         tgHeader, sym, tfName, tgAction,
         DoubleToString(prevVal, aoDigits), DoubleToString(currVal, aoDigits),
         timeText
      );
      SendTelegram(tgMsg);
   }
}

//+------------------------------------------------------------------+
//| URL-encode UTF-8 string for application/x-www-form-urlencoded    |
//+------------------------------------------------------------------+
string UrlEncodeUtf8(const string text)
{
   uchar utf8[];
   int len = StringToCharArray(text, utf8, 0, WHOLE_ARRAY, CP_UTF8) - 1;
   string encoded = "";
   for(int i = 0; i < len; i++)
   {
      uchar c = utf8[i];
      if((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
         c == '-' || c == '_' || c == '.' || c == '~')
      {
         encoded += CharToString(c);
      }
      else if(c == ' ')
      {
         encoded += "+";
      }
      else
      {
         encoded += StringFormat("%%%02X", c);
      }
   }
   return encoded;
}

//+------------------------------------------------------------------+
//| Send Parallel Notification to LINE Notify                        |
//+------------------------------------------------------------------+
void SendLineNotify(const string message)
{
   if(InpLineNotifyToken == "" || InpLineNotifyUrl == "")
      return;

   string payload = "message=" + UrlEncodeUtf8("\\n" + message);
   char postData[];
   int dataLen = StringToCharArray(payload, postData, 0, WHOLE_ARRAY, CP_UTF8);
   if(dataLen > 0)
      ArrayResize(postData, dataLen - 1);

   string headers = "Authorization: Bearer " + InpLineNotifyToken + "\\r\\n" +
                    "Content-Type: application/x-www-form-urlencoded\\r\\n";
   char   resultData[];
   string resultHeaders = "";

   ResetLastError();
   int statusCode = WebRequest("POST", InpLineNotifyUrl, headers, 5000, postData, resultData, resultHeaders);
   if(statusCode == -1)
   {
      int err = GetLastError();
      PrintFormat("LINE Notify WebRequest failed (Err=%d). Add %s to Tools->Options->Expert Advisors->Allow WebRequest",
                  err, InpLineNotifyUrl);
   }
   else if(statusCode < 200 || statusCode >= 300)
   {
      PrintFormat("LINE Notify HTTP %d: %s", statusCode, CharArrayToString(resultData));
   }
}

//+------------------------------------------------------------------+
//| Send Parallel Notification to Telegram Bot                       |
//+------------------------------------------------------------------+
void SendTelegram(const string message)
{
   if(InpTelegramBotToken == "" || InpTelegramChatId == "")
      return;

   string url = "https://api.telegram.org/bot" + InpTelegramBotToken + "/sendMessage";
   string payload = "chat_id=" + UrlEncodeUtf8(InpTelegramChatId) +
                    "&parse_mode=HTML" +
                    "&text=" + UrlEncodeUtf8(message);
   char postData[];
   int dataLen = StringToCharArray(payload, postData, 0, WHOLE_ARRAY, CP_UTF8);
   if(dataLen > 0)
      ArrayResize(postData, dataLen - 1);

   string headers = "Content-Type: application/x-www-form-urlencoded\\r\\n";
   char   resultData[];
   string resultHeaders = "";

   ResetLastError();
   int statusCode = WebRequest("POST", url, headers, 5000, postData, resultData, resultHeaders);
   if(statusCode == -1)
   {
      int err = GetLastError();
      PrintFormat("Telegram WebRequest failed (Err=%d). Add https://api.telegram.org to Tools->Options->Expert Advisors->Allow WebRequest",
                  err);
   }
   else if(statusCode < 200 || statusCode >= 300)
   {
      PrintFormat("Telegram HTTP %d: %s", statusCode, CharArrayToString(resultData));
   }
}

//+------------------------------------------------------------------+
//| Process pending repeat pushes for ~10s alarm                     |
//+------------------------------------------------------------------+
void ProcessRepeatPushQueue()
{
   if(pendingPushRemaining <= 0 || !InpSendPush)
      return;

   datetime nowLocal = TimeLocal();
   if(nowLocal >= nextPushAt)
   {
      int pingNumber = MathMin(InpPushRepeatCount, 5) - pendingPushRemaining + 1;
      string repeatMsg = StringFormat("[%d/%d] %s", pingNumber, MathMin(InpPushRepeatCount, 5), pendingPushMessage);
      SendNotification(repeatMsg);
      pendingPushRemaining--;
      nextPushAt = nowLocal + MathMax(2, InpPushIntervalSec);
   }
}

//+------------------------------------------------------------------+
//| Check AO Zero Cross for all configured symbols                   |
//+------------------------------------------------------------------+
void CheckAllWatchers()
{
   int idxPrev = ${prevIdx};
   int idxCurr = ${currIdx};

   for(int i = 0; i < ArraySize(watchers); i++)
   {
      string sym = watchers[i].symbol;
      datetime currentBarTime = iTime(sym, InpTimeframe, 0);
      if(currentBarTime == 0)
         continue;
      if(currentBarTime != watchers[i].lastBarTime)
      {
         watchers[i].lastBarTime = currentBarTime;
         watchers[i].lastSignalDir = 0;
      }
      if(InpConfirmClose && watchers[i].lastSignalDir == 99)
         continue;

      double aoValues[3];
      ArraySetAsSeries(aoValues, true);
      if(CopyBuffer(watchers[i].aoHandle, 0, 0, 3, aoValues) < 3)
         continue;

      double aoPrev = aoValues[idxPrev];
      double aoCurr = aoValues[idxCurr];

      // BUY: AO ตัดเส้น 0 ขึ้น
      if(InpAlertBuy && aoPrev <= 0.0 && aoCurr > 0.0 && watchers[i].lastSignalDir != 1 && watchers[i].lastSignalDir != 99)
      {
         DispatchSignalAlert(sym, "BUY", aoPrev, aoCurr);
         watchers[i].lastSignalDir = InpConfirmClose ? 99 : 1;
      }
      // SELL: AO ตัดเส้น 0 ลง
      else if(InpAlertSell && aoPrev >= 0.0 && aoCurr < 0.0 && watchers[i].lastSignalDir != -1 && watchers[i].lastSignalDir != 99)
      {
         DispatchSignalAlert(sym, "SELL", aoPrev, aoCurr);
         watchers[i].lastSignalDir = InpConfirmClose ? 99 : -1;
      }
      else if(InpConfirmClose)
      {
         watchers[i].lastSignalDir = 99;
      }
   }
}

void OnTick()  { CheckAllWatchers(); }
void OnTimer() { CheckAllWatchers(); ProcessRepeatPushQueue(); }
//+------------------------------------------------------------------+
`;
}
