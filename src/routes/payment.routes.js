const router = require("express").Router();
const { protect, requireRole } = require("../middleware/auth.middleware");
const { getWallet, getSummary, getTransactions, getMockPayment, confirmMockPayment, uploadSlip, raiseDispute } = require("../controllers/payment.controller");

router.get("/wallet", protect, getWallet); // FR-PAY-08
router.get("/summary", protect, getSummary); // FR-PAY-08
router.get("/transactions", protect, getTransactions); // FR-PAY-08
router.get("/balance", protect, getWallet); // alias เดิม เผื่อมีที่อื่นเรียกอยู่
router.get("/:jobId/mock", protect, getMockPayment); // Demo payment status for job participants
router.post("/:jobId/mock-confirm", protect, requireRole("hirer"), confirmMockPayment);
router.post("/:jobId/upload-slip", protect, ...uploadSlip); // FR-PAY-04
router.post("/:jobId/dispute", protect, raiseDispute); // FR-PAY-06

module.exports = router;