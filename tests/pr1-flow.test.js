"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const { detectProofImage } = require("../src/utils/proofImage");

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x00]);
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
const webp = Buffer.from("RIFFxxxxWEBP", "ascii");

test("image signatures allow only jpeg, png and webp", () => {
  assert.equal(detectProofImage(jpeg).mime, "image/jpeg");
  assert.equal(detectProofImage(png).mime, "image/png");
  assert.equal(detectProofImage(webp).mime, "image/webp");
  assert.equal(detectProofImage(Buffer.from("<svg>hello</svg>")), null);
  assert.equal(detectProofImage(Buffer.from("not an image")), null);
});

// Controller-only checks with a deterministic in-memory model mock. No MongoDB
// connection is used; this does NOT replace end-to-end testing against Atlas.
const store = { job: null, payment: null, logs: [], notifications: [], casUpdates: 0 };
const models = {
  Job: {
    findById: async (id) => store.job && String(store.job._id) === String(id) ? { ...store.job } : null,
    findOneAndUpdate: async (query, update) => {
      if (!store.job || String(query._id) !== String(store.job._id) || query.status !== store.job.status) return null;
      if (query.hirer && String(query.hirer) !== String(store.job.hirer)) return null;
      if (query.selectedWorker && String(query.selectedWorker) !== String(store.job.selectedWorker)) return null;
      if (query.completionConfirmedAt === null && store.job.completionConfirmedAt != null) return null;
      if (query.completionProofUrl && !store.job.completionProofUrl) return null;
      store.casUpdates++;
      Object.assign(store.job, update.$set);
      return { ...store.job };
    },
  },
  Payment: {
    findOneAndUpdate: async (query, update) => {
      if (!store.payment || store.payment.job !== query.job || store.payment.status !== query.status) return null;
      Object.assign(store.payment, update.$set);
      return { ...store.payment };
    },
  },
  JobWaiting: {},
};
function stub(rel, exportsValue) {
  const filename = require.resolve(rel);
  require.cache[filename] = { id: filename, filename, loaded: true, exports: exportsValue };
}
stub("../src/models", models);
stub("../src/services/jobLog.service", { logJobStatusChange: async (log) => { store.logs.push(log); } });
stub("../src/services/notification.service", { notifyUser: async (_, item) => { store.notifications.push(item); } });
const controller = require("../src/controllers/job.controller");
const secondMiddleware = controller.updateJobStatus[1];

function seed(status = "awaiting_confirmation", hasProof = true) {
  store.job = { _id: "job-1", hirer: "hirer-1", selectedWorker: "worker-1", title: "Carry parcel", status,
    completionProofUrl: hasProof ? "/uploads/job-proofs/fixture.jpg" : null,
    completionConfirmedAt: null, completionConfirmedBy: null };
  store.payment = { _id: "pay-1", job: "job-1", status: "held" };
  store.casUpdates = 0;
  store.logs = [];
  store.notifications = [];
}
function reqFor(userId = "hirer-1", body = {}) {
  return { params: { id: "job-1" }, body, user: { _id: userId, isAdmin: false }, app: { get: () => null } };
}
function resp() {
  return { statusCode: 200, body: null, headers: {}, status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }, set(data) { Object.assign(this.headers, data); return this; },
    type(type) { this.headers["Content-Type"] = type; return this; }, send(body) { this.body = body; return this; } };
}
async function call(handler, req) {
  const res = resp();
  let caught;
  await handler(req, res, (err) => { caught = err; });
  if (caught) throw caught;
  return res;
}

test("Hirer confirmation persists identity/time, transitions once, and releases demo held state", async () => {
  seed();
  const res = await call(controller.confirmCompletion, reqFor());
  assert.equal(res.statusCode, 200);
  assert.equal(store.job.status, "completed");
  assert.equal(store.job.completionConfirmedBy, "hirer-1");
  assert.ok(store.job.completionConfirmedAt instanceof Date);
  assert.equal(store.payment.status, "released");
  assert.equal(store.logs.length, 1);
  assert.equal(store.casUpdates, 1);
  assert.match(JSON.stringify(store.notifications), /จำลอง/);
  assert.doesNotMatch(JSON.stringify(store.notifications), /ถูกโอนเข้าบัญชีของคุณแล้ว/);

  const again = await call(controller.confirmCompletion, reqFor());
  assert.equal(again.statusCode, 409);
  assert.equal(store.casUpdates, 1);
  assert.equal(store.logs.length, 1);
  assert.equal(store.notifications.length, 2);
});

test("a non-owner may not confirm", async () => {
  seed();
  const res = await call(controller.confirmCompletion, reqFor("someone-else"));
  assert.equal(res.statusCode, 403);
  assert.equal(store.job.status, "awaiting_confirmation");
});

test("Hirer cannot confirm work still in progress or without proof", async () => {
  seed("in_progress");
  assert.equal((await call(controller.confirmCompletion, reqFor())).statusCode, 409);
  seed("awaiting_confirmation", false);
  assert.equal((await call(controller.confirmCompletion, reqFor())).statusCode, 400);
});

test("lost compare-and-set race returns conflict instead of duplicate completion", async () => {
  seed();
  const orig = models.Job.findOneAndUpdate;
  models.Job.findOneAndUpdate = async () => null;
  try {
    const res = await call(controller.confirmCompletion, reqFor());
    assert.equal(res.statusCode, 409);
    assert.equal(store.payment.status, "held");
    assert.equal(store.logs.length, 0);
  } finally { models.Job.findOneAndUpdate = orig; }
});

test("Worker proof submission switches to awaiting_confirmation and records the image", async () => {
  seed("in_progress", false);
  const res = await call(secondMiddleware, { ...reqFor("worker-1", { next: "awaiting_confirmation" }), file: { buffer: jpeg, mimetype: "image/jpeg" } });
  assert.equal(res.statusCode, 200);
  assert.equal(store.job.status, "awaiting_confirmation");
  assert.ok(store.job.proofSubmittedAt instanceof Date);
  assert.match(store.job.completionProofUrl, /^\/uploads\/job-proofs\/job-1-[\w-]+\.jpg$/);
  const filename = path.basename(store.job.completionProofUrl);
  const file = path.join(__dirname, "..", "uploads", "job-proofs", filename);
  assert.deepEqual(fs.readFileSync(file), jpeg);
  fs.unlinkSync(file);
});

test("Wrong file signature or non-worker cannot submit proof", async () => {
  seed("in_progress", false);
  const mismatch = await call(secondMiddleware, { ...reqFor("worker-1", { next: "awaiting_confirmation" }), file: { buffer: png, mimetype: "image/jpeg" } });
  assert.equal(mismatch.statusCode, 400);
  const other = await call(secondMiddleware, { ...reqFor("someone-else", { next: "awaiting_confirmation" }), file: { buffer: jpeg, mimetype: "image/jpeg" } });
  assert.equal(other.statusCode, 403);
  assert.equal(store.job.status, "in_progress");
});

test("Authenticated image fetch refuses outsiders and serves the real image type", async () => {
  seed();
  const filepath = path.join(__dirname, "..", "uploads", "job-proofs", "pr1-test-picture.jpg");
  fs.mkdirSync(path.dirname(filepath), { recursive: true });
  fs.writeFileSync(filepath, jpeg);
  store.job.completionProofUrl = "/uploads/job-proofs/pr1-test-picture.jpg";
  try {
    assert.equal((await call(controller.getCompletionProof, reqFor("outsider"))).statusCode, 403);
    const response = await call(controller.getCompletionProof, reqFor());
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, jpeg);
    assert.equal(response.headers["X-Content-Type-Options"], "nosniff");
    assert.equal(response.headers["Cache-Control"], "private, no-store");
    assert.equal((await call(controller.getCompletionProof, reqFor("worker-1"))).statusCode, 200);
  } finally { fs.unlinkSync(filepath); }
});
