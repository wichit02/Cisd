function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

export function isWebPushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

export async function getExistingPushSubscription(): Promise<PushSubscription | null> {
  if (!isWebPushSupported()) return null;
  const reg = await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

export async function subscribeDeviceToWebPush(): Promise<PushSubscription> {
  if (!isWebPushSupported()) {
    throw new Error('เบราว์เซอร์นี้ไม่รองรับการแจ้งเตือนอัตโนมัติ (แนะนำเปิดผ่าน Chrome บน Android)');
  }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error('กรุณากดอนุญาตการแจ้งเตือน (Allow) เพื่อรับสัญญาณเข้ามือถือ');
  }

  const reg = await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;

  const keyRes = await fetch('/api/push/vapid-public-key');
  if (!keyRes.ok) {
    throw new Error('ไม่สามารถดึงกุญแจเชื่อมต่อจากเซิร์ฟเวอร์ได้');
  }
  const { publicKey } = (await keyRes.json()) as { publicKey: string };

  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    const appServerKey = urlBase64ToUint8Array(publicKey);
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: appServerKey.buffer as ArrayBuffer,
    });
  }

  const saveRes = await fetch('/api/push/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subscription: sub.toJSON() }),
  });

  if (!saveRes.ok) {
    throw new Error('บันทึกอุปกรณ์เข้าเซิร์ฟเวอร์ไม่สำเร็จ');
  }

  return sub;
}

export async function unsubscribeDeviceFromWebPush(): Promise<void> {
  if (!isWebPushSupported()) return;
  const reg = await navigator.serviceWorker.getRegistration('/sw.js');
  if (!reg) return;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;

  await fetch('/api/push/unsubscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: sub.endpoint }),
  }).catch(() => {});

  await sub.unsubscribe();
}

export async function sendTestWebPush(endpoint?: string): Promise<void> {
  const res = await fetch('/api/push/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error || 'ส่งแจ้งเตือนทดสอบไม่สำเร็จ');
  }
}

export async function showLocalMobileNotification(payload: {
  title: string;
  body: string;
  tag?: string;
  url?: string;
}): Promise<boolean> {
  if (typeof window === 'undefined' || !('Notification' in window)) return false;
  if (Notification.permission !== 'granted') return false;

  const options: NotificationOptions & {
    renotify?: boolean;
    vibrate?: number[];
    data?: { url: string };
  } = {
    body: payload.body,
    icon: '/pwa-192x192.png',
    badge: '/pwa-192x192.png',
    tag: payload.tag || `signal-${Date.now()}`,
    renotify: true,
    requireInteraction: true,
    vibrate: [450, 150, 450, 150, 450, 150, 450],
    data: { url: payload.url || '/' },
  };

  try {
    if ('serviceWorker' in navigator) {
      let reg = await navigator.serviceWorker.getRegistration('/sw.js');
      if (!reg) {
        reg = await navigator.serviceWorker.register('/sw.js').catch(() => undefined);
      }
      if (reg && 'showNotification' in reg) {
        await reg.showNotification(payload.title, options);
        return true;
      }
    }
  } catch {
    // Fall back to direct Notification constructor below
  }

  try {
    new Notification(payload.title, {
      body: payload.body,
      icon: '/pwa-192x192.png',
      tag: options.tag,
    });
    return true;
  } catch {
    return false;
  }
}

export interface MobileSignalDispatchResult {
  ok: boolean;
  deliveredWebPushCount: number;
  deliveredToNtfy: boolean;
  deliveredToTelegram: boolean;
  telegramError?: string;
  telegramMissingToken?: boolean;
  localNotificationShown: boolean;
  deduplicated?: boolean;
}

export async function dispatchMobileSignalNotification(params: {
  symbol: string;
  timeframe: string;
  strategy: 'AO' | 'CISD';
  signal: 'BUY' | 'SELL';
  aoPrev: number;
  aoCurr: number;
  price: number;
  cisdLevel?: number | null;
  mode: 'live' | 'sim';
  timestampIso: string;
  prefix?: string;
}): Promise<MobileSignalDispatchResult> {
  let deliveredWebPushCount = 0;
  let deliveredToNtfy = false;
  let deliveredToTelegram = false;
  let telegramError: string | undefined;
  let telegramMissingToken = false;
  let deduplicated = false;
  let skipped = false;

  try {
    const res = await fetch('/api/monitor/notify-signal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    if (res.ok) {
      const data = (await res.json().catch(() => ({}))) as {
        deliveredWebPushCount?: number;
        deliveredToNtfy?: boolean;
        deliveredToTelegram?: boolean;
        telegramError?: string;
        telegramMissingToken?: boolean;
        deduplicated?: boolean;
        skipped?: boolean;
      };
      deliveredWebPushCount = Number(data.deliveredWebPushCount ?? 0);
      deliveredToNtfy = Boolean(data.deliveredToNtfy);
      deliveredToTelegram = Boolean(data.deliveredToTelegram);
      telegramError = data.telegramError;
      telegramMissingToken = Boolean(data.telegramMissingToken);
      deduplicated = Boolean(data.deduplicated);
      skipped = Boolean(data.skipped);
    }
  } catch {
    // Fallback to local mobile notification below if browser permitted
  }

  // Always show local browser/PWA notification if no Web Push delivered to phone (even when server deduplicated background cycle)
  let localNotificationShown = false;
  if (!skipped && (params.mode === 'sim' || deliveredWebPushCount === 0)) {
    const modePrefix = params.mode === 'sim' ? '[จำลอง] ' : '';
    const title =
      params.strategy === 'CISD'
        ? `${modePrefix}CISD ${params.timeframe} ${params.signal}: ${params.symbol}`
        : `${modePrefix}AO ${params.timeframe} ${params.signal}: ${params.symbol}`;
    const body =
      params.strategy === 'CISD'
        ? `${params.symbol} ${params.timeframe} ${
            params.signal === 'SELL' ? 'ปิดต่ำกว่าระดับ CISD' : 'ปิดเหนือระดับ CISD'
          } | ปิด ${params.price.toFixed(2)}${
            params.cisdLevel != null ? ` (CISD ${params.cisdLevel.toFixed(2)})` : ''
          }`
        : `${params.symbol} ${params.timeframe} ${
            params.signal === 'BUY' ? 'AO ตัด 0 ขึ้น' : 'AO ตัด 0 ลง'
          } | ราคา ${params.price.toFixed(2)}`;

    localNotificationShown = await showLocalMobileNotification({
      title,
      body,
      tag: `${params.mode}-${params.strategy}-${params.timeframe}-${params.symbol}-${params.timestampIso}-${params.signal}`,
      url: params.strategy === 'CISD' ? `/?tf=${params.timeframe}` : '/',
    });
  }

  return {
    ok:
      deliveredWebPushCount > 0 ||
      deliveredToNtfy ||
      deliveredToTelegram ||
      localNotificationShown,
    deliveredWebPushCount,
    deliveredToNtfy,
    deliveredToTelegram,
    telegramError,
    telegramMissingToken,
    localNotificationShown,
    deduplicated,
  };
}
