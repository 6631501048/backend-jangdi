const router = require("express").Router();
const { protect, adminOnly } = require("../middleware/auth.middleware");

router.use(protect, adminOnly); // NFR-SEC-04: ทุก route ในนี้ต้องเป็น Admin เท่านั้น

router.get("/dashboard", (req, res) => {
  res.status(501).json({ message: "TODO: สรุปข้อมูลแดชบอร์ด (FR-ADMIN-01)" });
});
router.get("/jobs/pending", (req, res) => {
  res.status(501).json({ message: "TODO: คิวประกาศงานรออนุมัติ (FR-ADMIN-02)" });
});
router.post("/jobs/:id/approve", (req, res) => {
  res.status(501).json({ message: "TODO: อนุมัติงาน -> แจ้งเตือน Worker ในรัศมี 2km ภายใน 1 นาที (FR-JOB-05–06, FR-MATCH-01–02)" });
});
router.post("/jobs/:id/reject", (req, res) => {
  res.status(501).json({ message: "TODO: ปฏิเสธงาน พร้อมเหตุผล (FR-ADMIN-02)" });
});
router.get("/users", (req, res) => {
  res.status(501).json({ message: "TODO: รายชื่อผู้ใช้ + กรองตามบทบาท (FR-ADMIN-03)" });
});
router.post("/users/:id/suspend", (req, res) => {
  res.status(501).json({ message: "TODO: ระงับ/เตือน/เคลียร์บัญชี (FR-ADMIN-03)" });
});
router.get("/payments/escrow", (req, res) => {
  res.status(501).json({ message: "TODO: ตรวจสอบเงิน Escrow ที่รอปล่อย (FR-ADMIN-04)" });
});
router.post("/payments/:id/refund-decision", (req, res) => {
  res.status(501).json({ message: "TODO: อนุมัติ/ปฏิเสธคำขอคืนเงิน (FR-ADMIN-05, FR-PAY-07)" });
});
router.get("/reports", (req, res) => {
  res.status(501).json({ message: "TODO: รายการรายงานพฤติกรรมไม่เหมาะสม (FR-ADMIN-06)" });
});
router.get("/sos", (req, res) => {
  res.status(501).json({ message: "TODO: สัญญาณ SOS ทั้งหมด (FR-ADMIN-07)" });
});
router.post("/sos/:id/resolve", (req, res) => {
  res.status(501).json({ message: "TODO: ปิดเคส SOS (FR-SOS-04)" });
});

module.exports = router;
