// Run from backend. Read-only unless --apply is explicitly provided.
require('dotenv').config();
const mongoose = require('mongoose');
const {Payment} = require('../src/models');
const {mockStripeFeePercent} = require('../src/services/paymentTerms.service');
const {planPaymentRepair} = require('../src/services/paymentRepair.service');

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('MongoDB configuration is missing');
  await mongoose.connect(uri,{serverSelectionTimeoutMS:15000,autoIndex:false,autoCreate:false});
  const rows = await Payment.find({$or:[
    {paymentMode:'stripe_test',$or:[{mockGatewayFeePercent:null},{mockGatewayFeeAmount:null}]},
    {status:'released',hasPayoutSlip:{$ne:true},$or:[{paymentMode:{$in:['demo','slip_demo','stripe_test']}},{paymentMode:{$exists:false}}]},
  ]}).select('+slipEvidence').populate('job','status completionConfirmedAt hirer selectedWorker').lean();
  const report={apply:process.argv.includes('--apply'),scanned:rows.length,requeuePayouts:0,freezeMockFees:0,needsReview:0,updated:0,concurrentChanges:0};
  for (const row of rows) {
    const {set,needsReview} = planPaymentRepair(row,mockStripeFeePercent());
    if (needsReview) report.needsReview++;
    if (set.status === 'payout_pending') report.requeuePayouts++;
    if ('mockGatewayFeeAmount' in set) report.freezeMockFees++;
    if (!report.apply || !Object.keys(set).length) continue;
    const result = await Payment.updateOne({_id:row._id,status:row.status,updatedAt:row.updatedAt},{$set:set,$push:{slipAudit:{action:'payment_flow_repaired',at:new Date(),notes:set.status ? `ย้ายรายการปล่อยเงินอัตโนมัติเดิมเข้าคิวรอจ่าย ไม่มีหลักฐานการโอน; releasedAt เดิม ${row.releasedAt ? new Date(row.releasedAt).toISOString():'ไม่มี'}` : 'บันทึกเปอร์เซ็นต์และต้นทุน Stripe mock แยกจากค่าธรรมเนียมจริง'}}});
    if (result.modifiedCount) report.updated++; else report.concurrentChanges++;
  }
  console.log(JSON.stringify(report));
}
main().catch(error=>{console.error(error.name === 'MongoServerSelectionError' ? 'MongoDB connection failed' : error.message);process.exitCode=1;}).finally(()=>mongoose.disconnect());
