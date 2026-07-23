// server-changes.js
// שינויים נדרשים ב-index.js (השרת, screentime-server)
// כל בלוק מטה מחליף את הפונקציה המקבילה בקובץ הקיים - לא קובץ חדש, אלא מדריך להחלפה.

// ─────────────────────────────────────────────────────────────────────────
// 1) POST /api/report - מפסיק לקבל/לשמור byApp ו-timing, מוסיף goalHours/wellnessScore
// ─────────────────────────────────────────────────────────────────────────
app.post('/api/report', auth, async (req, res) => {
  if (req.session.role !== 'student') return res.status(403).json({ error: 'אין הרשאה' });
  const {
    dailyAverage, totalMinutes, weeklyData, consent, platform,
    syncedAt, pushStatus, pushSentAt, syncSource, appVersion,
    goalHours, overallGoalPassed, wellnessScore, // ← שדות חדשים
  } = req.body;

  try {
    if (consent) await pool.query('UPDATE students SET consent=$1 WHERE id=$2', [consent.total || false, req.session.user_id]);

    await pool.query(`
      INSERT INTO reports (student_id, daily_average, total_minutes, weekly_data, consent, platform, synced_at,
                            session_count, avg_session_seconds, push_status, push_sent_at, sync_source, app_version,
                            goal_hours, overall_goal_passed, wellness_score)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      ON CONFLICT (student_id) DO UPDATE SET
        daily_average=$2, total_minutes=$3, weekly_data=$4, consent=$5, platform=$6, synced_at=$7,
        session_count=$8, avg_session_seconds=$9, push_status=$10, push_sent_at=$11, sync_source=$12, app_version=$13,
        goal_hours=$14, overall_goal_passed=$15, wellness_score=$16
    `, [req.session.user_id, dailyAverage || 0, totalMinutes || 0,
        JSON.stringify(weeklyData || [0,0,0,0,0,0,0]),
        JSON.stringify(consent || {}), platform || 'unknown',
        syncedAt || new Date().toISOString(),
        parseInt(req.body.sessionCount)||0, parseInt(req.body.avgSessionSeconds)||0,
        pushStatus || null, pushSentAt || null, syncSource || null, appVersion || null,
        goalHours || null, overallGoalPassed ?? null, wellnessScore || null]);

    const today = new Date().toISOString().split('T')[0];
    const histId = genId();
    await pool.query(`
      INSERT INTO reports_history (id, student_id, daily_average, total_minutes, weekly_data, consent, platform,
                                    report_date, synced_at, session_count, avg_session_seconds,
                                    goal_hours, overall_goal_passed, wellness_score)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      ON CONFLICT (student_id, report_date) DO UPDATE SET
        daily_average=EXCLUDED.daily_average, total_minutes=EXCLUDED.total_minutes, weekly_data=EXCLUDED.weekly_data,
        consent=EXCLUDED.consent, platform=EXCLUDED.platform, synced_at=EXCLUDED.synced_at,
        session_count=EXCLUDED.session_count, avg_session_seconds=EXCLUDED.avg_session_seconds,
        goal_hours=EXCLUDED.goal_hours, overall_goal_passed=EXCLUDED.overall_goal_passed, wellness_score=EXCLUDED.wellness_score
    `, [histId, req.session.user_id, parseFloat(dailyAverage)||0, parseInt(totalMinutes)||0,
        JSON.stringify(weeklyData||[0,0,0,0,0,0,0]),
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

// ─────────────────────────────────────────────────────────────────────────
// 2) GET /api/students - מסך המורה הראשי. הוסרו hours/weeklyData/byApp/timing/session*,
//    נוספו goalHours/overallGoalPassed/wellnessScore
// ─────────────────────────────────────────────────────────────────────────
app.get('/api/students', auth, teacherOnly, async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const r = await pool.query(`
      SELECT s.*, r.goal_hours, r.overall_goal_passed, r.wellness_score, r.synced_at, r.push_status, r.push_sent_at, r.sync_source, m.mood
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
      goalHours: s.goal_hours !== null ? parseFloat(s.goal_hours) : null,
      overallGoalPassed: s.overall_goal_passed,
      wellnessScore: s.wellness_score,
      lastSync: s.synced_at || null,
      mood: s.mood || null,
      pushStatus: s.push_status || null,
      pushSentAt: s.push_sent_at || null,
      syncSource: s.sync_source || null,
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────
// 3) GET /api/students/range - טווח תאריכים. הוסר hours/totalMinutes/session*,
//    נוסף ממוצע ציון ואחוז ימים שעמד ביעד בטווח
// ─────────────────────────────────────────────────────────────────────────
app.get('/api/students/range', auth, teacherOnly, async (req, res) => {
  try {
    const { from, to } = req.query;
    const today = new Date().toISOString().split('T')[0];
    const fromDate = from || today;
    const toDate = to || today;

    const r = await pool.query(`
      SELECT s.id, s.name, s.class_name, s.consent,
        AVG(h.wellness_score) as avg_wellness_score,
        COUNT(h.report_date) as days_count,
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
      avgWellnessScore: Math.round(parseFloat(s.avg_wellness_score)) || null,
      daysCount: parseInt(s.days_count) || 0,
      daysGoalPassed: parseInt(s.days_goal_passed) || 0,
      lastSync: s.last_sync || null,
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────
// 4) GET /api/history - היה מחזיר שורות גולמיות ללא סינון (כולל by_app/timing).
//    עכשיו SELECT מפורש - רק ציון/יעד, בלי פירוט אפליקציות/שעות בכלל
// ─────────────────────────────────────────────────────────────────────────
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
    else fromDate = '2020-01-01';

    const r = await pool.query(`
      SELECT s.id, s.name, s.class_name, h.goal_hours, h.overall_goal_passed, h.wellness_score, h.report_date, h.synced_at
      FROM students s
      LEFT JOIN reports_history h ON s.id = h.student_id AND h.report_date >= $2
      WHERE s.teacher_id = $1
      ORDER BY s.class_name, s.name, h.report_date DESC
    `, [req.session.teacher_id, fromDate]);
    res.json({ rows: r.rows, range, fromDate, today, yesterday: yesterdayStr });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────
// 5) GET /api/class-rank - חדש. מחזיר לתלמיד רק את המיקום שלו עצמו, לא שמות אחרים
// ─────────────────────────────────────────────────────────────────────────
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
