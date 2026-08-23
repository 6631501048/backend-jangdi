const router = require("express").Router();
const { protect, requireRole } = require("../middleware/auth.middleware");
const {
  getServicePosts, getServicePostById, createServicePost, getMyServicePosts, closeServicePost,
  sendServiceRequest, getMyIncomingRequests, respondToServiceRequest,
} = require("../controllers/servicePost.controller");

// literal path ต้องมาก่อน "/:id" เสมอ (บทเรียนจาก job.routes.js)
router.get("/", getServicePosts); // FR-BROWSE-01/02, FR-SERV-04
router.get("/my", protect, requireRole("worker"), getMyServicePosts);
router.post("/", protect, requireRole("worker"), createServicePost); // FR-SERV-01
router.get("/requests/my-as-worker", protect, requireRole("worker"), getMyIncomingRequests);
router.patch("/requests/:id", protect, requireRole("worker"), respondToServiceRequest); // FR-SERV-05/07

router.get("/:id", getServicePostById);
router.post("/:id/close", protect, requireRole("worker"), closeServicePost); // FR-SERV-03
router.post("/:id/requests", protect, requireRole("hirer"), sendServiceRequest); // FR-SERV-04/06

module.exports = router;