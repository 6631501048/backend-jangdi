const mongoose = require("mongoose");

/**
 * SOS
 * สัญญาณแจ้งเหตุฉุกเฉินระหว่างปฏิบัติงาน (FR-SOS-01–04, NFR-PERF-02)
 */
const sosSchema = new mongoose.Schema(
  {
    worker: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    job: { type: mongoose.Schema.Types.ObjectId, ref: "Job", required: true },

    // FR-SOS-02: ตำแหน่งที่ตั้ง ณ ขณะกด
    location: {
      type: { type: String, enum: ["Point"], default: "Point" },
      coordinates: { type: [Number], required: true },
    },

    status: { type: String, enum: ["active", "resolved"], default: "active" },
    triggeredAt: { type: Date, default: Date.now },

    resolvedAt: { type: Date, default: null },
    resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null }, // Admin
    adminNotes: { type: String, default: null },
  },
  { timestamps: true }
);

sosSchema.index({ location: "2dsphere" });
sosSchema.index({ status: 1 });

module.exports = mongoose.model("Sos", sosSchema);
