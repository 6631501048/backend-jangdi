/**
 * Rate limit แบบ in-memory (fixed window) — ไม่ต้องติดตั้ง package เพิ่ม
 * ใช้กัน brute-force รหัสผ่าน / สแปมสมัครบัญชีที่ /auth/login, /auth/register, /auth/google
 *
 * ข้อจำกัด: ตัวนับเก็บในหน่วยความจำของ process เดียว (รีสตาร์ทแล้วรีเซ็ต, รันหลาย instance แล้วไม่แชร์กัน)
 * พอสำหรับ deploy เครื่องเดียวของ senior project ถ้าขยายเป็นหลาย instance ให้เปลี่ยนไปใช้ Redis store
 *
 * หมายเหตุ: ถ้า deploy หลัง reverse proxy (nginx, Render ฯลฯ) ต้องตั้ง TRUST_PROXY ใน .env
 * ไม่งั้น req.ip จะเป็น IP ของ proxy ทำให้ทุกคนใช้โควตาร่วมกัน (ดู app.js)
 */
function createRateLimiter({
  windowMs,
  max,
  message = "ส่งคำขอบ่อยเกินไป กรุณาลองใหม่ภายหลัง",
  keyFn = (req) => req.ip,
  skipSuccessful = false, // true = นับเฉพาะคำขอที่ล้มเหลว (status >= 400) เช่น login ผิด
}) {
  const hits = new Map(); // key -> { count, resetAt }

  // เก็บกวาดรายการที่หมดอายุ ไม่ให้ Map โตไม่จำกัด (unref เพื่อไม่ให้ค้าง process ตอนปิด)
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (entry.resetAt <= now) hits.delete(key);
    }
  }, Math.min(windowMs, 60 * 1000));
  sweeper.unref();

  return function rateLimit(req, res, next) {
    // ปิดชั่วคราวตอนพัฒนา/ทดสอบ: DISABLE_RATE_LIMIT=true ใน .env (ไม่มีผลเมื่อ NODE_ENV=production)
    if (process.env.DISABLE_RATE_LIMIT === "true" && process.env.NODE_ENV !== "production") {
      return next();
    }

    const key = keyFn(req);
    const now = Date.now();

    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }

    if (entry.count >= max) {
      const retryAfterSeconds = Math.ceil((entry.resetAt - now) / 1000);
      res.set("Retry-After", String(retryAfterSeconds));
      return res.status(429).json({
        message: `${message} (ลองใหม่ได้ใน ${Math.ceil(retryAfterSeconds / 60)} นาที)`,
        retryAfterSeconds,
      });
    }

    entry.count += 1;

    if (skipSuccessful) {
      // คืนโควตาถ้าคำขอสำเร็จ — ผู้ใช้ที่ login ถูกต้องไม่โดนนับรวมกับคนที่เดารหัส
      res.on("finish", () => {
        if (res.statusCode < 400 && entry.count > 0) entry.count -= 1;
      });
    }

    next();
  };
}

const MINUTE = 60 * 1000;

/** login: ผิดได้ 10 ครั้ง / 15 นาที ต่อ (IP + อีเมล) — คนละอีเมลไม่กระทบกัน, login สำเร็จไม่นับ */
const loginLimiter = createRateLimiter({
  windowMs: 15 * MINUTE,
  max: 10,
  skipSuccessful: true,
  keyFn: (req) => `${req.ip}|${String(req.body?.email || "").toLowerCase()}`,
  message: "พยายามเข้าสู่ระบบผิดหลายครั้งเกินไป",
});

/** กัน IP เดียวเดารหัสผ่านหลายอีเมลสลับกัน: 50 ครั้งที่ล้มเหลว / 15 นาที ต่อ IP */
const loginIpLimiter = createRateLimiter({
  windowMs: 15 * MINUTE,
  max: 50,
  skipSuccessful: true,
  keyFn: (req) => req.ip,
  message: "มีการพยายามเข้าสู่ระบบผิดจากอุปกรณ์นี้มากเกินไป",
});

/** สมัครบัญชี: 5 ครั้ง / ชั่วโมง ต่อ IP (นับทุกครั้ง เพราะแต่ละครั้งส่งอีเมลยืนยันด้วย) */
const registerLimiter = createRateLimiter({
  windowMs: 60 * MINUTE,
  max: 5,
  message: "สมัครบัญชีบ่อยเกินไป",
});

/** Google login: 30 ครั้ง / 15 นาที ต่อ IP (กัน spam ยิง verifyIdToken) */
const googleLimiter = createRateLimiter({
  windowMs: 15 * MINUTE,
  max: 30,
  message: "ส่งคำขอเข้าสู่ระบบด้วย Google บ่อยเกินไป",
});

module.exports = { createRateLimiter, loginLimiter, loginIpLimiter, registerLimiter, googleLimiter };