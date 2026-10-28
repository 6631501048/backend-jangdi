"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");

const ids = {
  admin: "507f1f77bcf86cd799439011", hirer: "507f1f77bcf86cd799439012",
  worker: "507f1f77bcf86cd799439013", outsider: "507f1f77bcf86cd799439014",
  otherAdmin: "507f1f77bcf86cd799439015", job: "507f1f77bcf86cd799439016",
  report: "507f1f77bcf86cd799439017", missing: "507f1f77bcf86cd799439018",
};
const store = {
  jobs: [], users: {}, reports: [], events: [], query: null, projection: "",
};
function reset() {
  store.jobs = [{ _id: ids.job, status: "pending_review", hirer: ids.hirer,
    selectedWorker: ids.worker, title: "Help cleaning", description: "Please help" }];
  store.users = {
    [ids.admin]: { _id: ids.admin, isAdmin: true, accountStatus: "active" },
    [ids.otherAdmin]: { _id: ids.otherAdmin, isAdmin: true, accountStatus: "active" },
    [ids.hirer]: { _id: ids.hirer, isAdmin: false, accountStatus: "active", moderationHistory: [] },
    [ids.worker]: { _id: ids.worker, isAdmin: false, accountStatus: "active", moderationHistory: [] },
    [ids.outsider]: { _id: ids.outsider, isAdmin: false, accountStatus: "active", moderationHistory: [] },
  };
  store.reports = [];
  store.events = [];
  store.query = null;
  store.projection = "";
}
reset();
function matches(record, filter) {
  if (filter._id && String(record._id) !== String(filter._id)) return false;
  if (filter.status && typeof filter.status === "string" && record.status !== filter.status) return false;
  if (filter.status?.$in && !filter.status.$in.includes(record.status)) return false;
  if (filter.accountStatus && record.accountStatus !== filter.accountStatus) return false;
  if (filter.isAdmin?.$ne !== undefined && record.isAdmin === filter.isAdmin.$ne) return false;
  return true;
}
const models = {
  Job: {
    findOneAndUpdate: async (f, update) => {
      const job = store.jobs.find((j) => matches(j, f));
      if (!job) return null;
      Object.assign(job, update.$set);
      return { ...job };
    },
    findById: (id) => ({
      select() { return this; },
      then(resolve, reject) { return Promise.resolve(store.jobs.find((j) => j._id === String(id)) || null).then(resolve, reject); },
    }),
    find: (f) => ({
      select() { return this; }, populate() { return this; }, sort() { return this; }, skip() { return this; },
      limit() { return this; }, then(resolve, reject) {
        const result = store.jobs.filter((r) => matches(r, f));
        return Promise.resolve(result).then(resolve, reject);
      },
    }),
    countDocuments: async (f) => store.jobs.filter((r) => matches(r, f)).length,
    aggregate: async () => store.jobs.map((j) => ({ _id: j.status, count: 1 })),
  },
  User: {
    findById: (id) => ({
      select() { return this; },
      then(resolve, reject) { return Promise.resolve(store.users[String(id)] || null).then(resolve, reject); },
    }),
    findOneAndUpdate: async (filter, update) => {
      const user = store.users[String(filter._id)];
      if (!user || !matches(user, filter)) return null;
      Object.assign(user, update.$set);
      user.moderationHistory.push(update.$push.moderationHistory);
      return { ...user };
    },
    find: (filter) => ({ select(fields) { store.projection = fields; return this; }, sort: async () => Object.values(store.users).filter((u) => !u.isAdmin) }),
  },
  Report: {
    exists: async (f) => store.reports.some((r) =>
      String(r.reporter) === String(f.reporter) && String(r.reportedUser) === String(f.reportedUser) &&
      String(r.job) === String(f.job) && f.status.$in.includes(r.status)),
    create: async (body) => {
      const report = { _id: ids.report, ...body, status: "pending" };
      store.reports.push(report); return { ...report };
    },
    findOneAndUpdate: async (f, update) => {
      const report = store.reports.find((r) => matches(r, f));
      if (!report) return null;
      Object.assign(report, update.$set);
      return { ...report };
    },
    findById: async (id) => store.reports.find((r) => String(r._id) === String(id)) || null,
  },
};
// Isolated node --test file. Use DB fakes so test runs without external MongoDB.
function stub(path, object) {
  const resolved = require.resolve(path);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: object };
}
stub("../src/models", models);
stub("../src/services/notification.service", { notifyUser: async (_io, event) => store.events.push(event) });
stub("../src/services/jobLog.service", { logJobStatusChange: async () => {} });
stub("../src/services/matching.service", { notifyNearbyWorkers: async () => {} });
const admin = require("../src/controllers/admin.controller");
const { createReport } = require("../src/controllers/report.controller");
const { protect, adminOnly } = require("../src/middleware/auth.middleware");
const makeReq = (extra = {}) => ({
  user: store.users[ids.admin], params: {}, query: {}, body: {}, app: { get: () => null }, ...extra,
});
const makeRes = () => ({
  statusCode: 200, body: undefined, status(n) { this.statusCode = n; return this; },
  json(v) { this.body = v; return this; },
});
async function call(handler, req) {
  const res = makeRes(); let err;
  await handler(req, res, (e) => { err = e; });
  if (err) throw err;
  return res;
}

// A-01

test("A-01 list API validates pagination/status/search and maintains compatible response shape", async () => {
  reset();
  assert.equal((await call(admin.getAllJobs, makeReq({ query: { page: "0" } }))).statusCode, 400);
  assert.equal((await call(admin.getAllJobs, makeReq({ query: { limit: "abc" } }))).statusCode, 400);
  assert.equal((await call(admin.getAllJobs, makeReq({ query: { status: "wrong" } }))).statusCode, 400);
  const valid = await call(admin.getAllJobs, makeReq({ query: { status: "pending_review", limit: "200" } }));
  assert.equal(valid.statusCode, 200);
  assert.equal(valid.body.limit, 100);
  assert.equal(valid.body.total, 1);
  assert.equal(valid.body.jobs[0].status, "pending_review");
});

test("A-01 atomic approve only once and rejects a previously approved job", async () => {
  reset();
  const req = () => makeReq({ params: { id: ids.job } });
  const [a, b] = await Promise.all([call(admin.approveJob, req()), call(admin.approveJob, req())]);
  assert.deepEqual([a.statusCode, b.statusCode].sort(), [200, 409]);
  assert.equal(store.jobs[0].status, "waiting");
  assert.equal(store.events.filter((e) => e.type === "job_approved").length, 1);
  assert.equal((await call(admin.rejectJob, req())).statusCode, 409);
  assert.equal((await call(admin.approveJob, makeReq({ params: { id: "abc" } }))).statusCode, 400);
  assert.equal((await call(admin.approveJob, makeReq({ params: { id: ids.missing } }))).statusCode, 404);
});

test("A-01 reject validates reason and changes only pending_review", async () => {
  reset();
  const req = (reason) => makeReq({ params: { id: ids.job }, body: { reason } });
  assert.equal((await call(admin.rejectJob, req({ bad: true }))).statusCode, 400);
  assert.equal((await call(admin.rejectJob, req("x".repeat(501)))).statusCode, 400);
  assert.equal((await call(admin.rejectJob, req("Policy violation"))).statusCode, 200);
  assert.equal(store.jobs[0].rejectionReason, "Policy violation");
  assert.equal((await call(admin.rejectJob, req("repeat"))).statusCode, 409);
});

// A-03

test("A-03 moderation requires reason and forbids self/other Admin", async () => {
  reset();
  const base = { body: { action: "suspend", reason: "Repeated abusive behavior" } };
  assert.equal((await call(admin.updateUserStatus, makeReq({ ...base, params: { id: ids.admin } }))).statusCode, 403);
  assert.equal((await call(admin.updateUserStatus, makeReq({ ...base, params: { id: ids.otherAdmin } }))).statusCode, 403);
  assert.equal((await call(admin.updateUserStatus, makeReq({ params: { id: ids.hirer }, body: { action: "suspend" } }))).statusCode, 400);
  assert.equal((await call(admin.updateUserStatus, makeReq({ ...base, params: { id: "bad" } }))).statusCode, 400);
});

test("A-03 status and audit are updated together, duplicated actions are rejected", async () => {
  reset();
  const req = (action, reason) => makeReq({ params: { id: ids.hirer }, body: { action, reason } });
  assert.equal((await call(admin.updateUserStatus, req("suspend", "Safety violation"))).statusCode, 200);
  assert.equal(store.users[ids.hirer].accountStatus, "suspended");
  assert.deepEqual(store.users[ids.hirer].moderationHistory.map((r) => r.action), ["suspend"]);
  assert.equal(store.users[ids.hirer].moderationHistory[0].performedBy, ids.admin);
  assert.equal((await call(admin.updateUserStatus, req("suspend", "Try again now"))).statusCode, 409);
  assert.equal((await call(admin.updateUserStatus, req("clear", "Appeal accepted"))).statusCode, 200);
  assert.equal(store.users[ids.hirer].accountStatus, "active");
  assert.equal(store.users[ids.hirer].moderationHistory.length, 2);
});

test("A-03 Admin user list uses an allowlist (no account secrets)", async () => {
  reset();
  const res = await call(admin.getUsers, makeReq({ query: { search: "a.*" } }));
  assert.equal(res.statusCode, 200);
  assert.doesNotMatch(store.projection, /password|bankAccount|googleId|VerificationToken|lastKnownLocation/);
  assert.match(store.projection, /accountStatus/);
});

test("A-03 protect blocks suspended accounts even with an otherwise valid JWT", async () => {
  reset();
  process.env.JWT_SECRET = "test-only-secret-for-sprint4";
  store.users[ids.hirer].accountStatus = "suspended";
  const token = jwt.sign({ id: ids.hirer }, process.env.JWT_SECRET, { expiresIn: "30m" });
  const req = { headers: { authorization: `Bearer ${token}` } };
  const res = makeRes();
  let next = false;
  await protect(req, res, () => { next = true; });
  assert.equal(next, false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, "ACCOUNT_SUSPENDED");
  store.users[ids.hirer].accountStatus = "active";
  await protect(req, makeRes(), () => { next = true; });
  assert.equal(next, true);
});

test("A-03 Admin HTTP routes reject anonymous and ordinary users; Admin is authorized", async () => {
  reset();
  process.env.JWT_SECRET = "test-only-secret-for-sprint4";
  const app = express();
  app.use("/api/admin", require("../src/routes/admin.routes"));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  try {
    const endpoint = `http://127.0.0.1:${server.address().port}/api/admin/jobs`;
    let res = await fetch(endpoint);
    assert.equal(res.status, 401);
    res = await fetch(endpoint, { headers: { authorization: `Bearer ${jwt.sign({ id: ids.hirer }, process.env.JWT_SECRET)}` } });
    assert.equal(res.status, 403);
    res = await fetch(endpoint, { headers: { authorization: `Bearer ${jwt.sign({ id: ids.admin }, process.env.JWT_SECRET)}` } });
    assert.equal(res.status, 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// A-04

test("A-04 rejects malformed IDs, weak reason, long description, missing targets", async () => {
  reset();
  const body = { reportedUserId: ids.worker, reason: "Suspicious behavior" };
  const reporter = store.users[ids.hirer];
  assert.equal((await call(createReport, makeReq({ user: reporter, body: { ...body, reportedUserId: "bad" } }))).statusCode, 400);
  assert.equal((await call(createReport, makeReq({ user: reporter, body: { ...body, reason: "hi" } }))).statusCode, 400);
  assert.equal((await call(createReport, makeReq({ user: reporter, body: { ...body, description: "x".repeat(2001) } }))).statusCode, 400);
  assert.equal((await call(createReport, makeReq({ user: reporter, body: { ...body, reportedUserId: ids.missing } }))).statusCode, 404);
  assert.equal(store.reports.length, 0);
});

test("A-04 verifies both parties belong to a related job and prevents duplicate pending reports", async () => {
  reset();
  const body = { reportedUserId: ids.worker, jobId: ids.job, reason: "Safety issue" };
  const req = () => makeReq({ user: store.users[ids.hirer], body });
  assert.equal((await call(createReport, makeReq({ user: store.users[ids.outsider], body }))).statusCode, 403);
  assert.equal((await call(createReport, req())).statusCode, 201);
  assert.equal(store.reports.length, 1);
  assert.equal((await call(createReport, req())).statusCode, 409);
  assert.equal(store.reports.length, 1);
  assert.equal((await call(createReport, makeReq({ user: store.users[ids.hirer], body: { ...body, reportedUserId: ids.hirer } }))).statusCode, 400);
});

test("A-04 report resolution records notes, cannot overwrite closed case", async () => {
  reset();
  store.reports.push({ _id: ids.report, status: "pending", reporter: ids.hirer, reportedUser: ids.worker, job: ids.job });
  const req = (notes) => makeReq({ params: { id: ids.report }, body: { status: "resolved", resolutionNotes: notes } });
  assert.equal((await call(admin.resolveReport, req("no"))).statusCode, 400);
  assert.equal((await call(admin.resolveReport, req("Checked logs and resolved"))).statusCode, 200);
  assert.equal(store.reports[0].resolvedBy, ids.admin);
  assert.ok(store.reports[0].resolvedAt instanceof Date);
  assert.equal((await call(admin.resolveReport, req("Second change"))).statusCode, 409);
  assert.equal(store.reports[0].resolutionNotes, "Checked logs and resolved");
});

test("A-04 Report HTTP endpoint authenticates and rate-limits per reporter", async () => {
  reset();
  process.env.JWT_SECRET = "test-only-secret-for-sprint4";
  const app = express();
  app.use(express.json());
  app.use("/api/reports", require("../src/routes/report.routes"));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  try {
    const endpoint = `http://127.0.0.1:${server.address().port}/api/reports`;
    const body = JSON.stringify({ reportedUserId: ids.worker, jobId: ids.job, reason: "Safety issue" });
    let res = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body });
    assert.equal(res.status, 401);
    const headers = {
      "content-type": "application/json",
      authorization: `Bearer ${jwt.sign({ id: ids.hirer }, process.env.JWT_SECRET)}`,
    };
    const statuses = [];
    for (let i = 0; i < 6; i++) {
      res = await fetch(endpoint, { method: "POST", headers, body });
      statuses.push(res.status);
    }
    assert.deepEqual(statuses, [201, 409, 409, 409, 409, 429]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
