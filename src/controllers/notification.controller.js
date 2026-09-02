const asyncHandler = require("express-async-handler");
const { Notification } = require("../models");

/** GET /api/notifications?unreadOnly=true — FR-NOTIF-01/03 */
const getMyNotifications = asyncHandler(async (req, res) => {
  const query = { user: req.user._id };
  if (req.query.unreadOnly === "true") query.isRead = false;

  const notifications = await Notification.find(query).sort({ createdAt: -1 }).limit(50);
  res.json(notifications);
});

/** PATCH /api/notifications/:id/read — FR-NOTIF-03 */
const markAsRead = asyncHandler(async (req, res) => {
  const notif = await Notification.findOneAndUpdate(
    { _id: req.params.id, user: req.user._id },
    { isRead: true },
    { new: true }
  );
  if (!notif) return res.status(404).json({ message: "ไม่พบการแจ้งเตือนนี้" });
  res.json(notif);
});

/** PATCH /api/notifications/read-all — สะดวกสำหรับปุ่ม "อ่านทั้งหมด" */
const markAllAsRead = asyncHandler(async (req, res) => {
  await Notification.updateMany({ user: req.user._id, isRead: false }, { isRead: true });
  res.json({ message: "ทำเครื่องหมายอ่านทั้งหมดแล้ว" });
});

module.exports = { getMyNotifications, markAsRead, markAllAsRead };