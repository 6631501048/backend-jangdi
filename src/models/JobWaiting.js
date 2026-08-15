const mongoose = require("mongoose");

/**
 * JOB_WAITING
 * คิวผู้สมัครของแต่ละ Job ก่อนที่ Hirer จะเลือก Worker (FR-BROWSE-04–07, FR-MATCH-03–05)
 */
const jobWaitingSchema = new mongoose.Schema(
  {
    job: { type: mongoose.Schema.Types.ObjectId, ref: "Job", required: true },
    worker: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    // ระยะทางระหว่าง Worker กับ Job ณ ตอนสมัคร (เมตร) — ใช้แสดงใน FR-MATCH-03
    distanceMeters: { type: Number, default: null },
    status: {
      type: String,
      enum: ["waiting", "selected", "not_selected", "withdrawn"],
      default: "waiting",
    },
  },
  { timestamps: true }
);

// Worker หนึ่งคนสมัครงานเดียวกันซ้ำไม่ได้ (รองรับ FR-BROWSE-05: สมัครได้หลายงาน แต่ไม่ซ้ำงานเดิม)
jobWaitingSchema.index({ job: 1, worker: 1 }, { unique: true });

module.exports = mongoose.model("JobWaiting", jobWaitingSchema);
