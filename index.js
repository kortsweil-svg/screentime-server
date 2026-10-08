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

if (!process.env.DATABASE_URL) console.log('[DB] DATABASE_URL is not set!');
const pool = new Pool({
  // כתובת בסיס הנתונים נקראת רק ממשתנה הסביבה ב-Render. אסור לכתוב סיסמה בקוד - ה-repo ציבורי.
  connectionString: process.env.DATABASE_URL,
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
      consent JSONB DEFAULT '{}',
      platform TEXT,
      synced_at TIMESTAMP DEFAULT NOW()
    );
    ALTER TABLE reports ADD COLUMN IF NOT EXISTS push_status TEXT;
    ALTER TABLE reports ADD COLUMN IF NOT EXISTS push_sent_at TIMESTAMP;
    ALTER TABLE reports ADD COLUMN IF NOT EXISTS sync_source TEXT;
    ALTER TABLE reports ADD COLUMN IF NOT EXISTS app_version TEXT;
    ALTER TABLE reports ADD COLUMN IF NOT EXISTS goal_hours NUMERIC;
    -- דקות השימוש של אותו יום בלבד. total_minutes הוא שעות מצטברות
    -- ו-daily_average הוא ממוצע שבועי, אז אף אחד מהם לא מתאים לשחזור
    -- ההיסטוריה היומית אחרי התקנה מחדש.
    ALTER TABLE reports_history ADD COLUMN IF NOT EXISTS day_minutes INTEGER;
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

  // דירוג שבועי לפי מספר הימים שהתלמיד עמד ביעד, מיום א' עד אתמול (שעון ישראל).
  // כל יום נמדד מול היעד שנשמר לו בהיסטוריה.
  // התלמידים מקובצים לפי מורה ויעד, כך שמשווים רק בין מי שבחרו אותו יעד.
  // קבוצה של פחות מ-3 תלמידים לא מדורגת. כשל ביצירת ה-VIEW לא מפיל את השרת.
  try {
    await pool.query(`
      CREATE OR REPLACE VIEW goal_rank_current_week AS
      WITH bounds AS (
        SELECT (NOW() AT TIME ZONE 'Asia/Jerusalem')::date AS today,
               (NOW() AT TIME ZONE 'Asia/Jerusalem')::date
                 - EXTRACT(DOW FROM (NOW() AT TIME ZONE 'Asia/Jerusalem'))::int AS week_start
      ),
      members AS (
        SELECT s.id AS student_id, s.teacher_id, r.goal_hours::numeric AS goal_hours
        FROM students s
        JOIN reports r ON r.student_id = s.id
        WHERE s.active = TRUE AND s.consent = TRUE AND r.goal_hours::numeric > 0
      ),
      met AS (
        SELECT m.student_id, m.teacher_id, m.goal_hours,
               -- כל יום נבדק מול היעד שהיה באותו יום, כדי ששינוי יעד באמצע השבוע
               -- לא ישנה בדיעבד ימים שכבר נסגרו. בלי יעד שמור ליום - היעד הנוכחי.
               COUNT(h.student_id) FILTER (
                 WHERE h.day_minutes IS NOT NULL
                   AND h.day_minutes <= COALESCE(NULLIF(h.goal_hours::numeric, 0), m.goal_hours) * 60
               )::int AS days_met,
               COUNT(h.student_id) FILTER (WHERE h.day_minutes IS NOT NULL)::int AS days_reported
        FROM members m
        CROSS JOIN bounds b
        LEFT JOIN reports_history h
          ON h.student_id = m.student_id
         AND h.report_date::date >= b.week_start
         AND h.report_date::date < b.today
        GROUP BY m.student_id, m.teacher_id, m.goal_hours
      ),
      ranked AS (
        SELECT met.*,
               -- דירוג בלי דילוג אחרי תיקו: 1, 2, 2, 2, 3 (ולא 1, 2, 2, 2, 5).
               DENSE_RANK() OVER (PARTITION BY teacher_id, goal_hours ORDER BY days_met DESC)::int AS goal_rank,
               COUNT(*) OVER (PARTITION BY teacher_id, goal_hours)::int AS group_size
        FROM met
      )
      SELECT * FROM ranked WHERE group_size >= 3;
    `);
    console.log('goal_rank_current_week ready');
  } catch (e) {
    console.log('[goal_rank view] error:', e.message);
  }
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
    const r = await pool.query(`
      SELECT s.id, s.name, s.class_name, s.consent, s.active,
             r.platform, r.synced_at, r.goal_hours, r.app_version
      FROM students s
      LEFT JOIN reports r ON s.id = r.student_id
      WHERE s.teacher_id = $1
      ORDER BY s.class_name, s.name
    `, [req.session.teacher_id]);
    res.json(r.rows.map(s => ({
      id: s.id, name: s.name,
      initials: s.name.split(' ').map((w) => w[0]).join('').slice(0, 2),
      className: s.class_name,
      consent: s.consent, active: s.active,
      platform: s.platform || null,
      lastSync: s.synced_at || null,
      goalHours: s.goal_hours !== null ? parseFloat(s.goal_hours) : null,
      appVersion: s.app_version || null,
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── דשבורד מורה: סקירה לפי ימי עמידה ביעד ─────────────────────────────────
// לכל תלמיד: יעד, פלטפורמה, סנכרון אחרון, דירוג השבוע, וכל הימים מתחילת השנה
// (דקות ויעד לכל יום), כדי שהדשבורד יחשב כוכבים וגביעים באותם כללים כמו האפליקציה.
// תלמיד בלי הסכמה מקבל רשימת ימים ריקה.
app.get('/api/teacher/overview', auth, teacherOnly, async (req, res) => {
  try {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
    const dow = new Date(today + 'T12:00:00Z').getUTCDay();
    const ws = new Date(today + 'T12:00:00Z'); ws.setUTCDate(ws.getUTCDate() - dow);
    const weekStart = ws.toISOString().slice(0, 10);
    const st = await pool.query(`
      SELECT s.id, s.name, s.class_name, s.consent, s.active,
             r.goal_hours, r.platform, r.synced_at, r.app_version,
             g.days_met, g.days_reported, g.goal_rank, g.group_size
      FROM students s
      LEFT JOIN reports r ON r.student_id = s.id
      LEFT JOIN goal_rank_current_week g ON g.student_id = s.id
      WHERE s.teacher_id = $1
      ORDER BY s.class_name, s.name
    `, [req.session.teacher_id]);
    const hist = await pool.query(`
      SELECT h.student_id, h.report_date::date::text AS d, h.day_minutes, h.goal_hours
      FROM reports_history h
      JOIN students s ON s.id = h.student_id
      WHERE s.teacher_id = $1
        AND s.consent = TRUE
        AND h.report_date::date >= (date_trunc('year', $2::date)::date - 7)
        AND h.day_minutes IS NOT NULL
      ORDER BY h.report_date
    `, [req.session.teacher_id, today]);
    const byStudent = {};
    for (const h of hist.rows) {
      (byStudent[h.student_id] = byStudent[h.student_id] || []).push({
        date: h.d,
        minutes: h.day_minutes,
        goalHours: h.goal_hours !== null ? parseFloat(h.goal_hours) : null,
      });
    }
    res.json({
      today, weekStart,
      students: st.rows.map(s => ({
        id: s.id, name: s.name, className: s.class_name,
        consent: s.consent, active: s.active,
        goalHours: s.goal_hours !== null ? parseFloat(s.goal_hours) : null,
        platform: s.platform || null,
        lastSync: s.synced_at || null,
        appVersion: s.app_version || null,
        daysMet: s.days_met ?? null,
        daysReported: s.days_reported ?? null,
        rank: s.goal_rank ?? null,
        groupSize: s.group_size ?? null,
        days: s.consent ? (byStudent[s.id] || []) : [],
      })),
    });
  } catch (e) {
    console.error('[teacher/overview]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/students/:id', auth, teacherOnly, async (req, res) => {
  try {
    await pool.query('DELETE FROM students WHERE id=$1 AND teacher_id=$2', [req.params.id, req.session.teacher_id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── ממוצע כיתתי ─────────────────────────────────────────────────────────────
app.get('/api/class-average', auth, async (req, res) => {
  if (req.session.role !== 'student') return res.status(403).json({ error: 'אין הרשאה' });
  try {
    // קבל את הכיתה של התלמיד
    const student = await pool.query('SELECT class_name, teacher_id FROM students WHERE id=$1', [req.session.user_id]);
    if (!student.rows.length) return res.status(404).json({ error: 'תלמיד לא נמצא' });
    const { class_name, teacher_id } = student.rows[0];

    // הממוצע מחושב על שאר הכיתה בלבד, בלי התלמיד ששואל -
    // אחרת הוא משווה את עצמו לממוצע שהוא עצמו חלק ממנו,
    // וכל עלייה אצלו מושכת גם את קו ההשוואה למעלה.
    // רק דיווחים מהשבוע האחרון. בלי הסינון, תלמיד שלא פתח את
    // האפליקציה חודשים מזהם את הממוצע בנתון ישן.
    // ממוצע של 7 הימים הסגורים האחרונים לכל תלמיד, מתוך ההיסטוריה היומית.
    const r = await pool.query(`
      WITH per AS (
        SELECT s.id,
          (SELECT AVG(d.dm) FROM (
             SELECT MAX(h.day_minutes) AS dm
             FROM reports_history h
             WHERE h.student_id = s.id AND h.day_minutes > 0
               AND h.report_date::date BETWEEN CURRENT_DATE - 7 AND CURRENT_DATE - 1
             GROUP BY h.report_date
           ) d) AS mins
        FROM students s
        JOIN reports r ON s.id = r.student_id
        WHERE s.teacher_id = $1 AND s.class_name = $2
          AND s.id <> $3
          AND r.synced_at > NOW() - INTERVAL '7 days'
      )
      SELECT AVG(mins) / 60.0 AS class_avg, COUNT(*) AS student_count
      FROM per WHERE mins > 0
    `, [teacher_id, class_name, req.session.user_id]);

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
// ── תגים (גרסה 6.0) ──
// נבדק אחרי כל דיווח. תג שנפתח נשמר לתמיד ולא נמחק גם אם הרצף נשבר אחר כך.
app.post('/api/report', auth, async (req, res) => {
  if (req.session.role !== 'student') return res.status(403).json({ error: 'אין הרשאה' });
  // גרסאות ישנות שולחות גם שדות שכבר לא נשמרים (ציון, רצף, ממוצעים) - מתעלמים מהם.
  const { consent, platform, syncedAt, pushStatus, pushSentAt, syncSource, appVersion, goalHours, dayMinutes } = req.body;
  // יעד נשמר רק כשהדיווח שלח אותו. גרסה ישנה מאוד בלי השדה לא תמחק יעד קיים.
  const hasGoal = Object.prototype.hasOwnProperty.call(req.body, 'goalHours');
  try {
    if (consent) await pool.query('UPDATE students SET consent=$1 WHERE id=$2', [consent.total || false, req.session.user_id]);
    await pool.query(`
      INSERT INTO reports (student_id, consent, platform, synced_at, push_status, push_sent_at, sync_source, app_version, goal_hours)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (student_id) DO UPDATE SET
        consent=$2, platform=$3, synced_at=$4, push_status=$5, push_sent_at=$6, sync_source=$7, app_version=$8,
        goal_hours=CASE WHEN $10 THEN $9 ELSE reports.goal_hours END
    `, [req.session.user_id, JSON.stringify(consent || {}), platform || 'unknown',
        syncedAt || new Date().toISOString(),
        pushStatus || null, pushSentAt || null, syncSource || null, appVersion || null,
        goalHours ?? null, hasGoal]);

    // היסטוריה יומית - תאריך לפי שעון ישראל.
    // iOS שולח דיווח קל בלי דקות: אז רק מעדכנים זמן סנכרון ויעד, והדקות מגיעות מ-/api/ios-day.
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
    await pool.query(`
      INSERT INTO reports_history (id, student_id, platform, report_date, synced_at, goal_hours, day_minutes)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (student_id, report_date) DO UPDATE SET
        platform=EXCLUDED.platform, synced_at=EXCLUDED.synced_at,
        goal_hours=CASE WHEN $8 THEN EXCLUDED.goal_hours ELSE reports_history.goal_hours END,
        day_minutes=CASE WHEN EXCLUDED.day_minutes IS NOT NULL THEN EXCLUDED.day_minutes ELSE reports_history.day_minutes END
    `, [genId(), req.session.user_id, platform || 'unknown', today,
        syncedAt || new Date().toISOString(), goalHours ?? null, dayMinutes ?? null, hasGoal]);

    // השלמת ימים קודמים. אנדרואיד שומר במכשיר את כל השבוע ושולח גם אותו,
    // כך שימים שלא סונכרנו, או שנשמר להם מספר חלקי, מתעדכנים לערך המלא.
    // זמן מסך של יום שנסגר רק עולה, לכן נשמר המקסימום בין הקיים לחדש.
    try {
      const pastDays = Array.isArray(req.body.pastDays) ? req.body.pastDays.slice(0, 8) : [];
      const todayMs = Date.parse(today);
      for (const pd of pastDays) {
        const date = String(pd?.date || '');
        const minutes = parseInt(pd?.minutes);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
        if (!Number.isFinite(minutes) || minutes < 0 || minutes > 1440) continue;
        const ageDays = (todayMs - Date.parse(date)) / 86400000;
        if (!(ageDays >= 1 && ageDays <= 8)) continue;
        await pool.query(`
          INSERT INTO reports_history (id, student_id, platform, report_date, synced_at, goal_hours, day_minutes)
          VALUES ($1,$2,$3,$4,$5,$6,$7)
          ON CONFLICT (student_id, report_date) DO UPDATE SET
            day_minutes = GREATEST(COALESCE(reports_history.day_minutes, 0), EXCLUDED.day_minutes),
            goal_hours = COALESCE(reports_history.goal_hours, EXCLUDED.goal_hours)
        `, [genId(), req.session.user_id, platform || 'unknown', date,
            syncedAt || new Date().toISOString(), goalHours ?? null, minutes]);
      }
    } catch (e) {
      console.log('[report] pastDays error:', e.message);
    }

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

// ─── iOS: תוצאה יומית מה-Monitor Extension ─────────────────────────────────
// ה-extension שואל את אפל "כמה זמן באפליקציות היה היום" ב-23:30 (זמני) וב-00:01
// (סופי, על היום שנגמר), ושולח לכאן גם כשהאפליקציה סגורה.
// minutes = הסף הגבוה ביותר שנורה, כלומר גבול תחתון ברבעי שעה: הזמן האמיתי
// נמצא בין minutes ל-minutes+15. ה-VIEW של הדירוג משווה day_minutes <= יעד,
// ולכן שומרים minutes+1: סף שנורה בדיוק על היעד פירושו שהיעד נחצה.
app.post('/api/ios-day', auth, async (req, res) => {
  if (req.session.role !== 'student') return res.status(403).json({ error: 'אין הרשאה' });
  try {
    const date = String(req.body.date || '');
    const minutes = parseInt(req.body.minutes);
    const goalMinutes = req.body.goalMinutes != null ? parseInt(req.body.goalMinutes) : NaN;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'bad date' });
    if (!Number.isFinite(minutes) || minutes < 0 || minutes > 1440) return res.status(400).json({ error: 'bad minutes' });
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
    const ageDays = (Date.parse(today) - Date.parse(date)) / 86400000;
    if (!(ageDays >= 0 && ageDays <= 8)) return res.status(400).json({ error: 'date out of range' });
    const stored = minutes >= 15 ? minutes + 1 : minutes;
    const goalHours = Number.isFinite(goalMinutes) && goalMinutes >= 0 ? goalMinutes / 60 : null;
    await pool.query(`
      INSERT INTO reports_history (id, student_id, platform, report_date, synced_at, goal_hours, day_minutes)
      VALUES ($1,$2,'ios',$3,$4,$5,$6)
      ON CONFLICT (student_id, report_date) DO UPDATE SET
        day_minutes = GREATEST(COALESCE(reports_history.day_minutes, 0), EXCLUDED.day_minutes),
        goal_hours = COALESCE(EXCLUDED.goal_hours, reports_history.goal_hours)
    `, [genId(), req.session.user_id, date, new Date().toISOString(), goalHours, stored]);
    console.log(`[ios-day] ${req.session.user_id} ${date} ${minutes}m final=${!!req.body.final}`);
    res.json({ ok: true });
  } catch (e) {
    console.error('[ios-day] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── שחזור היסטוריה לתלמיד אחרי התקנה מחדש ───────────────────────────────────
// מחזיר את הדקות היומיות ששמורות בשרת, כדי שהאפליקציה תמזג אותן
// להיסטוריה המקומית. באנדרואיד המכשיר עצמו הוא מקור אמין יותר לימים
// האחרונים, אז שם המיזוג צריך להיות משלים בלבד ולא דורס.
app.get('/api/my-history', auth, async (req, res) => {
  if (req.session.role !== 'student') return res.status(403).json({ error: 'אין הרשאה' });
  try {
    const r = await pool.query(`
      SELECT report_date, day_minutes, synced_at
      FROM reports_history
      WHERE student_id = $1 AND day_minutes IS NOT NULL
      ORDER BY report_date DESC LIMIT 60
    `, [req.session.user_id]);
    res.json({
      days: r.rows.map(x => ({
        date: typeof x.report_date === 'string'
          ? x.report_date
          : new Date(x.report_date).toISOString().split('T')[0],
        minutes: x.day_minutes,
      })),
      lastSync: r.rows[0]?.synced_at || null,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── דירוג שבועי לפי ימים שעמד ביעד, בתוך קבוצת אותו יעד ───
// מחזיר לתלמיד רק את המיקום שלו. 404 כשאין דירוג: אין יעד, אין הסכמה, או קבוצה קטנה מ-3.
app.get('/api/goal-rank', auth, async (req, res) => {
  if (req.session.role !== 'student') return res.status(403).json({ error: 'אין הרשאה' });
  try {
    const r = await pool.query(
      'SELECT goal_rank, group_size, days_met, days_reported, goal_hours, teacher_id FROM goal_rank_current_week WHERE student_id=$1',
      [req.session.user_id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'אין דירוג לשבוע הנוכחי' });
    const row = r.rows[0];
    const tie = await pool.query(
      `SELECT COUNT(*)::int AS n FROM goal_rank_current_week
       WHERE teacher_id = $1 AND goal_hours = $2 AND days_met = $3`,
      [row.teacher_id, row.goal_hours, row.days_met]
    );
    res.json({
      rank: row.goal_rank,
      groupSize: row.group_size,
      daysMet: row.days_met,
      daysReported: row.days_reported,
      goalHours: Number(row.goal_hours),
      sharedWith: (tie.rows[0]?.n || 1) - 1,
    });
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
// מופעל על ידי שירות תזמון חיצוני (cron-job.org).
// iOS: 07:00 (period=morning) ו-17:00 (period=afternoon), עם platform=ios.
// אנדרואיד: 12:00 ו-20:00, עם platform=android.
// בלי platform - נשלח לכולם (התנהגות קודמת).
// מוגן בסוד פשוט (CRON_SECRET) כדי שלא כל אחד יוכל להפעיל.
async function sendSilentPushToAll(period, platform) {
  if (!firebaseReady) {
    console.log('[FCM] skipped - firebase not ready');
    return { sent: 0, failed: 0, error: 'firebase not ready' };
  }
  const r = platform
    ? await pool.query(
        `SELECT s.id, s.name, s.fcm_token, rp.goal_hours, h.day_minutes, h.synced_at AS day_synced_at
         FROM students s
         JOIN reports rp ON rp.student_id = s.id
         LEFT JOIN reports_history h
           ON h.student_id = s.id
          AND h.report_date::date = (NOW() AT TIME ZONE 'Asia/Jerusalem')::date
         WHERE s.fcm_token IS NOT NULL AND s.active=TRUE AND rp.platform = $1`,
        [platform])
    : await pool.query(
        `SELECT s.id, s.name, s.fcm_token, rp.goal_hours, h.day_minutes, h.synced_at AS day_synced_at
         FROM students s
         LEFT JOIN reports rp ON rp.student_id = s.id
         LEFT JOIN reports_history h
           ON h.student_id = s.id
          AND h.report_date::date = (NOW() AT TIME ZONE 'Asia/Jerusalem')::date
         WHERE s.fcm_token IS NOT NULL AND s.active=TRUE`);
  let sent = 0, failed = 0;
  const invalidTokens = [];
  const failures = [];

  for (const student of r.rows) {
    try {
      // פוש הבוקר הוא התראה רגילה ולא שקטה: כל מה שהוא צריך זה היעד,
      // והיעד שמור בשרת. התראה רגילה מגיעה תמיד, גם כשהאפליקציה נסגרה בהחלקה.
      if (period === 'morning') {
        await admin.messaging().send(buildMorningAlert(student));
        sent++;
        continue;
      }
      // גם 17:00 הוא התראה רגילה. המספר מוצג רק אם הדיווח של היום עדכני.
      if (period === 'afternoon') {
        await admin.messaging().send(buildAfternoonAlert(student));
        sent++;
        continue;
      }
      await admin.messaging().send({
        token: student.fcm_token,
        data: { type: 'daily_sync', period: period || 'noon' },
        android: {
          priority: 'high', // חשוב: מבטיח שההודעה תעיר את האפליקציה גם במצב חיסכון
          ttl: 30 * 60 * 1000, // תוקף חצי שעה (במילישניות): אם המכשיר לא זמין תוך 30 דקות,
                               // ההודעה מתבטלת ולא נמסרת מאוחר (למשל פוש שבת שיגיע במוצ"ש).
        },
        apns: {
          // ב-iOS פוש שקט מחייב content-available ועדיפות 5, אחרת
          // המערכת לא מעירה את האפליקציה כלל. גם עם זה iOS מחליט
          // בעצמו אם להריץ, לפי סוללה ודפוסי שימוש - זה best effort.
          headers: {
            'apns-priority': '5',
            'apns-push-type': 'background',
            'apns-expiration': String(Math.floor(Date.now() / 1000) + 30 * 60),
          },
          payload: {
            aps: { 'content-available': 1 },
          },
        },
      });
      sent++;
    } catch (e) {
      failed++;
      failures.push({ id: student.id, name: student.name, code: e.code || 'unknown', message: (e.message || '').slice(0, 120) });
      console.log(`[FCM] failed student=${student.id} code=${e.code} msg=${e.message}`);
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

  console.log(`[FCM] period=${period} platform=${platform || 'all'} sent=${sent} failed=${failed} cleaned=${invalidTokens.length}`);
  return { sent, failed, cleaned: invalidTokens.length, failures };
}

const MORNING_CHEERS = [
  'אתה יכול לעשות את זה 💪',
  'יום חדש, הזדמנות חדשה 🌱',
  'בהצלחה היום! 🎯',
  'עוד יום אחד לכיוון הכוכב ⭐',
];

function fmtHours(h) {
  const n = Number(h) || 0;
  return n === 1 ? 'שעה' : n === 2 ? 'שעתיים' : `${n} שעות`;
}

function fmtMinutes(m) {
  const h = Math.floor(m / 60);
  const mm = m % 60;
  if (h === 0) return `${mm} ד׳`;
  if (mm === 0) return `${h} ש׳`;
  return `${h} ש׳ ${mm} ד׳`;
}

const pickOne = arr => arr[Math.floor(Math.random() * arr.length)];
const ON_TRACK_TITLES = ['כל הכבוד! 🌤️', 'אתה בדרך הנכונה 👏', 'יפה מאוד! 🌿'];
const ON_TRACK_CHEERS = ['ממשיכים ככה עד הערב 💪', 'עוד קצת והיום הזה בכיס 🔥', 'שומרים על הקצב 🎯'];
const OVER_TITLES = ['לא נורא 🌙', 'קורה לכולם 🤍', 'מחר מתחילים מחדש 🌱'];
const OVER_HOPES = ['מחר יום חדש, ואתה יכול 🌱', 'כל יום הוא הזדמנות חדשה ✨', 'מחר נצליח יחד 💪'];
const FRESH_MS = 2 * 60 * 60 * 1000;

// עם דיווח מהשעתיים האחרונות: עידוד או נחמה לפי המספר.
// בלי דיווח עדכני: הזמנה לפתוח את האפליקציה, שם מוצג המספר המדויק של אפל.
function buildAfternoonAlert(student) {
  const goalMin = Math.round((Number(student.goal_hours) || 0) * 60);
  const minutes = student.day_minutes == null ? null : Number(student.day_minutes);
  const syncedAt = student.day_synced_at ? new Date(student.day_synced_at).getTime() : 0;
  const fresh = minutes !== null && minutes > 0 && Date.now() - syncedAt < FRESH_MS;

  let title;
  let body;
  if (fresh && goalMin > 0 && minutes > goalMin) {
    title = pickOne(OVER_TITLES);
    body = `היום עברת את היעד. ${pickOne(OVER_HOPES)}`;
  } else if (fresh && goalMin > 0) {
    title = pickOne(ON_TRACK_TITLES);
    body = `צברת ${fmtMinutes(minutes)} עד עכשיו · נשארו ${fmtMinutes(goalMin - minutes)} ליעד. ${pickOne(ON_TRACK_CHEERS)}`;
  } else {
    title = 'איך הולך היום? 🌤️';
    body = goalMin > 0
      ? 'פתח את האפליקציה ובדוק אם אתה בתוך היעד 🎯'
      : 'פתח את האפליקציה ובחר יעד יומי 🎯';
  }
  return {
    token: student.fcm_token,
    notification: { title, body },
    // האפליקציה מקבלת גם הזדמנות להתעורר ולדווח את המספר העדכני, בלי להציג התראה נוספת.
    data: { type: 'afternoon_alert' },
    android: { priority: 'high', ttl: 2 * 60 * 60 * 1000 },
    apns: {
      headers: {
        'apns-priority': '10',
        'apns-push-type': 'alert',
        'apns-expiration': String(Math.floor(Date.now() / 1000) + 2 * 60 * 60),
      },
      payload: { aps: { sound: 'default', 'content-available': 1 } },
    },
  };
}

function buildMorningAlert(student) {
  const cheer = MORNING_CHEERS[Math.floor(Math.random() * MORNING_CHEERS.length)];
  const goal = Number(student.goal_hours) || 0;
  const body = goal > 0
    ? `היעד שלך היום: ${fmtHours(goal)}. ${cheer}`
    : 'בחר יעד יומי באפליקציה ותתחיל לצבור כוכבים 🎯';
  return {
    token: student.fcm_token,
    notification: { title: 'בוקר טוב ☀️', body },
    // type שונה מ-daily_sync, כדי שהאפליקציה לא תריץ עליו סנכרון.
    data: { type: 'morning_alert' },
    android: { priority: 'high', ttl: 2 * 60 * 60 * 1000 },
    apns: {
      headers: {
        'apns-priority': '10',
        'apns-push-type': 'alert',
        // תוקף שעתיים: פוש בוקר שמגיע בצהריים כבר לא רלוונטי.
        'apns-expiration': String(Math.floor(Date.now() / 1000) + 2 * 60 * 60),
      },
      payload: { aps: { sound: 'default' } },
    },
  };
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
  const platform = req.query.platform || req.body?.platform || null;
  if (platform && !['ios', 'android'].includes(platform)) {
    return res.status(400).json({ error: 'platform must be ios or android' });
  }
  try {
    const result = await sendSilentPushToAll(period, platform);
    res.json({ ok: true, ...result });
  } catch (e) {
    console.log('[send-daily-push] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── בדיקת גרסה מינימלית נדרשת ──
// האפליקציה שואלת בפתיחה. השרת מחזיר את הגרסה המינימלית שמותר לעבוד איתה.
// כדי לחייב עדכון - פשוט משנים כאן את המספר (או דרך משתנה סביבה MIN_APP_VERSION ב-Render).
// גרסה מינימלית לכל פלטפורמה בנפרד, עם קישור לחנות המתאימה.
// משתני סביבה ב-Render: MIN_APP_VERSION_IOS, MIN_APP_VERSION_ANDROID.
// MIN_APP_VERSION נשאר כברירת מחדל לשתיהן.
// גרסאות ישנות שלא שולחות platform מזוהות לפי ה-User-Agent:
// באייפון הבקשה יוצאת עם CFNetwork/Darwin, ובאנדרואיד עם okhttp.
// כך ההפרדה עובדת מיד, בלי לעדכן את האפליקציה.
app.get('/api/min-version', (req, res) => {
  const fallback = process.env.MIN_APP_VERSION || '5.0';
  const ua = String(req.headers['user-agent'] || '');
  let platform = String(req.query.platform || '').toLowerCase();
  if (!platform) platform = /CFNetwork|Darwin|iPhone|iOS/i.test(ua) ? 'ios' : 'android';
  if (platform === 'ios') {
    return res.json({
      minVersion: process.env.MIN_APP_VERSION_IOS || fallback,
      storeUrl: 'https://apps.apple.com/app/id6811993215',
    });
  }
  res.json({
    minVersion: process.env.MIN_APP_VERSION_ANDROID || fallback,
    storeUrl: 'https://play.google.com/store/apps/details?id=com.screentimestudent2',
  });
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
