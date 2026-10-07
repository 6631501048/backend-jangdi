const router = require("express").Router();
const { protect } = require("../middleware/auth.middleware");
const { getProfile, getUserPosts, updateProfile, getReviews, uploadAvatar } = require("../controllers/user.controller");

router.post("/me/avatar", protect, ...uploadAvatar); // FR-PROF-01
router.get("/:id", protect, getProfile); // FR-PROF-01
router.patch("/:id", protect, updateProfile); // FR-PROF-01, FR-PROF-02
router.get("/:id/reviews", getReviews); // FR-PROF-03, FR-REV-04
router.get("/:id/posts", protect, getUserPosts); // FR-PROF-04

module.exports = router;