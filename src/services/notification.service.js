const { Notification, User } = require("../models");
const { sendEmail } = require("../utils/mailer");

const EMAIL_PRIMARY_TYPES = ["new_nearby_job"];

async function createNotification({ userId, type, title, message, relatedEntityType, relatedEntityId }, session) {
  const data = {
    user: userId,
    type,
    title,
    message,
    relatedEntityType: relatedEntityType || null,
    relatedEntityId: relatedEntityId || null,
    deliveryStatus: "pending",
  };
  if (session) {
    const [created] = await Notification.create([data], { session });
    return created;
  }
  return Notification.create(data);
}

async function deliverNotification(io, notification) {
  if (!notification || !io) return false;
  try {
    const room = `user:${notification.user}`;
    const sockets = await io.in(room).fetchSockets();
    if (sockets.length === 0) throw new Error("recipient is offline; delivery remains pending");
    io.to(room).emit("notification", {
      _id: notification._id,
      type: notification.type,
      title: notification.title,
      message: notification.message,
      isRead: notification.isRead,
      createdAt: notification.createdAt,
    });
    await Notification.updateOne(
      { _id: notification._id, deliveryStatus: "pending" },
      { $set: { deliveryStatus: "delivered", deliveredAt: new Date(), lastDeliveryError: null }, $inc: { deliveryAttempts: 1 } }
    );
    return true;
  } catch (err) {
    await Notification.updateOne(
      { _id: notification._id },
      { $set: { deliveryStatus: "pending", lastDeliveryError: String(err.message || err).slice(0, 500) }, $inc: { deliveryAttempts: 1 } }
    ).catch(() => {});
    console.error(`Notification delivery failed (${notification._id}): ${err.message || err}`);
    return false;
  }
}

async function retryPendingNotifications(io, limit = 100) {
  if (!io) return 0;
  const pending = await Notification.find({ deliveryStatus: "pending" }).sort({ createdAt: 1 }).limit(limit).lean();
  let delivered = 0;
  for (const notification of pending) {
    if (await deliverNotification(io, notification)) delivered += 1;
  }
  return delivered;
}

async function notifyUser(io, params) {
  const notification = await createNotification(params);
  await deliverNotification(io, notification);

  if (params.forceEmail || EMAIL_PRIMARY_TYPES.includes(params.type)) {
    try {
      const user = await User.findById(params.userId).select("email");
      if (user?.email) {
        const result = await sendEmail({ to: user.email, subject: params.title, html: `<p>${params.message}</p>` });
        if (result.sent) {
          await Notification.updateOne({ _id: notification._id }, { $set: { sentViaEmail: true } });
        }
      }
    } catch (err) {
      console.error(`Notification email failed (${notification._id}): ${err.message || err}`);
    }
  }
  return notification;
}

module.exports = { createNotification, deliverNotification, notifyUser, retryPendingNotifications };
