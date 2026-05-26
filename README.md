# לוח בקרה — Dashboard Template

דשבורד עסקי חי המציג נתונים חודשיים מקובצי Excel.  
מתארח על Vercel, נתונים שמורים ב-Supabase, קבצים זמניים ב-Vercel Blob.

---

## מבנה הפרויקט

```
Dashboard Template/
├── dashboard.html          ← הדשבורד הראשי (קריאה בלבד, ציבורי)
├── upload.html             ← דף העלאת קבצים (מוגן סיסמה)
├── api/
│   ├── upload.js           ← מקבל קבצי Excel → שומר ל-Blob → מפעיל process
│   ├── process.js          ← מעבד קבצים → מעדכן Supabase
│   ├── get-data.js         ← מגיש נתונים נוכחיים לדשבורד
│   └── seed.js             ← אתחול חד-פעמי עם נתוני מאי 2026
├── lib/
│   └── processors.js       ← כל לוגיקת עיבוד Excel (SheetJS)
├── package.json
└── vercel.json
```

---

## ארכיטקטורה

```
משתמש
  │
  ├─→ GET  /               → dashboard.html
  │         └─→ fetch /api/get-data  → Supabase → JS variables → גרפים + KPIs
  │
  └─→ GET  /upload         → upload.html (סיסמה)
            └─→ POST /api/upload  → Vercel Blob
                      └─→ POST /api/process → Supabase upsert
```

**שירותים:**
| שירות | תפקיד | תוכנית |
|--------|--------|---------|
| Vercel | Hosting + Serverless | Hobby (חינם) |
| Supabase | PostgreSQL — שמירת היסטוריה | Free tier |
| Vercel Blob | אחסון זמני Excel בזמן עיבוד | Free tier |

---

## הגדרת סביבה (Deployment)

### 1. Supabase — צור טבלה

ב-Supabase SQL Editor:
```sql
create table dashboard_history (
  id         int primary key,
  data       jsonb not null,
  updated_at timestamptz default now()
);
```

### 2. Vercel — Environment Variables

| משתנה | מקור |
|--------|-------|
| `SUPABASE_URL` | Supabase → Settings → API → Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Settings → API → service_role key |
| `UPLOAD_PASSWORD` | סיסמה לבחירתך לדף ההעלאה |
| `BLOB_READ_WRITE_TOKEN` | Vercel → Storage → Blob → נוצר אוטומטית |

### 3. Vercel Blob

Vercel Dashboard → Storage → Create Database → Blob → חבר לפרויקט.

### 4. Deploy ראשון

```bash
git init && git add . && git commit -m "initial"
# חבר repo ל-Vercel דרך vercel.com
git push
```

### 5. אתחול נתונים (פעם אחת)

```bash
curl -X POST "https://YOUR-DOMAIN.vercel.app/api/seed?password=YOUR_PASSWORD"
```

טוען את נתוני מאי 2026 לתוך Supabase.

---

## תהליך עדכון חודשי

1. ייצא קבצי Excel מהמערכת (EasyBizy)
2. פתח `https://YOUR-DOMAIN.vercel.app/upload`
3. הזן סיסמה
4. העלה כל קובץ לקטגוריה המתאימה
5. לחץ **"עדכן דשבורד"**
6. הדשבורד מתעדכן מיד

---

## מיפוי קבצי Excel לקטגוריות

| קטגוריה בדף ההעלאה | קובץ EasyBizy | עמודות מזהות |
|--------------------|---------------|--------------|
| לקוחות חדשים | Customers (5).xlsx | `CreatedOn`, `NumberOfVisits` |
| לקוחות פעילים | Customers (6).xlsx | `LastVisit`, `NextMeeting`, `CustomerId` |
| מכירות | TotalSales (2).xlsx | `תאריך`, `סכום`, `חוב`, `CustomerId` |
| מנויים וכרטיסיות | Subscriptions.xlsx | `לקוח`, `נותרו` |
| פגישות | MeetingClosings.xlsx | `CustomerId`, `CustomerName`, `MeetingStartTime` |

> **הערה:** המספרים בשמות הקבצים (5), (6) וכו' עשויים להשתנות. המערכת מזהה לפי **מבנה העמודות**, לא לפי שם הקובץ.

---

## לוגיקת חישובים (`lib/processors.js`)

### לקוחות חדשים
```
ספור שורות שבהן CreatedOn בתוך החודש AND NumberOfVisits > 0
```

### לקוחות פעילים (Distinct)
```
ספור לקוחות ייחודיים שבהם LastVisit בתוך החודש
```

### הכנסות
```
revenueTotal = sum(סכום) עבור שורות שבהן סכום > 0 AND חוב >= 0 (מכירות חדשות בלבד)
revenuePaid  = revenueTotal - sum(חוב חיובי שנותר פתוח)

שורות עם חוב < 0 = גביית חובות ישנים — לא נכנסות לrevenueTotal
```

### לקוחות בסיכון (KPI)
```
לקוחות שביקרו בחודש N-1 אך לא ביקרו בחודש N
(מחושב מ-visitor_sets המצטבר ב-Supabase)
```

### חובות פתוחים (KPI)
```
net_balance לכל CustomerId = sum(כל ערכי חוב)
מציג לקוחות שבהם net_balance > 0
```

### כרטיסיות לקראת סיום (KPI)
```
לקוחות ייחודיים שבהם נותרו ∈ {1, 2}
```

### פער בקביעת תור הבא (KPI)
```
לקוחות שהגיעו לפגישה בחודש הנוכחי
AND אין להם NextMeeting עתידי בקובץ הלקוחות הפעילים
```

---

## מבנה הנתונים ב-Supabase

טבלה: `dashboard_history`, שורה אחת (`id = 1`), עמודת `data` מסוג JSONB:

```json
{
  "months": {
    "2026-05": {
      "activeClients": 40,
      "newClients": 5,
      "revenueTotal": 17720,
      "revenuePaid": 13390
    }
  },
  "visitor_sets": {
    "2026-05": [1739, 2778, 13298, ...]
  },
  "debt_ledger": {
    "CUSTOMER_ID": { "name": "שם לקוח", "balance": 1250 }
  },
  "client_name_map": {
    "1739": "מליס אקא"
  },
  "kpis": {
    "openDebts":     { "count": 3, "total": 3050, "names": ["..."] },
    "atRiskClients": { "count": 9, "names": ["..."] },
    "expiringCards": { "count": 14, "names": ["..."] },
    "noNextMeeting": { "count": 39, "names": ["..."] }
  },
  "lastUpdated": "2026-05-26T14:30:00.000Z"
}
```

**חלון גרף:** 12 חודשים אחרונים עם נתונים, לפי סדר כרונולוגי.  
**עדיפות:** קובץ חדש מחליף נתוני תקופה קיימים (לא מסכם).

---

## נתונים קיימים (מאי 2026)

הנתונים הבאים כבר חושבו ונטענים ע"י `/api/seed`:

| מדד | ערך |
|-----|-----|
| לקוחות פעילים | 40 |
| לקוחות חדשים | 5 |
| מכירות | 17,720 ₪ |
| שולם | 13,390 ₪ |
| חובות פתוחים | 3 לקוחות / 3,050 ₪ |
| לקוחות בסיכון | 9 |
| כרטיסיות לקראת סיום | 14 |
| פער בקביעת תור הבא | 39 |

**קבצי מקור שנותחו** (שמורים ב-`C:\Users\Ironadmin\Downloads\ester 26_05_26\`):
- `Customers (5).xlsx` — 86 שורות
- `Customers (6).xlsx` — 62 שורות
- `TotalSales (2).xlsx` — 48 שורות
- `Subscriptions.xlsx`
- `MeetingClosings.xlsx` — 61 שורות

---

## Dependencies

```json
{
  "@supabase/supabase-js": "^2.49.0",
  "@vercel/blob": "^0.27.0",
  "multiparty": "^4.2.3",
  "xlsx": "^0.18.5"
}
```

---

## קבצים נוספים שנוצרו במהלך ניתוח (Downloads)

סקריפטי Python לניתוח חד-פעמי — לא חלק מהפרויקט:
- `analyze_excel.py`
- `analyze_debt.py`
- `analyze_sales_detail.py`
- `analyze_may_sales.py`
- `analyze_open_debts.py`
- `analyze_at_risk.py`
- `analyze_expiring_cards.py`
- `analyze_meetings.py`
- `analyze_no_next_meeting.py`
