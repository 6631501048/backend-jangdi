"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

const store = {
  job: { _id: "job1", hirer: "hirer1", selectedWorker: "worker1", status: "assigned", title: "Pick up food" },
  payment: { _id: "pay1", job: "job1", hirer: "hirer1", worker: "worker1", amount: 100,
    platformFeeAmount: 5, paymentMode: "demo", status: "pending", heldAt: null },
  notifications: [],
  findQuery: null,
};
const records = [
  { _id: "j1", status: "pending_review", title: "A", hirer: { fullName: "Hirer" } },
  { _id: "j2", status: "in_progress", title: "B" },
  { _id: "j3", status: "awaiting_confirmation", title: "C" },
  { _id: "j4", status: "completed", title: "D" },
];
const queryChain = (filter) => ({
  select() { return this; }, populate() { return this; }, sort() { return this; },
  skip(n) { this.offset = n; return this; },
  limit(n) { this.max = n; return this; },
  then(resolve, reject) {
    store.findQuery = filter;
    let rows = records.filter((r) => (!filter.status || filter.status === r.status));
    if (filter.$or) rows = rows.filter((r) => filter.$or.some((q) =>
      new RegExp(q.title?.$regex || q.description?.$regex || "", "i").test(r.title)));
    return Promise.resolve(rows.slice(this.offset || 0, (this.offset || 0) + (this.max || 20))).then(resolve, reject);
  },
});
const models = {
  Job: {
    findById: async (id) => id === store.job._id ? { ...store.job } : null,
    find: (filter) => queryChain(filter),
    countDocuments: async (filter) => records.filter((r) => !filter.status || r.status === filter.status).length,
    aggregate: async () => Object.entries(records.reduce((a, r) => {
      a[r.status] = (a[r.status] || 0) + 1; return a;
    }, {})).map(([_id, count]) => ({ _id, count })),
  },
  Payment: {
    findOne: async (q) => store.payment && String(q.job) === String(store.payment.job) ? { ...store.payment } : null,
    exists: async (q) => store.payment && store.payment.job === q.job && store.payment.worker === q.worker && store.payment.status === q.status ? { _id: store.payment._id } : null,
    findOneAndUpdate: async (q, update) => {
      if (!store.payment || store.payment.status !== q.status || q.paymentMode !== store.payment.paymentMode ||
        String(store.payment.hirer) !== String(q.hirer) || String(store.payment.job) !== String(q.job)) return null;
      Object.assign(store.payment, update.$set);
      return { ...store.payment };
    },
  },
};
const stub = (path, obj) => {
  const id = require.resolve(path);
  require.cache[id] = { id, filename: id, loaded: true, exports: obj };
};
stub("../src/models", models);
stub("../src/services/notification.service", { notifyUser: async (_, notification) => store.notifications.push(notification),
  createNotification: async () => ({ _id: "n1" }), deliverNotification: async () => {} });
stub("../src/services/jobLog.service", { logJobStatusChange: async () => {} });
stub("../src/services/matching.service", { notifyNearbyWorkers: async () => {} });
const payment = require("../src/controllers/payment.controller");
const admin = require("../src/controllers/admin.controller");
const jobController = require("../src/controllers/job.controller");
function request(userId = "hirer1", overrides = {}) {
  return { user: { _id: userId, isAdmin: false }, params: { jobId: "job1" }, query: {}, app: { get: () => null }, ...overrides };
}
function response() {
  return { code: 200, body: null, status(n) { this.code = n; return this; }, json(body) { this.body = body; return this; } };
}
async function call(handler, req) {
  const res = response(); let failure;
  await handler(req, res, (err) => { failure = err; });
  if (failure) throw failure;
  return res;
}
function reset() {
  store.job.status = "assigned";
  store.payment.status = "pending";
  store.payment.paymentMode = "demo";
  store.payment.heldAt = null;
  store.notifications = [];
}
test("Admin can query all statuses and filter a single state", async () => {
  const all = await call(admin.getAllJobs, request("admin", { user: { _id: "admin", isAdmin: true }, query: { status: "all", limit: "20" } }));
  assert.equal(all.code, 200);
  assert.equal(all.body.total, 4);
  assert.equal(all.body.jobs.length, 4);
  assert.equal(all.body.counts.awaiting_confirmation, 1);
  const pending = await call(admin.getAllJobs, request("admin", { user: { _id: "admin", isAdmin: true }, query: { status: "pending_review" } }));
  assert.equal(pending.body.jobs.length, 1);
  assert.equal(pending.body.jobs[0].status, "pending_review");
  const invalid = await call(admin.getAllJobs, request("admin", { query: { status: "invalid" } }));
  assert.equal(invalid.code, 400);
});
test("Admin search escapes regex metacharacters and pagination caps size", async () => {
  await call(admin.getAllJobs, request("admin", { query: { search: "a.*", limit: "10000" } }));
  assert.equal(store.findQuery.$or[0].title.$regex, "a\\.\\*");
  const all = await call(admin.getAllJobs, request("admin", { query: { limit: "999" } }));
  assert.equal(all.body.limit, 100);
});
test("Demo payment is visible only to related users and Admin", async () => {
  reset();
  const allowed = await call(payment.getMockPayment, request());
  assert.equal(allowed.body.status, "pending");
  assert.equal(allowed.body.totalDue, 105);
  const outsider = await call(payment.getMockPayment, request("other"));
  assert.equal(outsider.code, 403);
});
test("Hirer can pay DEMO once and the second request is rejected", async () => {
  reset();
  const first = await call(payment.confirmMockPayment, request());
  assert.equal(first.code, 200);
  assert.equal(store.payment.status, "held");
  assert.ok(store.payment.heldAt);
  assert.equal(store.notifications.length, 1);
  const second = await call(payment.confirmMockPayment, request());
  assert.equal(second.code, 409);
  assert.equal(store.notifications.length, 1);
});
test("Other users, already started jobs, and manual payments cannot confirm mock payment", async () => {
  reset();
  assert.equal((await call(payment.confirmMockPayment, request("worker1"))).code, 403);
  assert.equal(store.payment.status, "pending");
  store.job.status = "in_progress";
  assert.equal((await call(payment.confirmMockPayment, request())).code, 409);
  store.job.status = "assigned";
  store.payment.paymentMode = "manual";
  assert.equal((await call(payment.confirmMockPayment, request())).code, 409);
  assert.equal(store.payment.status, "pending");
});

test("Worker cannot start an assigned job before mock payment is held", async () => {
  reset();
  const middleware = jobController.updateJobStatus[1];
  const result = await call(middleware, request("worker1", {
    params: { id: "job1" }, body: { next: "in_progress" }, file: null,
  }));
  assert.equal(result.code, 409);
  assert.equal(store.job.status, "assigned");
  assert.match(result.body.message, /Mock|จำลอง|ชำระ/);
});
