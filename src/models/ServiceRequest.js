const mongoose = require("mongoose");

/**
 * SERVICE_REQUEST
 * คำขอของ Hirer ต่อ Service Post หนึ่งรายการ (FR-SERV-04–07)
 */
const serviceRequestSchema = new mongoose.Schema(
  {
    servicePost: { type: mongoose.Schema.Types.ObjectId, ref: "ServicePost", required: true },
    hirer: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    orderDetails: { type: String, required: true },

    // FR-SERV-05 / FR-SERV-07: pending -> accepted (แปลงเป็น Job) / declined
    status: {
      type: String,
      enum: ["pending", "accepted", "declined"],
      default: "pending",
    },
    respondedAt: { type: Date, default: null },

    // เมื่อ accepted แล้วจะสร้าง Job และเก็บ reference ไว้ที่นี่ด้วย
    resultingJob: { type: mongoose.Schema.Types.ObjectId, ref: "Job", default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model("ServiceRequest", serviceRequestSchema);
