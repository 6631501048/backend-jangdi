// Dry-run by default. Only closes listings linked to completed refunds;
// never edits jobs, payment records or evidence.
const path = require('node:path');
const backend = path.resolve(__dirname, '..');
require(path.join(backend, 'node_modules/dotenv')).config({ path: path.join(backend, '.env'), quiet: true });
const mongoose = require(path.join(backend, 'node_modules/mongoose'));
const apply = process.argv.includes('--apply');
(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 10000 });
    const db = mongoose.connection;
    const payments = await db.collection('payments').find({ status: 'refunded' }, { projection: { job: 1 } }).toArray();
    const jobIds = payments.map(payment => payment.job).filter(Boolean);
    const jobs = await db.collection('jobs').find({ _id: { $in: jobIds } }, { projection: { originServiceRequest: 1 } }).toArray();
    const requests = await db.collection('servicerequests').find({ $or: [
      { resultingJob: { $in: jobIds } }, { _id: { $in: jobs.map(job => job.originServiceRequest).filter(Boolean) } },
    ] }, { projection: { servicePost: 1 } }).toArray();
    const eligible = { _id: { $in: requests.map(request => request.servicePost).filter(Boolean) },
      $or: [{ status: 'active' }, { status: 'closed', closeReason: 'capacity' }] };
    const posts = await db.collection('serviceposts').find(eligible, { projection: { _id: 1, status: 1, closeReason: 1 } }).toArray();
    console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', count: posts.length, posts }));
    if (apply && posts.length) {
      const result = await db.collection('serviceposts').updateMany({ ...eligible, _id: { $in: posts.map(post => post._id) } }, {
        $set: { status: 'closed', closeReason: 'refund', updatedAt: new Date() },
      });
      console.log(JSON.stringify({ closed: result.modifiedCount }));
    }
  } catch (error) { console.error('REFUND_POST_REPAIR_FAILED', error.code || error.name); process.exitCode = 1; }
  finally { await mongoose.disconnect(); }
})();
