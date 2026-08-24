const { JobLog } = require("../models");

/**
 * FR-TRACK-05 / NFR-REL-02: เขียน audit log ทุกครั้งที่สถานะงานเปลี่ยน
 * insert-only — ห้ามแก้ไข record ที่มีอยู่แล้ว
 */
async function logJobStatusChange({ jobId, previousStatus, newStatus, changedBy, note }) {
  return JobLog.create({
    job: jobId,
    previousStatus: previousStatus || null,
    newStatus,
    changedBy,
    note: note || null,
  });
}

module.exports = { logJobStatusChange };