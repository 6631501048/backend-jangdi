const router = require("express").Router();
const { protect } = require("../middleware/auth.middleware");
const { createReport } = require("../controllers/report.controller");

router.post("/", protect, createReport);

module.exports = router;