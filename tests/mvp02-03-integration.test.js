"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");

const id = {
  admin:"507f1f77bcf86cd799439101", worker:"507f1f77bcf86cd799439102",
  worker2:"507f1f77bcf86cd799439103", hirer:"507f1f77bcf86cd799439104",
  post:"507f1f77bcf86cd799439105", req:"507f1f77bcf86cd799439106",
  job:"507f1f77bcf86cd799439107", feedback:"507f1f77bcf86cd799439108",
};
const db = { users:{}, posts:[], requests:[], jobs:[], payments:[], feedback:[], events:[] };
function reset() {
  db.users = {
    [id.admin]:{_id:id.admin,isAdmin:true,currentRole:"hirer",accountStatus:"active",isEmailVerified:true},
    [id.worker]:{_id:id.worker,isAdmin:false,currentRole:"worker",accountStatus:"active",isEmailVerified:true},
    [id.worker2]:{_id:id.worker2,isAdmin:false,currentRole:"worker",accountStatus:"active",isEmailVerified:true},
    [id.hirer]:{_id:id.hirer,isAdmin:false,currentRole:"hirer",accountStatus:"active",isEmailVerified:true},
  };
  db.posts = [{_id:id.post,worker:id.worker,category:"delivery",title:"Deliver package",description:"Please pick up package",fee:35,
    currentOrderCount:0,maxSimultaneousOrders:1,availabilityEnd:new Date(Date.now()+86400000),status:"active",
    location:{type:"Point",coordinates:[99.88,20.04]},createdAt:new Date()}];
  db.requests = [];
  db.jobs=[]; db.payments=[]; db.feedback=[];db.events=[];
}
reset();
function chain(value) {
  return { select(){return this;},populate(){return this;},sort(){return this;},skip(){return this;},limit(){return this;},
    then(resolve,reject){return Promise.resolve(value).then(resolve,reject);} };
}
function match(document, query) {
  return Object.entries(query).every(([k,v])=>{
    if (k==="$expr") return document.currentOrderCount < document.maxSimultaneousOrders;
    if (k==="$or") return true;
    if (k==="availabilityEnd") return document.availabilityEnd >= v.$gte;
    if (typeof v === "object" && v !== null && !(v instanceof Date)) {
      if (v.$in) return v.$in.map(String).includes(String(document[k]));
    }
    return String(document[k])===String(v);
  });
}
function update(document,patch) {
  if (patch.$set) Object.assign(document,patch.$set);
  if (patch.$inc) for(const [k,v] of Object.entries(patch.$inc)) document[k]=(document[k]||0)+v;
  return document;
}
const models = {
  User:{findById: async x=>db.users[String(x)]||null},
  ServicePost:{
    findById:async x=>db.posts.find(y=>String(y._id)===String(x))||null,
    find:filter=>chain(db.posts.filter(x=>match(x,filter))),
    findOneAndUpdate:async (f,p)=>{const post=db.posts.find(x=>match(x,f));return post?{...update(post,p)}:null;},
    updateOne:async(f,p)=>{const post=db.posts.find(x=>match(x,f));if(post)update(post,p);},
    countDocuments:async f=>db.posts.filter(x=>match(x,f)).length,
  },
  ServiceRequest:{
    findById:x=>{
      const original=db.requests.find(y=>String(y._id)===String(x));
      let doc=original?{...original}:null;
      return {
        populate(field){
          if(doc && field==='servicePost') doc.servicePost=db.posts.find(p=>String(p._id)===String(doc.servicePost))||null;
          if(doc && field==='hirer') doc.hirer=db.users[String(doc.hirer)]||null;
          if(doc && field==='resultingJob' && doc.resultingJob) doc.resultingJob=db.jobs.find(j=>String(j._id)===String(doc.resultingJob))||null;
          return this;
        },
        then(resolve,reject){return Promise.resolve(doc).then(resolve,reject);},
      };
    },
    find:filter=>chain(db.requests),
    create:async body=>{const req={_id:id.req, ...body,status:"pending"};db.requests.push(req);return req;},
    findOneAndUpdate:async(f,p)=>{const req=db.requests.find(x=>match(x,f));return req?{...update(req,p)}:null;},
    updateOne:async(f,p)=>{const req=db.requests.find(x=>match(x,f));if(req)update(req,p);},
  },
  Job:{
    findById:x=>chain(db.jobs.find(y=>String(y._id)===String(x))||null),
    create:async body=>{const job={_id:id.job,...body};db.jobs.push(job);return job;},
    deleteOne:async(f)=>{db.jobs=db.jobs.filter(j=>!match(j,f));},
    find:f=>chain(db.jobs.filter(x=>match(x,f))),
    countDocuments:async f=>db.jobs.filter(x=>match(x,f)).length,
    aggregate:async()=>[],
  },
  Payment:{create:async body=>{db.payments.push(body);return body;},deleteOne:async()=>{db.payments=[];}},
  Feedback:{findOne:f=>chain(db.feedback.find(x=>match(x,f))||null)},
};
function stub(path, exports) {
  const resolved=require.resolve(path); require.cache[resolved]={id:resolved,filename:resolved,loaded:true,exports};
}
stub("../src/models",models);
stub("../src/services/jobLog.service",{logJobStatusChange:async()=>{}});
stub("../src/services/notification.service",{notifyUser:async(_io,d)=>db.events.push(d)});
stub("../src/services/matching.service",{notifyNearbyWorkers:async()=>{}});
process.env.JWT_SECRET="mvp-02-03-test-secret";
const app=express(); app.use(express.json());
app.use("/api/service-posts",require("../src/routes/servicePost.routes"));
app.use("/api/jobs",require("../src/routes/job.routes"));
app.use("/api/admin",require("../src/routes/admin.routes"));
app.use((error,_req,res,_next)=>res.status(500).json({message:error.message}));
let server,base;
const token=x=>jwt.sign({id:x},process.env.JWT_SECRET,{expiresIn:"5m"});
async function req(method,path,{user,body}={}) {
  const response=await fetch(base+path,{method,headers:{...(user?{authorization:`Bearer ${token(user)}`} :{}),...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
  return {status:response.status,data:await response.json()};
}
const create=body=>req('POST',`/api/service-posts/${id.post}/requests`,{user:id.hirer,body});
const baseOrder={orderDetails:"Deliver to F4, food 50 THB",orderData:{from:"Campus market",to:"Dorm F4",estimatedDelivery:"18:00",requirements:"buy rice",itemBudget:50}};
test.before(async()=>{server=await new Promise(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s));});base=`http://127.0.0.1:${server.address().port}`;});
test.after(async()=>{if(server) await new Promise(r=>server.close(r));});
test('MVP-02 requires an authenticated Hirer and validates real request fields',async()=>{
  reset();
  assert.equal((await req('POST',`/api/service-posts/${id.post}/requests`,{body:baseOrder})).status,401);
  assert.equal((await req('POST',`/api/service-posts/${id.post}/requests`,{user:id.worker,body:baseOrder})).status,403);
  assert.equal((await create({orderDetails:'   '})).status,400);
  assert.equal((await create({...baseOrder,orderData:{itemBudget:-2}})).status,400);
  assert.equal((await create({...baseOrder,orderData:'bad'})).status,400);
  const response=await create(baseOrder);
  assert.equal(response.status,201);
  assert.equal(response.data.request.orderData.itemBudget,50);
  assert.equal(db.requests[0].orderData.to,'Dorm F4');
});
test('MVP-02 exact request details are private to the Service Post owner',async()=>{
  reset();await create(baseOrder);
  assert.equal((await req('GET',`/api/service-posts/requests/${id.req}`)).status,401);
  assert.equal((await req('GET',`/api/service-posts/requests/${id.req}`,{user:id.worker2})).status,403);
  const response=await req('GET',`/api/service-posts/requests/${id.req}`,{user:id.worker});
  assert.equal(response.status,200);
  assert.equal(response.data.orderData.itemBudget,50);
});
test('MVP-02 accepting a Service Request creates one linked Job and pending demo payment',async()=>{
  reset();await create(baseOrder);
  const accept=()=>req('PATCH',`/api/service-posts/requests/${id.req}`,{user:id.worker,body:{action:'accept'}});
  assert.equal((await accept()).status,200);
  assert.equal(db.requests[0].status,'accepted');
  assert.equal(db.requests[0].resultingJob,id.job);
  assert.equal(db.jobs[0].fromText,'Campus market');
  assert.equal(db.jobs[0].toText,'Dorm F4');
  assert.equal(db.jobs[0].price,35);
  assert.equal(db.payments[0].status,'pending');
  assert.equal(db.payments[0].paymentMode,'demo');
  assert.equal(db.posts[0].currentOrderCount,1);
  assert.equal(db.posts[0].status,'closed');
  assert.equal((await accept()).status,409);
  assert.equal(db.jobs.length,1);
});
test('MVP-02 declining a Service Request does not create a job',async()=>{
  reset();await create(baseOrder);
  assert.equal((await req('PATCH',`/api/service-posts/requests/${id.req}`,{user:id.worker,body:{action:'decline'}})).status,200);
  assert.equal(db.requests[0].status,'declined');
  assert.equal(db.jobs.length,0);
});
test('MVP-02 cannot accept after capacity is full or post expires',async()=>{
  reset();await create(baseOrder);db.posts[0].currentOrderCount=1;
  assert.equal((await req('PATCH',`/api/service-posts/requests/${id.req}`,{user:id.worker,body:{action:'accept'}})).status,409);
  assert.equal(db.jobs.length,0);
  reset();await create(baseOrder);db.posts[0].availabilityEnd=new Date(Date.now()-1000);
  assert.equal((await req('PATCH',`/api/service-posts/requests/${id.req}`,{user:id.worker,body:{action:'accept'}})).status,409);
});
test('MVP-03 Admin read-only Worker service post list enforces permissions',async()=>{
  reset();
  assert.equal((await req('GET','/api/admin/service-posts')).status,401);
  assert.equal((await req('GET','/api/admin/service-posts',{user:id.worker})).status,403);
  const response=await req('GET','/api/admin/service-posts?status=all',{user:id.admin});
  assert.equal(response.status,200);
  assert.equal(response.data.posts.length,1);
  assert.equal((await req('GET','/api/admin/service-posts?status=unknown',{user:id.admin})).status,400);
});
test('MVP-03 review status returns correct direction and detects existing review',async()=>{
  reset();db.jobs.push({_id:id.job,hirer:id.hirer,selectedWorker:id.worker,status:'completed'});
  assert.equal((await req('GET',`/api/jobs/${id.job}/review-status`,{user:id.worker2})).status,403);
  const first=await req('GET',`/api/jobs/${id.job}/review-status`,{user:id.hirer});
  assert.equal(first.status,200);assert.equal(first.data.reviewed,false);assert.equal(first.data.eligible,true);
  db.feedback.push({_id:id.feedback,job:id.job,direction:'hirer_to_worker',rating:4});
  assert.equal((await req('GET',`/api/jobs/${id.job}/review-status`,{user:id.hirer})).data.reviewed,true);
  assert.equal((await req('GET',`/api/jobs/${id.job}/review-status`,{user:id.worker})).data.reviewed,false);
});

test('MVP-02 concurrent accept requests create no duplicate job or payment',async()=>{
  reset();await create(baseOrder);
  const accept=()=>req('PATCH',`/api/service-posts/requests/${id.req}`,{user:id.worker,body:{action:'accept'}});
  const [a,b]=await Promise.all([accept(),accept()]);
  assert.deepEqual([a.status,b.status].sort(),[200,409]);
  assert.equal(db.jobs.length,1);
  assert.equal(db.payments.length,1);
});
