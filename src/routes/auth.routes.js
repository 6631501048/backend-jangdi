const router = require("express").Router();
const {
  register, login, googleLogin, getMe, switchRole, changePassword,
  verifyEmail, resendVerification, forgotPassword, resetPassword,
} = require("../controllers/auth.controller");
const { protect } = require("../middleware/auth.middleware");
const { loginLimiter, loginIpLimiter, registerLimiter, googleLimiter, createRateLimiter } = require("../middleware/rateLimit.middleware");
const recoveryLimiter = createRateLimiter({ windowMs: 15 * 60_000, max: 5, message: 'ขอลิงก์ตั้งรหัสผ่านบ่อยเกินไป' });
const resetLimiter = createRateLimiter({ windowMs: 15 * 60_000, max: 10, message: 'ลองตั้งรหัสผ่านบ่อยเกินไป' });

router.post("/register", registerLimiter, register);       // FR-AUTH-01
router.post("/login", loginIpLimiter, loginLimiter, login);
router.post("/google", googleLimiter, googleLogin);       // FR-AUTH-03
router.post('/forgot-password', recoveryLimiter, forgotPassword);
router.post('/reset-password', resetLimiter, resetPassword);
router.get("/verify-email", verifyEmail);  // FR-AUTH-04
router.post("/resend-verification", protect, resendVerification);
router.get("/me", protect, getMe);
router.patch("/role", protect, switchRole); // FR-AUTH-06
router.patch("/password", protect, changePassword); // FR-PROF-01

module.exports = router;
