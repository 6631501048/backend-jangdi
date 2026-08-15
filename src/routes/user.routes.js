const router = require("express").Router();
const { protect } = require("../middleware/auth.middleware");
// TODO: ย้าย logic ไปไว้ที่ user.controller.js เมื่อเริ่ม implement จริง

router.get("/:id", protect, (req, res) => {
  res.status(501).json({ message: "TODO: GET user profile (FR-PROF-01)" });
});
router.patch("/:id", protect, (req, res) => {
  res.status(501).json({ message: "TODO: PATCH user profile (FR-PROF-01, FR-PROF-02)" });
});
router.get("/:id/reviews", (req, res) => {
  res.status(501).json({ message: "TODO: GET review history (FR-REV-04)" });
});
router.get("/:id/posts", protect, (req, res) => {
  res.status(501).json({ message: "TODO: GET job/service post history (FR-PROF-04)" });
});

module.exports = router;
