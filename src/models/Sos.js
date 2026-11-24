const mongoose = require("mongoose");

const pointSchema = new mongoose.Schema({
  type: { type: String, enum: ["Point"], required: true },
  coordinates: {
    type: [Number], required: true,
    validate: { validator: (a) => Array.isArray(a) && a.length === 2 && a.every(Number.isFinite), message: "พิกัดไม่ถูกต้อง" },
  },
}, { _id: false });

/** SOS can be sent without GPS if the browser blocks/denies geolocation. */
const sosSchema = new mongoose.Schema({
  worker: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  job: { type: mongoose.Schema.Types.ObjectId, ref: "Job", required: true },
  location: { type: pointSchema, default: undefined },
  status: { type: String, enum: ["active", "resolved"], default: "active" },
  triggeredAt: { type: Date, default: Date.now },
  resolvedAt: { type: Date, default: null },
  resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  adminNotes: { type: String, default: null, maxlength: 1000 },
}, { timestamps: true });

sosSchema.index({ location: "2dsphere" });
sosSchema.index({ status: 1, createdAt: -1 });
// Existing databases must resolve historical duplicate active SOS records before index creation.
sosSchema.index({ worker: 1, job: 1, status: 1 }, { unique: true, partialFilterExpression: { status: "active" } });

module.exports = mongoose.model("Sos", sosSchema);
