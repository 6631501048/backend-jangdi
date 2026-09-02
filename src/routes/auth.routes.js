const router = require("express").Router();
const { register, login, googleLogin, getMe, switchRole, changePassword } = require("../controllers/auth.controller");
const { protect } = require("../middleware/auth.middleware");

router.post("/register", register);       // FR-AUTH-01
router.post("/login", login);
router.post("/google", googleLogin);       // FR-AUTH-03
router.get("/me", protect, getMe);
router.patch("/role", protect, switchRole); // FR-AUTH-06
router.patch("/password", protect, changePassword); // FR-PROF-01

module.exports = router;