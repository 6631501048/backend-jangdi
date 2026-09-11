const asyncHandler = require("express-async-handler");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { OAuth2Client } = require("google-auth-library");
const { User } = require("../models");
const { isLamduanEmail } = require("../utils/validators");
const { sendEmail } = require("../utils/mailer");

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

function signToken(userId) {
  return jwt.sign({ id: userId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || "7d",
  });
}

/** ตัด field ที่ไม่ควรส่งกลับไปฝั่ง client ออก (เช่น password) */
function sanitizeUser(user) {
  const obj = user.toObject ? user.toObject() : user;
  delete obj.password;
  delete obj.emailVerificationToken;
  delete obj.emailVerificationExpires;
  return obj;
}

/** สร้าง token ยืนยันอีเมล + ส่งอีเมลจริง (FR-AUTH-04, FR-NOTIF-01) */
async function sendVerificationEmail(user) {
  const token = crypto.randomBytes(32).toString("hex");
  user.emailVerificationToken = token;
  user.emailVerificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 ชั่วโมง
  await user.save();

  const verifyUrl = `${process.env.CLIENT_URL || "http://localhost:5173"}/verify-email?token=${token}`;
  await sendEmail({
    to: user.email,
    subject: "ยืนยันอีเมลของคุณ - JangDi",
    html: `<p>คลิกลิงก์นี้เพื่อยืนยันอีเมลของคุณ (ลิงก์หมดอายุใน 24 ชั่วโมง):</p><p><a href="${verifyUrl}">${verifyUrl}</a></p>`,
  });
}

/**
 * POST /api/auth/register  (FR-AUTH-01, FR-AUTH-02, FR-AUTH-04)
 * ลงทะเบียนด้วยอีเมล Lamduan + รหัสผ่าน แล้วส่งอีเมลยืนยัน (TODO: ต่อ email provider จริง)
 */
const register = asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ message: "กรุณากรอก email และ password ให้ครบ" });
  }
  if (!isLamduanEmail(email)) {
    return res.status(400).json({ message: "ต้องใช้อีเมล @lamduan.mfu.ac.th เท่านั้น" });
  }
  if (password.length < 8) {
    return res.status(400).json({ message: "รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร" });
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

  await sendVerificationEmail(user); // FR-AUTH-04, FR-NOTIF-01

  res.status(201).json({
    message: "ลงทะเบียนสำเร็จ กรุณายืนยันอีเมลก่อนใช้งาน",
    token: signToken(user._id),
    user: sanitizeUser(user),
  });
});

/** POST /api/auth/login (email/password) */
const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  const user = await User.findOne({ email: email?.toLowerCase() }).select("+password");
  if (!user || !user.password) {
    return res.status(401).json({ message: "อีเมลหรือรหัสผ่านไม่ถูกต้อง" });
  }
  const match = await bcrypt.compare(password, user.password);
  if (!match) {
    return res.status(401).json({ message: "อีเมลหรือรหัสผ่านไม่ถูกต้อง" });
  }
  res.json({
    token: signToken(user._id),
    user: sanitizeUser(user),
  });
});

/**
 * POST /api/auth/google  (FR-AUTH-03)
 * body: { idToken } จาก Google Sign-In ฝั่ง frontend
 */
const googleLogin = asyncHandler(async (req, res) => {
  const { idToken } = req.body;
  const ticket = await googleClient.verifyIdToken({
    idToken,
    audience: process.env.GOOGLE_CLIENT_ID,
  });
  const payload = ticket.getPayload();

  if (!isLamduanEmail(payload.email)) {
    return res.status(403).json({ message: "ต้องใช้บัญชี Google ของอีเมล @lamduan.mfu.ac.th เท่านั้น" });
  }

  let user = await User.findOne({ email: payload.email.toLowerCase() });
  const isNewUser = !user;

  if (!user) {
    user = await User.create({
      email: payload.email.toLowerCase(),
      googleId: payload.sub,
      fullName: payload.name,
      avatarUrl: payload.picture,
      isEmailVerified: true, // Google ยืนยันอีเมลให้แล้ว
      studentId: payload.email.split("@")[0],
    });
  } else if (!user.googleId) {
    user.googleId = payload.sub;
    await user.save();
  }

  // FR-AUTH-05: ถ้าเป็นผู้ใช้ใหม่/ยังกรอกโปรไฟล์ไม่ครบ ให้ frontend พาไปหน้ากรอกโปรไฟล์ต่อ
  res.json({
    token: signToken(user._id),
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
  if (!current || !next) {
    return res.status(400).json({ message: "กรุณากรอกรหัสผ่านปัจจุบันและรหัสผ่านใหม่" });
  }
  if (next.length < 8) {
    return res.status(400).json({ message: "รหัสผ่านใหม่ต้องมีอย่างน้อย 8 ตัวอักษร" });
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
  await user.save();
  res.json({ message: "เปลี่ยนรหัสผ่านสำเร็จ" });
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
  if (req.user.isEmailVerified) {
    return res.status(400).json({ message: "อีเมลนี้ยืนยันแล้ว" });
  }
  await sendVerificationEmail(req.user);
  res.json({ message: "ส่งอีเมลยืนยันใหม่แล้ว กรุณาตรวจสอบกล่องจดหมาย" });
});

module.exports = { register, login, googleLogin, getMe, switchRole, changePassword, verifyEmail, resendVerification };