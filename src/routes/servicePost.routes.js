const router = require("express").Router();
const { protect, requireRole } = require("../middleware/auth.middleware");

router.post("/", protect, requireRole("worker"), (req, res) => {
  res.status(501).json({ message: "TODO: สร้าง Service Post (FR-SERV-01)" });
});
router.post("/:id/close", protect, requireRole("worker"), (req, res) => {
  res.status(501).json({ message: "TODO: ปิด Service Post ด้วยตนเอง (FR-SERV-03)" });
});
router.post("/:id/requests", protect, requireRole("hirer"), (req, res) => {
  res.status(501).json({ message: "TODO: ส่ง Service Request (FR-SERV-04)" });
});
router.patch("/requests/:id", protect, requireRole("worker"), (req, res) => {
  res.status(501).json({ message: "TODO: accept/decline Service Request -> แปลงเป็น Job (FR-SERV-05, FR-SERV-07)" });
});

module.exports = router;
