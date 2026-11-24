function feePercent() {
  const value = Number(process.env.ESCROW_FEE_PERCENT_MIN);
  return value >= 5 && value <= 10 ? value : 7;
}
function terms() {
  return {
    feePercent: feePercent(),
    serviceOrderFeePercent: serviceOrderFeePercent(),
    serviceOrderFixedFeeAmount: serviceOrderFixedFeeAmount(),
    mockStripeFeePercent: mockStripeFeePercent(),
    mockStripeFixedFeeAmount: 10,
    paymentMode: 'slip_demo',
    bank: { name: 'ธนาคารตัวอย่าง (จำลอง)', accountNumber: '000-000-0000', accountName: 'JangDi บัญชีทดสอบ' },
    notice: 'ข้อมูลบัญชีและสลิปใช้ทดสอบเท่านั้น ไม่มีการโอนเงินจริง',
    maxSlipBytes: 2 * 1024 * 1024,
  };
}
function mockStripeFeePercent() {
  const raw = process.env.MOCK_STRIPE_FEE_PERCENT;
  if (raw == null || raw.trim() === '') return 3.65;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 && value <= 100 ? value : 3.65;
}
function serviceOrderFeePercent() {
  return feePercent();
}
function serviceOrderFixedFeeAmount() {
  return 0;
}
function calculateCombinedFees(amount) {
  const baseAmount = Math.max(0, Number(amount) || 0);
  const appPercent = feePercent();
  const appFixed = 0;
  const gatewayPercent = mockStripeFeePercent();
  const gatewayFixed = 10;
  const baseAppFee = baseAmount * appPercent / 100 + appFixed;
  const rate = gatewayPercent / 100;
  // Every job type has the same flat platform charge; Stripe costs come out of it.
  const total = baseAppFee;
  const platformFeeAmount = Math.round(total * 100) / 100;
  const gatewayFeeAmount = Math.round((baseAmount + platformFeeAmount) * rate * 100 + gatewayFixed * 100) / 100;
  return {
    appPercent, appFixed,
    platformFeeAmount,
    gatewayFeeAmount,
    totalDue: Math.round((baseAmount + platformFeeAmount) * 100) / 100,
    gatewayPercent,
    gatewayFixed,
  };
}
module.exports = { feePercent, terms, mockStripeFeePercent, serviceOrderFeePercent, serviceOrderFixedFeeAmount, calculateCombinedFees };
