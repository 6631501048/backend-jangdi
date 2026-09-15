const mongoose = require("mongoose");

/**
 * JOB
 * ประกาศงานจากฝั่ง Hirer และวงจรชีวิตของงาน (FR-JOB-*, FR-TRACK-*, FR-MATCH-*)
 */
const jobSchema = new mongoose.Schema(
  {
    hirer: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },

    // FR-JOB-01
    category: { type: String, required: true, trim: true },
    title: { type: String, required: true, trim: true },
    description: { type: String, required: true },
    locationText: { type: String, trim: true },
    // FR-BROWSE-03: รายละเอียดเพิ่มเติมสำหรับงานประเภทจัดส่ง/รับ-ส่งของ (แสดงในหน้า Job Detail / Tracking)
    fromText: { type: String, trim: true, default: "" },
    toText: { type: String, trim: true, default: "" },
    deliveryFee: { type: Number, default: 0, min: 0 },
    notes: { type: String, trim: true, default: "" },
    location: {
      type: { type: String, enum: ["Point"], default: "Point" },
      coordinates: { type: [Number], required: true }, // [lng, lat]
    },
    price: { type: Number, required: true, min: 0 },
    scheduledAt: { type: Date, required: true },

    // FR-JOB-02: ช่วงเวลาที่ใช้ในการทำงาน แยกจากเวลานัดหมาย — ไม่บังคับกรอก (null ได้ถ้าไม่ระบุ)
    durationStart: { type: Date, default: null },
    durationEnd: { type: Date, default: null },

    // FR-JOB-03–06: ผลการกรองเนื้อหาอัตโนมัติ + การอนุมัติของ Admin
    contentFilterPassed: { type: Boolean, default: null },
    rejectionReason: { type: String, default: null },
    approvedAt: { type: Date, default: null },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },

    // สถานะหลักของงาน ครอบคลุมทั้งวงจรตาม FR-JOB-08 / FR-TRACK-01
    status: {
      type: String,
      enum: [
        "pending_filter", // รอผ่านตัวกรองอัตโนมัติ
        "pending_review", // รอ Admin อนุมัติ
        "rejected", // ไม่ผ่านตัวกรอง/Admin ปฏิเสธ
        "waiting", // ประกาศแล้ว รอผู้สมัคร/ยังไม่เลือก Worker (JOB_WAITING)
        "assigned", // เลือก Worker แล้ว รอเริ่มงาน
        "in_progress", // Worker กำลังทำงาน (on_the_way / arrived ฯลฯ เก็บใน subStatus)
        "completed", // Hirer ยืนยันงานเสร็จแล้ว
        "cancelled",
        "disputed",
      ],
      default: "pending_filter",
    },
    subStatus: {
      type: String,
      enum: ["on_the_way", "arrived", "working", null],
      default: null,
    },

    selectedWorker: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },

    // FR-TRACK-03: หลักฐานรูปภาพเมื่องานเสร็จ
    completionProofUrl: { type: String, default: null },

    // เชื่อมโยงถ้างานนี้ถูกแปลงมาจาก Service Request (FR-SERV-07)
    originServiceRequest: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ServiceRequest",
      default: null,
    },

    cancelledAt: { type: Date, default: null },
    cancelReason: { type: String, default: null },
  },
  { timestamps: true }
);

jobSchema.index({ location: "2dsphere" });
jobSchema.index({ status: 1, category: 1 });

module.exports = mongoose.model("Job", jobSchema);