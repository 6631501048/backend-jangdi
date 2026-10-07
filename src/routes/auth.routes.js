const router = require("express").Router();
const {
  register, login, googleLogin, getMe, switchRole, changePassword,
  verifyEmail, resendVerification,
} = require("../controllers/auth.controller");
const { protect } = require("../middleware/auth.middleware");
const { loginLimiter, loginIpLimiter, registerLimiter, googleLimiter } = require("../middleware/rateLimit.middleware");

router.post("/register", registerLimiter, register);       // FR-AUTH-01
router.post("/login", loginIpLimiter, loginLimiter, login);
router.post("/google", googleLimiter, googleLogin);       // FR-AUTH-03
router.get("/verify-email", verifyEmail);  // FR-AUTH-04
router.post("/resend-verification", protect, resendVerification);
router.get("/me", protect, getMe);
router.patch("/role", protect, switchRole); // FR-AUTH-06
router.patch("/password", protect, changePassword); // FR-PROF-01

module.exports = router;