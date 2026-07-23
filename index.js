const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { Pool } = require('pg');
const admin = require('firebase-admin');
const app = express();

app.use(cors());
app.use(express.json());

// ── אתחול Firebase Admin (לשליחת הודעות FCM) ──
// המפתח הסודי נשמר כמשתנה סביבה ב-Render (FIREBASE_SERVICE_ACCOUNT) - לא בקוד.
let firebaseReady = false;
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    firebaseReady = true;
    console.log('[Firebase] initialized OK');
  } else {
    console.log('[Firebase] FIREBASE_SERVICE_ACCOUNT not set - FCM disabled');
  }
} catch (e) {
  console.log('[Firebase] init error:', e.message);
}

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
      security_question TEXT,
      security_answer_hash TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
    ALTER TABLE teachers ADD COLUMN IF NOT EXISTS security_question TEXT;
    ALTER TABLE teachers ADD COLUMN IF NOT EXISTS security_answer_hash TEXT;
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
    ALTER TABLE students ADD COLUMN IF NOT EXISTS fcm_token TEXT;
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
    ALTER TABLE reports ADD COLUMN IF NOT EXISTS push_status TEXT;
    ALTER TABLE reports ADD COLUMN IF NOT EXISTS push_sent_at TIMESTAMP;
    ALTER TABLE reports ADD COLUMN IF NOT EXISTS sync_source TEXT;
    ALTER TABLE reports ADD COLUMN IF NOT EXISTS app_version TEXT;
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL,
      teacher_id TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS mood_checks (
      id TEXT PRIMARY KEY,
      student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      mood TEXT NOT NULL,
      date TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(student_id, date)
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
    const { securityQuestion, securityAnswer } = req.body;
    await pool.query('INSERT INTO teachers (id,username,password_hash,name,institution_code,security_question,security_answer_hash) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [id, username, hash(password), name, institutionCode,
       securityQuestion||null, securityAnswer ? hash(securityAnswer.toLowerCase().trim()) : null]);
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

// ─── שחזור סיסמה ─────────────────────────────────────────────────────────────
app.post('/api/teacher/check-security', async (req, res) => {
  const { username, securityAnswer } = req.body;
  try {
    const r = await pool.query('SELECT * FROM teachers WHERE username=$1', [username]);
    if (!r.rows.length) return res.status(404).json({ error: 'שם משתמש לא נמצא' });
    const teacher = r.rows[0];
    if (!teacher.security_answer_hash) return res.status(400).json({ error: 'לא הוגדרה שאלת אבטחה' });
    if (teacher.security_answer_hash !== hash(securityAnswer.toLowerCase().trim()))
      return res.status(401).json({ error: 'תשובה שגויה' });
    res.json({ ok: true, question: teacher.security_question });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/teacher/reset-password', async (req, res) => {
  const { username, securityAnswer, newPassword } = req.body;
  try {
    const r = await pool.query('SELECT * FROM teachers WHERE username=$1', [username]);
    if (!r.rows.length) return res.status(404).json({ error: 'שם משתמש לא נמצא' });
    const teacher = r.rows[0];
    if (teacher.security_answer_hash !== hash(securityAnswer.toLowerCase().trim()))
      return res.status(401).json({ error: 'תשובה שגויה' });
    await pool.query('UPDATE teachers SET password_hash=$1 WHERE id=$2', [hash(newPassword), teacher.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
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
    const today = new Date().toISOString().split('T')[0];
    const r = await pool.query(`
      SELECT s.*, r.daily_average, r.weekly_data, r.by_app, r.timing, r.synced_at, r.session_count, r.avg_session_seconds, r.push_status, r.push_sent_at, r.sync_source,
             r.goal_hours, r.overall_goal_passed, r.wellness_score, m.mood
      FROM students s
      LEFT JOIN reports r ON s.id = r.student_id
      LEFT JOIN mood_checks m ON s.id = m.student_id AND m.date = $2
      WHERE s.teacher_id = $1
      ORDER BY s.class_name, s.name
    `, [req.session.teacher_id, today]);
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
      mood: s.mood || null,
      sessionCount: s.session_count || 0,
      avgSessionSeconds: s.avg_session_seconds || 0,
      pushStatus: s.push_status || null,
      pushSentAt: s.push_sent_at || null,
      syncSource: s.sync_source || null,
      // ── חדש בגרסה 6.0 - שדות נוספים, לצד הישנים, לא במקומם ──
      goalHours: s.goal_hours !== null ? parseFloat(s.goal_hours) : null,
      overallGoalPassed: s.overall_goal_passed,
      wellnessScore: s.wellness_score,
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/students/:id', auth, teacherOnly, async (req, res) => {
  try {
    await pool.query('DELETE FROM students WHERE id=$1 AND teacher_id=$2', [req.params.id, req.session.teacher_id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── תלמידים לפי טווח תאריכים ───────────────────────────────────────────────
app.get('/api/students/range', auth, teacherOnly, async (req, res) => {
  try {
    const { from, to } = req.query;
    const today = new Date().toISOString().split('T')[0];
    const fromDate = from || today;
    const toDate = to || today;

    const r = await pool.query(`
      SELECT s.id, s.name, s.class_name, s.consent,
        AVG(h.daily_average) as avg_hours,
        SUM(h.total_minutes) as total_minutes,
        COUNT(h.report_date) as days_count,
        SUM(h.session_count) as session_count,
        AVG(NULLIF(h.avg_session_seconds,0)) as avg_session_seconds,
        AVG(h.wellness_score) as avg_wellness_score,
        COUNT(h.report_date) FILTER (WHERE h.overall_goal_passed) as days_goal_passed,
        MAX(h.synced_at) as last_sync
      FROM students s
      LEFT JOIN reports_history h ON s.id = h.student_id
        AND h.report_date >= $2 AND h.report_date <= $3
      WHERE s.teacher_id = $1
      GROUP BY s.id, s.name, s.class_name, s.consent
      ORDER BY s.class_name, s.name
    `, [req.session.teacher_id, fromDate, toDate]);

    res.json(r.rows.map(s => ({
      id: s.id, name: s.name,
      initials: s.name.split(' ').map((w) => w[0]).join('').slice(0, 2),
      className: s.class_name,
      consent: s.consent,
      hours: parseFloat(s.avg_hours) || 0,
      totalMinutes: parseInt(s.total_minutes) || 0,
      daysCount: parseInt(s.days_count) || 0,
      sessionCount: parseInt(s.session_count) || 0,
      avgSessionSeconds: Math.round(parseFloat(s.avg_session_seconds) || 0),
      lastSync: s.last_sync || null,
      // ── חדש בגרסה 6.0 ──
      avgWellnessScore: Math.round(parseFloat(s.avg_wellness_score)) || null,
      daysGoalPassed: parseInt(s.days_goal_passed) || 0,
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── היסטוריה ────────────────────────────────────────────────────────────────
app.get('/api/history', auth, teacherOnly, async (req, res) => {
  try {
    const { range } = req.query;
    let fromDate;
    const now = new Date();
    const today = now.toISOString().split('T')[0];
    const yesterday = new Date(now); yesterday.setDate(yesterday.getDate()-1);
    const yesterdayStr = yesterday.toISOString().split('T')[0];

    if (range === 'today') fromDate = today;
    else if (range === 'yesterday') fromDate = yesterdayStr;
    else if (range === '7d') { const d=new Date(now); d.setDate(d.getDate()-7); fromDate=d.toISOString().split('T')[0]; }
    else if (range === '30d') { const d=new Date(now); d.setDate(d.getDate()-30); fromDate=d.toISOString().split('T')[0]; }
    else if (range === '90d') { const d=new Date(now); d.setDate(d.getDate()-90); fromDate=d.toISOString().split('T')[0]; }
    else if (range === '180d') { const d=new Date(now); d.setDate(d.getDate()-180); fromDate=d.toISOString().split('T')[0]; }
    else if (range === '365d') { const d=new Date(now); d.setDate(d.getDate()-365); fromDate=d.toISOString().split('T')[0]; }
    else fromDate = '2020-01-01'; // מאז תמיד

    const r = await pool.query(`
      SELECT s.id, s.name, s.class_name, h.daily_average, h.weekly_data, h.by_app, h.timing, h.report_date, h.synced_at,
             h.goal_hours, h.overall_goal_passed, h.wellness_score
      FROM students s
      LEFT JOIN reports_history h ON s.id = h.student_id AND h.report_date >= $2
      WHERE s.teacher_id = $1
      ORDER BY s.class_name, s.name, h.report_date DESC
    `, [req.session.teacher_id, fromDate]);
    res.json({ rows: r.rows, range, fromDate, today, yesterday: yesterdayStr });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── ממוצע כיתתי ─────────────────────────────────────────────────────────────
app.get('/api/class-average', auth, async (req, res) => {
  if (req.session.role !== 'student') return res.status(403).json({ error: 'אין הרשאה' });
  try {
    // קבל את הכיתה של התלמיד
    const student = await pool.query('SELECT class_name, teacher_id FROM students WHERE id=$1', [req.session.user_id]);
    if (!student.rows.length) return res.status(404).json({ error: 'תלמיד לא נמצא' });
    const { class_name, teacher_id } = student.rows[0];

    // חשב ממוצע של כל התלמידים בכיתה
    const r = await pool.query(`
      SELECT AVG(r.daily_average) as class_avg, COUNT(s.id) as student_count
      FROM students s
      LEFT JOIN reports r ON s.id = r.student_id
      WHERE s.teacher_id = $1 AND s.class_name = $2 AND r.daily_average > 0
    `, [teacher_id, class_name]);

    const classAvg = parseFloat(r.rows[0]?.class_avg) || 0;
    const studentCount = parseInt(r.rows[0]?.student_count) || 0;
    res.json({ classAvg, studentCount, className: class_name });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── מצב רוח ─────────────────────────────────────────────────────────────────
app.post('/api/mood', auth, async (req, res) => {
  if (req.session.role !== 'student') return res.status(403).json({ error: 'אין הרשאה' });
  const { mood } = req.body;
  if (!['good','neutral','bad'].includes(mood)) return res.status(400).json({ error: 'מצב רוח לא תקף' });
  const date = new Date().toISOString().split('T')[0];
  const id = genId();
  try {
    await pool.query(`
      INSERT INTO mood_checks (id, student_id, mood, date)
      VALUES ($1,$2,$3,$4)
      ON CONFLICT (student_id, date) DO UPDATE SET mood=$3
    `, [id, req.session.user_id, mood, date]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/mood/today', auth, async (req, res) => {
  if (req.session.role !== 'student') return res.status(403).json({ error: 'אין הרשאה' });
  const date = new Date().toISOString().split('T')[0];
  try {
    const r = await pool.query('SELECT mood FROM mood_checks WHERE student_id=$1 AND date=$2', [req.session.user_id, date]);
    res.json({ mood: r.rows[0]?.mood || null });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── דוחות ───────────────────────────────────────────────────────────────────
app.post('/api/report', auth, async (req, res) => {
  if (req.session.role !== 'student') return res.status(403).json({ error: 'אין הרשאה' });
  const {
    dailyAverage, totalMinutes, weeklyData, consent, platform,
    syncedAt, pushStatus, pushSentAt, syncSource, appVersion,
    goalHours, overallGoalPassed, wellnessScore, // ← חדש בגרסה 6.0
  } = req.body;
  try {
    if (consent) await pool.query('UPDATE students SET consent=$1 WHERE id=$2', [consent.total || false, req.session.user_id]);
    await pool.query(`
      INSERT INTO reports (student_id, daily_average, total_minutes, weekly_data, by_app, timing, consent, platform, synced_at, session_count, avg_session_seconds, push_status, push_sent_at, sync_source, app_version,
                            goal_hours, overall_goal_passed, wellness_score)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
      ON CONFLICT (student_id) DO UPDATE SET
        daily_average=$2, total_minutes=$3, weekly_data=$4, by_app=$5, timing=$6, consent=$7, platform=$8, synced_at=$9, session_count=$10, avg_session_seconds=$11, push_status=$12, push_sent_at=$13, sync_source=$14, app_version=$15,
        -- COALESCE: אם הדיווח הגיע מגרסה ישנה שלא שולחת את השדות האלה,
        -- משאירים את הערך הקיים במקום לדרוס אותו ב-null.
        goal_hours=COALESCE($16, reports.goal_hours),
        overall_goal_passed=COALESCE($17, reports.overall_goal_passed),
        wellness_score=COALESCE($18, reports.wellness_score)
    `, [req.session.user_id, dailyAverage || 0, totalMinutes || 0,
        JSON.stringify(weeklyData || [0,0,0,0,0,0,0]),
        JSON.stringify(req.body.byApp || {}), JSON.stringify(req.body.timing || {}),
        JSON.stringify(consent || {}), platform || 'unknown',
        syncedAt || new Date().toISOString(),
        parseInt(req.body.sessionCount)||0, parseInt(req.body.avgSessionSeconds)||0,
        pushStatus || null, pushSentAt || null, syncSource || null, appVersion || null,
        goalHours || null, overallGoalPassed ?? null, wellnessScore || null]);

    // שמירה להיסטוריה יומית
    const today = new Date().toISOString().split('T')[0];
    const histId = genId();
    await pool.query(`
      INSERT INTO reports_history (id, student_id, daily_average, total_minutes, weekly_data, by_app, timing, consent, platform, report_date, synced_at, session_count, avg_session_seconds,
                                    goal_hours, overall_goal_passed, wellness_score)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      ON CONFLICT (student_id, report_date) DO UPDATE SET
        daily_average=EXCLUDED.daily_average, total_minutes=EXCLUDED.total_minutes, weekly_data=EXCLUDED.weekly_data, by_app=EXCLUDED.by_app, timing=EXCLUDED.timing, consent=EXCLUDED.consent, platform=EXCLUDED.platform, synced_at=EXCLUDED.synced_at, session_count=EXCLUDED.session_count, avg_session_seconds=EXCLUDED.avg_session_seconds,
        goal_hours=COALESCE(EXCLUDED.goal_hours, reports_history.goal_hours),
        overall_goal_passed=COALESCE(EXCLUDED.overall_goal_passed, reports_history.overall_goal_passed),
        wellness_score=COALESCE(EXCLUDED.wellness_score, reports_history.wellness_score)
    `, [histId, req.session.user_id, parseFloat(dailyAverage)||0, parseInt(totalMinutes)||0,
        JSON.stringify(weeklyData||[0,0,0,0,0,0,0]),
        JSON.stringify(req.body.byApp || {}), JSON.stringify(req.body.timing || {}),
        JSON.stringify(consent||{}), platform||'unknown',
        today, syncedAt||new Date().toISOString(),
        parseInt(req.body.sessionCount)||0, parseInt(req.body.avgSessionSeconds)||0,
        goalHours || null, overallGoalPassed ?? null, wellnessScore || null]);

    res.json({ ok: true });
  } catch (e) { 
    console.error('[report] error:', e.message);
    res.status(500).json({ error: e.message }); 
  }
});

app.get('/api/report', auth, async (req, res) => {
  if (req.session.role !== 'student') return res.status(403).json({ error: 'אין הרשאה' });
  try {
    const r = await pool.query('SELECT * FROM reports WHERE student_id=$1', [req.session.user_id]);
    res.json(r.rows[0] || {});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── חדש בגרסה 6.0: דירוג כיתתי - מחזיר לתלמיד רק את המיקום שלו עצמו ───
app.get('/api/class-rank', auth, async (req, res) => {
  if (req.session.role !== 'student') return res.status(403).json({ error: 'אין הרשאה' });
  try {
    const r = await pool.query(
      'SELECT class_rank, class_size, avg_score FROM class_rank_current_week WHERE student_id=$1',
      [req.session.user_id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'אין עדיין דירוג לשבוע הנוכחי' });
    const row = r.rows[0];
    res.json({ rank: row.class_rank, classSize: row.class_size, avgScore: row.avg_score });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── שמירת טוקן FCM של תלמיד ──
app.post('/api/update-fcm-token', auth, async (req, res) => {
  if (req.session.role !== 'student') return res.status(403).json({ error: 'אין הרשאה' });
  const { fcmToken } = req.body;
  if (!fcmToken) return res.status(400).json({ error: 'חסר טוקן' });
  try {
    await pool.query('UPDATE students SET fcm_token=$1 WHERE id=$2', [fcmToken, req.session.user_id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── שליחת הודעת FCM שקטה (data message) לכל התלמידים ──
// ההודעה מעירה את האפליקציה על המכשיר, והיא קוראת זמן מסך טרי ומציגה פוש מקומי.
// מופעל על ידי שירות תזמון חיצוני (cron-job.org) ב-12:00 וב-20:00.
// מוגן בסוד פשוט (CRON_SECRET) כדי שלא כל אחד יוכל להפעיל.
async function sendSilentPushToAll(period) {
  if (!firebaseReady) {
    console.log('[FCM] skipped - firebase not ready');
    return { sent: 0, failed: 0, error: 'firebase not ready' };
  }
  const r = await pool.query("SELECT id, fcm_token FROM students WHERE fcm_token IS NOT NULL AND active=TRUE");
  let sent = 0, failed = 0;
  const invalidTokens = [];

  for (const student of r.rows) {
    try {
      await admin.messaging().send({
        token: student.fcm_token,
        data: { type: 'daily_sync', period: period || 'noon' },
        android: {
          priority: 'high', // חשוב: מבטיח שההודעה תעיר את האפליקציה גם במצב חיסכון
          ttl: 30 * 60 * 1000, // תוקף חצי שעה (במילישניות): אם המכשיר לא זמין תוך 30 דקות,
                               // ההודעה מתבטלת ולא נמסרת מאוחר (למשל פוש שבת שיגיע במוצ"ש).
        },
      });
      sent++;
    } catch (e) {
      failed++;
      // אם הטוקן לא תקף יותר (המשתמש הסיר את האפליקציה) - נסמן למחיקה
      if (e.code === 'messaging/registration-token-not-registered' ||
          e.code === 'messaging/invalid-registration-token') {
        invalidTokens.push(student.id);
      }
    }
  }

  // ניקוי טוקנים לא תקפים
  if (invalidTokens.length) {
    await pool.query('UPDATE students SET fcm_token=NULL WHERE id = ANY($1)', [invalidTokens]);
  }

  console.log(`[FCM] period=${period} sent=${sent} failed=${failed} cleaned=${invalidTokens.length}`);
  return { sent, failed, cleaned: invalidTokens.length };
}

// app.all - הנתיב מקבל גם GET וגם POST (וכל שיטה). כך ה-cron עובד בכל הגדרה,
// ואפשר גם לבדוק ידנית מהדפדפן (GET). ה-secret וה-period נקראים גם מה-query וגם מה-body.
app.all('/api/send-daily-push', async (req, res) => {
  // הגנה: רק מי שיודע את הסוד יכול להפעיל (מוגדר כמשתנה סביבה ב-Render)
  const secret = req.headers['x-cron-secret'] || req.query.secret;
  if (process.env.CRON_SECRET && secret !== process.env.CRON_SECRET) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const period = req.query.period || req.body?.period || 'noon';
  try {
    const result = await sendSilentPushToAll(period);
    res.json({ ok: true, ...result });
  } catch (e) {
    console.log('[send-daily-push] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── בדיקת גרסה מינימלית נדרשת ──
// האפליקציה שואלת בפתיחה. השרת מחזיר את הגרסה המינימלית שמותר לעבוד איתה.
// כדי לחייב עדכון - פשוט משנים כאן את המספר (או דרך משתנה סביבה MIN_APP_VERSION ב-Render).
app.get('/api/min-version', (req, res) => {
  const minVersion = process.env.MIN_APP_VERSION || '5.0';
  res.json({ minVersion, storeUrl: 'https://play.google.com/store/apps/details?id=com.screentimestudent2' });
});

const PORT = process.env.PORT || 3001;
initDB().then(() => {
  app.listen(PORT, () => console.log(`Server on port ${PORT}`));
  const SIX_DAYS = 6 * 24 * 60 * 60 * 1000;
  setInterval(async () => {
    try {
      await pool.query('SELECT 1');
      console.log('[ping] Supabase kept alive');
    } catch(e) {
      console.log('[ping] error:', e.message);
    }
  }, SIX_DAYS);
}).catch(console.error);
