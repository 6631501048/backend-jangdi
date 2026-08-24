const router = require("express").Router();
const { protect } = require("../middleware/auth.middleware");
const { getMyNotifications, markAsRead, markAllAsRead } = require("../controllers/notification.controller");

router.get("/", protect, getMyNotifications); // FR-NOTIF-01/03
router.patch("/read-all", protect, markAllAsRead);
router.patch("/:id/read", protect, markAsRead); // FR-NOTIF-03

module.exports = router;