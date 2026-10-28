require("dotenv").config();
const path = require("path");
const fs = require("fs");
const mongoose = require("mongoose");
const connectDB = require("../src/config/db");
const { Job, Payment, JobLog } = require("../src/models");
const { detectProofImage } = require("../src/utils/proofImage");

const proofDir = path.resolve(process.env.JOB_PROOF_DIR || path.join(__dirname, "..", "uploads", "job-proofs"));

async function main() {
  await connectDB();
  try {
    const jobs = await Job.find({ status: "completed", completionConfirmedAt: null })
      .select("_id title hirer selectedWorker completionProofUrl proofSubmittedAt updatedAt")
      .lean();
    const ids = jobs.map((job) => job._id);
    const [payments, completedLogs] = await Promise.all([
      ids.length ? Payment.find({ job: { $in: ids } }).select("job status releasedAt").lean() : [],
      ids.length ? JobLog.find({ job: { $in: ids }, newStatus: "completed" }).select("job changedBy createdAt").lean() : [],
    ]);
    const paymentByJob = new Map(payments.map((payment) => [String(payment.job), payment]));
    const logByJob = new Map(completedLogs.map((log) => [String(log.job), log]));

    const report = jobs.map((job) => {
      const match = /^\/uploads\/job-proofs\/([a-zA-Z0-9_.-]+)$/.exec(job.completionProofUrl || "");
      let proofState = "missing-reference";
      if (match) {
        try {
          proofState = detectProofImage(fs.readFileSync(path.join(proofDir, match[1]))) ? "readable" : "invalid-image";
        } catch (err) {
          proofState = err.code === "ENOENT" ? "file-missing" : "read-error";
        }
      }
      const payment = paymentByJob.get(String(job._id));
      const log = logByJob.get(String(job._id));
      return {
        jobId: String(job._id),
        title: job.title,
        proofState,
        proofSubmittedAt: job.proofSubmittedAt || null,
        completedLog: log ? { at: log.createdAt, changedBy: String(log.changedBy) } : null,
        paymentStatus: payment?.status || "missing",
        paymentReleasedAt: payment?.releasedAt || null,
      };
    });
    console.log(JSON.stringify({
      mode: "read-only dry run",
      count: report.length,
      groups: {
        proofReadable: report.filter((row) => row.proofState === "readable").length,
        proofMissingOrInvalid: report.filter((row) => row.proofState !== "readable").length,
        hasCompletedLog: report.filter((row) => row.completedLog).length,
        paymentReleased: report.filter((row) => row.paymentStatus === "released").length,
      },
      jobs: report,
      note: "No records were changed. Review evidence before any manual correction.",
    }, null, 2));
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error(`Legacy completion audit failed: ${err.message || err}`);
  process.exitCode = 1;
});
