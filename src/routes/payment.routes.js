const router = require("express").Router();
const { protect } = require("../middleware/auth.middleware");

router.get("/balance", protect, (req, res) => {
  res.status(501).json({ message: "TODO: ยอดเงินคงเหลือ + ประวัติธุรกรรม (FR-PAY-08)" });
});
router.post("/:jobId/upload-slip", protect, (req, res) => {
  res.status(501).json({ message: "TODO: อัปโหลดสลิปโอนเงินเข้า/ออก Escrow (FR-PAY-04)" });
});

module.exports = router;
