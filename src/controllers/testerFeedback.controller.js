const asyncHandler=require('express-async-handler');
const mongoose=require('mongoose');
const TesterFeedback=require('../models/TesterFeedback');
const categories=['general','bug','suggestion'];
const createFeedback=asyncHandler(async(req,res)=>{
 const {message,category='general',pagePath=''}=req.body||{};
 if(typeof message!=='string'||!message.trim()||message.trim().length>2000)return res.status(400).json({message:'กรุณาใส่ความคิดเห็น 1–2000 ตัวอักษร'});
 if(!categories.includes(category))return res.status(400).json({message:'ประเภทความคิดเห็นไม่ถูกต้อง'});
 // Store only an internal pathname, never query strings or password-reset fragments.
 if(typeof pagePath!=='string'||pagePath.length>200||(pagePath!==''&&(!pagePath.startsWith('/')||pagePath.startsWith('//')||/[?#\\\s]/.test(pagePath))))return res.status(400).json({message:'หน้าที่เกี่ยวข้องไม่ถูกต้อง'});
 const item=await TesterFeedback.create({author:req.user._id,role:req.user.currentRole,category,message:message.trim(),pagePath});
 res.status(201).json({message:'ส่งความคิดเห็นถึงผู้ดูแลแล้ว ขอบคุณที่ช่วยทดสอบ JangDi',id:item._id});
});
const listFeedback=asyncHandler(async(req,res)=>{
 const status=req.query.status||'all';
 const requested=Number(req.query.page||1);
 if(!['all','new','read'].includes(status)||!Number.isSafeInteger(requested)||requested<1)return res.status(400).json({message:'ตัวกรองหรือหมายเลขหน้าไม่ถูกต้อง'});
 const filter=status==='all'?{}:{status};
 const total=await TesterFeedback.countDocuments(filter),totalPages=Math.max(1,Math.ceil(total/20)),page=Math.min(requested,totalPages);
 const items=await TesterFeedback.find(filter).select('author role category message pagePath status createdAt readAt').populate('author','fullName email avatarUrl').sort({createdAt:-1,_id:-1}).skip((page-1)*20).limit(20);
 res.json({items,total,totalPages,page});
});
const markRead=asyncHandler(async(req,res)=>{
 if(!mongoose.isValidObjectId(req.params.id))return res.status(404).json({message:'ไม่พบความคิดเห็นนี้'});
 let item=await TesterFeedback.findOneAndUpdate({_id:req.params.id,status:'new'},{$set:{status:'read',readAt:new Date(),readBy:req.user._id}},{new:true}).select('_id status readAt');
 if(!item)item=await TesterFeedback.findById(req.params.id).select('_id status readAt');
 if(!item)return res.status(404).json({message:'ไม่พบความคิดเห็นนี้'});
 res.json({message:'ทำเครื่องหมายอ่านแล้ว',item});
});
module.exports={createFeedback,listFeedback,markRead};
