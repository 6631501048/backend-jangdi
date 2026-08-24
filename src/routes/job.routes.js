const router = require("express").Router();
const { protect, requireRole } = require("../middleware/auth.middleware");
const {
  createJob, getMyJobs, getJobById, cancelJob,
  getFeed, applyToJob, getApplicants, selectWorker, getMyWorkerJobs, updateJobStatus, confirmCompletion,
} = require("../controllers/job.controller");
const { submitReview } = require("../controllers/review.controller");

// หมายเหตุ: route แบบ literal path (เช่น /my, /my-as-worker) ต้องมาก่อน /:id เสมอ
router.get("/", getFeed); // FR-BROWSE-01–02
router.get("/my", protect, requireRole("hirer"), getMyJobs); // FR-JOB-08
router.get("/my-as-worker", protect, requireRole("worker"), getMyWorkerJobs); // FR-BROWSE-07, FR-TRACK-01/06
router.post("/", protect, requireRole("hirer"), createJob); // FR-JOB-01–05

router.get("/:id", protect, getJobById); // FR-BROWSE-03
router.post("/:id/apply", protect, requireRole("worker"), applyToJob); // FR-BROWSE-04–06
router.get("/:id/applicants", protect, requireRole("hirer"), getApplicants); // FR-MATCH-03
router.post("/:id/select-worker", protect, requireRole("hirer"), selectWorker); // FR-MATCH-04–06, FR-PAY-01
router.patch("/:id/status", protect, requireRole("worker"), ...updateJobStatus); // FR-TRACK-01/03/05
router.post("/:id/confirm-completion", protect, requireRole("hirer"), confirmCompletion); // FR-TRACK-04, FR-PAY-05
router.post("/:id/cancel", protect, cancelJob); // FR-JOB-07
router.post("/:id/review", protect, submitReview); // FR-REV-01–03

module.exports = router;