const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { Pool } = require('pg');
const app = express();

app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres.uzuluwhuvthpynoazaor:A13!039097518@aws-1-eu-west-2.pooler.supabase.com:6543/postgres',
  ssl: { rejectUnauthorized: false }
});

// יצירת טבלאות אם לא קיימות
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS teachers (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS classes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      teacher_id TEXT NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS students (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE,
      password_hash TEXT,
      name TEXT NOT NULL,
      initials TEXT,
      class_id TEXT REFERENCES classes(id) ON DELETE SET NULL,
      teacher_id TEXT NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
      platform TEXT DEFAULT 'iOS',
      consent BOOLEAN DEFAULT FALSE,
      active BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS invites (
      token TEXT PRIMARY KEY,
      student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      short_code TEXT UNIQUE,
      used BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS reports (
      student_id TEXT PRIMARY KEY REFERENCES students(id) ON DELETE CASCADE,
      daily_average NUMERIC DEFAULT 0,
      total_minutes INTEGER DEFAULT 0,
      weekly_data JSONB DEFAULT '[0,0,0,0,0,0,0]',
      consent JSONB DEFAULT '{}',
      platform TEXT,
      synced_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL,
      teacher_id TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log('DB ready');
}

function hash(p) { return crypto.createHash('sha256').update(p+'st_salt').digest('hex'); }
function genToken() { return crypto.randomBytes(32).toString('hex'); }
function genId() { return crypto.randomBytes(8).toString('hex'); }

async function getSession(token) {
  const r = await pool.query('SELECT * FROM sessions WHERE token=$1', [token]);
  return r.rows[0] || null;
}

function auth(req, res, next) {
  const token = req.headers['authorization']?.replace('Bearer ', '');
  if (!token) return res.status(401).json({error: 'לא מחובר'});
  getSession(token).then(session => {
    if (!session) return res.status(401).json({error: 'לא מחובר'});
    req.session = session;
    next();
  }).catch(() => res.status(401).json({error: 'שגיאה'}));
}

function teacherOnly(req, res, next) {
  if (req.session.role !== 'teacher') return res.status(403).json({error: 'הרשאה נדרשת'});
  next();
}

app.get('/', (req, res) => res.json({status: 'ok'}));

// ─── מורה: רישום ─────────────────────────────────────────────────────────────
app.post('/api/teacher/register', async (req, res) => {
  const {username, password, name} = req.body;
  if (!username || !password || !name) return res.status(400).json({error: 'חסרים פרטים'});
  try {
    const exists = await pool.query('SELECT id FROM teachers WHERE username=$1', [username]);
    if (exists.rows.length) return res.status(400).json({error: 'שם משתמש תפוס'});
    const id = genId();
    await pool.query('INSERT INTO teachers (id,username,password_hash,name) VALUES ($1,$2,$3,$4)', [id, username, hash(password), name]);
    const token = genToken();
    await pool.query('INSERT INTO sessions (token,user_id,role,teacher_id) VALUES ($1,$2,$3,$4)', [token, id, 'teacher', id]);
    res.json({ok: true, token, teacher: {id, username, name}});
  } catch(e) { res.status(500).json({error: e.message}); }
});

// ─── מורה: התחברות ────────────────────────────────────────────────────────────
app.post('/api/teacher/login', async (req, res) => {
  const {username, password} = req.body;
  try {
    const r = await pool.query('SELECT * FROM teachers WHERE username=$1', [username]);
    const teacher = r.rows[0];
    if (!teacher || teacher.password_hash !== hash(password))
      return res.status(401).json({error: 'שם משתמש או סיסמה שגויים'});
    const token = genToken();
    await pool.query('INSERT INTO sessions (token,user_id,role,teacher_id) VALUES ($1,$2,$3,$4)', [token, teacher.id, 'teacher', teacher.id]);
    res.json({ok: true, token, teacher: {id: teacher.id, username: teacher.username, name: teacher.name}});
  } catch(e) { res.status(500).json({error: e.message}); }
});

// ─── כיתות ───────────────────────────────────────────────────────────────────
app.post('/api/classes', auth, teacherOnly, async (req, res) => {
  const {name} = req.body;
  if (!name) return res.status(400).json({error: 'נדרש שם'});
  try {
    const id = genId();
    await pool.query('INSERT INTO classes (id,name,teacher_id) VALUES ($1,$2,$3)', [id, name, req.session.teacher_id]);
    res.json({ok: true, class: {id, name, teacherId: req.session.teacher_id}});
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.get('/api/classes', auth, teacherOnly, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM classes WHERE teacher_id=$1 ORDER BY created_at', [req.session.teacher_id]);
    res.json(r.rows.map(c => ({id: c.id, name: c.name, teacherId: c.teacher_id})));
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.delete('/api/classes/:id', auth, teacherOnly, async (req, res) => {
  try {
    await pool.query('DELETE FROM classes WHERE id=$1 AND teacher_id=$2', [req.params.id, req.session.teacher_id]);
    res.json({ok: true});
  } catch(e) { res.status(500).json({error: e.message}); }
});

// ─── תלמידים ─────────────────────────────────────────────────────────────────
app.post('/api/students', auth, teacherOnly, async (req, res) => {
  const {name, classId, platform} = req.body;
  if (!name || !classId) return res.status(400).json({error: 'חסרים פרטים'});
  try {
    const cls = await pool.query('SELECT * FROM classes WHERE id=$1 AND teacher_id=$2', [classId, req.session.teacher_id]);
    if (!cls.rows.length) return res.status(403).json({error: 'כיתה לא נמצאה'});
    const id = genId();
    const initials = name.split(' ').map(w => w[0]).join('').slice(0, 2);
    await pool.query('INSERT INTO students (id,name,initials,class_id,teacher_id,platform) VALUES ($1,$2,$3,$4,$5,$6)',
      [id, name, initials, classId, req.session.teacher_id, platform || 'iOS']);
    const inviteToken = genToken();
    const shortCode = Math.floor(100000 + Math.random() * 900000).toString();
    await pool.query('INSERT INTO invites (token,student_id,short_code) VALUES ($1,$2,$3)', [inviteToken, id, shortCode]);
    const joinUrl = `screentime://join/${inviteToken}`;
    res.json({ok: true, student: {id, name, classId}, joinUrl, shortCode});
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.get('/api/students', auth, teacherOnly, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT s.*, c.name as class_name,
        r.daily_average, r.weekly_data, r.synced_at
      FROM students s
      LEFT JOIN classes c ON s.class_id = c.id
      LEFT JOIN reports r ON s.id = r.student_id
      WHERE s.teacher_id = $1
      ORDER BY s.created_at
    `, [req.session.teacher_id]);
    res.json(r.rows.map(s => ({
      id: s.id, name: s.name, initials: s.initials,
      classId: s.class_id, className: s.class_name || '',
      platform: s.platform, consent: s.consent, active: s.active,
      hours: parseFloat(s.daily_average) || 0,
      weeklyData: s.weekly_data || [0,0,0,0,0,0,0],
      lastSync: s.synced_at || null,
    })));
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.delete('/api/students/:id', auth, teacherOnly, async (req, res) => {
  try {
    await pool.query('DELETE FROM students WHERE id=$1 AND teacher_id=$2', [req.params.id, req.session.teacher_id]);
    res.json({ok: true});
  } catch(e) { res.status(500).json({error: e.message}); }
});

// ─── חיפוש לפי קוד קצר ───────────────────────────────────────────────────────
app.get('/api/join/code/:shortCode', async (req, res) => {
  try {
    const inv = await pool.query('SELECT * FROM invites WHERE short_code=$1 AND used=FALSE', [req.params.shortCode]);
    if (!inv.rows.length) return res.status(404).json({error: 'קוד לא תקף או שכבר נוצל'});
    const s = await pool.query('SELECT s.*, c.name as class_name, t.name as teacher_name FROM students s LEFT JOIN classes c ON s.class_id=c.id LEFT JOIN teachers t ON s.teacher_id=t.id WHERE s.id=$1', [inv.rows[0].student_id]);
    if (!s.rows.length) return res.status(404).json({error: 'תלמיד לא נמצא'});
    const student = s.rows[0];
    res.json({ok: true, token: inv.rows[0].token, studentName: student.name, className: student.class_name || '', teacherName: student.teacher_name || ''});
  } catch(e) { res.status(500).json({error: e.message}); }
});

// ─── קישור הצטרפות ───────────────────────────────────────────────────────────
app.get('/api/join/:inviteToken', async (req, res) => {
  try {
    const inv = await pool.query('SELECT * FROM invites WHERE token=$1', [req.params.inviteToken]);
    if (!inv.rows.length || inv.rows[0].used) return res.status(404).json({error: 'קישור לא תקף'});
    const s = await pool.query('SELECT s.*, c.name as class_name, t.name as teacher_name FROM students s LEFT JOIN classes c ON s.class_id=c.id LEFT JOIN teachers t ON s.teacher_id=t.id WHERE s.id=$1', [inv.rows[0].student_id]);
    if (!s.rows.length) return res.status(404).json({error: 'תלמיד לא נמצא'});
    const student = s.rows[0];
    res.json({ok: true, studentName: student.name, className: student.class_name || '', teacherName: student.teacher_name || ''});
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.post('/api/join/:inviteToken', async (req, res) => {
  const {username, password} = req.body;
  if (!username || !password) return res.status(400).json({error: 'חסרים פרטים'});
  try {
    const inv = await pool.query('SELECT * FROM invites WHERE token=$1', [req.params.inviteToken]);
    if (!inv.rows.length || inv.rows[0].used) return res.status(404).json({error: 'קישור לא תקף'});
    const exists = await pool.query('SELECT id FROM students WHERE username=$1', [username]);
    if (exists.rows.length) return res.status(400).json({error: 'שם המשתמש תפוס'});
    const studentId = inv.rows[0].student_id;
    await pool.query('UPDATE students SET username=$1, password_hash=$2, active=TRUE WHERE id=$3', [username, hash(password), studentId]);
    await pool.query('UPDATE invites SET used=TRUE WHERE token=$1', [req.params.inviteToken]);
    const s = await pool.query('SELECT s.*, c.name as class_name, t.name as teacher_name FROM students s LEFT JOIN classes c ON s.class_id=c.id LEFT JOIN teachers t ON s.teacher_id=t.id WHERE s.id=$1', [studentId]);
    const student = s.rows[0];
    const token = genToken();
    await pool.query('INSERT INTO sessions (token,user_id,role,teacher_id) VALUES ($1,$2,$3,$4)', [token, studentId, 'student', student.teacher_id]);
    res.json({ok: true, token, student: {id: studentId, name: student.name, className: student.class_name || '', teacherName: student.teacher_name || '', platform: student.platform, consent: student.consent}});
  } catch(e) { res.status(500).json({error: e.message}); }
});

// ─── תלמיד: התחברות ───────────────────────────────────────────────────────────
app.post('/api/student/login', async (req, res) => {
  const {username, password} = req.body;
  try {
    const r = await pool.query('SELECT s.*, c.name as class_name, t.name as teacher_name FROM students s LEFT JOIN classes c ON s.class_id=c.id LEFT JOIN teachers t ON s.teacher_id=t.id WHERE s.username=$1', [username]);
    const student = r.rows[0];
    if (!student || student.password_hash !== hash(password))
      return res.status(401).json({error: 'שם משתמש או סיסמה שגויים'});
    const token = genToken();
    await pool.query('INSERT INTO sessions (token,user_id,role,teacher_id) VALUES ($1,$2,$3,$4)', [token, student.id, 'student', student.teacher_id]);
    res.json({ok: true, token, student: {id: student.id, name: student.name, className: student.class_name || '', teacherName: student.teacher_name || '', platform: student.platform, consent: student.consent}});
  } catch(e) { res.status(500).json({error: e.message}); }
});

// ─── דוחות ───────────────────────────────────────────────────────────────────
app.post('/api/report', auth, async (req, res) => {
  if (req.session.role !== 'student') return res.status(403).json({error: 'אין הרשאה'});
  const {dailyAverage, totalMinutes, weeklyData, consent, platform, syncedAt} = req.body;
  try {
    if (consent) await pool.query('UPDATE students SET consent=$1 WHERE id=$2', [consent.total || false, req.session.user_id]);
    await pool.query(`
      INSERT INTO reports (student_id, daily_average, total_minutes, weekly_data, consent, platform, synced_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (student_id) DO UPDATE SET
        daily_average=$2, total_minutes=$3, weekly_data=$4, consent=$5, platform=$6, synced_at=$7
    `, [req.session.user_id, dailyAverage||0, totalMinutes||0, JSON.stringify(weeklyData||[0,0,0,0,0,0,0]), JSON.stringify(consent||{}), platform||'unknown', syncedAt||new Date().toISOString()]);
    res.json({ok: true});
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.get('/api/report', auth, async (req, res) => {
  if (req.session.role !== 'student') return res.status(403).json({error: 'אין הרשאה'});
  try {
    const r = await pool.query('SELECT * FROM reports WHERE student_id=$1', [req.session.user_id]);
    res.json(r.rows[0] || {});
  } catch(e) { res.status(500).json({error: e.message}); }
});

const PORT = process.env.PORT || 3001;
initDB().then(() => app.listen(PORT, () => console.log(`Server on port ${PORT}`))).catch(console.error);
