function feePercent() {
  const value = Number(process.env.ESCROW_FEE_PERCENT_MIN);
  return value >= 5 && value <= 10 ? value : 5;
}
function terms() {
  return {
    feePercent: feePercent(),
    paymentMode: 'slip_demo',
    bank: { name: 'ธนาคารตัวอย่าง (จำลอง)', accountNumber: '000-000-0000', accountName: 'JangDi บัญชีทดสอบ' },
    notice: 'ข้อมูลบัญชีและสลิปใช้ทดสอบเท่านั้น ไม่มีการโอนเงินจริง',
    maxSlipBytes: 2 * 1024 * 1024,
  };
}
module.exports = { feePercent, terms };
