"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

const store = { job: null, applicants: [], payment: null, logs: [], failPayment: false, notifications: [] };
const objectCopy = (o) => structuredClone(o);
const models = {
  Job: {
    findById: async (id) => id === store.job._id ? { ...store.job } : null,
    findOneAndUpdate: async (filter, update) => {
      if (String(filter._id) !== String(store.job._id) || filter.status !== store.job.status ||
          String(filter.hirer) !== String(store.job.hirer)) return null;
      Object.assign(store.job, update.$set);
      return { ...store.job };
    },
  },
  JobWaiting: {
    findOne: async (q) => store.applicants.find((a) => a.job === q.job && a.worker === q.worker && a.status === q.status) || null,
    updateOne: async (q, update) => {
      const item = store.applicants.find((a) => a.job === q.job && a.worker === q.worker && a.status === q.status);
      if (!item) return { matchedCount: 0 };
      Object.assign(item, update.$set);
      return { matchedCount: 1 };
    },
    updateMany: async (q, update) => {
      for(const a of store.applicants) if (a.job === q.job && a.worker !== q.worker.$ne && a.status === q.status) Object.assign(a, update.$set);
    },
  },
  Payment: {
    create: async (records) => {
      if (store.failPayment) throw new Error("Simulated Payment write failure");
      store.payment = { ...records[0] };
      return [store.payment];
    },
  },
};
const stub = (path, value) => {
  const id = require.resolve(path);
  require.cache[id] = { id, filename: id, loaded: true, exports: value };
};
stub("../src/models", models);
stub("../src/services/jobLog.service", { logJobStatusChange: async (record) => store.logs.push(record) });
stub("../src/services/notification.service", { notifyUser: async (_, item) => store.notifications.push(item) });
stub("../src/services/transaction.service", {
  withTransaction: async (cb) => {
    const before = objectCopy(store);
    try { return await cb({ mocked: true }); }
    catch (error) { Object.assign(store, before); throw error; }
  },
});
const controller = require("../src/controllers/job.controller");
function seed() {
  store.job = { _id: "j1", status: "waiting", title: "Print notes", hirer: "hirer1", price: 100, deliveryFee: 20 };
  store.applicants = [{ job: "j1", worker: "worker1", status: "waiting" }, { job: "j1", worker: "worker2", status: "waiting" }];
  store.payment = null;
  store.logs = [];
  store.notifications = [];
  store.failPayment = false;
}
const req = () => ({ params: { id: "j1" }, body: { workerId: "worker1" }, user: { _id: "hirer1" }, app: { get: () => null } });
const response = () => ({ code: 200, body: null, status(n) { this.code = n; return this; }, json(item) { this.body = item; return this; } });
async function call(handler, request) { const res = response(); let error; await handler(request, res, e => { error = e; }); if(error) throw error; return res; }
test("selecting a Worker creates pending Demo payment and preserves applicant states", async () => {
  seed();
  const out = await call(controller.selectWorker, req());
  assert.equal(out.code, 200);
  assert.equal(store.job.status, "assigned");
  assert.equal(store.payment.status, "pending");
  assert.equal(store.payment.paymentMode, "demo");
  assert.equal(store.payment.amount, 120);
  assert.equal(store.payment.platformFeeAmount, 5);
  assert.equal(store.payment.netAmountToWorker, 120);
  assert.equal(store.applicants.find(a => a.worker === "worker1").status, "selected");
  assert.equal(store.applicants.find(a => a.worker === "worker2").status, "not_selected");
  assert.equal(store.logs.length, 1);
});
test("failure to insert payment rolls back selected Worker and queue in transaction", async () => {
  seed(); store.failPayment = true;
  await assert.rejects(() => call(controller.selectWorker, req()), /Payment write failure/);
  assert.equal(store.job.status, "waiting");
  assert.equal(store.payment, null);
  assert.equal(store.applicants[0].status, "waiting");
  assert.equal(store.logs.length, 0);
  assert.equal(store.notifications.length, 0);
});
