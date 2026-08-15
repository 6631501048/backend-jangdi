const mongoose = require("mongoose");

/**
 * REPORT
 * รายงานพฤติกรรมไม่เหมาะสมของผู้ใช้ (FR-ADMIN-06)
 */
const reportSchema = new mongoose.Schema(
  {
    reporter: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    reportedUser: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    job: { type: mongoose.Schema.Types.ObjectId, ref: "Job", default: null },

    reason: { type: String, required: true },
    description: { type: String, default: "" },

    status: {
      type: String,
      enum: ["pending", "investigating", "resolved", "dismissed"],
      default: "pending",
    },
    resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    resolvedAt: { type: Date, default: null },
    resolutionNotes: { type: String, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Report", reportSchema);
