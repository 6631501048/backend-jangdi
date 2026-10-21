const { JobLog } = require("../models");

/** Write an immutable status event, optionally inside the caller's transaction. */
async function logJobStatusChange({ jobId, previousStatus, newStatus, changedBy, note, session }) {
  const entry = {
    job: jobId,
    previousStatus: previousStatus || null,
    newStatus,
    changedBy,
    note: note || null,
  };
  if (session) {
    const [created] = await JobLog.create([entry], { session });
    return created;
  }
  return JobLog.create(entry);
}

module.exports = { logJobStatusChange };
