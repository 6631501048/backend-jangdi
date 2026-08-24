const router = require("express").Router();
const { protect, requireRole } = require("../middleware/auth.middleware");
const { createSos } = require("../controllers/sos.controller");

router.post("/", protect, requireRole("worker"), createSos); // FR-SOS-01–03, NFR-PERF-02

module.exports = router;