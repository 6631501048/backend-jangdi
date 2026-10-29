"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");

const id = {
  admin: "507f1f77bcf86cd799439051", worker: "507f1f77bcf86cd799439052",
  hirer: "507f1f77bcf86cd799439053", otherWorker: "507f1f77bcf86cd799439054",
  job: "507f1f77bcf86cd799439055", otherJob: "507f1f77bcf86cd799439056",
  sos: "507f1f77bcf86cd799439057", missing: "507f1f77bcf86cd799439058",
};
let users, jobs, cases, events, lastId;
function reset() {
  users = {
    [id.admin]: { _id: id.admin, isAdmin: true, accountStatus: "active", currentRole: "hirer", fullName: "Admin" },
    [id.worker]: { _id: id.worker, isAdmin: false, accountStatus: "active", currentRole: "worker", fullName: "Worker" },
    [id.hirer]: { _id: id.hirer, isAdmin: false, accountStatus: "active", currentRole: "hirer" },
    [id.otherWorker]: { _id: id.otherWorker, isAdmin: false, accountStatus: "active", currentRole: "worker" },
  };
  jobs = {
    [id.job]: { _id: id.job, selectedWorker: id.worker, status: "in_progress", title: "Help cleaning" },
    [id.otherJob]: { _id: id.otherJob, selectedWorker: id.otherWorker, status: "assigned", title: "Move packages" },
  };
  cases = []; events = []; lastId = 0;
}
reset();
function matches(doc, filter) {
  return Object.entries(filter).every(([key, value]) => {
    if (key === "_id" || key === "worker" || key === "job") return String(doc[key]) === String(value);
    if (key === "status") return doc.status === value;
    if (key === "isAdmin") return doc.isAdmin === value;
    return true;
  });
}
function chain(value) {
  return {
    select() { return this; }, populate() { return this; }, sort() { return Promise.resolve(value); },
    then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); },
  };
}
const models = {
  User: {
    findById: async (uid) => users[String(uid)] || null,
    find: (filter) => chain(Object.values(users).filter((u) => matches(u, filter))),
  },
  Job: { findById: async (jid) => jobs[String(jid)] || null },
  Sos: {
    exists: async (filter) => cases.some((c) => matches(c, filter)),
    create: async (body) => {
      if (cases.some((c) => matches(c, { worker: body.worker, job: body.job, status: "active" }))) {
        const err = new Error("duplicate key"); err.code = 11000; throw err;
      }
      const doc = { _id: id.sos.slice(0, -1) + String(++lastId), status: "active", triggeredAt: new Date(), ...body };
      cases.push(doc); return { ...doc };
    },
    find: (filter) => chain(cases.filter((c) => matches(c, filter))),
    findById: async (sid) => cases.find((c) => String(c._id) === String(sid)) || null,
    findOneAndUpdate: async (filter, patch) => {
      const record = cases.find((c) => matches(c, filter));
      if (!record) return null;
      Object.assign(record, patch.$set);
      return { ...record };
    },
  },
};
function stub(path, value) {
  const resolved = require.resolve(path);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: value };
}
stub("../src/models", models);
stub("../src/services/notification.service", { notifyUser: async (_io, notification) => { events.push(notification); } });
stub("../src/services/jobLog.service", { logJobStatusChange: async () => {} });
stub("../src/services/matching.service", { notifyNearbyWorkers: async () => {} });
process.env.JWT_SECRET = "sprint4-sos-isolated-test-key";
const app = express();
app.use(express.json());
app.use("/api/sos", require("../src/routes/sos.routes"));
app.use("/api/admin", require("../src/routes/admin.routes"));
app.use((error, _req, res, _next) => res.status(500).json({ message: error.message }));
let server, base;
const token = (uid) => jwt.sign({ id: uid }, process.env.JWT_SECRET, { expiresIn: "5m" });
async function request(path, { user, method = "GET", body } = {}) {
  const r = await fetch(base + path, {
    method, headers: { ...(user ? { authorization: `Bearer ${token(user)}` } : {}), ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, data: await r.json() };
}
const postSOS = (user = id.worker, body = { jobId: id.job }) => request("/api/sos", { user, method: "POST", body });
const closeSOS = (sosId, notes = "Admin contacted the worker and confirmed safety", user = id.admin) =>
  request(`/api/admin/sos/${sosId}/resolve`, { user, method: "POST", body: { adminNotes: notes } });

test.before(async () => {
  server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { if (server) await new Promise((resolve) => server.close(resolve)); });

test("A-05 unauthenticated SOS returns 401; Hirer cannot trigger", async () => {
  reset();
  assert.equal((await request("/api/sos", { method: "POST", body: { jobId: id.job } })).status, 401);
  assert.equal((await postSOS(id.hirer)).status, 403);
});
test("A-05 Worker SOS stores GeoJSON coordinates in [lng,lat] order", async () => {
  reset();
  const r = await postSOS(id.worker, { jobId: id.job, lat: 20.05, lng: 99.88 });
  assert.equal(r.status, 201);
  assert.deepEqual(r.data.sos.location.coordinates, [99.88, 20.05]);
  await new Promise((done) => setImmediate(done));
  assert.equal(events.filter((e) => e.type === "sos_alert").length, 1);
  assert.equal(events.find((e) => e.type === "sos_alert").userId, id.admin);
});
test("A-05 SOS can be triggered even when geolocation permission is unavailable", async () => {
  reset();
  const r = await postSOS();
  assert.equal(r.status, 201);
  assert.equal(r.data.sos.location, undefined);
});
test("A-05 SOS rejects malformed and partial coordinates", async () => {
  reset();
  for (const body of [
    { jobId: id.job, lat: 20 }, { jobId: id.job, lng: 99 }, { jobId: id.job, lat: 91, lng: 1 },
    { jobId: id.job, lat: 0, lng: 181 }, { jobId: id.job, lat: "", lng: "" },
    { jobId: id.job, lat: true, lng: 99 },
  ]) assert.equal((await postSOS(id.worker, body)).status, 400);
  assert.equal(cases.length, 0);
});
test("A-05 SOS rejects invalid Job ID, nonexistent Job, unauthorized Worker and finished Job", async () => {
  reset();
  assert.equal((await postSOS(id.worker, { jobId: "bad-id" })).status, 400);
  assert.equal((await postSOS(id.worker, { jobId: id.missing })).status, 404);
  assert.equal((await postSOS(id.otherWorker)).status, 403);
  jobs[id.job].status = "completed";
  assert.equal((await postSOS()).status, 409);
});
test("A-05 duplicate active SOS is rejected; a resolved SOS permits new alert", async () => {
  reset();
  const first = await postSOS(); assert.equal(first.status, 201);
  assert.equal((await postSOS()).status, 409);
  assert.equal(cases.length, 1);
  assert.equal((await closeSOS(first.data.sos._id)).status, 200);
  assert.equal((await postSOS()).status, 201);
  assert.equal(cases.length, 2);
});
test("A-05 Admin API is access-controlled and validates status", async () => {
  reset(); await postSOS();
  assert.equal((await request("/api/admin/sos")).status, 401);
  assert.equal((await request("/api/admin/sos", { user: id.worker })).status, 403);
  assert.equal((await request("/api/admin/sos?status=invalid", { user: id.admin })).status, 400);
  const r = await request("/api/admin/sos?status=active", { user: id.admin });
  assert.equal(r.status, 200); assert.equal(r.data.length, 1);
});
test("A-05 SOS resolution needs reason, prevents closed case being overwritten", async () => {
  reset(); const first = await postSOS(); const sosId = first.data.sos._id;
  assert.equal((await closeSOS("invalid")).status, 400);
  assert.equal((await closeSOS(sosId, "no")).status, 400);
  assert.equal((await closeSOS(sosId, "x".repeat(1001))).status, 400);
  assert.equal((await closeSOS(sosId, "Investigated", id.worker)).status, 403);
  const r = await closeSOS(sosId);
  assert.equal(r.status, 200);
  assert.equal(r.data.sos.status, "resolved");
  assert.equal(r.data.sos.resolvedBy, id.admin);
  assert.equal(r.data.sos.adminNotes, "Admin contacted the worker and confirmed safety");
  assert.equal((await closeSOS(sosId, "Overwritten after closure")).status, 409);
  assert.equal(cases[0].adminNotes, "Admin contacted the worker and confirmed safety");
  assert.equal((await closeSOS(id.missing)).status, 404);
});
test("A-06 SOS full HTTP flow: Worker creates -> Admin sees -> Admin resolves -> closed list", async () => {
  reset();
  const s = await postSOS(id.worker, { jobId: id.job, lat: 20.05, lng: 99.88 });
  assert.equal(s.status, 201);
  let active = await request("/api/admin/sos?status=active", { user: id.admin });
  assert.equal(active.data.length, 1);
  assert.equal(active.data[0].location.coordinates[0], 99.88);
  assert.equal((await closeSOS(s.data.sos._id)).status, 200);
  active = await request("/api/admin/sos?status=active", { user: id.admin });
  assert.equal(active.data.length, 0);
  const closed = await request("/api/admin/sos?status=resolved", { user: id.admin });
  assert.equal(closed.data.length, 1);
  assert.equal(closed.data[0].resolvedBy, id.admin);
});
