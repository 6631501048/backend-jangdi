const router = require("express").Router();
const { protect, requireRole } = require("../middleware/auth.middleware");
const { getWallet, getSummary, getTransactions, getMockPayment, confirmMockPayment, uploadSlip, raiseDispute } = require("../controllers/payment.controller");

const {getOverview} = require('../controllers/finance.controller');
const {createCheckout} = require('../controllers/stripe.controller');
const {requestRefund,getEvidence} = require('../controllers/refund.controller');
router.get('/overview', protect, getOverview);
router.post('/:jobId/checkout', protect, requireRole('hirer'), createCheckout);
router.post('/:jobId/refund-request', protect, requireRole('hirer'), ...requestRefund);
router.get('/:id/refund-evidence/:index', protect, getEvidence);
router.get("/wallet", protect, getWallet); // FR-PAY-08
router.get("/summary", protect, getSummary); // FR-PAY-08
router.get("/transactions", protect, getTransactions); // FR-PAY-08
router.get("/balance", protect, getWallet); // alias เดิม เผื่อมีที่อื่นเรียกอยู่
router.get("/:jobId/mock", protect, getMockPayment); // Demo payment status for job participants
router.post("/:jobId/mock-confirm", protect, requireRole("hirer"), confirmMockPayment);
router.post("/:jobId/upload-slip", protect, ...uploadSlip); // FR-PAY-04
router.post("/:jobId/dispute", protect, requireRole('hirer'), ...requestRefund); // Legacy alias, same authorization and transaction guards

module.exports = router;
