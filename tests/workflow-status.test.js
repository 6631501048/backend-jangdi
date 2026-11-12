const test = require('node:test');
const assert = require('node:assert/strict');
const id = '507f1f77bcf86cd799439011';
let payment, job, requests, stripeCalls, postState;
const clone = value => value == null ? value : structuredClone(value);
function matches(record, query) {
  return record && Object.entries(query).every(([key, value]) => {
    if (value && typeof value === 'object' && '$ne' in value) return record[key] !== value.$ne;
    if (value && typeof value === 'object' && '$gt' in value) return record[key] > value.$gt;
    if (value?.$in) return value.$in.map(String).includes(String(record[key]));
    return String(record[key] ?? null) === String(value ?? null);
  });
}
function chain(read) {
  return { populate() { return this; }, select() { return this; }, lean() { return this; }, sort() { return this; }, session() { return this; },
    then(resolve, reject) { return Promise.resolve(clone(read())).then(resolve, reject); } };
}
function update(kind, query, changes, options = {}) {
  const record = kind === 'payment' ? payment : job;
  if (!matches(record, query)) return null;
  const old = clone(record);
  Object.assign(record, changes.$set || {});
  return options.new === false ? old : clone(record);
}
function stub(relative, exports) {
  const filename = require.resolve(relative);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}
stub('../src/models', {
  Payment: {
    findOne: query => chain(() => matches(payment, query) ? payment : null),
    find: query => chain(() => payment && matches(payment, query) ? [payment] : []),
    findById: () => chain(() => payment),
    findOneAndUpdate: async (...args) => update('payment', ...args),
    updateOne: async (...args) => update('payment', ...args),
  },
  Job: {
    findOne: query => chain(() => matches(job, query) ? job : null),
    find: query => chain(() => job && matches(job, query) ? [job] : []),
    findById: () => chain(() => job),
    findOneAndUpdate: async (...args) => update('job', ...args),
    updateOne: async (...args) => ({ matchedCount: update('job', ...args) ? 1 : 0 }),
  },
  ServicePost: {
    find: () => chain(() => [{ _id: 'post1' }]), findById: () => chain(() => postState),
    updateOne: async (query, changes) => {
      if (!matches(postState, query)) return { matchedCount: 0 };
      Object.assign(postState, changes.$set || {});
      postState.currentOrderCount += changes.$inc?.currentOrderCount || 0;
      return { matchedCount: 1 };
    },
  },
  ServiceRequest: { find: () => chain(() => requests), findById: () => chain(() => requests[0]) },
  JobWaiting: { find: () => chain(() => []) },
});
stub('../src/services/transaction.service', { withTransaction: async work => {
  const saved = { payment: clone(payment), job: clone(job), postState: clone(postState) };
  try { return await work({}); } catch (error) { payment = saved.payment; job = saved.job; postState = saved.postState; throw error; }
} });
stub('../src/services/stripe.service', { request: async () => { stripeCalls++; throw new Error('Must not initiate Stripe refunds'); } });
stub('../src/services/notification.service', { createNotification: async data => data, deliverNotification: async () => {} });
const workflow = require('../src/services/workflowStatus.service');
const refunds = require('../src/controllers/refund.controller');
const services = require('../src/controllers/servicePost.controller');
const jobs = require('../src/controllers/job.controller');
function reset(status = 'refunded', mode = 'stripe_test') {
  payment = { _id: id, job: id, hirer: 'hirer1', worker: 'worker1', status, paymentMode: mode,
    refundDecision: status === 'disputed' ? null : 'approved', amount: 100, platformFeeAmount: 5, stripeRefundId: null };
  job = { _id: id, hirer: 'hirer1', selectedWorker: 'worker1', status: 'disputed' };
  requests = [{ _id: 'request1', status: 'accepted', servicePost: { _id: 'post1', worker: 'worker1' }, resultingJob: { _id: id, status: 'disputed' } }];
  stripeCalls = 0;
  postState = { _id: 'post1', status: 'closed', closeReason: 'capacity', currentOrderCount: 1, availabilityEnd: new Date('2099-01-01') };
}
function invoke(handler, overrides = {}) {
  return new Promise((resolve, reject) => {
    const req = { user: { _id: 'hirer1' }, params: { id }, query: {}, body: {}, ...overrides };
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { resolve({ status: this.statusCode, body }); return this; } };
    handler(req, res, reject);
  });
}

test('payment state overrides stale work without changing the stored job', async () => {
  for (const [status, expected] of [['refunded', 'cancelled'], ['refund_pending', 'disputed'], ['disputed', 'disputed'], ['held', 'in_progress']]) {
    reset(status); job.status = 'in_progress';
    const [result] = await workflow.withJobPaymentStates([job]);
    assert.equal(result.status, expected); assert.equal(result.paymentStatus, status);
    assert.equal(job.status, 'in_progress');
  }
});
test('worker list, hirer list and request detail agree about a completed refund', async () => {
  reset();
  for (const handler of [services.getMyIncomingRequests, services.getMyOutgoingRequests]) {
    const response = await invoke(handler, { user: { _id: 'worker1' } });
    assert.equal(response.body[0].resultingJob.status, 'cancelled');
    assert.equal(response.body[0].paymentStatus, 'refunded');
  }
  const detail = await invoke(services.getIncomingRequestById, { user: { _id: 'worker1' } });
  assert.equal(detail.body.resultingJob.status, 'cancelled');
  assert.equal((await invoke(services.getIncomingRequestById, { user: { _id: 'other' } })).status, 403);
});
test('refunded jobs appear only in cancelled lists for both parties and detail agrees', async () => {
  reset();
  for (const [handler, user] of [[jobs.getMyJobs, 'hirer1'], [jobs.getMyWorkerJobs, 'worker1']]) {
    assert.equal((await invoke(handler, { user: { _id: user }, query: { status: 'disputed' } })).body.length, 0);
    const response = await invoke(handler, { user: { _id: user }, query: { status: 'cancelled' } });
    assert.equal(response.body.length, 1);
  }
  const detail = await invoke(jobs.getJobById);
  assert.equal(detail.body.status, 'cancelled'); assert.equal(detail.body.paymentStatus, 'refunded');
});
test('admin approval for every payment mode waits for transfer proof and never calls Stripe', async () => {
  for (const mode of ['demo', 'slip_demo', 'stripe_test']) {
    reset('disputed', mode);
    const req = { user: { _id: 'admin1', isAdmin: true }, body: { decision: 'approved', notes: 'ตรวจสอบหลักฐานเรียบร้อยแล้ว' } };
    await invoke(refunds.decideRefund, req);
    assert.equal(payment.status, 'refund_pending'); assert.equal(payment.refundMethod, 'admin_transfer');
    assert.equal(payment.refundAmount, 105); assert.equal(job.status, 'disputed'); assert.equal(stripeCalls, 0);
    await assert.rejects(invoke(refunds.decideRefund, req));
    await refunds.completeRefund(id, null);
    assert.equal(payment.status, 'refunded'); assert.equal(job.status, 'cancelled');
  }
});
test('existing Stripe refund cannot be converted into a second admin transfer', async () => {
  reset('disputed'); payment.stripeRefundId = 're_existing';
  await assert.rejects(invoke(refunds.decideRefund, { body: { decision: 'approved', notes: 'ตรวจสอบหลักฐานเรียบร้อยแล้ว' } }), error => error.statusCode === 409);
  assert.equal(payment.status, 'disputed'); assert.equal(stripeCalls, 0);
});
test('failed job cancellation rolls back refund completion', async () => {
  reset('refund_pending'); job.status = 'completed';
  await assert.rejects(refunds.completeRefund(id, null));
  assert.equal(payment.status, 'refund_pending'); assert.equal(job.status, 'completed');
});

const express = require('express');
const { once } = require('node:events');
const { adminOnly } = require('../src/middleware/auth.middleware');
const slips = require('../src/controllers/slipPayment.controller');
let server, base;
test.before(async () => {
  const app = express(); app.use(express.json());
  // Only the test transport supplies users; exercise the real admin role guard.
  app.use((req, res, next) => { req.user = { _id: req.headers['x-test-role'] || 'hirer1', isAdmin: req.headers['x-test-role'] === 'admin1' }; next(); });
  app.post('/admin/payments/:id/refund-decision', adminOnly, refunds.decideRefund);
  app.post('/admin/payments/:id/slips/:direction', adminOnly, ...slips.submitOutbound);
  app.use((error, req, res, next) => res.status(error.statusCode || 500).json({ message: error.message }));
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => new Promise(resolve => server.close(resolve)));
const png = Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]);
function proof(amount = '105', bytes = png) {
  const body = new FormData(); body.append('amount', amount); body.append('reference', 'BANKREF001');
  body.append('notes', 'แอดมินโอนคืนและตรวจสอบยอดแล้ว'); body.append('slip', new Blob([bytes], { type: 'image/png' }), 'refund.png'); return body;
}
const postProof = (role = 'admin1', body = proof()) => fetch(`${base}/admin/payments/${id}/slips/refund`, { method: 'POST', headers: { 'x-test-role': role }, body });
test('only admin can approve and record a return; proof finalizes payment/job and releases capacity once', async () => {
  for (const mode of ['slip_demo', 'stripe_test']) {
    reset('disputed', mode); job.originServiceRequest = 'request1';
    const decisionRequest = role => fetch(`${base}/admin/payments/${id}/refund-decision`, {
      method: 'POST', headers: { 'x-test-role': role, 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'approved', notes: 'ตรวจสอบและอนุมัติคืนเงินเต็มยอด' }),
    });
    for (const role of ['hirer1', 'worker1']) assert.equal((await decisionRequest(role)).status, 403);
    assert.equal((await decisionRequest('admin1')).status, 200);
    assert.equal(payment.status, 'refund_pending'); assert.equal(job.status, 'disputed');
    for (const role of ['hirer1', 'worker1']) assert.equal((await postProof(role)).status, 403);
    assert.equal((await postProof('admin1', proof('104'))).status, 409);
    assert.equal((await postProof('admin1', proof('105', Buffer.from('not a picture')))).status, 400);
    assert.equal(payment.status, 'refund_pending'); assert.equal(postState.currentOrderCount, 1);
    const returned = await postProof();
    assert.equal(returned.status, 200, await returned.text());
    assert.equal(payment.status, 'refunded'); assert.equal(payment.hasRefundSlip, true); assert.equal(payment.refundReference, 'BANKREF001');
    assert.equal(job.status, 'cancelled'); assert.equal(postState.currentOrderCount, 0); assert.equal(postState.status, 'active');
    assert.equal((await postProof()).status, 409); assert.equal(postState.currentOrderCount, 0); assert.equal(stripeCalls, 0);
  }
});
