const asyncHandler = require("express-async-handler");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const mongoose = require("mongoose");
const { User, Feedback, Job, ServicePost } = require("../models");

/**
 * ตรวจว่า viewer กับ target เป็นคู่งานกันอยู่หรือไม่ (hirer ↔ worker ที่ถูกเลือกของงานเดียวกัน
 * และงานนั้นยังเดินอยู่) — ใช้ตัดสินว่าเปิดเบอร์โทร/LINE ให้เห็นได้ไหม (F11)
 */
const ACTIVE_JOB_STATUSES = ["assigned", "in_progress", "disputed"];
async function isActiveCounterpart(viewerId, targetId) {
  const job = await Job.exists({
    status: { $in: ACTIVE_JOB_STATUSES },
    $or: [
      { hirer: viewerId, selectedWorker: targetId },
      { hirer: targetId, selectedWorker: viewerId },
    ],
  });
  return !!job;
}

/**
 * GET /api/users/:id — FR-PROF-01
 * ข้อมูลที่ส่งกลับขึ้นกับว่าใครเป็นคนขอ (กรองที่ชั้น API — ข้อมูลใน DB ยังครบเหมือนเดิม):
 *  - เจ้าของบัญชี / Admin  : ครบทุก field (ยกเว้น password และ token ที่ select:false อยู่แล้ว)
 *  - คู่งานที่กำลังทำงานร่วมกัน : ข้อมูลสาธารณะ + เบอร์โทร + LINE
 *  - ผู้ใช้อื่นทั่วไป         : ข้อมูลสาธารณะเท่านั้น (ชื่อ รูป คำอธิบาย คะแนน)
 *  ไม่มีใครนอกจากเจ้าของ/Admin ที่เห็น บัญชีธนาคาร ที่อยู่ อีเมล รหัสนักศึกษา พิกัด
 */
const getProfile = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(404).json({ message: "ไม่พบผู้ใช้นี้" });
  }
  const user = await User.findById(req.params.id).select("-password");
  if (!user) return res.status(404).json({ message: "ไม่พบผู้ใช้นี้" });

  const isSelfOrAdmin = String(user._id) === String(req.user._id) || req.user.isAdmin;
  if (isSelfOrAdmin) return res.json(user);

  const publicProfile = {
    _id: user._id,
    fullName: user.fullName,
    avatarUrl: user.avatarUrl,
    shortDescription: user.shortDescription,
    credibilityScore: user.credibilityScore,
    reviewCount: user.reviewCount,
    createdAt: user.createdAt,
  };

  if (await isActiveCounterpart(req.user._id, user._id)) {
    publicProfile.phone = user.phone;
    publicProfile.lineId = user.lineId;
  }

  res.json(publicProfile);
});

/**
 * GET /api/users/:id/posts — FR-PROF-04 ประวัติโพสต์
 * คืน { jobs, servicePosts } ล่าสุดก่อน (สูงสุด 50 รายการต่อชนิด)
 *  - เจ้าของบัญชี / Admin : เห็นทุกสถานะ (รวมรอตรวจสอบ/ถูกปฏิเสธ/ยกเลิก) พร้อมเหตุผลที่ถูกปฏิเสธ และ worker ที่ถูกเลือก
 *  - คนอื่น              : เห็นเฉพาะโพสต์ที่เคยเผยแพร่จริง และไม่เห็นสถานที่/ผู้รับจ้าง
 */
const PUBLIC_JOB_STATUSES = ["waiting", "assigned", "in_progress", "completed"];
const POST_HISTORY_LIMIT = 50;

const getUserPosts = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(404).json({ message: "ไม่พบผู้ใช้นี้" });
  }
  const exists = await User.exists({ _id: req.params.id });
  if (!exists) return res.status(404).json({ message: "ไม่พบผู้ใช้นี้" });

  const isSelfOrAdmin = String(req.params.id) === String(req.user._id) || req.user.isAdmin;

  const jobQuery = { hirer: req.params.id };
  const serviceQuery = { worker: req.params.id };
  if (!isSelfOrAdmin) {
    jobQuery.status = { $in: PUBLIC_JOB_STATUSES };
    serviceQuery.status = { $in: ["active", "closed", "expired"] };
  }

  const jobFields = isSelfOrAdmin
    ? "title category price status scheduledAt locationText rejectionReason cancelReason selectedWorker createdAt"
    : "title category price status scheduledAt createdAt";
  const serviceFields = "title category fee status availabilityStart availabilityEnd createdAt";

  let jobFind = Job.find(jobQuery).select(jobFields).sort({ createdAt: -1 }).limit(POST_HISTORY_LIMIT);
  if (isSelfOrAdmin) jobFind = jobFind.populate("selectedWorker", "fullName avatarUrl");

  const [jobs, servicePosts] = await Promise.all([
    jobFind,
    ServicePost.find(serviceQuery).select(serviceFields).sort({ createdAt: -1 }).limit(POST_HISTORY_LIMIT),
  ]);

  res.json({ jobs, servicePosts });
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

  const { fullName, shortDescription, phone, lineId, facebook, instagram, avatarUrl, bankAccount, contactAddress, lat, lng } = req.body;

  if (fullName !== undefined) user.fullName = fullName;
  if (shortDescription !== undefined) user.shortDescription = shortDescription;
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

module.exports = { getProfile, getUserPosts, updateProfile, getReviews, uploadAvatar };