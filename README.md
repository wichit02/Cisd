# AO Signal Studio (M5 Awesome Oscillator Monitor)

ระบบเฝ้าสัญญาณ **Awesome Oscillator (5, 34)** ตัดเส้น 0 บนกรอบเวลา **M5** ตลอด 24 ชั่วโมงสำหรับ **US100 (US 100 Index Cash)** พร้อมส่งแจ้งเตือนเข้า **Telegram** และ **Android Web Push**

---

## 1. ความต้องการของระบบ
- **Node.js 22+** (แนะนำ Node 22 LTS เพื่อรัน `node server.ts` ได้ทันที หรือใช้ `npx tsx server.ts` บน Node 18/20)

## 2. วิธีรันบนเครื่องหรือ VPS (Production)
```bash
# 1. ติดตั้งแพ็กเกจ
npm install

# 2. สร้างไฟล์ .env จากตัวอย่าง แล้วใส่ค่า Bot Token / Chat ID ของคุณ
cp .env.example .env

# 3. Build หน้าเว็บ (dist/)
npm run build

# 4. รันเซิร์ฟเวอร์จริง
NODE_ENV=production npm start
```
> หรือใช้ `pm2` บน VPS เพื่อให้รันค้างตลอด 24 ชม.:
> `NODE_ENV=production pm2 start server.ts --interpreter npx --interpreter-args tsx --name ao-signal`

## 3. ตัวแปรสภาพแวดล้อม (Environment Variables)
| ตัวแปร | คำอธิบาย | จำเป็น |
|---|---|---|
| `PORT` | พอร์ตของเซิร์ฟเวอร์ (ค่าเริ่มต้น `3000`) | ไม่บังคับ |
| `TELEGRAM_BOT_TOKEN` | Bot Token จาก `@BotFather` | แนะนำ (กันค่าหายเวลา deploy ใหม่) |
| `TELEGRAM_CHAT_ID` | ตัวเลข Chat ID ของคุณ | แนะนำ |
| `TELEGRAM_MODE` | `always` (ส่งทุกสัญญาณ) หรือ `fallback` | ค่าเริ่มต้น `always` |
| `VAPID_PUBLIC_KEY` | Web Push Public Key (สร้างอัตโนมัติถ้าเว้นว่าง) | ไม่บังคับ |
| `VAPID_PRIVATE_KEY` | Web Push Private Key (สร้างอัตโนมัติถ้าเว้นว่าง) | ไม่บังคับ |

## 4. วิธีนำขึ้น Render.com / Railway ฟรี (รันหลังบ้าน 24 ชม.)
1. อัปโหลดโฟลเดอร์นี้ขึ้น GitHub (แบบ Private repo)
2. สร้าง Web Service บน **Render.com** (เลือก Blueprint `render.yaml` หรือตั้งค่า Build: `npm install && npm run build`, Start: `NODE_ENV=production npm start`)
3. เพิ่ม `TELEGRAM_BOT_TOKEN` และ `TELEGRAM_CHAT_ID` ในหน้า **Environment Variables**
4. สำหรับ Render Free Tier: ตั้ง **UptimeRobot** (ฟรี) ให้เรียก `https://your-app.onrender.com/api/health` ทุก **5 นาที** เพื่อให้เซิร์ฟเวอร์ตื่นตลอด 24 ชม.
