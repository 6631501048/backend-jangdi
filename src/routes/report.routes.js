const router = require("express").Router();
const { protect } = require("../middleware/auth.middleware");
const { createReport } = require("../controllers/report.controller");
const { createRateLimiter } = require("../middleware/rateLimit.middleware");
const reportLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000, max: 5,
  keyFn: (req) => String(req.user._id),
  message: "ส่งรายงานบ่อยเกินไป",
});

router.post("/", protect, reportLimiter, createReport);

module.exports = router;