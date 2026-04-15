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

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS teachers (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      institution_code TEXT UNIQUE,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS students (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      class_name TEXT NOT NULL,
      teacher_id TEXT NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
      consent BOOLEAN DEFAULT FALSE,
      active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS reports (
      student_id TEXT PRIMARY KEY REFERENCES students(id) ON DELETE CASCADE,
      daily_average NUMERIC DEFAULT 0,
      total_minutes INTEGER DEFAULT 0,
      weekly_data JSONB DEFAULT '[0,0,0,0,0,0,0]',
      by_app JSONB DEFAULT '{}',
      timing JSONB DEFAULT '{}',
      consent JSONB DEFAULT '{}',
      platform TEXT,
      synced_at TIMESTAMP DEFAULT NOW()
    );
    ALTER TABLE reports ADD COLUMN IF NOT EXISTS by_app JSONB DEFAULT '{}';
    ALTER TABLE reports ADD COLUMN IF NOT EXISTS timing JSONB DEFAULT '{}';
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

function hash(p) { return crypto.createHash('sha256').update(p + 'st_salt').digest('hex'); }
function genToken() { return crypto.randomBytes(32).toString('hex'); }
function genId() { return crypto.randomBytes(8).toString('hex'); }
function genCode() { return Math.floor(100000 + Math.random() * 900000).toString(); }

async function getSession(token) {
  const r = await pool.query('SELECT * FROM sessions WHERE token=$1', [token]);
  return r.rows[0] || null;
}

function auth(req, res, next) {
  const token = req.headers['authorization']?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'לא מחובר' });
  getSession(token).then(session => {
    if (!session) return res.status(401).json({ error: 'לא מחובר' });
    req.session = session;
    next();
  }).catch(() => res.status(401).json({ error: 'שגיאה' }));
}

function teacherOnly(req, res, next) {
  if (req.session.role !== 'teacher') return res.status(403).json({ error: 'הרשאה נדרשת' });
  next();
}

app.get('/', (req, res) => res.json({ status: 'ok' }));

// ─── מורה: רישום ─────────────────────────────────────────────────────────────
app.post('/api/teacher/register', async (req, res) => {
  const { username, password, name } = req.body;
  if (!username || !password || !name) return res.status(400).json({ error: 'חסרים פרטים' });
  try {
    const exists = await pool.query('SELECT id FROM teachers WHERE username=$1', [username]);
    if (exists.rows.length) return res.status(400).json({ error: 'שם משתמש תפוס' });
    const id = genId();
    const institutionCode = genCode();
    await pool.query('INSERT INTO teachers (id,username,password_hash,name,institution_code) VALUES ($1,$2,$3,$4,$5)',
      [id, username, hash(password), name, institutionCode]);
    const token = genToken();
    await pool.query('INSERT INTO sessions (token,user_id,role,teacher_id) VALUES ($1,$2,$3,$4)',
      [token, id, 'teacher', id]);
    res.json({ ok: true, token, teacher: { id, username, name, institutionCode } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── מורה: התחברות ────────────────────────────────────────────────────────────
app.post('/api/teacher/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const r = await pool.query('SELECT * FROM teachers WHERE username=$1', [username]);
    const teacher = r.rows[0];
    if (!teacher || teacher.password_hash !== hash(password))
      return res.status(401).json({ error: 'שם משתמש או סיסמה שגויים' });
    const token = genToken();
    await pool.query('INSERT INTO sessions (token,user_id,role,teacher_id) VALUES ($1,$2,$3,$4)',
      [token, teacher.id, 'teacher', teacher.id]);
    res.json({ ok: true, token, teacher: { id: teacher.id, username: teacher.username, name: teacher.name, institutionCode: teacher.institution_code } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── קוד מוסד ────────────────────────────────────────────────────────────────
app.get('/api/institution/:code', async (req, res) => {
  try {
    const r = await pool.query('SELECT id, name FROM teachers WHERE institution_code=$1', [req.params.code]);
    if (!r.rows.length) return res.status(404).json({ error: 'קוד לא תקף' });
    res.json({ ok: true, teacherName: r.rows[0].name, teacherId: r.rows[0].id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── רישום תלמיד ──────────────────────────────────────────────────────────────
app.post('/api/student/register', async (req, res) => {
  const { institutionCode, username, password, name, className } = req.body;
  if (!institutionCode || !username || !password || !name || !className)
    return res.status(400).json({ error: 'חסרים פרטים' });
  try {
    const teacher = await pool.query('SELECT * FROM teachers WHERE institution_code=$1', [institutionCode]);
    if (!teacher.rows.length) return res.status(404).json({ error: 'קוד מוסד לא תקף' });
    const exists = await pool.query('SELECT id FROM students WHERE username=$1', [username]);
    if (exists.rows.length) return res.status(400).json({ error: 'שם המשתמש תפוס' });
    const id = genId();
    const teacherId = teacher.rows[0].id;
    await pool.query('INSERT INTO students (id,username,password_hash,name,class_name,teacher_id) VALUES ($1,$2,$3,$4,$5,$6)',
      [id, username, hash(password), name, className, teacherId]);
    const token = genToken();
    await pool.query('INSERT INTO sessions (token,user_id,role,teacher_id) VALUES ($1,$2,$3,$4)',
      [token, id, 'student', teacherId]);
    res.json({
      ok: true, token,
      student: { id, name, className, teacherName: teacher.rows[0].name, platform: 'android', consent: false }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── התחברות תלמיד ────────────────────────────────────────────────────────────
app.post('/api/student/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const r = await pool.query('SELECT s.*, t.name as teacher_name FROM students s LEFT JOIN teachers t ON s.teacher_id=t.id WHERE s.username=$1', [username]);
    const student = r.rows[0];
    if (!student || student.password_hash !== hash(password))
      return res.status(401).json({ error: 'שם משתמש או סיסמה שגויים' });
    const token = genToken();
    await pool.query('INSERT INTO sessions (token,user_id,role,teacher_id) VALUES ($1,$2,$3,$4)',
      [token, student.id, 'student', student.teacher_id]);
    res.json({
      ok: true, token,
      student: { id: student.id, name: student.name, className: student.class_name, teacherName: student.teacher_name, platform: 'android', consent: student.consent }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── תלמידים (למורה) ─────────────────────────────────────────────────────────
app.get('/api/students', auth, teacherOnly, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT s.*, r.daily_average, r.weekly_data, r.synced_at
      FROM students s
      LEFT JOIN reports r ON s.id = r.student_id
      WHERE s.teacher_id = $1
      ORDER BY s.class_name, s.name
    `, [req.session.teacher_id]);
    res.json(r.rows.map(s => ({
      id: s.id, name: s.name,
      initials: s.name.split(' ').map((w) => w[0]).join('').slice(0, 2),
      className: s.class_name,
      platform: 'android', consent: s.consent, active: s.active,
      hours: parseFloat(s.daily_average) || 0,
      weeklyData: s.weekly_data || [0,0,0,0,0,0,0],
      byApp: s.by_app || {},
      timing: s.timing || {},
      lastSync: s.synced_at || null,
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/students/:id', auth, teacherOnly, async (req, res) => {
  try {
    await pool.query('DELETE FROM students WHERE id=$1 AND teacher_id=$2', [req.params.id, req.session.teacher_id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── דוחות ───────────────────────────────────────────────────────────────────
app.post('/api/report', auth, async (req, res) => {
  if (req.session.role !== 'student') return res.status(403).json({ error: 'אין הרשאה' });
  const { dailyAverage, totalMinutes, weeklyData, consent, platform, syncedAt } = req.body;
  try {
    if (consent) await pool.query('UPDATE students SET consent=$1 WHERE id=$2', [consent.total || false, req.session.user_id]);
    await pool.query(`
      INSERT INTO reports (student_id, daily_average, total_minutes, weekly_data, by_app, timing, consent, platform, synced_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (student_id) DO UPDATE SET
        daily_average=$2, total_minutes=$3, weekly_data=$4, by_app=$5, timing=$6, consent=$7, platform=$8, synced_at=$9
    `, [req.session.user_id, dailyAverage || 0, totalMinutes || 0,
        JSON.stringify(weeklyData || [0,0,0,0,0,0,0]),
        JSON.stringify(req.body.byApp || {}), JSON.stringify(req.body.timing || {}),
        JSON.stringify(consent || {}), platform || 'unknown',
        syncedAt || new Date().toISOString()]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/report', auth, async (req, res) => {
  if (req.session.role !== 'student') return res.status(403).json({ error: 'אין הרשאה' });
  try {
    const r = await pool.query('SELECT * FROM reports WHERE student_id=$1', [req.session.user_id]);
    res.json(r.rows[0] || {});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 3001;
initDB().then(() => app.listen(PORT, () => console.log(`Server on port ${PORT}`))).catch(console.error);
