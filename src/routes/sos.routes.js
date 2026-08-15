const router = require("express").Router();
const { protect, requireRole } = require("../middleware/auth.middleware");

router.post("/", protect, requireRole("worker"), (req, res) => {
  res.status(501).json({ message: "TODO: กด SOS -> บันทึกตำแหน่ง+งาน -> แจ้ง Admin ภายใน 1 นาที (FR-SOS-01–03, NFR-PERF-02)" });
});

module.exports = router;
