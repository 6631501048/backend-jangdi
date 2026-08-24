const { Notification } = require("../models");

/**
 * สร้าง Notification ในฐานข้อมูล + ส่งแบบเรียลไทม์ผ่าน Socket.IO (FR-NOTIF-01, FR-NOTIF-03)
 * อีเมลสำรอง (FR-NOTIF-02) ยังเป็น TODO — ต่อ provider จริงตอน implement
 *
 * @param {import("socket.io").Server} io
 * @param {object} params
 */
async function notifyUser(io, { userId, type, title, message, relatedEntityType, relatedEntityId }) {
  const notif = await Notification.create({
    user: userId,
    type,
    title,
    message,
    relatedEntityType: relatedEntityType || null,
    relatedEntityId: relatedEntityId || null,
  });

  if (io) {
    io.to(`user:${userId}`).emit("notification", {
      _id: notif._id,
      type: notif.type,
      title: notif.title,
      message: notif.message,
      isRead: notif.isRead,
      createdAt: notif.createdAt,
    });
  }

  // TODO (FR-NOTIF-02): ถ้าผู้ใช้ไม่ online (ไม่มี socket ใน room) ให้ส่งอีเมลสำรองแทน
  return notif;
}

module.exports = { notifyUser };