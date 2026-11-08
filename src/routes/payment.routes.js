const router = require("express").Router();
const { protect, requireRole } = require("../middleware/auth.middleware");
const { getWallet, getSummary, getTransactions, getMockPayment, confirmMockPayment, uploadSlip, raiseDispute } = require("../controllers/payment.controller");

const {getOverview} = require('../controllers/finance.controller');
const {createCheckout,getStripeStatus,syncPayment} = require('../controllers/stripe.controller');
const {requestRefund,getEvidence} = require('../controllers/refund.controller');
const slips = require('../controllers/slipPayment.controller');
router.get('/config', protect, slips.getConfig);
router.get('/stripe/status', protect, getStripeStatus);
router.post('/:jobId/slips/inbound', protect, requireRole('hirer'), ...slips.submitInbound);
router.get('/:id/slips/:direction', protect, slips.getSlip);
router.get('/overview', protect, getOverview);
router.post('/:jobId/checkout', protect, requireRole('hirer'), createCheckout);
router.post('/:jobId/stripe/sync', protect, requireRole('hirer'), syncPayment);
router.post('/:jobId/stripe/slip', protect, requireRole('hirer'), ...slips.submitStripeEvidence);
router.post('/:jobId/refund-request', protect, requireRole('hirer'), ...requestRefund);
router.get('/:id/refund-evidence/:index', protect, getEvidence);
router.get("/wallet", protect, getWallet); // FR-PAY-08
router.get("/summary", protect, getSummary); // FR-PAY-08
router.get("/transactions", protect, getTransactions); // FR-PAY-08
router.get("/balance", protect, getWallet); // alias เดิม เผื่อมีที่อื่นเรียกอยู่
router.get("/:jobId/mock", protect, getMockPayment); // Demo payment status for job participants
router.post("/:jobId/mock-confirm", protect, requireRole("hirer"), confirmMockPayment);
router.post('/:jobId/upload-slip', protect, requireRole('hirer'), ...slips.submitInbound); // FR-PAY-04
router.post("/:jobId/dispute", protect, requireRole('hirer'), ...requestRefund); // Legacy alias, same authorization and transaction guards

module.exports = router;
