const mongoose = require("mongoose");

/**
 * JOB_LOG
 * บันทึกการเปลี่ยนสถานะงานแบบไม่สามารถแก้ไขได้ ใช้สืบข้อพิพาท (FR-TRACK-05, NFR-REL-02)
 * แนวทาง: insert-only — ห้าม update/delete record ที่มีอยู่แล้วในระดับ application logic
 */
const jobLogSchema = new mongoose.Schema(
  {
    job: { type: mongoose.Schema.Types.ObjectId, ref: "Job", required: true },
    previousStatus: { type: String, default: null },
    newStatus: { type: String, required: true },
    changedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    note: { type: String, default: null },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  }
);

jobLogSchema.index({ job: 1, createdAt: 1 });

module.exports = mongoose.model("JobLog", jobLogSchema);
