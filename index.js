<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>מעקב זמן מסך — מורה</title>
  <link rel="manifest" href="manifest.json"/>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    :root{--bg:#fff;--bg2:#f5f5f3;--bg3:#eeede8;--text:#1a1a18;--text2:#6b6b67;--border:rgba(0,0,0,0.12);--border2:rgba(0,0,0,0.22);--green:#3B6D11;--green-bg:#EAF3DE;--amber:#854F0B;--amber-bg:#FAEEDA;--red:#A32D2D;--red-bg:#FCEBEB;--blue:#185FA5;--blue-bg:#E6F1FB;--r:8px;--rl:12px}
    @media(prefers-color-scheme:dark){:root{--bg:#1a1a18;--bg2:#242420;--bg3:#2c2c2a;--text:#f0efe8;--text2:#9a9a94;--border:rgba(255,255,255,0.12);--border2:rgba(255,255,255,0.22);--green-bg:#173404;--amber-bg:#412402;--red-bg:#501313;--blue-bg:#042C53}}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--bg3);color:var(--text);min-height:100vh}
    header{background:var(--bg);border-bottom:0.5px solid var(--border);padding:0 1.5rem;display:flex;align-items:center;justify-content:space-between;height:56px;position:sticky;top:0;z-index:10}
    .logo{font-size:16px;font-weight:500}
    .logo span{font-size:13px;color:var(--text2);font-weight:400;margin-right:8px}
    nav{display:flex;gap:4px}
    .nav-btn{padding:6px 14px;border-radius:var(--r);border:none;background:transparent;font-size:14px;cursor:pointer;color:var(--text2);font-family:inherit}
    .nav-btn.active{background:var(--bg2);color:var(--text);font-weight:500}
    main{max-width:900px;margin:0 auto;padding:1.5rem}
    .screen{display:none}.screen.active{display:block}
    .metric-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-bottom:1.25rem}
    .metric{background:var(--bg2);border-radius:var(--r);padding:.75rem 1rem}
    .metric-label{font-size:12px;color:var(--text2);margin-bottom:4px}
    .metric-val{font-size:24px;font-weight:500}
    .card{background:var(--bg);border:0.5px solid var(--border);border-radius:var(--rl);padding:1.25rem;margin-bottom:1rem}
    .card-title{font-size:15px;font-weight:500;margin-bottom:4px}
    .card-sub{font-size:13px;color:var(--text2);margin-bottom:1rem}
    .badge{display:inline-block;font-size:11px;padding:2px 8px;border-radius:var(--r);font-weight:500}
    .badge-green{background:var(--green-bg);color:var(--green)}
    .badge-amber{background:var(--amber-bg);color:var(--amber)}
    .badge-red{background:var(--red-bg);color:var(--red)}
    .badge-gray{background:var(--bg2);color:var(--text2)}
    .student-row{display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:0.5px solid var(--border)}
    .student-row:last-child{border-bottom:none}
    .avatar{width:38px;height:38px;border-radius:50%;background:var(--blue-bg);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:500;color:var(--blue);flex-shrink:0}
    .bar-bg{height:6px;background:var(--bg2);border-radius:3px;overflow:hidden;flex:1}
    .bar-fill{height:100%;border-radius:3px}
    .alert-box{background:var(--amber-bg);border:0.5px solid rgba(133,79,11,0.3);border-radius:var(--r);padding:.75rem 1rem;font-size:13px;color:var(--amber);margin-bottom:.75rem}
    .btn{padding:8px 16px;border-radius:var(--r);border:0.5px solid var(--border2);background:var(--bg);font-size:14px;cursor:pointer;color:var(--text);font-family:inherit}
    .btn:hover{background:var(--bg2)}
    .btn-primary{background:var(--text);color:var(--bg);border-color:transparent}
    .btn-primary:hover{opacity:.85;background:var(--text)}
    .btn-danger{border-color:rgba(163,45,45,0.4);color:var(--red)}
    .btn-danger:hover{background:var(--red-bg)}
    .btn-blue{background:var(--blue);color:#fff;border-color:transparent}
    .btn-blue:hover{opacity:.85}
    select,input[type=text],input[type=password]{padding:7px 10px;border:0.5px solid var(--border2);border-radius:var(--r);background:var(--bg);color:var(--text);font-size:14px;font-family:inherit}
    .form-group{margin-bottom:1rem}
    .form-label{font-size:13px;color:var(--text2);margin-bottom:6px;display:block}
    .week-chart{display:flex;align-items:flex-end;gap:6px;height:90px;margin-top:.75rem}
    .week-col{display:flex;flex-direction:column;align-items:center;flex:1;gap:4px}
    .week-bar{width:100%;border-radius:3px 3px 0 0;min-height:2px}
    .week-lbl{font-size:11px;color:var(--text2)}
    .toolbar{display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem;gap:8px;flex-wrap:wrap}
    .code-display{font-size:48px;font-weight:500;letter-spacing:10px;text-align:center;padding:1rem 0;color:var(--text)}
    /* Auth */
    .auth-wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1rem}
    .auth-card{background:var(--bg);border:0.5px solid var(--border);border-radius:var(--rl);padding:2rem;width:100%;max-width:380px}
    .auth-title{font-size:20px;font-weight:500;margin-bottom:6px;text-align:center}
    .auth-sub{font-size:13px;color:var(--text2);margin-bottom:1.5rem;text-align:center}
    .auth-input{width:100%;padding:10px 12px;border:0.5px solid var(--border2);border-radius:var(--r);background:var(--bg);color:var(--text);font-size:15px;font-family:inherit;margin-bottom:.75rem}
    .auth-btn{width:100%;padding:12px;border-radius:var(--r);border:none;background:var(--text);color:var(--bg);font-size:15px;font-weight:500;cursor:pointer;font-family:inherit;margin-bottom:.75rem}
    .auth-btn:hover{opacity:.85}
    .auth-toggle{font-size:13px;color:var(--text2);text-align:center}
    .auth-toggle a{color:var(--blue);cursor:pointer}
    .auth-error{background:var(--red-bg);color:var(--red);border-radius:var(--r);padding:.5rem .75rem;font-size:13px;margin-bottom:.75rem;display:none}
    @media(max-width:600px){.metric-grid{grid-template-columns:repeat(2,minmax(0,1fr))};header{padding:0 1rem};main{padding:1rem}}
    .student-detail{padding:10px 0 4px 0;border-top:0.5px solid var(--border);margin-top:6px}
    .detail-card{background:var(--bg2);border-radius:var(--r);padding:.75rem;margin-bottom:6px}
    .detail-card-title{font-size:12px;font-weight:500;color:var(--text2);margin-bottom:6px;text-transform:uppercase;letter-spacing:.04em}
    .app-row{display:flex;justify-content:space-between;align-items:center;font-size:13px;padding:4px 0;border-bottom:0.5px solid var(--border)}
    .app-row:last-child{border-bottom:none}
    .time-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:6px}
    .time-block{background:var(--bg);border-radius:var(--r);padding:6px;text-align:center;border:0.5px solid var(--border)}
    .time-lbl{font-size:11px;color:var(--text2)}
    .time-val{font-size:14px;font-weight:500;color:var(--text)}
    .expand-btn{background:none;border:none;cursor:pointer;color:var(--text2);font-size:12px;padding:0;font-family:inherit}
  </style>
</head>
<body>

<div id="auth-screen" class="auth-wrap">
  <div class="auth-card">
    <div id="auth-title" class="auth-title">כניסה למורה</div>
    <div id="auth-sub" class="auth-sub">הזן את פרטי הכניסה שלך</div>
    <div id="auth-error" class="auth-error"></div>
    <div id="reg-name-wrap" style="display:none">
      <input class="auth-input" type="text" id="auth-fullname" placeholder="שם מלא"/>
      <select class="auth-input" id="auth-security-q" style="margin-bottom:.75rem">
        <option value="">בחר שאלת אבטחה</option>
        <option value="school">שם בית הספר שלך?</option>
        <option value="city">באיזו עיר גרת בילדות?</option>
        <option value="teacher">שם המורה האהוב עליך?</option>
        <option value="pet">שם חיית המחמד הראשונה שלך?</option>
      </select>
      <input class="auth-input" type="text" id="auth-security-a" placeholder="תשובה לשאלת האבטחה"/>
    </div>
    <input class="auth-input" type="text" id="auth-username" placeholder="שם משתמש"/>
    <input class="auth-input" type="password" id="auth-password" placeholder="סיסמה"/>
    <button class="auth-btn" id="auth-submit" onclick="submitAuth()">כניסה</button>
    <div class="auth-toggle">
      <span id="auth-toggle-txt">אין לך חשבון?</span>
      <a onclick="toggleMode()"> הירשם כאן</a>
    </div>
    <div class="auth-toggle" style="margin-top:8px">
      <a onclick="showForgot()" id="forgot-link">שכחתי סיסמה</a>
    </div>
    <div id="forgot-wrap" style="display:none;margin-top:1rem;border-top:0.5px solid var(--border);padding-top:1rem">
      <div style="font-size:14px;font-weight:500;margin-bottom:.75rem;color:var(--text)">שחזור סיסמה</div>
      <input class="auth-input" type="text" id="forgot-username" placeholder="שם משתמש"/>
      <div id="forgot-question" style="display:none">
        <div id="forgot-q-text" style="font-size:13px;color:var(--text2);margin-bottom:.5rem"></div>
        <input class="auth-input" type="text" id="forgot-answer" placeholder="תשובה"/>
        <input class="auth-input" type="password" id="forgot-newpass" placeholder="סיסמה חדשה"/>
        <button class="auth-btn" onclick="doReset()">אפס סיסמה</button>
      </div>
      <div id="forgot-question-hidden" style="display:none"></div>
      <button class="auth-btn" id="forgot-check-btn" onclick="checkSecurity()" style="display:block">המשך</button>
    </div>
  </div>
</div>

<div id="app-screen" style="display:none">
  <header>
    <div class="logo">מעקב זמן מסך <span id="teacher-header"></span></div>
    <nav>
      <button class="nav-btn active" onclick="showScreen('dashboard')">דשבורד</button>
      <button class="nav-btn" onclick="showScreen('students')">תלמידים</button>
      <button class="nav-btn" onclick="showScreen('manage')">ניהול</button>
      <button class="nav-btn" onclick="logout()" style="color:var(--red)">יציאה</button>
    </nav>
  </header>
  <main>

    <div id="screen-dashboard" class="screen active">
      <!-- קוד מוסד בולט -->
      <div class="card" style="border-color:rgba(24,95,165,0.3);background:var(--blue-bg)">
        <div style="font-size:12px;color:var(--blue);margin-bottom:4px">קוד המוסד — שתף עם התלמידים</div>
        <div style="display:flex;justify-content:space-between;align-items:center">
          <div class="code-display" id="inst-code-display" style="padding:0;font-size:36px;letter-spacing:8px"></div>
          <div style="display:flex;gap:8px">
            <button class="btn btn-blue" onclick="copyCode()">העתק</button>
            <button class="btn" onclick="shareCode()">שתף ↗</button>
          </div>
        </div>
      </div>
      <div class="metric-grid" id="dash-metrics"></div>
      <div id="dash-alerts"></div>
      <div class="card">
        <div class="card-title">התפלגות זמן מסך</div>
        <div class="card-sub">כל התלמידים — שבוע נוכחי</div>
        <div class="week-chart" id="dist-chart"></div>
      </div>
      <div class="card" style="margin-top:0">
        <div class="card-title">ממוצע לפי כיתה</div>
        <div id="class-breakdown"></div>
      </div>
    </div>

    <div id="screen-students" class="screen">
      <div class="card">
        <div class="toolbar">
          <div class="card-title" style="margin-bottom:0">תלמידים</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <select id="filter-class" onchange="renderStudents()"><option value="">כל הכיתות</option></select>
            <select id="filter-status" onchange="renderStudents()">
              <option value="">כל הסטטוסים</option>
              <option value="high">גבוה (7+ש')</option>
              <option value="medium">מתון (3-7ש')</option>
              <option value="low">תקין (עד 3ש')</option>
              <option value="no-consent">ללא הסכמה</option>
            </select>
          </div>
        </div>
        <div style="margin-top:1rem" id="students-list"></div>
      </div>
    </div>

    <div id="screen-manage" class="screen">
      <div class="card">
        <div class="card-title">קוד המוסד</div>
        <div class="card-sub">שתף קוד אחד עם כל התלמידים — כל אחד יירשם בעצמו</div>
        <div class="code-display" id="manage-code-display"></div>
        <div style="display:flex;gap:8px;justify-content:center;margin-top:.5rem">
          <button class="btn btn-blue" onclick="copyCode()">העתק קוד</button>
          <button class="btn" onclick="shareCode()">שתף ↗</button>
        </div>
      </div>
      <div class="card">
        <div class="card-title">ניהול תלמידים</div>
        <div id="manage-list"></div>
      </div>
    </div>

  </main>
</div>

<script>
const SERVER='https://screentime-server.onrender.com';
let token=localStorage.getItem('teacher_token');
let teacherName=localStorage.getItem('teacher_name')||'';
let institutionCode=localStorage.getItem('institution_code')||'';
let isReg=false;

const api=(path,method='GET',body=null)=>fetch(SERVER+path,{
  method,headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},
  body:body?JSON.stringify(body):null
}).then(r=>r.json());

function color(h){return h<3?'#3B6D11':h<6?'#854F0B':'#A32D2D'}
function badge(h,consent){
  if(!consent) return '<span class="badge badge-gray">ללא הסכמה</span>';
  if(h<3) return '<span class="badge badge-green">תקין</span>';
  if(h<6) return '<span class="badge badge-amber">מתון</span>';
  return '<span class="badge badge-red">גבוה</span>';
}

function showError(msg){const e=document.getElementById('auth-error');e.textContent=msg;e.style.display='block'}

function showForgot(){
  const w = document.getElementById('forgot-wrap');
  const l = document.getElementById('forgot-link');
  w.style.display = w.style.display==='none' ? 'block' : 'none';
  l.textContent = w.style.display==='none' ? 'שכחתי סיסמה' : 'סגור';
}

async function checkSecurity(){
  const username = document.getElementById('forgot-username').value.trim();
  if(!username){alert('נא להכניס שם משתמש');return;}
  const btn = document.getElementById('forgot-check-btn');
  btn.textContent='...';btn.disabled=true;
  try {
    const res = await fetch(SERVER+'/api/teacher/check-security',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({username, securityAnswer:'__check__'})
    });
    const data = await res.json();
    const q = data.question || (data.error === 'תשובה שגויה' ? true : null);
    if(q || data.error === 'תשובה שגויה'){
      const r2 = await fetch(SERVER+'/api/teacher/check-security',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({username, securityAnswer:''})
      });
      const d2 = await r2.json();
      document.getElementById('forgot-q-text').textContent = d2.question||'שאלת האבטחה שלך';
      document.getElementById('forgot-question').style.display='block';
      document.getElementById('forgot-check-btn').style.display='none';
      document.getElementById('forgot-question-hidden').textContent=username;
    } else {
      alert(data.error||'שגיאה');
    }
  } catch(e){alert('שגיאה בחיבור');}
  btn.textContent='המשך';btn.disabled=false;
}

async function checkSecurityStep2(){
  const username = document.getElementById('forgot-question-hidden').textContent;
  if(!username) return;
  try {
    const res = await fetch(SERVER+'/api/teacher/check-security',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({username, securityAnswer:''})
    });
    const data = await res.json();
    if(data.question){
      document.getElementById('forgot-q-text').textContent = data.question;
      document.getElementById('forgot-question').style.display='block';
      document.getElementById('forgot-check-btn').style.display='none';
    }
  } catch(e){}
}

async function doReset(){
  const username = document.getElementById('forgot-username').value.trim();
  const answer = document.getElementById('forgot-answer').value.trim();
  const newpass = document.getElementById('forgot-newpass').value;
  if(!answer||!newpass){alert('נא למלא את כל השדות');return;}
  if(newpass.length<4){alert('הסיסמה חייבת להכיל לפחות 4 תווים');return;}
  try {
    const res = await fetch(SERVER+'/api/teacher/reset-password',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({username, securityAnswer:answer, newPassword:newpass})
    });
    const data = await res.json();
    if(data.ok){
      alert('הסיסמה אופסה בהצלחה! אפשר להתחבר עם הסיסמה החדשה.');
      document.getElementById('forgot-wrap').style.display='none';
      document.getElementById('forgot-link').textContent='שכחתי סיסמה';
    } else {
      alert(data.error||'שגיאה');
    }
  } catch(e){alert('שגיאה בחיבור');}
}

function toggleMode(){
  isReg=!isReg;
  document.getElementById('auth-title').textContent=isReg?'הרשמה':'כניסה למורה';
  document.getElementById('auth-sub').textContent=isReg?'צור חשבון מורה חדש':'הזן את פרטי הכניסה שלך';
  document.getElementById('auth-submit').textContent=isReg?'הרשמה':'כניסה';
  document.getElementById('auth-toggle-txt').textContent=isReg?'כבר יש לך חשבון?':'אין לך חשבון?';
  document.querySelector('#auth-screen .auth-toggle a').textContent=isReg?' התחבר כאן':' הירשם כאן';
  document.getElementById('reg-name-wrap').style.display=isReg?'block':'none';
  document.getElementById('auth-error').style.display='none';
}

async function submitAuth(){
  const username=document.getElementById('auth-username').value.trim();
  const password=document.getElementById('auth-password').value;
  if(!username||!password){showError('נא למלא שם משתמש וסיסמה');return}
  const btn=document.getElementById('auth-submit');
  btn.textContent='...';btn.disabled=true;
  try{
    let data;
    if(isReg){
      const name=document.getElementById('auth-fullname').value.trim();
      if(!name){showError('נא למלא שם מלא');btn.textContent='הרשמה';btn.disabled=false;return}
      const secQ = document.getElementById('auth-security-q').value;
      const secA = document.getElementById('auth-security-a').value.trim();
      if(!secQ||!secA){showError('נא לבחור שאלת אבטחה ולמלא תשובה');btn.textContent='הרשמה';btn.disabled=false;return;}
      data=await api('/api/teacher/register','POST',{username,password,name,securityQuestion:secQ,securityAnswer:secA});
    } else {
      data=await api('/api/teacher/login','POST',{username,password});
    }
    if(!data.ok){showError(data.error||'שגיאה');btn.textContent=isReg?'הרשמה':'כניסה';btn.disabled=false;return}
    token=data.token;
    teacherName=data.teacher.name;
    institutionCode=data.teacher.institutionCode||'';
    localStorage.setItem('teacher_token',token);
    localStorage.setItem('teacher_name',teacherName);
    localStorage.setItem('institution_code',institutionCode);
    enterApp();
  }catch(e){showError('לא ניתן להתחבר לשרת');btn.textContent=isReg?'הרשמה':'כניסה';btn.disabled=false}
}

function enterApp(){
  document.getElementById('auth-screen').style.display='none';
  document.getElementById('app-screen').style.display='block';
  document.getElementById('teacher-header').textContent=teacherName;
  const c=institutionCode||localStorage.getItem('institution_code')||'';
  document.getElementById('inst-code-display').textContent=c;
  document.getElementById('manage-code-display').textContent=c;
  renderDashboard();
}

function logout(){
  localStorage.removeItem('teacher_token');localStorage.removeItem('teacher_name');
  token=null;
  document.getElementById('auth-screen').style.display='flex';
  document.getElementById('app-screen').style.display='none';
}

function showScreen(s){
  document.querySelectorAll('.screen').forEach(el=>el.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach((b,i)=>b.classList.toggle('active',['dashboard','students','manage'][i]===s));
  document.getElementById('screen-'+s).classList.add('active');
  if(s==='dashboard') renderDashboard();
  if(s==='students') renderStudents();
  if(s==='manage') renderManage();
}

function copyCode(){
  const code=localStorage.getItem('institution_code')||'';
  navigator.clipboard.writeText(code).then(()=>alert('קוד הועתק: '+code));
}

function shareCode(){
  const code=localStorage.getItem('institution_code')||'';
  const text='הורד את אפליקציית מעקב זמן מסך והכנס את קוד המוסד: '+code;
  if(navigator.share){navigator.share({title:'הצטרפות לאפליקציה',text});}
  else{navigator.clipboard.writeText(text);alert('הועתק!');}
}

async function renderDashboard(){
  document.getElementById('dash-metrics').innerHTML='<div style="color:var(--text2);font-size:13px">טוען...</div>';
  const data=await api('/api/students');
  if(data.error){document.getElementById('dash-metrics').innerHTML='';return}
  const active=data.filter(s=>s.consent);
  const avg=active.length?(active.reduce((a,s)=>a+s.hours,0)/active.length):0;
  const alerts=active.filter(s=>s.hours>=7);
  document.getElementById('dash-metrics').innerHTML=`
    <div class="metric"><div class="metric-label">תלמידים רשומים</div><div class="metric-val">${data.length}</div></div>
    <div class="metric"><div class="metric-label">ממוצע יומי</div><div class="metric-val">${avg.toFixed(1)}ש'</div></div>
    <div class="metric"><div class="metric-label">דורשים תשומת לב</div><div class="metric-val" style="color:var(--red)">${alerts.length}</div></div>`;
  document.getElementById('dash-alerts').innerHTML=alerts.map(s=>`
    <div class="alert-box"><strong>${s.name}</strong> — ${s.hours.toFixed(1)} שעות מסך ביום</div>`).join('');
  const maxH=Math.max(...active.map(s=>s.hours),1);
  document.getElementById('dist-chart').innerHTML=active.map(s=>`
    <div class="week-col">
      <div class="week-bar" style="height:${Math.round(s.hours/maxH*70)}px;background:${color(s.hours)}"></div>
      <div class="week-lbl">${s.initials||s.name?.slice(0,2)}</div>
    </div>`).join('');

  // התפלגות לפי כיתה
  const classes = {};
  data.forEach(s => {
    if (!classes[s.className]) classes[s.className] = {total:0, count:0, students:0};
    classes[s.className].students++;
    if (s.consent && s.hours > 0) { classes[s.className].total += s.hours; classes[s.className].count++; }
  });
  const classEl = document.getElementById('class-breakdown');
  if (classEl) {
    const rows = Object.entries(classes).sort((a,b)=>a[0].localeCompare(b[0], 'he'));
    if (!rows.length) { classEl.innerHTML='<div style="font-size:13px;color:var(--text2)">אין נתונים</div>'; return; }
    classEl.innerHTML = `
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:0;margin-bottom:4px">
        <div style="font-size:11px;color:var(--text2);padding:4px 0">כיתה</div>
        <div style="font-size:11px;color:var(--text2);padding:4px 0;text-align:center">ממוצע</div>
        <div style="font-size:11px;color:var(--text2);padding:4px 0;text-align:center">תלמידים</div>
        <div style="font-size:11px;color:var(--text2);padding:4px 0;text-align:center">סטטוס</div>
      </div>` +
      rows.map(([cls, d]) => {
        const avg = d.count ? d.total/d.count : 0;
        const statusBadge = d.count === 0
          ? `<span class="badge badge-gray">אין נתונים</span>`
          : avg < 3 ? `<span class="badge badge-green">תקין</span>`
          : avg < 6 ? `<span class="badge badge-amber">מתון</span>`
          : `<span class="badge badge-red">גבוה</span>`;
        return `<div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:0;padding:7px 0;border-top:0.5px solid var(--border)">
          <div style="font-size:14px;font-weight:500">${cls}</div>
          <div style="font-size:13px;text-align:center">${d.count ? avg.toFixed(1)+"ש'" : "—"}</div>
          <div style="font-size:13px;text-align:center;color:var(--text2)">${d.students}</div>
          <div style="text-align:center">${statusBadge}</div>
        </div>`;
      }).join('');
  }
}

let allStudentsData = [];
let expandedStudentId = null;

async function renderStudents(){
  document.getElementById('students-list').innerHTML='<div style="color:var(--text2);font-size:13px;padding:1rem 0">טוען...</div>';
  const data=await api('/api/students');
  if(data.error){document.getElementById('students-list').innerHTML='';return}
  allStudentsData = data;
  const cls=document.getElementById('filter-class')?.value||'';
  const status=document.getElementById('filter-status')?.value||'';
  const classes=[...new Set(data.map(s=>s.className))].sort();
  const sel=document.getElementById('filter-class');
  if(sel){const cur=sel.value;sel.innerHTML='<option value="">כל הכיתות</option>'+classes.map(c=>`<option value="${c}">${c}</option>`).join('');sel.value=cur}
  let f=data;
  if(cls) f=f.filter(s=>s.className===cls);
  if(status==='high') f=f.filter(s=>s.consent&&s.hours>=7);
  if(status==='medium') f=f.filter(s=>s.consent&&s.hours>=3&&s.hours<7);
  if(status==='low') f=f.filter(s=>s.consent&&s.hours<3);
  if(status==='no-consent') f=f.filter(s=>!s.consent);
  renderStudentsList(f);
}

function renderStudentsList(f){
  const avgHours = allStudentsData.filter(s=>s.consent&&s.hours>0).reduce((a,s,i,arr)=>a+s.hours/arr.length,0);
  document.getElementById('students-list').innerHTML=f.length?f.map(s=>`
    <div class="student-row" style="flex-direction:column;align-items:stretch;cursor:pointer" onclick="toggleStudent('${s.id}')">
      <div style="display:flex;align-items:center;gap:12px">
        <div class="avatar">${s.initials||s.name?.slice(0,2)}</div>
        <div style="flex:1;min-width:0">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
            <div><span style="font-size:14px;font-weight:500">${s.name}</span>
            <span style="font-size:11px;color:var(--text2);margin-right:6px">${s.className}</span></div>
            <div style="display:flex;gap:6px;align-items:center">
              ${badge(s.hours,s.consent)}
              <span style="font-size:13px;font-weight:500">${s.consent?s.hours.toFixed(1)+"ש'":'—'}</span>
              <span style="font-size:11px;color:var(--text2)">${expandedStudentId===s.id?'▲':'▼'}</span>
            </div>
          </div>
          ${s.consent
            ?`<div class="bar-bg"><div class="bar-fill" style="width:${Math.min(100,Math.round(s.hours/12*100))}%;background:${color(s.hours)}"></div></div>`
            :`<div style="font-size:12px;color:var(--text2)">ממתין לאישור שיתוף</div>`}
          ${s.lastSync?`<div style="font-size:11px;color:var(--text2);margin-top:2px">סונכרן: ${new Date(s.lastSync).toLocaleString('he-IL')}</div>`:''}
        </div>
      </div>
      ${expandedStudentId===s.id && s.consent ? renderStudentDetail(s, avgHours) : ''}
    </div>`).join(''):'<div style="text-align:center;padding:2rem;color:var(--text2);font-size:14px">אין תלמידים עדיין</div>';
}

function renderStudentDetail(s, avgHours){
  const consent = s.rawConsent || {};
  const byApp = (typeof s.byApp === 'string') ? JSON.parse(s.byApp) : (s.byApp || {});
  console.log('byApp for', s.name, ':', JSON.stringify(byApp));
  const timing = (typeof s.timing === 'string') ? JSON.parse(s.timing) : (s.timing || {});
  const diff = s.hours - avgHours;
  const diffStr = diff > 0 ? `+${diff.toFixed(1)}ש' מעל הממוצע` : diff < 0 ? `${diff.toFixed(1)}ש' מתחת לממוצע` : 'בדיוק בממוצע';
  const diffColor = diff > 1 ? 'var(--red)' : diff < -1 ? 'var(--green)' : 'var(--text2)';

  const appsHtml = (()=>{
    const blockList = ['launcher','signin','gms','systemui','packageinstaller','inputmethod','permissioncontroller','screentimestudent','com.android','android.settings','android.vending','google.settings','playconsole'];
    const filtered = Object.entries(byApp)
      .filter(([pkg]) => {
        const p = pkg.toLowerCase();
        const userApps = ['youtube','chrome','whatsapp','instagram','facebook','tiktok','snapchat','telegram','twitter','spotify','netflix','gmail','maps','photos','camera','gallery','music','podcast','games','browser','sbrowser'];
        if(userApps.some(a => p.includes(a))) return true;
        return !blockList.some(b => p.includes(b));
      })
      .map(([pkg,mins]) => [pkg, Number(mins)])
      .filter(([,mins]) => mins > 0)
      .sort((a,b) => Number(b[1])-Number(a[1]))
      .slice(0,8);
    if(!filtered.length) return '<div style="font-size:12px;color:var(--text2)">לא נמצאו אפליקציות משתמש</div>';
    const appNames = {'android.youtube':'YouTube','android.chrome':'Chrome','com.whatsapp':'WhatsApp','com.instagram.android':'Instagram','com.facebook.katana':'Facebook','com.tiktok':'TikTok','android.googlequicksearchbox':'Google','app.sbrowser':'Samsung Browser'};
    return filtered.map(([pkg,mins])=>{
      const name = appNames[pkg] || pkg.split('.').slice(-1)[0];
      const display = Number(mins) >= 60 ? (Number(mins)/60).toFixed(1)+"ש'" : Number(mins)+"ד'";
      return `<div class="app-row"><span>${name}</span><span style="font-weight:500">${display}</span></div>`;
    }).join('');
  })();

  const t2 = (typeof timing === 'string') ? JSON.parse(timing) : (timing||{});
  const timingHtml = `
    <div class="time-grid">
      <div class="time-block"><div class="time-lbl">בוקר</div><div class="time-val">${t2.morning||'—'}</div></div>
      <div class="time-block"><div class="time-lbl">צהריים</div><div class="time-val">${t2.noon||'—'}</div></div>
      <div class="time-block"><div class="time-lbl">ערב</div><div class="time-val">${t2.evening||'—'}</div></div>
      <div class="time-block"><div class="time-lbl">לילה</div><div class="time-val">${t2.night||'—'}</div></div>
    </div>`;

  return `<div class="student-detail" onclick="event.stopPropagation()">
    <div class="detail-card">
      <div class="detail-card-title">אפליקציות מובילות</div>
      ${appsHtml}
    </div>
    <div class="detail-card">
      <div class="detail-card-title">שעות שימוש</div>
      ${timingHtml}
    </div>
    <div class="detail-card">
      <div class="detail-card-title">השוואה לממוצע הכיתה (${avgHours.toFixed(1)}ש')</div>
      <div style="font-size:13px;color:${diffColor};font-weight:500">${diffStr}</div>
      <div style="display:flex;gap:4px;align-items:center;margin-top:6px">
        <div style="height:6px;border-radius:3px;flex:${Math.min(s.hours/12,1)};background:${color(s.hours)}"></div>
        <div style="height:6px;border-radius:3px;flex:${Math.max(0,1-s.hours/12)};background:var(--bg3)"></div>
      </div>
    </div>
  </div>`;
}

function toggleStudent(id){
  expandedStudentId = expandedStudentId === id ? null : id;
  const cls=document.getElementById('filter-class')?.value||'';
  const status=document.getElementById('filter-status')?.value||'';
  let f=allStudentsData;
  if(cls) f=f.filter(s=>s.className===cls);
  if(status==='high') f=f.filter(s=>s.consent&&s.hours>=7);
  if(status==='medium') f=f.filter(s=>s.consent&&s.hours>=3&&s.hours<7);
  if(status==='low') f=f.filter(s=>s.consent&&s.hours<3);
  if(status==='no-consent') f=f.filter(s=>!s.consent);
  renderStudentsList(f);
}

async function renderManage(){
  const data=await api('/api/students');
  if(!data.error){
    document.getElementById('manage-list').innerHTML=data.length?data.map(s=>`
      <div class="student-row">
        <div class="avatar">${s.initials||s.name?.slice(0,2)}</div>
        <div style="flex:1">
          <div style="font-size:14px;font-weight:500">${s.name}</div>
          <div style="font-size:12px;color:var(--text2)">${s.className} · ${s.consent?'אישר':'ממתין'}</div>
        </div>
        <button class="btn btn-danger" style="font-size:13px" onclick="removeStudent('${s.id}')">הסר</button>
      </div>`).join(''):'<div style="font-size:13px;color:var(--text2);padding:.5rem 0">אין תלמידים עדיין</div>';
  }
}

async function removeStudent(id){
  await api('/api/students/'+id,'DELETE');
  renderManage();
  renderStudents();
}

if(token){
  fetch(SERVER+'/api/students',{headers:{'Authorization':'Bearer '+token}})
    .then(r=>r.json())
    .then(data=>{if(!data.error) enterApp(); else{token=null;localStorage.removeItem('teacher_token');}})
    .catch(()=>{});
}
setInterval(()=>{if(token&&document.getElementById('screen-dashboard').classList.contains('active')) renderDashboard();},60000);
</script>
</body>
</html>
