const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

// אחסון בזיכרון — מספיק להתחלה
// בהמשך אפשר להחליף ב-MongoDB או Supabase
let reports = {};
let students = [
  { id: '1', name: 'דניאל כהן',   cls: 'ט׳2', platform: 'iOS',     consent: true  },
  { id: '2', name: 'נועה לוי',    cls: 'ט׳2', platform: 'Android', consent: true  },
  { id: '3', name: 'יוסף אזולאי', cls: 'ט׳2', platform: 'iOS',     consent: true  },
  { id: '4', name: 'שירה מזרחי',  cls: 'י׳1', platform: 'Android', consent: true  },
  { id: '5', name: 'איתי ברק',    cls: 'י׳1', platform: 'iOS',     consent: true  },
  { id: '6', name: 'מאיה פרץ',    cls: 'ט׳2', platform: 'iOS',     consent: true  },
  { id: '7', name: 'רון גולדברג', cls: 'י׳1', platform: 'Android', consent: false },
  { id: '8', name: 'ליאת שפירא',  cls: 'ט׳2', platform: 'iOS',     consent: true  },
];

// ─── Health check ────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Screen Time Server פועל' });
});

// ─── תלמידים ─────────────────────────────────────────────────────────────────

// קבל רשימת כל התלמידים
app.get('/api/students', (req, res) => {
  const result = students.map(s => ({
    ...s,
    hours: reports[s.id]?.dailyAverage ?? 0,
    lastSync: reports[s.id]?.syncedAt ?? null,
    weeklyData: reports[s.id]?.weeklyData ?? [0,0,0,0,0,0,0],
  }));
  res.json(result);
});

// הוסף תלמיד חדש
app.post('/api/students', (req, res) => {
  const { name, cls, platform } = req.body;
  if (!name || !cls) return res.status(400).json({ error: 'נדרש שם וכיתה' });
  const id = String(Date.now());
  const initials = name.split(' ').map(w => w[0]).join('').slice(0, 2);
  const student = { id, name, initials, cls, platform: platform || 'iOS', consent: false };
  students.push(student);
  res.json({ ok: true, student });
});

// מחק תלמיד
app.delete('/api/students/:id', (req, res) => {
  students = students.filter(s => s.id !== req.params.id);
  delete reports[req.params.id];
  res.json({ ok: true });
});

// ─── דוחות ───────────────────────────────────────────────────────────────────

// תלמיד מעלה דוח זמן מסך
app.post('/api/report', (req, res) => {
  const { studentId, dailyAverage, totalMinutes, weeklyData, consent, platform, syncedAt } = req.body;
  if (!studentId) return res.status(400).json({ error: 'נדרש studentId' });

  // עדכן הסכמה
  const student = students.find(s => s.id === studentId);
  if (student && consent) {
    student.consent = consent.total || false;
  }

  reports[studentId] = {
    studentId,
    dailyAverage: dailyAverage ?? 0,
    totalMinutes: totalMinutes ?? 0,
    weeklyData: weeklyData ?? [0,0,0,0,0,0,0],
    consent: consent ?? {},
    platform: platform ?? 'unknown',
    syncedAt: syncedAt ?? new Date().toISOString(),
  };

  res.json({ ok: true, received: new Date().toISOString() });
});

// קבל דוח של תלמיד ספציפי
app.get('/api/report/:studentId', (req, res) => {
  const report = reports[req.params.studentId];
  if (!report) return res.status(404).json({ error: 'אין דוח עדיין' });
  res.json(report);
});

// קבל סיכום כל הדוחות (למורה)
app.get('/api/reports', (req, res) => {
  const result = students.map(s => ({
    ...s,
    report: reports[s.id] ?? null,
    hours: reports[s.id]?.dailyAverage ?? 0,
    weeklyData: reports[s.id]?.weeklyData ?? [0,0,0,0,0,0,0],
    lastSync: reports[s.id]?.syncedAt ?? null,
  }));
  res.json(result);
});

// ─── הסכמה ───────────────────────────────────────────────────────────────────

// תלמיד מעדכן הסכמה
app.post('/api/consent/:studentId', (req, res) => {
  const student = students.find(s => s.id === req.params.studentId);
  if (!student) return res.status(404).json({ error: 'תלמיד לא נמצא' });
  student.consent = req.body.total ?? false;
  if (reports[req.params.studentId]) {
    reports[req.params.studentId].consent = req.body;
  }
  res.json({ ok: true });
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`✅ השרת פועל על פורט ${PORT}`);
});
