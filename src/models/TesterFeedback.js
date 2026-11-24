const mongoose=require('mongoose');
// Tester comments are separate from Feedback (job ratings between members).
const schema=new mongoose.Schema({
 author:{type:mongoose.Schema.Types.ObjectId,ref:'User',required:true},
 role:{type:String,enum:['hirer','worker'],required:true},
 category:{type:String,enum:['general','bug','suggestion'],default:'general'},
 message:{type:String,required:true,trim:true,maxlength:2000},
 pagePath:{type:String,default:'',maxlength:200},
 status:{type:String,enum:['new','read'],default:'new'},
 readAt:{type:Date,default:null},
 readBy:{type:mongoose.Schema.Types.ObjectId,ref:'User',default:null},
},{timestamps:true});
schema.index({status:1,createdAt:-1});
module.exports=mongoose.model('TesterFeedback',schema);
