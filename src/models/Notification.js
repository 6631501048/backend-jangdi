const mongoose = require("mongoose");

/**
 * NOTIFICATION
 * การแจ้งเตือนในระบบ ทั้งแบบเรียลไทม์และอีเมลสำรอง (FR-NOTIF-01–03)
 */
const notificationSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    type: {
      type: String,
      enum: [
        "new_nearby_job",
        "application_update",
        "job_status_change",
        "job_approved",
        "job_rejected",
        "payment_update",
        "sos_alert",
        "system",
      ],
      required: true,
    },
    title: { type: String, required: true },
    message: { type: String, required: true },

    relatedEntityType: { type: String, default: null }, // เช่น "Job", "Payment"
    relatedEntityId: { type: mongoose.Schema.Types.ObjectId, default: null },

    isRead: { type: Boolean, default: false }, // FR-NOTIF-03
    sentViaEmail: { type: Boolean, default: false }, // FR-NOTIF-02
  },
  { timestamps: true }
);

notificationSchema.index({ user: 1, isRead: 1, createdAt: -1 });

module.exports = mongoose.model("Notification", notificationSchema);
