const router = require("express").Router();
const { protect, requireRole } = require("../middleware/auth.middleware");
const { createJob, getMyJobs, getJobById, cancelJob } = require("../controllers/job.controller");

router.get("/", (req, res) => {
  res.status(501).json({ message: "TODO: GET feed ของ Job + Service Post ที่อนุมัติแล้ว (FR-BROWSE-01–02)" });
});
router.get("/my", protect, requireRole("hirer"), getMyJobs); // FR-JOB-08
router.post("/", protect, requireRole("hirer"), createJob); // FR-JOB-01–05
router.get("/:id", protect, getJobById); // FR-BROWSE-03
router.post("/:id/apply", protect, requireRole("worker"), (req, res) => {
  res.status(501).json({ message: "TODO: สมัครงาน -> เพิ่มเข้า JOB_WAITING (FR-BROWSE-04–06)" });
});
router.get("/:id/applicants", protect, requireRole("hirer"), (req, res) => {
  res.status(501).json({ message: "TODO: ดูรายชื่อผู้สมัคร (FR-MATCH-03)" });
});
router.post("/:id/select-worker", protect, requireRole("hirer"), (req, res) => {
  res.status(501).json({ message: "TODO: เลือก Worker -> assign งาน -> เข้า Escrow (FR-MATCH-04–06, FR-PAY-01)" });
});
router.patch("/:id/status", protect, requireRole("worker"), (req, res) => {
  res.status(501).json({ message: "TODO: อัปเดตสถานะงาน + เขียน JOB_LOG (FR-TRACK-01, FR-TRACK-05)" });
});
router.post("/:id/complete", protect, requireRole("worker"), (req, res) => {
  res.status(501).json({ message: "TODO: อัปโหลดรูปยืนยันงานเสร็จ (FR-TRACK-03)" });
});
router.post("/:id/confirm-completion", protect, requireRole("hirer"), (req, res) => {
  res.status(501).json({ message: "TODO: Hirer ยืนยันงานเสร็จ -> ปล่อยเงิน Escrow (FR-TRACK-04, FR-PAY-05)" });
});
router.post("/:id/cancel", protect, cancelJob); // FR-JOB-07
router.post("/:id/dispute", protect, (req, res) => {
  res.status(501).json({ message: "TODO: ยื่นข้อพิพาท -> พักเงิน (FR-PAY-06)" });
});
router.post("/:id/review", protect, (req, res) => {
  res.status(501).json({ message: "TODO: ให้คะแนน/รีวิวหลังงานเสร็จ (FR-REV-01–02)" });
});

module.exports = router;