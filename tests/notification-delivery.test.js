"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

const records = [];
const Notification = {
  create: async (input) => {
    const row = { ...(Array.isArray(input) ? input[0] : input), _id: `n${records.length + 1}`, createdAt: new Date(), isRead: false };
    records.push(row);
    return row;
  },
  updateOne: async (query, update) => {
    const row = records.find((item) => String(item._id) === String(query._id));
    if (!row) return { matchedCount: 0 };
    Object.assign(row, update.$set || {});
    for (const [key, amount] of Object.entries(update.$inc || {})) row[key] = (row[key] || 0) + amount;
    return { matchedCount: 1 };
  },
  find: (query) => ({
    sort() { return this; },
    limit() { return this; },
    lean: async () => records.filter((row) => row.deliveryStatus === query.deliveryStatus),
  }),
};
const modelsPath = require.resolve("../src/models");
require.cache[modelsPath] = { id: modelsPath, filename: modelsPath, loaded: true, exports: { Notification, User: {} } };
const { createNotification, deliverNotification, retryPendingNotifications } = require("../src/services/notification.service");
test.beforeEach(() => records.splice(0, records.length));

test("offline recipients keep notification pending until they reconnect", async () => {
  const notification = await createNotification({ userId: "worker-offline", type: "job_status_change", title: "Done", message: "Job completed" });
  let emitted = false;
  const io = {
    in: () => ({ fetchSockets: async () => [] }),
    to: () => ({ emit: () => { emitted = true; } }),
  };
  assert.equal(await deliverNotification(io, notification), false);
  assert.equal(notification.deliveryStatus, "pending");
  assert.match(notification.lastDeliveryError, /offline/);
  assert.equal(emitted, false);
});

test("failed realtime notification stays pending and is retried without recreating it", async () => {
  const notification = await createNotification({ userId: "worker-1", type: "job_status_change", title: "Done", message: "Job completed" });
  let shouldFail = true;
  let emits = 0;
  const io = {
    in: () => ({ fetchSockets: async () => [{}] }),
    to: () => ({ emit: () => { emits += 1; if (shouldFail) throw new Error("socket unavailable"); } }),
  };

  assert.equal(await deliverNotification(io, notification), false);
  assert.equal(notification.deliveryStatus, "pending");
  assert.equal(notification.deliveryAttempts, 1);
  assert.match(notification.lastDeliveryError, /socket unavailable/);
  assert.equal(records.length, 1);

  shouldFail = false;
  assert.equal(await retryPendingNotifications(io), 1);
  assert.equal(notification.deliveryStatus, "delivered");
  assert.equal(notification.deliveryAttempts, 2);
  assert.equal(records.length, 1);
  assert.equal(emits, 2);
});
