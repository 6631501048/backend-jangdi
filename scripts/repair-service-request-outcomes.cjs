// Dry-run by default. Resolve only stale pending requests on closed/expired
// listings. Requests linked to a Job are skipped. No notifications are sent.
const path = require('node:path');
const backend = path.resolve(__dirname, '..');
require(path.join(backend, 'node_modules/dotenv')).config({ path: path.join(backend, '.env'), quiet: true });
const mongoose = require(path.join(backend, 'node_modules/mongoose'));
const apply = process.argv.includes('--apply');
function reasonFor(post) {
  if (!post) return 'post_closed';
  if (['closed', 'rejected'].includes(post.status)) return post.closeReason === 'capacity' ? 'capacity' : post.closeReason === 'refund' ? 'refund' : 'post_closed';
  if (post.status === 'expired' || (post.availabilityEnd && new Date(post.availabilityEnd) < new Date())) return 'expired';
  return null;
}
(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 10000 });
    const db = mongoose.connection;
    const pending = await db.collection('servicerequests').find({ status: 'pending' }, { projection: { _id: 1, servicePost: 1, resultingJob: 1 } }).toArray();
    const posts = await db.collection('serviceposts').find({ _id: { $in: pending.map(request => request.servicePost) } }, { projection: { status: 1, closeReason: 1, availabilityEnd: 1 } }).toArray();
    const byPost = new Map(posts.map(post => [String(post._id), post]));
    const jobs = await db.collection('jobs').find({ originServiceRequest: { $in: pending.map(request => request._id) } }, { projection: { originServiceRequest: 1 } }).toArray();
    const linked = new Set(jobs.map(job => String(job.originServiceRequest)));
    const candidates = pending.filter(request => !request.resultingJob && !linked.has(String(request._id)))
      .map(request => ({ ...request, reason: reasonFor(byPost.get(String(request.servicePost))) })).filter(request => request.reason);
    console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', count: candidates.length, requests: candidates.map(request => ({ id: String(request._id), reason: request.reason })) }));
    if (apply) {
      let repaired = 0;
      for (const candidate of candidates) {
        const session = await mongoose.startSession();
        try {
          let changed = 0;
          await session.withTransaction(async () => {
            changed = 0;
            const current = await db.collection('servicerequests').findOne({ _id: candidate._id, status: 'pending', resultingJob: null }, { session });
            if (!current) return;
            if (await db.collection('jobs').findOne({ originServiceRequest: current._id }, { session, projection: { _id: 1 } })) return;
            const post = await db.collection('serviceposts').findOne({ _id: current.servicePost }, { session });
            const reason = reasonFor(post);
            if (!reason) return;
            const result = await db.collection('servicerequests').updateOne({ _id: current._id, status: 'pending', resultingJob: null }, {
              $set: { status: 'declined', declineReason: reason, respondedAt: new Date(), updatedAt: new Date() },
            }, { session });
            changed = result.modifiedCount;
          });
          repaired += changed;
        } finally { await session.endSession(); }
      }
      console.log(JSON.stringify({ repaired }));
    }
  } catch (error) { console.error('REQUEST_OUTCOME_REPAIR_FAILED', error.code || error.name); process.exitCode = 1; }
  finally { await mongoose.disconnect(); }
})();
