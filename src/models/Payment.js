const mongoose = require("mongoose");

/**
 * PAYMENT
 * state machine ของ Escrow: pending -> held -> released (หรือ refunded) (FR-PAY-01–08)
 */
const paymentSchema = new mongoose.Schema(
  {
    job: { type: mongoose.Schema.Types.ObjectId, ref: "Job", required: true, unique: true },
    hirer: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    worker: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },

    amount: { type: Number, required: true, min: 0 }, // มูลค่างานเต็ม
    platformFeePercent: { type: Number, required: true, min: 5, max: 10 }, // FR-PAY-03
    platformFeeAmount: { type: Number, required: true },
    netAmountToWorker: { type: Number, required: true },

    // FR-PAY-02: Pending -> Held -> Released, ทางเลือก Refunded, และ disputed ระหว่างทาง
    status: {
      type: String,
      enum: ["pending", "held", "released", "refunded", "disputed"],
      default: "pending",
    },

    // FR-PAY-04: หลักฐานสลิปทั้งขาเข้า (Hirer -> Escrow) และขาออก (Escrow -> Worker / คืนเงิน)
    inboundSlipUrl: { type: String, default: null },
    outboundSlipUrl: { type: String, default: null },

    heldAt: { type: Date, default: null },
    releasedAt: { type: Date, default: null },

    // FR-PAY-06
    disputeRaisedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    disputeReason: { type: String, default: null },

    // FR-PAY-07
    refundRequestedAt: { type: Date, default: null },
    refundDecision: { type: String, enum: ["approved", "rejected", null], default: null },
    refundDecidedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Payment", paymentSchema);
