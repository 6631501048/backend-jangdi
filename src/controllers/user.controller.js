const asyncHandler = require("express-async-handler");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { User, Feedback } = require("../models");

/** GET /api/users/:id — FR-PROF-01 */
const getProfile = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id).select("-password");
  if (!user) return res.status(404).json({ message: "ไม่พบผู้ใช้นี้" });
  res.json(user);
});

/**
 * PATCH /api/users/:id — FR-PROF-01, FR-PROF-02
 * เจ้าของบัญชีเท่านั้นที่แก้ไขได้ (หรือ Admin)
 * body: { fullName, phone, lineId, facebook, instagram, avatarUrl, bankAccount,
 *         contactAddress: { name, address, phone },
 *         lat, lng } // FR-PROF-02 + ตำแหน่งสำหรับ matching (FR-MATCH-01)
 */
const updateProfile = asyncHandler(async (req, res) => {
  if (String(req.params.id) !== String(req.user._id) && !req.user.isAdmin) {
    return res.status(403).json({ message: "คุณไม่มีสิทธิ์แก้ไขโปรไฟล์นี้" });
  }

  const user = await User.findById(req.params.id);
  if (!user) return res.status(404).json({ message: "ไม่พบผู้ใช้นี้" });

  const { fullName, phone, lineId, facebook, instagram, avatarUrl, bankAccount, contactAddress, lat, lng } = req.body;

  if (fullName !== undefined) user.fullName = fullName;
  if (phone !== undefined) user.phone = phone;
  if (lineId !== undefined) user.lineId = lineId;
  if (facebook !== undefined) user.facebook = facebook;
  if (instagram !== undefined) user.instagram = instagram;
  if (avatarUrl !== undefined) user.avatarUrl = avatarUrl;
  if (bankAccount !== undefined) user.bankAccount = bankAccount; // FR-PROF-01
  if (contactAddress !== undefined) user.contactAddress = contactAddress; // FR-PROF-02

  // FR-MATCH-01: บันทึกตำแหน่งปัจจุบันเพื่อใช้คำนวณระยะทางตอนแจ้งเตือนงานใกล้เคียง
  if (lat != null && lng != null) {
    user.lastKnownLocation = { type: "Point", coordinates: [Number(lng), Number(lat)] };
  }

  // FR-AUTH-05: กรอกข้อมูลจำเป็น (ชื่อ + เบอร์โทร) ครบแล้วถือว่าโปรไฟล์สมบูรณ์
  if (user.fullName && user.phone) {
    user.isProfileComplete = true;
  }

  await user.save();

  const sanitized = user.toObject();
  delete sanitized.password;
  res.json({ message: "บันทึกโปรไฟล์สำเร็จ", user: sanitized });
});

/**
 * GET /api/users/:id/reviews — FR-PROF-03, FR-REV-04
 * ดูประวัติรีวิวของผู้ใช้ เรียงล่าสุดก่อน
 */
const getReviews = asyncHandler(async (req, res) => {
  const reviews = await Feedback.find({ toUser: req.params.id })
    .populate("fromUser", "fullName avatarUrl")
    .sort({ createdAt: -1 });

  const user = await User.findById(req.params.id).select("credibilityScore reviewCount");
  if (!user) return res.status(404).json({ message: "ไม่พบผู้ใช้นี้" });

  res.json({
    averageRating: user.credibilityScore,
    reviewCount: user.reviewCount,
    reviews,
  });
});

/* ---------- อัปโหลดรูปโปรไฟล์ (FR-PROF-01) ---------- */
const AVATAR_DIR = path.join(__dirname, "..", "..", "uploads", "avatars");
fs.mkdirSync(AVATAR_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, AVATAR_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || ".jpg";
    cb(null, `${req.user._id}-${Date.now()}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith("image/")) {
      return cb(new Error("อัปโหลดได้เฉพาะไฟล์รูปภาพเท่านั้น"));
    }
    cb(null, true);
  },
});

/** POST /api/users/me/avatar — multipart/form-data field name: "avatar" */
const uploadAvatar = [
  upload.single("avatar"),
  asyncHandler(async (req, res) => {
    if (!req.file) return res.status(400).json({ message: "กรุณาแนบไฟล์รูปภาพ" });

    const avatarUrl = `/uploads/avatars/${req.file.filename}`;
    req.user.avatarUrl = avatarUrl;
    await req.user.save();

    res.json({ message: "อัปโหลดรูปโปรไฟล์สำเร็จ", avatarUrl });
  }),
];

module.exports = { getProfile, updateProfile, getReviews, uploadAvatar };