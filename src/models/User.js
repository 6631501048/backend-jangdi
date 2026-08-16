const mongoose = require("mongoose");

/**
 * USER
 * รองรับบทบาทคู่ Hirer/Worker ในบัญชีเดียว (FR-AUTH-06, §2.2)
 * ยืนยันตัวตนด้วยอีเมล Lamduan เท่านั้น (FR-AUTH-01, FR-AUTH-02, NFR-SEC-01)
 */
const addressSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true },
    address: { type: String, trim: true },
    phone: { type: String, trim: true },
  },
  { _id: false }
);

const userSchema = new mongoose.Schema(
  {
    studentId: { type: String, required: true, trim: true },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      // FR-AUTH-01 / FR-AUTH-02: ต้องเป็นอีเมล Lamduan เท่านั้น
      match: [/^[^\s@]+@lamduan\.mfu\.ac\.th$/, "ต้องใช้อีเมล @lamduan.mfu.ac.th เท่านั้น"],
    },
    password: { type: String, select: false }, // ไม่บังคับถ้า login ผ่าน Google OAuth
    googleId: { type: String, default: null },

    isEmailVerified: { type: Boolean, default: false }, // FR-AUTH-04
    isProfileComplete: { type: Boolean, default: false }, // FR-AUTH-05

    // FR-PROF-01
    fullName: { type: String, trim: true },
    avatarUrl: { type: String, default: null },
    phone: { type: String, trim: true },
    lineId: { type: String, trim: true },
    facebook: { type: String, trim: true },
    instagram: { type: String, trim: true },

    // FR-PROF-02
    contactAddress: addressSchema,

    // FR-AUTH-06: บทบาทปัจจุบันที่ใช้งานอยู่ (สลับได้ ไม่ใช่ field ผูกถาวร)
    currentRole: { type: String, enum: ["hirer", "worker"], default: "hirer" },
    isAdmin: { type: Boolean, default: false },
    // บัญชีทดสอบระบบ (dev/QA) — ไม่ผูกกับสิทธิ์ admin, ใช้แยกกลุ่มผู้ใช้ทดสอบออกจากผู้ใช้จริง
    isTester: { type: Boolean, default: false },

    // FR-PROF-03 / FR-REV-03: คะแนนความน่าเชื่อถือ คำนวณจาก Feedback
    credibilityScore: { type: Number, default: 0, min: 0, max: 5 },
    reviewCount: { type: Number, default: 0 },

    // NFR-SEC ตอนแบน/เตือนบัญชี — เกี่ยวกับ FR-ADMIN-03
    accountStatus: {
      type: String,
      enum: ["active", "warned", "suspended"],
      default: "active",
    },

    // ตำแหน่งปัจจุบันโดยประมาณของผู้ใช้ (ใช้คำนวณระยะทางตอน browse/matching)
    // หมายเหตุ: ห้ามใส่ default ให้ "type" ที่นี่ — ถ้าใส่ Mongoose จะสร้าง
    // { type: "Point" } แบบไม่มี coordinates ให้อัตโนมัติทุกครั้งที่สร้าง user ใหม่
    // ทำให้ 2dsphere index พังตอน insert (Can't extract geo keys)
    lastKnownLocation: {
      type: { type: String, enum: ["Point"] },
      coordinates: { type: [Number] }, // [lng, lat]
    },
  },
  { timestamps: true }
);

// sparse: true -> ข้าม index เอกสารที่ยังไม่มี lastKnownLocation เลย (เช่น user ที่เพิ่งสมัคร)
userSchema.index({ lastKnownLocation: "2dsphere" }, { sparse: true });

module.exports = mongoose.model("User", userSchema);