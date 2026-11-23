const asyncHandler = require("express-async-handler");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { OAuth2Client } = require("google-auth-library");
const { User } = require("../models");
const { isLamduanEmail } = require("../utils/validators");
const { sendEmail, isEmailConfigured } = require("../utils/mailer");
const { validPassword, normalizeEmail, hashResetToken } = require("../utils/passwordRecovery");

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

function signToken(user) {
  return jwt.sign({ id: user._id, av: user.authVersion || 0 }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || "7d",
  });
}

/** ตัด field ที่ไม่ควรส่งกลับไปฝั่ง client ออก (เช่น password) */
function sanitizeUser(user) {
  const obj = user.toObject ? user.toObject() : user;
  delete obj.password;
  delete obj.emailVerificationToken;
  delete obj.emailVerificationExpires;
  delete obj.passwordResetToken;
  delete obj.passwordResetExpires;
  delete obj.passwordResetRequestedAt;
  delete obj.authVersion;
  return obj;
}

const VERIFY_TTL_MS = 24 * 60 * 60 * 1000; // ลิงก์ยืนยันอายุ 24 ชั่วโมง
const RESEND_COOLDOWN_MS = 60 * 1000; // กดขอส่งซ้ำได้ทุก 60 วินาที (กันสแปมอีเมล)

/** สร้าง token ยืนยันอีเมล + ส่งอีเมลจริง (FR-AUTH-04, FR-NOTIF-01) คืน { sent } ว่าส่งออกจริงหรือไม่ */
async function sendVerificationEmail(user) {
  const token = crypto.randomBytes(32).toString("hex");
  user.emailVerificationToken = token;
  user.emailVerificationExpires = new Date(Date.now() + VERIFY_TTL_MS);
  await user.save();

  const verifyUrl = `${process.env.CLIENT_URL || "http://localhost:5173"}/verify-email?token=${token}`;
  const result = await sendEmail({
    to: user.email,
    subject: "ยืนยันอีเมลของคุณ - JangDi",
    html: `<p>คลิกลิงก์นี้เพื่อยืนยันอีเมลของคุณ (ลิงก์หมดอายุใน 24 ชั่วโมง):</p><p><a href="${verifyUrl}">${verifyUrl}</a></p>`,
  });

  // dev ที่ยังไม่ตั้ง SMTP: พิมพ์ลิงก์ลง console เพื่อให้ทดสอบ flow ได้ (ไม่พิมพ์ใน production)
  if (!result.sent && process.env.NODE_ENV !== "production") {
    console.log(`[dev] SMTP ไม่พร้อม — ลิงก์ยืนยันของ ${user.email}: ${verifyUrl}`);
  }
  return result;
}

/**
 * POST /api/auth/register  (FR-AUTH-01, FR-AUTH-02, FR-AUTH-04)
 * ลงทะเบียนด้วยอีเมล Lamduan + รหัสผ่าน แล้วส่งอีเมลยืนยัน (TODO: ต่อ email provider จริง)
 */
const register = asyncHandler(async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const { password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ message: "กรุณากรอก email และ password ให้ครบ" });
  }
  if (!isLamduanEmail(email)) {
    return res.status(400).json({ message: "ต้องใช้อีเมล @lamduan.mfu.ac.th เท่านั้น" });
  }
  if (!validPassword(password)) {
    return res.status(400).json({ message: "รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร และไม่เกิน 72 ไบต์" });
  }

  const existing = await User.findOne({ email: email.toLowerCase() });
  if (existing) {
    return res.status(409).json({ message: "อีเมลนี้ถูกใช้ลงทะเบียนแล้ว" });
  }

  const hashed = await bcrypt.hash(password, 10);
  const user = await User.create({
    studentId: email.split("@")[0], // ล็อกจาก local-part ของอีเมล เสมอ ไม่รับค่าจาก client โดยตรง (กันปลอม ID)
    email: email.toLowerCase(),
    password: hashed,
  });

  const mail = await sendVerificationEmail(user); // FR-AUTH-04, FR-NOTIF-01

  res.status(201).json({
    message: "ลงทะเบียนสำเร็จ กรุณายืนยันอีเมลก่อนใช้งาน",
    emailSent: mail.sent,
    token: signToken(user),
    user: sanitizeUser(user),
  });
});

/** POST /api/auth/login (email/password) */
const login = asyncHandler(async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const { password } = req.body;
  if (!isLamduanEmail(email) || typeof password !== "string" || !password) {
    return res.status(401).json({ message: "อีเมลหรือรหัสผ่านไม่ถูกต้อง" });
  }
  const user = await User.findOne({ email }).select("+password");
  if (!user || !user.password) {
    return res.status(401).json({ message: "อีเมลหรือรหัสผ่านไม่ถูกต้อง" });
  }
  const match = await bcrypt.compare(password, user.password);
  if (!match) {
    return res.status(401).json({ message: "อีเมลหรือรหัสผ่านไม่ถูกต้อง" });
  }
  if (user.accountStatus === "suspended") {
    return res.status(403).json({ code: "ACCOUNT_SUSPENDED", message: "บัญชีนี้ถูกระงับการใช้งาน กรุณาติดต่อผู้ดูแลระบบ" });
  }
  res.json({
    token: signToken(user),
    user: sanitizeUser(user),
  });
});

/**
 * POST /api/auth/google  (FR-AUTH-03)
 * body: { idToken } จาก Google Sign-In ฝั่ง frontend
 */
const googleLogin = asyncHandler(async (req, res) => {
  const { idToken } = req.body;
  if (typeof idToken !== "string" || !idToken) return res.status(400).json({ message: "ไม่พบข้อมูลเข้าสู่ระบบจาก Google" });
  let ticket;
  try {
    ticket = await googleClient.verifyIdToken({ idToken, audience: process.env.GOOGLE_CLIENT_ID });
  } catch {
    return res.status(401).json({ message: "ข้อมูลเข้าสู่ระบบจาก Google ไม่ถูกต้องหรือหมดอายุ กรุณาลองใหม่" });
  }
  const payload = ticket.getPayload();
  const email = normalizeEmail(payload?.email);

  if (payload?.email_verified !== true || !payload.sub || !isLamduanEmail(email)) {
    return res.status(403).json({ message: "ต้องใช้บัญชี Google ของอีเมล @lamduan.mfu.ac.th เท่านั้น" });
  }

  let user = await User.findOne({ email });
  const isNewUser = !user;

  if (!user) {
    user = await User.create({
      email,
      googleId: payload.sub,
      fullName: payload.name,
      avatarUrl: payload.picture,
      isEmailVerified: true, // Google ยืนยันอีเมลให้แล้ว
      studentId: email.split("@")[0],
    });
  }

  if (user.accountStatus === "suspended") {
    return res.status(403).json({ code: "ACCOUNT_SUSPENDED", message: "บัญชีนี้ถูกระงับการใช้งาน กรุณาติดต่อผู้ดูแลระบบ" });
  }

  if (user.googleId && user.googleId !== payload.sub) {
    return res.status(409).json({ message: "บัญชี Google ไม่ตรงกับบัญชีที่เชื่อมไว้ กรุณาติดต่อผู้ดูแลระบบ" });
  }
  if (!user.googleId || !user.isEmailVerified) {
    user.googleId = payload.sub;
    user.isEmailVerified = true;
    await user.save();
  }

  // FR-AUTH-05: ถ้าเป็นผู้ใช้ใหม่/ยังกรอกโปรไฟล์ไม่ครบ ให้ frontend พาไปหน้ากรอกโปรไฟล์ต่อ
  res.json({
    token: signToken(user),
    isNewUser,
    user: sanitizeUser(user),
  });
});

/** GET /api/auth/me */
const getMe = asyncHandler(async (req, res) => {
  res.json(sanitizeUser(req.user));
});

/** PATCH /api/auth/role  — FR-AUTH-06: สลับบทบาท Hirer/Worker */
const switchRole = asyncHandler(async (req, res) => {
  const { role } = req.body;
  if (req.user.isAdmin) {
    return res.status(403).json({ message: "บัญชีผู้ดูแลระบบไม่มีบทบาท Hirer/Worker" });
  }
  if (!["hirer", "worker"].includes(role)) {
    return res.status(400).json({ message: "role ต้องเป็น hirer หรือ worker เท่านั้น" });
  }
  req.user.currentRole = role;
  await req.user.save();
  res.json({ user: sanitizeUser(req.user) });
});

/** PATCH /api/auth/password — FR-PROF-01: เปลี่ยนรหัสผ่าน */
const changePassword = asyncHandler(async (req, res) => {
  const { current, next } = req.body;
  if (typeof current !== "string" || !current) {
    return res.status(400).json({ message: "กรุณากรอกรหัสผ่านปัจจุบันและรหัสผ่านใหม่" });
  }
  if (!validPassword(next)) {
    return res.status(400).json({ message: "รหัสผ่านใหม่ต้องมีอย่างน้อย 8 ตัวอักษร และไม่เกิน 72 ไบต์" });
  }

  const user = await User.findById(req.user._id).select("+password");
  if (!user.password) {
    return res.status(400).json({ message: "บัญชีนี้ล็อกอินด้วย Google ไม่มีรหัสผ่านให้เปลี่ยน" });
  }

  const match = await bcrypt.compare(current, user.password);
  if (!match) {
    return res.status(401).json({ message: "รหัสผ่านปัจจุบันไม่ถูกต้อง" });
  }

  user.password = await bcrypt.hash(next, 10);
  user.authVersion = (user.authVersion || 0) + 1;
  user.passwordResetToken = null;
  user.passwordResetExpires = null;
  await user.save();
  res.json({ message: "เปลี่ยนรหัสผ่านสำเร็จ", token: signToken(user) });
});

/** GET /api/auth/verify-email?token=... — FR-AUTH-04 */
const verifyEmail = asyncHandler(async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).json({ message: "ไม่พบ token ยืนยัน" });

  const user = await User.findOne({
    emailVerificationToken: token,
    emailVerificationExpires: { $gt: new Date() },
  }).select("+emailVerificationToken +emailVerificationExpires");

  if (!user) {
    return res.status(400).json({ message: "ลิงก์ยืนยันไม่ถูกต้องหรือหมดอายุแล้ว" });
  }

  user.isEmailVerified = true;
  user.emailVerificationToken = null;
  user.emailVerificationExpires = null;
  await user.save();

  res.json({ message: "ยืนยันอีเมลสำเร็จ" });
});

/** POST /api/auth/resend-verification — ส่งอีเมลยืนยันซ้ำ (กรณีลิงก์เดิมหมดอายุ) */
const resendVerification = asyncHandler(async (req, res) => {
  // req.user จาก protect ไม่ได้ select emailVerificationExpires (select:false) จึงโหลดใหม่
  const user = await User.findById(req.user._id).select("+emailVerificationExpires");
  if (user.isEmailVerified) {
    return res.status(400).json({ message: "อีเมลนี้ยืนยันแล้ว" });
  }

  // เวลาที่ส่งล่าสุด = เวลาหมดอายุ - TTL (ไม่ต้องเพิ่ม field ใน schema)
  const lastSentAt = user.emailVerificationExpires
    ? user.emailVerificationExpires.getTime() - VERIFY_TTL_MS
    : 0;
  const waitMs = lastSentAt + RESEND_COOLDOWN_MS - Date.now();
  if (waitMs > 0) {
    const retryAfterSeconds = Math.ceil(waitMs / 1000);
    return res.status(429).json({
      message: `ส่งอีเมลไปเมื่อสักครู่ กรุณารออีก ${retryAfterSeconds} วินาที`,
      retryAfterSeconds,
    });
  }

  const mail = await sendVerificationEmail(user);
  res.json({
    message: mail.sent
      ? "ส่งอีเมลยืนยันใหม่แล้ว กรุณาตรวจสอบกล่องจดหมาย (รวมถึงโฟลเดอร์สแปม)"
      : "ระบบส่งอีเมลยังไม่พร้อม กรุณาติดต่อผู้ดูแลระบบ",
    emailSent: mail.sent,
    retryAfterSeconds: RESEND_COOLDOWN_MS / 1000,
  });
});

const RECOVERY_MESSAGE = "หากอีเมลนี้มีบัญชี JangDi ที่ใช้งานได้ ระบบจะส่งลิงก์สำหรับตั้งรหัสผ่าน กรุณาตรวจสอบกล่องจดหมายและสแปม";

/** One flow covers both forgotten passwords and Google-only accounts adding a password. */
const forgotPassword = asyncHandler(async (req, res) => {
  const email = normalizeEmail(req.body.email);
  if (!isLamduanEmail(email)) return res.status(400).json({ message: "ต้องใช้อีเมล @lamduan.mfu.ac.th เท่านั้น" });
  // Fail uniformly for all addresses when SMTP is unavailable. Never return a reset token.
  if (!isEmailConfigured()) return res.status(503).json({ message: "ระบบส่งอีเมลยังไม่พร้อม กรุณาลองใหม่ภายหลัง หรือเข้าสู่ระบบด้วย Google" });
  const origin = process.env.CLIENT_URL || "http://localhost:5173";
  let resetUrl;
  try {
    resetUrl = new URL('/reset-password', origin);
    if (!['http:', 'https:'].includes(resetUrl.protocol)) throw new Error('Invalid CLIENT_URL');
  } catch {
    return res.status(503).json({ message: "ระบบกู้คืนบัญชียังไม่พร้อม กรุณาลองใหม่ภายหลัง" });
  }
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashResetToken(token);
  const now = new Date();
  const user = await User.findOneAndUpdate({
    email, accountStatus: { $ne: 'suspended' },
    $or: [{ passwordResetRequestedAt: null }, { passwordResetRequestedAt: { $lte: new Date(now.getTime() - 60_000) } }],
  }, { $set: { passwordResetToken: tokenHash, passwordResetExpires: new Date(now.getTime() + 30 * 60_000), passwordResetRequestedAt: now } }, { new: true });
  if (user) {
    // The fragment keeps the secret out of HTTP request URLs and referrer headers.
    resetUrl.hash = `token=${token}`;
    const result = await sendEmail({ to: user.email, subject: 'ตั้งรหัสผ่านบัญชี JangDi',
      html: `<p>คุณขอตั้งรหัสผ่านสำหรับบัญชี JangDi</p><p><a href="${resetUrl.href}">ตั้งรหัสผ่านใหม่</a></p><p>ลิงก์ใช้ได้ครั้งเดียวและหมดอายุใน 30 นาที ใช้ได้ทั้งการตั้งรหัสผ่านครั้งแรกและการลืมรหัสผ่าน</p><p>หากไม่ได้เป็นผู้ขอ สามารถข้ามอีเมลนี้ได้ รหัสผ่านเดิมยังใช้งานได้</p>` });
    if (!result.sent) {
      // Don't invalidate a newer request if sending this older email failed.
      await User.updateOne({ _id: user._id, passwordResetToken: tokenHash }, { $set: { passwordResetToken: null, passwordResetExpires: null, passwordResetRequestedAt: null } });
      console.warn('[auth] Password recovery email could not be delivered');
    }
  }
  // Identical response for absent, suspended and throttled accounts and mail failures.
  return res.json({ message: RECOVERY_MESSAGE, retryAfterSeconds: 60 });
});

const resetPassword = asyncHandler(async (req, res) => {
  const { token, password } = req.body;
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) {
    return res.status(400).json({ code: 'RESET_LINK_INVALID', message: 'ลิงก์ไม่ถูกต้อง หมดอายุ หรือถูกใช้งานแล้ว กรุณาขอลิงก์ใหม่' });
  }
  if (!validPassword(password)) return res.status(400).json({ message: 'รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร และไม่เกิน 72 ไบต์' });
  const hashed = await bcrypt.hash(password, 10);
  // Atomic consumption: two requests with the same link cannot both change a password.
  const user = await User.findOneAndUpdate({ passwordResetToken: hashResetToken(token), passwordResetExpires: { $gt: new Date() }, accountStatus: { $ne: 'suspended' } }, {
    $set: { password: hashed, passwordResetToken: null, passwordResetExpires: null, isEmailVerified: true, emailVerificationToken: null, emailVerificationExpires: null },
    $inc: { authVersion: 1 },
  }, { new: true });
  if (!user) return res.status(400).json({ code: 'RESET_LINK_INVALID', message: 'ลิงก์ไม่ถูกต้อง หมดอายุ หรือถูกใช้งานแล้ว กรุณาขอลิงก์ใหม่' });
  return res.json({ message: 'ตั้งรหัสผ่านสำเร็จ กรุณาเข้าสู่ระบบด้วยรหัสผ่านใหม่' });
});

module.exports = { register, login, googleLogin, getMe, switchRole, changePassword, verifyEmail, resendVerification, forgotPassword, resetPassword };
