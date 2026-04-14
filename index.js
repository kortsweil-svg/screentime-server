const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const app = express();

app.use(cors());
app.use(express.json());

let teachers = {};
let classes = {};
let students = {};
let reports = {};
let sessions = {};
let invites = {};  // { token: { studentId, used } }

function hash(p) { return crypto.createHash('sha256').update(p+'st_salt').digest('hex'); }
function token() { return crypto.randomBytes(32).toString('hex'); }
function id() { return crypto.randomBytes(8).toString('hex'); }

function auth(req,res,next){
  const t=req.headers['authorization']?.replace('Bearer ','');
  if(!t||!sessions[t]) return res.status(401).json({error:'לא מחובר'});
  req.session=sessions[t]; next();
}
function teacherOnly(req,res,next){
  if(req.session.role!=='teacher') return res.status(403).json({error:'הרשאה נדרשת'});
  next();
}

app.get('/',(req,res)=>res.json({status:'ok'}));

// ─── מורה: רישום והתחברות ─────────────────────────────────────────────────────
app.post('/api/teacher/register',(req,res)=>{
  const{username,password,name}=req.body;
  if(!username||!password||!name) return res.status(400).json({error:'חסרים פרטים'});
  if(Object.values(teachers).find(t=>t.username===username))
    return res.status(400).json({error:'שם משתמש תפוס'});
  const tid=id();
  teachers[tid]={id:tid,username,passwordHash:hash(password),name};
  const tok=token();
  sessions[tok]={userId:tid,role:'teacher',teacherId:tid};
  res.json({ok:true,token:tok,teacher:{id:tid,username,name}});
});

app.post('/api/teacher/login',(req,res)=>{
  const{username,password}=req.body;
  const t=Object.values(teachers).find(t=>t.username===username);
  if(!t||t.passwordHash!==hash(password))
    return res.status(401).json({error:'שם משתמש או סיסמה שגויים'});
  const tok=token();
  sessions[tok]={userId:t.id,role:'teacher',teacherId:t.id};
  res.json({ok:true,token:tok,teacher:{id:t.id,username:t.username,name:t.name}});
});

// ─── כיתות ───────────────────────────────────────────────────────────────────
app.post('/api/classes',auth,teacherOnly,(req,res)=>{
  const{name}=req.body;
  if(!name) return res.status(400).json({error:'נדרש שם'});
  const cid=id();
  classes[cid]={id:cid,name,teacherId:req.session.teacherId};
  res.json({ok:true,class:classes[cid]});
});
app.get('/api/classes',auth,teacherOnly,(req,res)=>{
  res.json(Object.values(classes).filter(c=>c.teacherId===req.session.teacherId));
});
app.delete('/api/classes/:id',auth,teacherOnly,(req,res)=>{
  const c=classes[req.params.id];
  if(!c||c.teacherId!==req.session.teacherId) return res.status(403).json({error:'אין הרשאה'});
  delete classes[req.params.id]; res.json({ok:true});
});

// ─── תלמידים ─────────────────────────────────────────────────────────────────

// מורה מוסיף תלמיד — מקבל חזרה קישור הצטרפות
app.post('/api/students',auth,teacherOnly,(req,res)=>{
  const{name,classId,platform}=req.body;
  if(!name||!classId) return res.status(400).json({error:'חסרים פרטים'});
  const cls=classes[classId];
  if(!cls||cls.teacherId!==req.session.teacherId)
    return res.status(403).json({error:'כיתה לא נמצאה'});
  const sid=id();
  const initials=name.split(' ').map(w=>w[0]).join('').slice(0,2);
  students[sid]={
    id:sid,name,initials,classId,teacherId:req.session.teacherId,
    platform:platform||'iOS',consent:false,
    username:null,passwordHash:null,active:false
  };
  // קישור הצטרפות חד-פעמי
  const inviteToken=token();
  invites[inviteToken]={studentId:sid,used:false,createdAt:new Date().toISOString()};
  const joinUrl=`https://screentime-server.onrender.com/join/${inviteToken}`;
  res.json({ok:true,student:{id:sid,name,classId},joinUrl});
});

app.get('/api/students',auth,teacherOnly,(req,res)=>{
  const mine=Object.values(students)
    .filter(s=>s.teacherId===req.session.teacherId)
    .map(s=>({
      id:s.id,name:s.name,initials:s.initials,
      classId:s.classId,className:classes[s.classId]?.name||'',
      platform:s.platform,consent:s.consent,active:s.active,
      hours:reports[s.id]?.dailyAverage??0,
      weeklyData:reports[s.id]?.weeklyData??[0,0,0,0,0,0,0],
      lastSync:reports[s.id]?.syncedAt??null,
    }));
  res.json(mine);
});

app.delete('/api/students/:id',auth,teacherOnly,(req,res)=>{
  const s=students[req.params.id];
  if(!s||s.teacherId!==req.session.teacherId) return res.status(403).json({error:'אין הרשאה'});
  delete students[req.params.id]; delete reports[req.params.id];
  res.json({ok:true});
});

// ─── קישור הצטרפות ───────────────────────────────────────────────────────────

// בדיקת תוקף קישור
app.get('/api/join/:inviteToken',(req,res)=>{
  const invite=invites[req.params.inviteToken];
  if(!invite||invite.used) return res.status(404).json({error:'קישור לא תקף או שכבר נוצל'});
  const student=students[invite.studentId];
  if(!student) return res.status(404).json({error:'תלמיד לא נמצא'});
  const teacher=teachers[student.teacherId];
  res.json({
    ok:true,
    studentName:student.name,
    className:classes[student.classId]?.name||'',
    teacherName:teacher?.name||'',
  });
});

// תלמיד מגדיר שם משתמש וסיסמה
app.post('/api/join/:inviteToken',(req,res)=>{
  const invite=invites[req.params.inviteToken];
  if(!invite||invite.used) return res.status(404).json({error:'קישור לא תקף'});
  const{username,password}=req.body;
  if(!username||!password) return res.status(400).json({error:'חסרים פרטים'});
  if(Object.values(students).find(s=>s.username===username))
    return res.status(400).json({error:'שם המשתמש תפוס'});
  const student=students[invite.studentId];
  student.username=username;
  student.passwordHash=hash(password);
  student.active=true;
  invite.used=true;
  const tok=token();
  sessions[tok]={userId:student.id,role:'student',teacherId:student.teacherId};
  const teacher=teachers[student.teacherId];
  res.json({
    ok:true,token:tok,
    student:{
      id:student.id,name:student.name,
      className:classes[student.classId]?.name||'',
      teacherName:teacher?.name||'',
      platform:student.platform,consent:student.consent,
    }
  });
});

// ─── תלמיד: התחברות ───────────────────────────────────────────────────────────
app.post('/api/student/login',(req,res)=>{
  const{username,password}=req.body;
  const s=Object.values(students).find(s=>s.username===username);
  if(!s||s.passwordHash!==hash(password))
    return res.status(401).json({error:'שם משתמש או סיסמה שגויים'});
  const tok=token();
  sessions[tok]={userId:s.id,role:'student',teacherId:s.teacherId};
  const teacher=teachers[s.teacherId];
  res.json({
    ok:true,token:tok,
    student:{
      id:s.id,name:s.name,
      className:classes[s.classId]?.name||'',
      teacherName:teacher?.name||'',
      platform:s.platform,consent:s.consent,
    }
  });
});

// ─── דוחות ───────────────────────────────────────────────────────────────────
app.post('/api/report',auth,(req,res)=>{
  if(req.session.role!=='student') return res.status(403).json({error:'אין הרשאה'});
  const sid=req.session.userId;
  const{dailyAverage,totalMinutes,weeklyData,consent,platform,syncedAt}=req.body;
  if(students[sid]&&consent) students[sid].consent=consent.total||false;
  reports[sid]={
    studentId:sid,dailyAverage:dailyAverage??0,totalMinutes:totalMinutes??0,
    weeklyData:weeklyData??[0,0,0,0,0,0,0],
    consent:consent??{},platform:platform??'unknown',
    syncedAt:syncedAt??new Date().toISOString()
  };
  res.json({ok:true});
});

app.get('/api/report',auth,(req,res)=>{
  if(req.session.role!=='student') return res.status(403).json({error:'אין הרשאה'});
  res.json(reports[req.session.userId]||{});
});

app.post('/api/consent',auth,(req,res)=>{
  if(req.session.role!=='student') return res.status(403).json({error:'אין הרשאה'});
  const s=students[req.session.userId];
  if(!s) return res.status(404).json({error:'לא נמצא'});
  s.consent=req.body.total||false;
  res.json({ok:true});
});

const PORT=process.env.PORT||3001;
app.listen(PORT,()=>console.log(`Server on port ${PORT}`));
