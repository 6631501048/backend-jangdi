"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

// These isolated controller tests use in-memory stubs (no MongoDB / real HTTP).
const store = { job: null, applications: [], logs: [], selectedJobs: [], payment: [], preventUpdate: false };
const clone = (v) => v == null ? v : { ...v };
const candidates = (query, records) => records.filter((r) => {
  return Object.keys(query).every((key) => {
    const expected = query[key];
    const actual = r[key];
    if (expected?.$in) return expected.$in.includes(actual);
    return String(actual) === String(expected);
  });
});
const queryResult = (rows) => ({ populate() { return this; }, async sort() { return rows; }, then(resolve, reject) { return Promise.resolve(rows).then(resolve, reject); } });
const models = {
  Job: {
    findById: async (id) => store.job?._id === id ? clone(store.job) : null,
    findOneAndUpdate: async (query, update) => {
      if (store.preventUpdate || !store.job || !candidates(query, [store.job]).length) return null;
      Object.assign(store.job, update.$set);
      return clone(store.job);
    },
    find: (query) => queryResult(candidates(query, store.selectedJobs)),
  },
  JobWaiting: {
    find: (query) => queryResult(candidates(query, store.applications)),
    async countDocuments() { return 0; },
  },
  JobLog: { find: () => queryResult(store.logs) },
  Payment: { create: async (p) => { store.payment.push(p); return p; } },
};
const stub = (file, exports) => {
  const id = require.resolve(file);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};
stub("../src/models", models);
stub("../src/services/jobLog.service", { logJobStatusChange: async (item) => store.logs.push({ ...item, createdAt: new Date() }) });
stub("../src/services/notification.service", { notifyUser: async () => {} });
const ctrl = require("../src/controllers/job.controller");
function reset() {
  store.job = { _id: "j1", hirer: "h1", selectedWorker: null, title: "Deliver", price: 50, deliveryFee: 10,
    status: "waiting", scheduledAt: "2026-10-25T12:00:00Z" };
  store.applications = [];
  store.selectedJobs = [];
  store.logs = [];
  store.payment = [];
  store.preventUpdate = false;
}
const res = () => ({ statusCode: 200, body: null, status(n) { this.statusCode = n; return this; },
  json(v) { this.body = v; return this; } });
async function invoke(handler, props = {}) {
  const response = res(); let failure;
  await handler({ user: { _id: "h1", isAdmin: false }, params: { id: "j1" }, body: {}, query: {}, app: { get: () => null }, ...props }, response, (err) => { failure = err; });
  if (failure) throw failure;
  return response;
}
test("cancelled applications are moved from Waiting to Cancelled tab", async () => {
  reset();
  const active = { _id: "j2", title: "Post", price: 30, status: "waiting", hirer: { fullName: "H" }, scheduledAt: null };
  const cancelled = { _id: "j3", title: "Removed", price: 40, status: "cancelled", hirer: { fullName: "H" }, cancelledAt: new Date() };
  store.applications = [
    { worker: "w1", job: active, status: "waiting" },
    { worker: "w1", job: cancelled, status: "waiting" },
  ];
  const waiting = await invoke(ctrl.getMyWorkerJobs, { user: { _id: "w1" }, query: { status: "waiting" } });
  assert.deepEqual(waiting.body.map((j) => j.id), ["j2"]);
  const removed = await invoke(ctrl.getMyWorkerJobs, { user: { _id: "w1" }, query: { status: "cancelled" } });
  assert.deepEqual(removed.body.map((j) => j.id), ["j3"]);
});
test("Hirer active My Jobs tab groups awaiting confirmation with active work", async () => {
  reset();
  store.selectedJobs = [
    { _id: "assigned", status: "assigned", hirer: "h1" },
    { _id: "progress", status: "in_progress", hirer: "h1" },
    { _id: "proof", status: "awaiting_confirmation", hirer: "h1" },
    { _id: "done", status: "completed", hirer: "h1" },
  ];
  const active = await invoke(ctrl.getMyJobs, { query: { status: "assigned" } });
  assert.deepEqual(active.body.map((job) => job._id), ["assigned", "progress", "proof"]);
  const completed = await invoke(ctrl.getMyJobs, { query: { status: "completed" } });
  assert.deepEqual(completed.body.map((job) => job._id), ["done"]);
});
test("timeline only exposes status timestamps to the job parties", async () => {
  reset(); store.job.selectedWorker = "w1";
  store.logs = [{ newStatus: "assigned", createdAt: new Date("2026-10-22T01:00:00Z") }];
  const outsider = await invoke(ctrl.getJobTimeline, { user: { _id: "x1" } });
  assert.equal(outsider.statusCode, 403);
  const worker = await invoke(ctrl.getJobTimeline, { user: { _id: "w1" } });
  assert.equal(worker.statusCode, 200);
  assert.deepEqual(worker.body[0].status, "assigned");
  assert.ok(worker.body[0].at);
});
test("Hirer cancellation is possible before assignment and preserves reason", async () => {
  reset();
  const result = await invoke(ctrl.cancelJob, { body: { reason: "Schedule changed" } });
  assert.equal(result.statusCode, 200);
  assert.equal(store.job.status, "cancelled");
  assert.equal(store.job.cancelReason, "Schedule changed");
  assert.equal(store.logs.at(-1).newStatus, "cancelled");
});
test("Hirer cannot cancel an assigned job without a dispute/refund flow", async () => {
  reset(); store.job.status = "assigned"; store.job.selectedWorker = "w1";
  const result = await invoke(ctrl.cancelJob, { body: { reason: "Too late" } });
  assert.equal(result.statusCode, 409);
  assert.equal(store.job.status, "assigned");
});
test("concurrent cancellation loses safely when another operation moved the status", async () => {
  reset(); store.preventUpdate = true;
  const result = await invoke(ctrl.cancelJob, { body: { reason: "Cancel" } });
  assert.equal(result.statusCode, 409);
  assert.equal(store.job.status, "waiting");
});
