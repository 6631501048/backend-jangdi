const mongoose = require("mongoose");

/**
 * FEEDBACK
 * รีวิว/ให้คะแนนหลังงานเสร็จ ทั้งสองทิศทาง (FR-REV-01–04)
 */
const feedbackSchema = new mongoose.Schema(
  {
    job: { type: mongoose.Schema.Types.ObjectId, ref: "Job", required: true },
    fromUser: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    toUser: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    direction: {
      type: String,
      enum: ["hirer_to_worker", "worker_to_hirer"],
      required: true,
    },
    rating: { type: Number, required: true, min: 1, max: 5 },
    tags: { type: [String], default: [] },
    comment: { type: String, default: "", trim: true },
  },
  { timestamps: true }
);

// ให้รีวิวต่องานได้ครั้งเดียวต่อทิศทาง
feedbackSchema.index({ job: 1, direction: 1 }, { unique: true });

module.exports = mongoose.model("Feedback", feedbackSchema);