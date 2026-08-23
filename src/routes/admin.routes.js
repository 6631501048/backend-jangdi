const router = require("express").Router();
const { protect, adminOnly } = require("../middleware/auth.middleware");
const {
  getPendingJobs, approveJob, rejectJob,
  getDashboard, getUsers, updateUserStatus,
  getEscrowPayments, decideRefund,
  getReports, resolveReport,
  getSosList, resolveSos,
} = require("../controllers/admin.controller");

router.use(protect, adminOnly); // NFR-SEC-04: ทุก route ในนี้ต้องเป็น Admin เท่านั้น

router.get("/dashboard", getDashboard); // FR-ADMIN-01
router.get("/jobs/pending", getPendingJobs); // FR-ADMIN-02
router.post("/jobs/:id/approve", approveJob); // FR-JOB-05–06, FR-MATCH-01–02
router.post("/jobs/:id/reject", rejectJob); // FR-ADMIN-02
router.get("/users", getUsers); // FR-ADMIN-03
router.post("/users/:id/suspend", updateUserStatus); // FR-ADMIN-03
router.get("/payments/escrow", getEscrowPayments); // FR-ADMIN-04
router.post("/payments/:id/refund-decision", decideRefund); // FR-ADMIN-05, FR-PAY-07
router.get("/reports", getReports); // FR-ADMIN-06
router.post("/reports/:id/resolve", resolveReport); // FR-ADMIN-06
router.get("/sos", getSosList); // FR-ADMIN-07
router.post("/sos/:id/resolve", resolveSos); // FR-SOS-04

module.exports = router;