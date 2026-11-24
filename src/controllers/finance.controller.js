const asyncHandler = require('express-async-handler');
const { Payment } = require('../models');
const finance = require('../services/finance.service');
const getOverview = asyncHandler(async (req,res) => {
  let window;
  try { window = finance.range(req.query); } catch (err) { return res.status(400).json({message:err.message}); }
  const isHirer = req.user.currentRole === 'hirer';
  const payments = await Payment.find({[isHirer ? 'hirer':'worker']:req.user._id}).populate('job','title').sort({createdAt:-1}).lean();
  res.json(finance.overview(payments,isHirer,window));
});
const getFinancials = asyncHandler(async (req,res) => {
  let window;
  try { window = finance.range(req.query); } catch (err) { return res.status(400).json({message:err.message}); }
  const payments = await Payment.find({}).lean();
  res.json(finance.financials(payments,window));
});
module.exports = {getOverview,getFinancials};
