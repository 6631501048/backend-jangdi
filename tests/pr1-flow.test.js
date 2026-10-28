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
const store = { job: null, payment: null, logs: [], notifications: [], delivered: [], casUpdates: 0, failLog: false, failDelivery: false };
let transactionQueue = Promise.resolve();
const models = {
  Job: {
    findById: async (id) => store.job && String(store.job._id) === String(id) ? { ...store.job } : null,
    findOneAndUpdate: async (query, update) => {
      if (!store.job || String(query._id) !== String(store.job._id) || query.status !== store.job.status) return null;
      if (query.hirer && String(query.hirer) !== String(store.job.hirer)) return null;
      if (query.selectedWorker && String(query.selectedWorker) !== String(store.job.selectedWorker)) return null;
      if (query.completionConfirmedAt === null && store.job.completionConfirmedAt != null) return null;
      if (query.completionProofUrl && String(query.completionProofUrl) !== String(store.job.completionProofUrl)) return null;
      store.casUpdates++;
      Object.assign(store.job, update.$set);
      return { ...store.job };
    },
  },
  Payment: {
    findOneAndUpdate: async (query, update) => {
      if (!store.payment || String(store.payment.job) !== String(query.job) || String(store.payment.hirer) !== String(query.hirer) ||
          String(store.payment.worker) !== String(query.worker) || store.payment.status !== query.status) return null;
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
stub("../src/services/jobLog.service", { logJobStatusChange: async (log) => {
  if (store.failLog) throw new Error("simulated log write failure");
  store.logs.push(log);
} });
stub("../src/services/notification.service", {
  createNotification: async (item) => {
    const notification = { ...item, _id: `notification-${store.notifications.length + 1}` };
    store.notifications.push(notification);
    return notification;
  },
  deliverNotification: async (_, notification) => { if (!store.failDelivery) store.delivered.push(notification._id); return !store.failDelivery; },
  notifyUser: async (_, item) => { store.notifications.push(item); },
});
stub("../src/services/transaction.service", {
  withTransaction: (work) => {
    const operation = transactionQueue.then(async () => {
      const snapshot = {
        job: { ...store.job }, payment: store.payment && { ...store.payment },
        logs: [...store.logs], notifications: [...store.notifications], casUpdates: store.casUpdates,
      };
      try { return await work({ mocked: true }); }
      catch (err) {
        store.job = snapshot.job;
        store.payment = snapshot.payment;
        store.logs = snapshot.logs;
        store.notifications = snapshot.notifications;
        store.casUpdates = snapshot.casUpdates;
        throw err;
      }
    });
    transactionQueue = operation.catch(() => {});
    return operation;
  },
});
const proofPath = path.join(__dirname, "..", "uploads", "job-proofs", "pr1-confirm-picture.jpg");
const controller = require("../src/controllers/job.controller");
const secondMiddleware = controller.updateJobStatus[1];

function seed(status = "awaiting_confirmation", hasProof = true) {
  store.job = { _id: "job-1", hirer: "hirer-1", selectedWorker: "worker-1", title: "Carry parcel", status,
    completionProofUrl: hasProof ? "/uploads/job-proofs/pr1-confirm-picture.jpg" : null,
    completionConfirmedAt: null, completionConfirmedBy: null };
  fs.mkdirSync(path.dirname(proofPath), { recursive: true });
  fs.writeFileSync(proofPath, jpeg);
  store.payment = { _id: "pay-1", job: "job-1", hirer: "hirer-1", worker: "worker-1", status: "held" };
  store.casUpdates = 0;
  store.logs = [];
  store.notifications = [];
  store.delivered = [];
  store.failLog = false;
  store.failDelivery = false;
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
  assert.match(JSON.stringify(store.notifications), /No real transfer occurred/);
  assert.doesNotMatch(JSON.stringify(store.notifications), /real transfer happened/i);

  const again = await call(controller.confirmCompletion, reqFor());
  assert.equal(again.statusCode, 409);
  assert.equal(store.casUpdates, 1);
  assert.equal(store.logs.length, 1);
  assert.equal(store.notifications.length, 2);
  assert.equal(store.delivered.length, 2);
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

test("missing or invalid proof blocks confirmation without changing records", async () => {
  seed();
  fs.unlinkSync(proofPath);
  const missing = await call(controller.confirmCompletion, reqFor());
  assert.equal(missing.statusCode, 409);
  assert.equal(store.job.status, "awaiting_confirmation");
  assert.equal(store.payment.status, "held");
  assert.equal(store.logs.length, 0);

  seed();
  fs.writeFileSync(proofPath, Buffer.from("not an image"));
  const invalid = await call(controller.confirmCompletion, reqFor());
  assert.equal(invalid.statusCode, 409);
  assert.equal(store.job.status, "awaiting_confirmation");
  fs.writeFileSync(proofPath, jpeg);
});

test("payment or audit-log failure rolls back Job and prevents notifications", async () => {
  seed();
  store.payment = null;
  const paymentFailure = await call(controller.confirmCompletion, reqFor());
  assert.equal(paymentFailure.statusCode, 409);
  assert.equal(store.job.status, "awaiting_confirmation");
  assert.equal(store.logs.length, 0);
  assert.equal(store.notifications.length, 0);

  seed();
  store.failLog = true;
  await assert.rejects(() => call(controller.confirmCompletion, reqFor()), /simulated log write failure/);
  assert.equal(store.job.status, "awaiting_confirmation");
  assert.equal(store.payment.status, "held");
  assert.equal(store.notifications.length, 0);
});

test("simultaneous confirmation requests only commit once", async () => {
  seed();
  const results = await Promise.all([
    call(controller.confirmCompletion, reqFor()),
    call(controller.confirmCompletion, reqFor()),
  ]);
  assert.deepEqual(results.map((result) => result.statusCode).sort(), [200, 409]);
  assert.equal(store.job.status, "completed");
  assert.equal(store.payment.status, "released");
  assert.equal(store.logs.length, 1);
  assert.equal(store.notifications.length, 2);
});

test("notification delivery failure leaves durable pending records and does not undo confirmation", async () => {
  seed();
  store.failDelivery = true;
  const response = await call(controller.confirmCompletion, reqFor());
  assert.equal(response.statusCode, 200);
  assert.equal(store.job.status, "completed");
  assert.equal(store.payment.status, "released");
  assert.equal(store.notifications.length, 2);
  assert.equal(store.delivered.length, 0);
});

test("Worker proof submission switches to awaiting_confirmation and records the image", async () => {
  seed("in_progress", false);
  const res = await call(secondMiddleware, { ...reqFor("worker-1", { next: "awaiting_confirmation" }), file: { buffer: jpeg, mimetype: "image/jpeg" } });
  assert.equal(res.statusCode, 200);
  assert.equal(store.job.status, "awaiting_confirmation");
  assert.ok(store.job.proofSubmittedAt instanceof Date);
  assert.equal(store.notifications.length, 1);
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

test.after(() => { try { fs.unlinkSync(proofPath); } catch {} });

test("Worker can replace a submitted photo before Hirer confirmation; old bytes are retired only after commit", async () => {
  seed("awaiting_confirmation", true);
  const replaceHandler = controller.replaceCompletionProof[1];
  const firstPath = proofPath;
  const response = await call(replaceHandler, {
    ...reqFor("worker-1"),
    file: { buffer: png, mimetype: "image/png" },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(store.job.status, "awaiting_confirmation");
  assert.match(store.job.completionProofUrl, /^\/uploads\/job-proofs\/job-1-[\w-]+\.png$/);
  assert.equal(fs.existsSync(firstPath), false);
  const newPath = path.join(path.dirname(firstPath), path.basename(store.job.completionProofUrl));
  assert.equal(fs.readFileSync(newPath).equals(png), true);
  assert.equal(store.logs[0].note, "Worker replaced completion proof");
  assert.equal(store.notifications.length, 1);
  assert.equal((await call(controller.getCompletionProof, reqFor("worker-1"))).statusCode, 200);
  fs.unlinkSync(newPath);
});

test("Proof replacement is forbidden after completion, for non-participants, or for invalid photo data", async () => {
  seed("completed", true);
  let response = await call(controller.replaceCompletionProof[1], {
    ...reqFor("worker-1"), file: { buffer: png, mimetype: "image/png" },
  });
  assert.equal(response.statusCode, 409);
  seed("awaiting_confirmation", true);
  response = await call(controller.replaceCompletionProof[1], {
    ...reqFor("other-worker"), file: { buffer: png, mimetype: "image/png" },
  });
  assert.equal(response.statusCode, 403);
  response = await call(controller.replaceCompletionProof[1], {
    ...reqFor("worker-1"), file: { buffer: Buffer.from("fake bytes"), mimetype: "image/png" },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(store.job.completionProofUrl, "/uploads/job-proofs/pr1-confirm-picture.jpg");
  assert.equal(fs.existsSync(proofPath), true);
});

test("Proof update conflict keeps the prior picture and deletes the new uncommitted photo", async () => {
  seed("awaiting_confirmation", true);
  const before = new Set(fs.readdirSync(path.dirname(proofPath)));
  const original = models.Job.findOneAndUpdate;
  models.Job.findOneAndUpdate = async () => null;
  try {
    const response = await call(controller.replaceCompletionProof[1], {
      ...reqFor("worker-1"), file: { buffer: png, mimetype: "image/png" },
    });
    assert.equal(response.statusCode, 409);
    assert.equal(store.job.completionProofUrl, "/uploads/job-proofs/pr1-confirm-picture.jpg");
    assert.equal(fs.existsSync(proofPath), true);
    assert.deepEqual(new Set(fs.readdirSync(path.dirname(proofPath))), before);
  } finally { models.Job.findOneAndUpdate = original; }
});
