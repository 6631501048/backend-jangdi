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

    reason: { type: String, required: true, trim: true, minlength: 5, maxlength: 200 },
    description: { type: String, default: "", maxlength: 2000 },

    status: {
      type: String,
      enum: ["pending", "investigating", "resolved", "dismissed"],
      default: "pending",
    },
    resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    resolvedAt: { type: Date, default: null },
    resolutionNotes: { type: String, default: null, maxlength: 1000 },
  },
  { timestamps: true }
);

reportSchema.index({ reporter: 1, reportedUser: 1, job: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model("Report", reportSchema);
