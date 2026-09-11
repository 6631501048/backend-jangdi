const { Notification, User } = require("../models");
const { sendEmail } = require("../utils/mailer");

/**
 * ประเภทการแจ้งเตือนที่ต้องส่งอีเมลเป็น "ช่องทางหลัก" ตาม FR-NOTIF-01
 * (Objective 1.2.2 ของ proposal ระบุอีเมลเป็นกลไกหลักสำหรับแจ้งงานใหม่ใกล้เคียง)
 */
const EMAIL_PRIMARY_TYPES = ["new_nearby_job"];

/**
 * สร้าง Notification ในฐานข้อมูล + ส่งแบบเรียลไทม์ผ่าน Socket.IO (FR-NOTIF-02, ช่องทางเสริม)
 * + ส่งอีเมลจริงเป็นช่องทางหลักสำหรับ type ที่อยู่ใน EMAIL_PRIMARY_TYPES (FR-NOTIF-01)
 *
 * @param {import("socket.io").Server} io
 * @param {object} params
 * @param {boolean} [params.forceEmail] บังคับส่งอีเมลแม้ type จะไม่อยู่ใน EMAIL_PRIMARY_TYPES (เช่น ใช้กับการยืนยันบัญชี)
 */
async function notifyUser(io, { userId, type, title, message, relatedEntityType, relatedEntityId, forceEmail }) {
  const notif = await Notification.create({
    user: userId,
    type,
    title,
    message,
    relatedEntityType: relatedEntityType || null,
    relatedEntityId: relatedEntityId || null,
  });

  // FR-NOTIF-02: ช่องทางเสริมแบบเรียลไทม์สำหรับผู้ใช้ที่ออนไลน์อยู่
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

  // FR-NOTIF-01: อีเมลเป็นช่องทางหลัก สำหรับแจ้งงานใหม่ใกล้เคียง (ตาม Objective 1.2.2)
  if (forceEmail || EMAIL_PRIMARY_TYPES.includes(type)) {
    const user = await User.findById(userId).select("email");
    if (user?.email) {
      const result = await sendEmail({
        to: user.email,
        subject: title,
        html: `<p>${message}</p>`,
      });
      if (result.sent) {
        notif.sentViaEmail = true;
        await notif.save();
      }
    }
  }

  return notif;
}

module.exports = { notifyUser };