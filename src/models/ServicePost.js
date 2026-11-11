const mongoose = require("mongoose");

/**
 * SERVICE_POST
 * ประกาศความพร้อมให้บริการที่ริเริ่มโดย Worker (FR-SERV-01–03)
 */
const servicePostSchema = new mongoose.Schema(
  {
    worker: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    category: { type: String, required: true, trim: true },
    serviceType: { type: String, enum: ["shopping", "pickup_delivery", "passenger", null], default: null },
    title: { type: String, required: true, trim: true },
    locationLabel: { type: String, default: "", trim: true },
    description: { type: String, required: true },
    fee: { type: Number, required: true, min: 0 },

    maxSimultaneousOrders: { type: Number, required: true, min: 1, max: 3 },
    currentOrderCount: { type: Number, default: 0 },

    availabilityStart: { type: Date, required: true },
    availabilityEnd: { type: Date, required: true },

    serviceRadiusMeters: { type: Number, required: true, default: 2000 },
    location: {
      type: { type: String, enum: ["Point"], default: "Point" },
      coordinates: { type: [Number], required: true },
    },

    // FR-SERV-02 / FR-SERV-03 / FR-SERV-06
    status: {
      type: String,
      enum: ["pending_review", "active", "rejected", "closed", "expired"],
      default: "pending_review",
    },
    closeReason: { type: String, enum: ["manual", "capacity", null], default: null },
    closeNote: { type: String, default: "", trim: true, maxlength: 500 },
    rejectionReason: { type: String, default: null },
  },
  { timestamps: true }
);

servicePostSchema.index({ location: "2dsphere" });
servicePostSchema.index({ status: 1, availabilityEnd: 1 });

module.exports = mongoose.model("ServicePost", servicePostSchema);
