const asyncHandler = require('express-async-handler');
const {Payment,Job} = require('../models');
const stripe = require('../services/stripe.service');
const {paidTotal} = require('../services/finance.service');
// Shared by signed webhooks and server-to-server reconciliation. Never trust browser totals.
async function recordPaidSession(payment, session, heldAt = new Date()) {
  if (session.livemode === true || session.payment_status !== 'paid') return;
  if (session.id !== payment.stripeSessionId || String(payment._id) !== session.client_reference_id || session.currency !== 'thb' || session.amount_total !== Math.round(paidTotal(payment)*100)) {
    throw Object.assign(new Error('Payment amount mismatch'), {statusCode:400});
  }
  if (payment.status !== 'pending') return;
  const terms = require('../services/paymentTerms.service');
  const percent = payment.mockGatewayFeePercent ?? terms.mockStripeFeePercent();
  const fixed = payment.mockGatewayFeeFixedAmount ?? terms.terms().mockStripeFixedFeeAmount;
  const chargeAmount = payment.amount + payment.platformFeeAmount;
  const gatewayFee = Math.round((chargeAmount * percent / 100 + fixed) * 100) / 100;
  await Payment.updateOne({_id:payment._id,status:'pending',paymentMode:'stripe_test',stripeSessionId:session.id},{$set:{status:'held',heldAt,stripePaymentIntentId:session.payment_intent,mockGatewayFeePercent:percent,mockGatewayFeeFixedAmount:fixed,mockGatewayFeeAmount:gatewayFee}});
}
const syncPayment = asyncHandler(async (req,res) => {
  const payment = await Payment.findOne({job:req.params.jobId,hirer:req.user._id,paymentMode:'stripe_test'});
  if (!payment) return res.status(404).json({message:'ไม่พบรายการ Stripe ของคุณสำหรับงานนี้'});
  if (payment.status === 'pending' && payment.stripeSessionId) {
    const session = await stripe.request(`checkout/sessions/${payment.stripeSessionId}`);
    if (session.livemode !== false) return res.status(400).json({message:'Only test sessions are accepted'});
    await recordPaidSession(payment,session);
  }
  if (payment.status === 'disputed' && payment.refundDecision === 'approved' && payment.stripeRefundId) {
    const refund = await stripe.request(`refunds/${payment.stripeRefundId}`);
    await require('./refund.controller').recordStripeRefund(payment,refund);
  }
  const current = await Payment.findOne({_id:payment._id,hirer:req.user._id});
  res.json({status:current.status,message:current.status === 'pending' ? 'Stripe ยังไม่ยืนยันการชำระเงิน' : 'ตรวจสอบสถานะกับ Stripe แล้ว'});
});
const getStripeStatus = (req,res) => res.json({
  ready: stripe.configured(),
  testKeyConfigured: /^sk_test_/.test(process.env.STRIPE_SECRET_KEY || ''),
  webhookConfigured: !!process.env.STRIPE_WEBHOOK_SECRET,
});
const createCheckout = asyncHandler(async (req,res) => {
  if (!stripe.configured()) return res.status(503).json({message:'กรุณาตั้งค่า Stripe test key ที่ backend ก่อน'});
  const job = await Job.findById(req.params.jobId);
  if (!job || String(job.hirer) !== String(req.user._id)) return res.status(403).json({message:'เฉพาะผู้ว่าจ้างของงานนี้เท่านั้น'});
  if (job.status !== 'assigned') return res.status(409).json({message:'งานไม่ได้อยู่ในสถานะรอชำระเงิน'});
  // Lock this pending record to Stripe before any external request. Mock confirmation cannot race it.
  const payment = await Payment.findOneAndUpdate({job:job._id,hirer:req.user._id,worker:job.selectedWorker,status:'pending',paymentMode:{$in:['demo','stripe_test','slip_demo']}},{$set:{paymentMode:'stripe_test'}},{new:true});
  if (!payment) return res.status(409).json({message:'รายการนี้ชำระแล้วหรือไม่สามารถชำระได้'});
  // Freeze the mock rate once; changing configuration cannot change a payable session's fee.
  if (payment.mockGatewayFeePercent == null || payment.mockGatewayFeeFixedAmount == null || payment.mockGatewayFeeAmount == null) {
    const terms = require('../services/paymentTerms.service');
    const percent = payment.mockGatewayFeePercent ?? terms.mockStripeFeePercent();
    const fixed = payment.mockGatewayFeeFixedAmount ?? terms.terms().mockStripeFixedFeeAmount;
    const chargeAmount = payment.amount + payment.platformFeeAmount;
    const gatewayFee = Math.round((chargeAmount * percent / 100 + fixed) * 100) / 100;
    await Payment.updateOne({_id:payment._id,status:'pending',paymentMode:'stripe_test',mockGatewayFeePercent:payment.mockGatewayFeePercent},{$set:{mockGatewayFeePercent:percent,mockGatewayFeeFixedAmount:fixed,mockGatewayFeeAmount:gatewayFee}});
  }
  let session;
  if (payment.stripeSessionId) {
    session = await stripe.request(`checkout/sessions/${payment.stripeSessionId}`);
    if (session.status === 'open') {
      const methods = session.payment_method_types || session.allowed_payment_method_types || [];
      if (methods.includes('promptpay')) return res.json({url:session.url});
      // Close the old card-only session before replacing it: never leave two payable sessions.
      await stripe.request(`checkout/sessions/${session.id}/expire`,{method:'POST',key:`checkout-promptpay-expire-${session.id}`});
    }
    if (session.status === 'complete') return res.status(409).json({message:'ปิดขั้นตอน Checkout แล้ว กรุณาตรวจสอบสถานะล่าสุดเพื่อยืนยันผลจาก Stripe'});
  }
  const base = new URL(process.env.CLIENT_URL || 'http://localhost:5173');
  const returnUrl = new URL(`/hirer/my-jobs/${job._id}/mock-payment`,base).href;
  session = await stripe.request('checkout/sessions',{method:'POST',key:`checkout-v3-${payment._id}-${payment.stripeSessionId || 'first'}`,params:{mode:'payment',locale:'th',success_url:`${returnUrl}?checkout=success`,cancel_url:`${returnUrl}?checkout=cancelled`,client_reference_id:String(payment._id),'metadata[paymentId]':String(payment._id),'line_items[0][price_data][currency]':'thb','line_items[0][price_data][unit_amount]':Math.round(paidTotal(payment)*100),'line_items[0][price_data][product_data][name]':job.title,'line_items[0][quantity]':1,'allowed_payment_method_types[0]':'card','allowed_payment_method_types[1]':'promptpay'}});
  // A concurrent retry must not overwrite a newer Checkout session.
  await Payment.updateOne({_id:payment._id,status:'pending',paymentMode:'stripe_test',stripeSessionId:payment.stripeSessionId || null},{$set:{stripeSessionId:session.id}});
  res.json({url:session.url});
});
const webhook = asyncHandler(async (req,res) => {
  let event;
  try { event = stripe.verify(req.body,req.headers['stripe-signature']); } catch { return res.status(400).json({message:'Invalid webhook signature'}); }
  if (event.livemode) return res.status(400).json({message:'Only test events are accepted'});
  if (['checkout.session.completed','checkout.session.async_payment_succeeded'].includes(event.type)) {
    const session = event.data.object;
    if (session.payment_status !== 'paid') return res.json({received:true});
    const payment = await Payment.findOne({stripeSessionId:session.id,paymentMode:'stripe_test'});
    // A very fast webhook may arrive before the session id was persisted; ask Stripe to retry.
    if (!payment) {
      // Ignore other integrations sharing the Stripe account, but retry our own early delivery.
      if (!require('mongoose').isValidObjectId(session.metadata?.paymentId)) return res.json({received:true});
      const pending = await Payment.findOne({_id:session.metadata.paymentId,paymentMode:'stripe_test',status:'pending'});
      return pending ? res.status(503).json({message:'Payment session not ready'}) : res.json({received:true});
    }
    if (String(payment._id) !== session.client_reference_id || session.currency !== 'thb' || session.amount_total !== Math.round(paidTotal(payment)*100)) return res.status(400).json({message:'Payment amount mismatch'});
    if (payment.status !== 'pending') return res.json({received:true});
    await recordPaidSession(payment,session,new Date(event.created*1000));
  }
  if (['refund.updated','refund.created','refund.failed'].includes(event.type)) {
    const refund = event.data.object;
    const payment = await Payment.findOne({stripePaymentIntentId:refund.payment_intent,paymentMode:'stripe_test',refundDecision:'approved',status:'disputed'});
    if (payment) {
      // Events can arrive out of order: reconcile against the current Stripe object.
      const current = await stripe.request(`refunds/${refund.id}`);
      await require('./refund.controller').recordStripeRefund(payment,current);
    }
  }
  res.json({received:true});
});
module.exports = {createCheckout,webhook,getStripeStatus,syncPayment};
