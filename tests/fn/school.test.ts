// Unit tests for hub-jobs' school action (supabase/functions/hub-jobs/school.ts, ical.ts), through handle()
// as the Edge Function runs it: a fake school host behind the injected fetch, a fake database answering
// school_begin, school_store and school_finish with the shapes migration 0006 returns, and a fake clock.
// Covered: the iCal reader on a realistic feed (folded lines, CRLF and LF, VALUE=DATE and Blackbaud's
// midnight all-day form, exclusive all-day ends, TZID with an IANA zone, a Windows zone name and an unknown
// one, Z times, HTML entities and a description in HTML, a VALARM and a VTIMEZONE, a cancelled event,
// a repeated UID, an RRULE counted and not expanded); what is kept (the window, a 14-month schedule of
// 1,500 classes of which 56 days are kept, an assignment due 200 days out, the caps); the address check
// (webcal, https only, port 443, no user info, the host suffix, the path, z, the length); redirects (to
// http, to port 8443, with user info, to another host, a fourth, all refused; three followed); the size
// limit (Content-Length, and a body that runs on); the time limit; each HTTP answer's code; an HTML
// sign-in page; one link's failure not stopping the others; who may ask; and that a link's address never
// reaches a log line, the database (but from school_begin) or the answer, even when fetch's own error
// quotes it.
// Everything is made up: the school's host academy.school.example (the allowed suffix is replaced with
// .school.example, as the database tests replace theirs), the classes, the teachers and the assignments.
// Run alone with: node --experimental-strip-types tests/fn/school.test.ts
import { handle } from '../../supabase/functions/hub-jobs/handler.ts';
import {
  SCHOOL_HOST, SCHOOL_LIMITS, MAX_BYTES, RUN_BUDGET_MS, checkAddress, keep,
} from '../../supabase/functions/hub-jobs/school.ts';
import { parseIcal, splitClass, resolveZone } from '../../supabase/functions/hub-jobs/ical.ts';
import { readFileSync } from 'node:fs';

const results: string[] = [];
const check = (name: string, ok: boolean, detail: unknown = '') =>
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' && !ok ? `  (${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 500)})` : ''}`);

// ---------------------------------------------------------------------
// Fixtures (made up)
// ---------------------------------------------------------------------
check('the address check allows hosts ending in .myschoolapp.com only (Blackbaud\'s)', SCHOOL_HOST.suffix === '.myschoolapp.com');
check('... so a made-up school host is refused with it', checkAddress('https://academy.school.example/podium/feed/iCal.aspx?z=Q1w2E3r4') === null);
SCHOOL_HOST.suffix = '.school.example';

const SECRET = '6c1e9a4f2b7d0e3a5c8f1b4d7a0e3c6f9b2d5a8c';   // the cron secret, made up
const TZ = 'America/New_York';
const TODAY = '2026-11-02';
const NOW = Date.parse('2026-11-02T15:23:00Z');            // Mon Nov 2, 10:23am in New York
const RUN = 'eeeeeeee-0000-4000-8000-0000000000aa';
const HOST = 'academy.school.example';
const z = (s: string) => `https://${HOST}/podium/feed/iCal.aspx?z=${s}`;
const FEEDS = {
  assignments: { feed_id: 'ffffffff-0000-4000-8000-000000000001', kind: 'assignments', url: z('A1a2A3a4A5a6A7a8') },
  schedule: { feed_id: 'ffffffff-0000-4000-8000-000000000002', kind: 'schedule', url: z('S1s2S3s4S5s6S7s8') },
  games: { feed_id: 'ffffffff-0000-4000-8000-000000000003', kind: 'games', url: z('G1g2G3g4G5g6G7g8') },
};

// An Assignments feed as Blackbaud's export looks (CRLF, folded at 75 octets, a VTIMEZONE written the way
// a .NET calendar writes it). The teachers and classes are made up.
const crlf = (lines: string[]) => lines.join('\r\n') + '\r\n';
const ASSIGNMENTS = crlf([
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Example K12//Calendar Feed//EN',
  'CALSCALE:GREGORIAN',
  'METHOD:PUBLISH',
  'X-WR-CALNAME:Assignments',
  'X-WR-TIMEZONE:America/New_York',
  'BEGIN:VTIMEZONE',
  'TZID:Eastern Standard Time',
  'BEGIN:STANDARD',
  'DTSTART:16011104T020000',
  'RRULE:FREQ=YEARLY;BYDAY=1SU;BYMONTH=11',
  'TZOFFSETFROM:-0400',
  'TZOFFSETTO:-0500',
  'END:STANDARD',
  'BEGIN:DAYLIGHT',
  'DTSTART:16010311T020000',
  'RRULE:FREQ=YEARLY;BYDAY=2SU;BYMONTH=3',
  'TZOFFSETFROM:-0500',
  'TZOFFSETTO:-0400',
  'END:DAYLIGHT',
  'END:VTIMEZONE',
  // 1. An all-day date, its end exclusive; the class in the title with its section and block; a
  //    description in HTML, folded, with escaped commas.
  'BEGIN:VEVENT',
  'UID:a-101@academy.school.example',
  'DTSTAMP:20261030T120000Z',
  'DTSTART;VALUE=DATE:20261105',
  'DTEND;VALUE=DATE:20261106',
  'SUMMARY:Biology - 2 (B): Lab report: water filters',
  'DESCRIPTION:<p>Write up the lab\\, using the template.</p><p>Due at the start ',
  ' of class. Ms. Rivera</p>',
  'BEGIN:VALARM',
  'ACTION:DISPLAY',
  'SUMMARY:Reminder from the alarm',
  'DESCRIPTION:not the description',
  'TRIGGER:-PT15M',
  'END:VALARM',
  'END:VEVENT',
  // 2. Blackbaud's midnight form, floating; an HTML entity in the title.
  'BEGIN:VEVENT',
  'UID:a-102@academy.school.example',
  'DTSTART:20261103T000000',
  'DTEND:20261104T000000',
  'SUMMARY:History 8 - 1: Read chapters 5 &amp; 6',
  'END:VEVENT',
  // 3. A span from the assigned day to the due day.
  'BEGIN:VEVENT',
  'UID:a-103@academy.school.example',
  'DTSTART;VALUE=DATE:20261102',
  'DTEND;VALUE=DATE:20261117',
  'SUMMARY:English 8 - 3 (C): Essay: a person who changed a town',
  'DESCRIPTION:Five paragraphs.\\nCite two sources\\; use MLA.',
  'END:VEVENT',
  // 4. Midnight in UTC (5:00Z is midnight in New York after the clock change).
  'BEGIN:VEVENT',
  'UID:a-104@academy.school.example',
  'DTSTART:20261106T050000Z',
  'DTEND:20261107T050000Z',
  'SUMMARY:Spanish 1 - 3 (D): Vocabulary quiz',
  'END:VEVENT',
  // 5. A Windows zone name at midnight, no end, folded with a tab.
  'BEGIN:VEVENT',
  'UID:a-105@academy.school.example',
  'DTSTART;TZID=Eastern Standard Time:20261112T000000',
  'SUMMARY:Art 8: Sketch three',
  '\t views of a chair',
  'END:VEVENT',
  // 6. A timed due (11:59pm) in an IANA zone.
  'BEGIN:VEVENT',
  'UID:a-106@academy.school.example',
  'DTSTART;TZID=America/New_York:20261113T235900',
  'DTEND;TZID=America/New_York:20261113T235900',
  'SUMMARY:Math 8 - 2: Worksheet 5.1',
  'END:VEVENT',
  // 7. Taken off the site.
  'BEGIN:VEVENT',
  'UID:a-107@academy.school.example',
  'STATUS:CANCELLED',
  'DTSTART;VALUE=DATE:20261110',
  'SUMMARY:Cancelled: field notes',
  'END:VEVENT',
  // 8. No UID; a title that names no class ("Chapter 6: …").
  'BEGIN:VEVENT',
  'DTSTART;VALUE=DATE:20261109',
  'DTEND;VALUE=DATE:20261110',
  'SUMMARY:Chapter 6: questions 1-10',
  'END:VEVENT',
  // 9. Due 200 days out: not kept (and so never "missing").
  'BEGIN:VEVENT',
  'UID:a-109@academy.school.example',
  'DTSTART;VALUE=DATE:20270521',
  'SUMMARY:Science 8: Year-end project',
  'END:VEVENT',
  // 10. Past the window (two months back).
  'BEGIN:VEVENT',
  'UID:a-110@academy.school.example',
  'DTSTART;VALUE=DATE:20260904',
  'SUMMARY:Science 8: Safety contract',
  'END:VEVENT',
  // 11. The same UID as 2, later in the feed (the database keeps the last).
  'BEGIN:VEVENT',
  'UID:a-102@academy.school.example',
  'DTSTART;VALUE=DATE:20261104',
  'SUMMARY:History 8 - 1: Read chapters 5 and 6',
  'END:VEVENT',
  // 12. A repeating event: read once, counted.
  'BEGIN:VEVENT',
  'UID:a-112@academy.school.example',
  'DTSTART;VALUE=DATE:20261102',
  'RRULE:FREQ=WEEKLY;COUNT=6',
  'SUMMARY:English 8 - 3 (C): Reading log',
  'END:VEVENT',
  // 13. A zone this runtime doesn't know: the household's.
  'BEGIN:VEVENT',
  'UID:a-113@academy.school.example',
  'DTSTART;TZID=Olympus Mons Standard Time:20261116T000000',
  'DTEND;TZID=Olympus Mons Standard Time:20261117T000000',
  'SUMMARY:Music 8: Practice log',
  'END:VEVENT',
  'END:VCALENDAR',
]);

// A Schedule feed of 14 months: five classes on each of 300 school days from Sep 1, 2026 (1,500 events).
function scheduleFeed(): { text: string; inWindow: number } {
  const classes = [['Biology - 2 (B)', '0815', '0900'], ['History 8 - 1', '0905', '0950'], ['Math 8 - 2', '1000', '1045'],
    ['English 8 - 3 (C)', '1050', '1135'], ['Orchestra', '1530', '1615']];
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Example K12//Calendar Feed//EN', 'X-WR-CALNAME:Schedule'];
  let d = Date.parse('2026-09-01T00:00:00Z');
  let days = 0;
  let inWindow = 0;
  while (days < 300) {
    const day = new Date(d).toISOString().slice(0, 10);
    const wd = new Date(d).getUTCDay();
    if (wd !== 0 && wd !== 6) {
      days++;
      if (day >= TODAY && day <= '2026-12-27') inWindow += classes.length;
      for (const [title, s, e] of classes) {
        const ymd = day.replace(/-/g, '');
        lines.push('BEGIN:VEVENT', `UID:s-${ymd}-${s}@academy.school.example`, `DTSTART;TZID=Eastern Standard Time:${ymd}T${s}00`,
          `DTEND;TZID=Eastern Standard Time:${ymd}T${e}00`, `SUMMARY:${title}`, 'END:VEVENT');
      }
    }
    d += 86400000;
  }
  lines.push('END:VCALENDAR');
  return { text: lines.join('\n') + '\n', inWindow };   // LF line ends, as some exports have
}
const SCHEDULE = scheduleFeed();
const GAMES = crlf([
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Example K12//Calendar Feed//EN', 'X-WR-CALNAME:Games/Practices',
  'BEGIN:VEVENT', 'UID:g-1@academy.school.example', 'DTSTART;TZID=Eastern Standard Time:20261104T161500',
  'DTEND;TZID=Eastern Standard Time:20261104T180000', 'SUMMARY:Soccer game vs. the Example Otters', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:g-2@academy.school.example', 'DTSTART;VALUE=DATE:20261107', 'DTEND;VALUE=DATE:20261108',
  'SUMMARY:Cross-country meet (all day)', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:g-3@academy.school.example', 'DTSTART:20261105T213000Z', 'DURATION:PT1H30M',
  'SUMMARY:Soccer practice', 'END:VEVENT',
  'END:VCALENDAR',
]);
const SIGN_IN = '<!DOCTYPE html><html><head><title>Sign in</title></head><body><form action="/app/login">Username</form></body></html>';

// ---------------------------------------------------------------------
// The reader (ical.ts)
// ---------------------------------------------------------------------
const parsed = parseIcal(ASSIGNMENTS, TZ);
check('an Assignments feed is a calendar', parsed.kind === 'calendar', parsed.kind);
const evs = parsed.kind === 'calendar' ? parsed.events : [];
const byUid = (u: string) => evs.filter((e) => e.uid === u);
check('every VEVENT but the cancelled one is read (12), the VTIMEZONE and the VALARM aren\'t events', evs.length === 12, evs.map((e) => e.uid));
const lab = byUid('a-101@academy.school.example')[0];
check('VALUE=DATE: an all-day item, its exclusive end moved back a day', !!lab && lab.allDay && lab.firstDay === '2026-11-05' && lab.lastDay === '2026-11-05', lab);
check('... its summary unescaped, on one line', lab?.summary === 'Biology - 2 (B): Lab report: water filters', lab?.summary);
check('... its description: folded lines joined, HTML made text, \\, unescaped; the VALARM\'s text not taken',
  lab?.description === 'Write up the lab, using the template.\nDue at the start of class. Ms. Rivera', lab?.description);
const read = byUid('a-102@academy.school.example');
check('Blackbaud\'s midnight form (floating 00:00 to 00:00) is all-day on its date', read[0]?.allDay && read[0].firstDay === '2026-11-03' && read[0].lastDay === '2026-11-03', read[0]);
check('... an HTML entity in the title is decoded', read[0]?.summary === 'History 8 - 1: Read chapters 5 & 6', read[0]?.summary);
check('a repeated UID is read twice, in order (the database keeps the last)', read.length === 2 && read[1].summary.endsWith('5 and 6') && read[1].firstDay === '2026-11-04');
const essay = byUid('a-103@academy.school.example')[0];
check('a span from the assigned day to the due day: first and last day', essay?.firstDay === '2026-11-02' && essay?.lastDay === '2026-11-16', essay);
check('... TEXT escapes: \\n a line break, \\; a semicolon', essay?.description === 'Five paragraphs.\nCite two sources; use MLA.', essay?.description);
const quiz = byUid('a-104@academy.school.example')[0];
check('midnight written in UTC (05:00Z, New York after the clock change) is all-day on the local date', quiz?.allDay && quiz.firstDay === '2026-11-06' && quiz.lastDay === '2026-11-06', quiz);
const sketch = byUid('a-105@academy.school.example')[0];
check('a Windows zone name (Eastern Standard Time) at midnight with no end: all-day', sketch?.allDay && sketch.firstDay === '2026-11-12' && sketch.lastDay === '2026-11-12', sketch);
check('... a line folded with a tab is joined', sketch?.summary === 'Art 8: Sketch three views of a chair', sketch?.summary);
const ws = byUid('a-106@academy.school.example')[0];
check('a timed due at 11:59pm (TZID America/New_York): timed, on its local day, in UTC', ws && !ws.allDay && ws.firstDay === '2026-11-13' && ws.start === '2026-11-14T04:59:00.000Z', ws);
check('a cancelled event is left out', byUid('a-107@academy.school.example').length === 0);
const noUid = evs.find((e) => e.uid === null);
check('an event without a UID is read, with uid null', noUid?.summary === 'Chapter 6: questions 1-10' && noUid.firstDay === '2026-11-09');
check('an RRULE is counted, not expanded (the VTIMEZONE\'s RRULEs don\'t count)', parsed.kind === 'calendar' && parsed.repeats === 1 && byUid('a-112@academy.school.example').length === 1);
const practice = byUid('a-113@academy.school.example')[0];
check('a zone the runtime doesn\'t know is read in the household\'s zone', practice?.allDay && practice.firstDay === '2026-11-16' && resolveZone('Olympus Mons Standard Time', TZ) === TZ, practice);
check('Windows zone names resolve (Pacific Standard Time → America/Los_Angeles)', resolveZone('Pacific Standard Time', TZ) === 'America/Los_Angeles');
const lf = parseIcal(ASSIGNMENTS.replace(/\r\n/g, '\n'), TZ);
check('LF line ends read the same as CRLF', lf.kind === 'calendar' && JSON.stringify(lf.events) === JSON.stringify(evs));
check('an HTML page (a sign-in page) is "sign_in"', parseIcal(SIGN_IN, TZ).kind === 'sign_in');
check('anything else without BEGIN:VCALENDAR is "not_calendar"', parseIcal('{"error": "nope"}', TZ).kind === 'not_calendar' && parseIcal('', TZ).kind === 'not_calendar');
check('a broken event (no DTSTART, a bad date) is left out, the rest read',
  (() => { const r = parseIcal(crlf(['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'SUMMARY:No start', 'END:VEVENT', 'BEGIN:VEVENT', 'DTSTART;VALUE=DATE:20261340', 'SUMMARY:Bad', 'END:VEVENT',
    'BEGIN:VEVENT', 'DTSTART;VALUE=DATE:20261120', 'SUMMARY:Good', 'END:VEVENT', 'END:VCALENDAR']), TZ); return r.kind === 'calendar' && r.events.length === 1 && r.events[0].summary === 'Good'; })());
check('the class from the title: "Biology - 2 (B): Lab report" → Biology, Lab report',
  JSON.stringify(splitClass('Biology - 2 (B): Lab report')) === JSON.stringify({ subject: 'Biology', title: 'Lab report' }));
check('... "History 8 - 1: Read" → History 8; "Art 8: Sketch" → Art 8', splitClass('History 8 - 1: Read').subject === 'History 8' && splitClass('Art 8: Sketch').subject === 'Art 8');
check('... "Chapter 6: questions" and a title with no colon name no class', splitClass('Chapter 6: questions 1-10').subject === null && splitClass('Worksheet 5.1').subject === null);

// What is kept.
const kept = keep(evs, 'assignments', TODAY);
const keptList = Array.isArray(kept) ? kept : [];
check('assignments kept: due from today − 14 to today + 120 (the one 200 days out and the one in September aren\'t)',
  keptList.length === 10 && !keptList.some((k) => /Year-end|Safety/.test(String(k.title))), keptList.map((k) => k.title));
const keptLab = keptList.find((k) => k.uid === 'a-101@academy.school.example');
check('... each as school_store takes it: uid, title, class, description, first and last day',
  JSON.stringify(keptLab) === JSON.stringify({ uid: 'a-101@academy.school.example', title: 'Lab report: water filters', subject: 'Biology',
    details: 'Write up the lab, using the template.\nDue at the start of class. Ms. Rivera', first_day: '2026-11-05', last_day: '2026-11-05' }), keptLab);
const sched = parseIcal(SCHEDULE.text, TZ);
check('a 14-month Schedule feed: all 1,500 events are read', sched.kind === 'calendar' && sched.events.length === 1500, sched.kind === 'calendar' ? sched.events.length : sched.kind);
const keptSched = keep(sched.kind === 'calendar' ? sched.events : [], 'schedule', TODAY);
check(`... only the 56 days busy time can use are kept (${SCHEDULE.inWindow})`, Array.isArray(keptSched) && keptSched.length === SCHEDULE.inWindow && SCHEDULE.inWindow === 200,
  Array.isArray(keptSched) ? keptSched.length : keptSched);
const bio = Array.isArray(keptSched) ? keptSched.find((k) => k.uid === 's-20261103-0815@academy.school.example') : null;
check('... a class at 8:15 in "Eastern Standard Time" on Nov 3 starts at 13:15Z', bio?.starts_at === '2026-11-03T13:15:00.000Z' && bio?.ends_at === '2026-11-03T14:00:00.000Z', bio);
const games = parseIcal(GAMES, TZ);
const keptGames = keep(games.kind === 'calendar' ? games.events : [], 'games', TODAY);
check('Games/Practices: timed events are busy time; an all-day meet isn\'t kept; DURATION gives the end',
  Array.isArray(keptGames) && keptGames.length === 2 && keptGames[1].ends_at === '2026-11-05T23:00:00.000Z' && keptGames[0].starts_at === '2026-11-04T21:15:00.000Z', keptGames);
const many = Array.from({ length: 401 }, (_, i) => ({ uid: `n-${i}`, summary: `Worksheet ${i}`, description: null, allDay: true, firstDay: '2026-11-20', lastDay: '2026-11-20', start: null, end: null, repeats: false }));
check('401 assignments in the window: too_many', keep(many, 'assignments', TODAY) === 'too_many' && Array.isArray(keep(many.slice(1), 'assignments', TODAY)));

// ---------------------------------------------------------------------
// The address check (school.ts; private.school_url does the same)
// ---------------------------------------------------------------------
check('webcal:// becomes https://', checkAddress('webcal://academy.school.example/podium/feed/iCal.aspx?z=Q1w2') === 'https://academy.school.example/podium/feed/iCal.aspx?z=Q1w2');
check('port 443 written out is fine', checkAddress('https://academy.school.example:443/podium/feed/iCal.aspx?z=Q1w2') === 'https://academy.school.example/podium/feed/iCal.aspx?z=Q1w2');
const refusedAddresses = [
  'http://academy.school.example/podium/feed/iCal.aspx?z=Q1w2',
  'https://academy.school.example:8443/podium/feed/iCal.aspx?z=Q1w2',
  'https://pat:pw@academy.school.example/podium/feed/iCal.aspx?z=Q1w2',
  'https://academy.school.example@attacker.example/podium/feed/iCal.aspx?z=Q1w2',
  'https://academy.school.example.attacker.example/podium/feed/iCal.aspx?z=Q1w2',
  'https://evilschool.example/podium/feed/iCal.aspx?z=Q1w2',
  'https://school.example/podium/feed/iCal.aspx?z=Q1w2',
  'https://10.0.0.1/podium/feed/iCal.aspx?z=Q1w2',
  'https://[::1]/podium/feed/iCal.aspx?z=Q1w2',
  'https://academy.school.example/podium/feed/other.aspx?z=Q1w2',
  'https://academy.school.example/podium/feed/iCal.aspx?t=Q1w2',
  'https://academy.school.example/podium/feed/iCal.aspx?z=',
  'https://academy.school.example/podium/feed/iCal.aspx?z=Q1 w2',
  `https://academy.school.example/podium/feed/iCal.aspx?z=${'a'.repeat(460)}`,
  'ftp://academy.school.example/podium/feed/iCal.aspx?z=Q1w2',
  'file:///etc/passwd',
  '',
];
const notRefused = refusedAddresses.filter((a) => checkAddress(a) !== null);
check('refused: http, port 8443, user info, a host after an @, a look-alike, another domain, the bare domain, an IP, IPv6, another path, no z, an empty z, a space, over 500 characters, ftp, file:',
  notRefused.length === 0, notRefused);

// ---------------------------------------------------------------------
// The action, through handle(): a fake database and a fake school host
// ---------------------------------------------------------------------
type Call = { fn: string; args: any };
type Hit = { url: string; redirect: unknown; signal: boolean; method: string };
type Route = (url: string, init: any) => Promise<Response> | Response;

function setup(opts: { feeds?: any[]; routes?: Record<string, Route>; begin?: any; storeError?: boolean; admin?: boolean } = {}) {
  const calls: Call[] = [];
  const hits: Hit[] = [];
  const clock = { t: NOW };
  const routes = opts.routes ?? {};
  const db = {
    rpc(fn: string, args?: any) {
      calls.push({ fn, args });
      if (fn === 'school_begin') {
        return Promise.resolve(opts.begin ?? { data: { go: true, stop: null, run_id: RUN, today: TODAY, tz: TZ, feeds: opts.feeds ?? [FEEDS.assignments] }, error: null });
      }
      if (fn === 'school_store') {
        if (opts.storeError) return Promise.resolve({ data: null, error: { message: 'boom', code: 'XX000' } });
        const n = Array.isArray(args?.p_items) ? args.p_items.length : 0;
        return Promise.resolve({ data: args?.p_stop ? { stored: false, stop: args.p_stop } : { stored: true, stop: null, kept: n, added: n, missing: 0, gone: 0 }, error: null });
      }
      if (fn === 'school_finish') return Promise.resolve({ data: null, error: null });
      return Promise.resolve({ data: null, error: { message: `unexpected ${fn}`, code: 'PGRST202' } });
    },
    from() { throw new Error('no table reads in the school action'); },
  };
  const user = { rpc: (fn: string) => Promise.resolve(fn === 'whoami' ? { data: opts.admin === false ? { role: 'member' } : { role: 'admin' }, error: null } : { data: null, error: null }) };
  const fetchFake = async (input: string | URL, init: any = {}) => {
    const url = String(input);
    hits.push({ url, redirect: init.redirect, signal: !!init.signal, method: init.method });
    const r = routes[url];
    if (!r) return new Response('not here', { status: 404 });
    return r(url, init);
  };
  const deps = {
    env: (n: string) => ({ HUB_CRON_SECRET: SECRET, SUPABASE_URL: 'https://project.example', SUPABASE_SECRET_KEYS: '{"default":"sb_secret_made_up"}' } as Record<string, string>)[n],
    fetch: fetchFake as unknown as typeof fetch,
    service: () => db,
    user: () => user,
    now: () => clock.t,
  };
  return { deps, calls, hits, clock };
}
const cron = () => new Request('https://project.example/functions/v1/hub-jobs', { method: 'POST', headers: { 'x-hub-cron': SECRET, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'school' }) });
const ok = (text: string, headers: Record<string, string> = {}) => () => new Response(text, { status: 200, headers: { 'Content-Type': 'text/calendar; charset=utf-8', ...headers } });
const redirect = (to: string, status = 302) => () => new Response(null, { status, headers: { Location: to } });
const stores = (calls: Call[]) => calls.filter((c) => c.fn === 'school_store').map((c) => c.args);

// The console, while the job runs: nothing may be written there.
const logged: string[] = [];
const realConsole = { log: console.log, error: console.error, warn: console.warn, info: console.info, debug: console.debug };
function quietConsole() {
  for (const k of Object.keys(realConsole) as (keyof typeof realConsole)[]) (console as any)[k] = (...a: unknown[]) => logged.push(a.map(String).join(' '));
}
function loudConsole() {
  Object.assign(console, realConsole);
}
async function run(s: ReturnType<typeof setup>, req: Request = cron()) {
  quietConsole();
  try {
    const res = await handle(req, s.deps as any);
    return { status: res.status, text: await res.text() };
  } finally {
    loudConsole();
  }
}

// Node's AbortSignal.timeout doesn't keep the process alive; this does while the cases run.
const keepAlive = setInterval(() => { /* waiting */ }, 1000);

(async () => {
  // ---- A good run: three links read, stored, the run ended.
  {
    const s = setup({
      feeds: [FEEDS.assignments, FEEDS.schedule, FEEDS.games],
      routes: { [FEEDS.assignments.url]: ok(ASSIGNMENTS), [FEEDS.schedule.url]: ok(SCHEDULE.text), [FEEDS.games.url]: ok(GAMES) },
    });
    const r = await run(s);
    const body = JSON.parse(r.text);
    check('a cron run reads the three links and stores each (200)', r.status === 200 && body.ok === true && body.read === 3 && body.stored === 3 && body.failed === 0, r);
    check('... school_begin first (p_force false), school_finish last with the run id',
      s.calls[0].fn === 'school_begin' && s.calls[0].args?.p_force === false && s.calls.at(-1)?.fn === 'school_finish' && s.calls.at(-1)?.args?.p_run === RUN, s.calls.map((c) => c.fn));
    const st = stores(s.calls);
    check('... school_store with the run, the link, the items and no stop',
      st.length === 3 && st.every((a) => a.p_run === RUN && a.p_stop === null) && st[0].p_feed === FEEDS.assignments.feed_id && st[0].p_items.length === 10 && st[0].p_repeats === 1, st.map((a) => [a.p_feed, a.p_items?.length, a.p_stop, a.p_repeats]));
    check('... 200 schedule items and 2 games items', st[1].p_items.length === 200 && st[2].p_items.length === 2);
    check('... each fetch is a GET with redirect: "manual" and a time limit',
      s.hits.length === 3 && s.hits.every((h) => h.redirect === 'manual' && h.signal && h.method === 'GET'), s.hits);
    check('... and nothing is written to the console', logged.length === 0, logged);
    check('... the answer carries no address', !r.text.includes('podium') && !r.text.includes('A1a2'), r.text);
  }

  // ---- Who may ask.
  {
    const s = setup({ routes: { [FEEDS.assignments.url]: ok(ASSIGNMENTS) } });
    const noHeader = await run(s, new Request('https://project.example/functions/v1/hub-jobs', { method: 'POST', body: JSON.stringify({ action: 'school' }) }));
    check('no x-hub-cron and no sign-in: 401, nothing read', noHeader.status === 401 && JSON.parse(noHeader.text).error === 'Not allowed.' && s.calls.length === 0 && s.hits.length === 0, noHeader);
    const wrong = await run(s, new Request('https://project.example/functions/v1/hub-jobs', { method: 'POST', headers: { 'x-hub-cron': 'x'.repeat(40) }, body: JSON.stringify({ action: 'school' }) }));
    check('a wrong cron secret: 401', wrong.status === 401 && s.calls.length === 0, wrong);
    const short = setup();
    short.deps.env = (n: string) => (n === 'HUB_CRON_SECRET' ? 'short' : 'x');
    const sh = await run(short, new Request('https://project.example/functions/v1/hub-jobs', { method: 'POST', headers: { 'x-hub-cron': 'short' }, body: JSON.stringify({ action: 'school' }) }));
    check('HUB_CRON_SECRET under 32 characters: 503', sh.status === 503 && short.calls.length === 0, sh);
    const member = setup({ admin: false });
    const m = await run(member, new Request('https://project.example/functions/v1/hub-jobs', { method: 'POST', headers: { Authorization: 'Bearer user-token' }, body: JSON.stringify({ action: 'school' }) }));
    check('a signed-in member who isn\'t an admin: 403', m.status === 403 && member.calls.length === 0, m);
    const admin = setup({ routes: { [FEEDS.assignments.url]: ok(ASSIGNMENTS) } });
    const a = await run(admin, new Request('https://project.example/functions/v1/hub-jobs', { method: 'POST', headers: { Authorization: 'Bearer user-token' }, body: JSON.stringify({ action: 'school' }) }));
    check('a parent\'s Check now (signed in as an admin): school_begin with p_force true', a.status === 200 && admin.calls[0].args?.p_force === true && stores(admin.calls).length === 1, a);
    const nokey = setup();
    nokey.deps.env = (n: string) => (n === 'HUB_CRON_SECRET' ? SECRET : undefined);
    const nk = await run(nokey);
    check('no service key: 503, nothing read', nk.status === 503 && nokey.calls.length === 0, nk);
  }

  // ---- The database's answers.
  {
    const s = setup({ begin: { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.school_begin' } } });
    const r = await run(s);
    check('before migration 0006: 503 no_schema', r.status === 503 && JSON.parse(r.text).stop === 'no_schema', r);
    const b = setup({ begin: { data: { go: false, stop: 'busy' }, error: null } });
    const rb = await run(b);
    check('another run holds the lease: 200 busy, nothing fetched', rb.status === 200 && JSON.parse(rb.text).stop === 'busy' && b.hits.length === 0, rb);
    const e = setup({ begin: { data: null, error: { code: 'XX000', message: 'deadlock detected' } } });
    const re = await run(e);
    check('a database error at the start: 500 with a fixed message (not the database\'s words)', re.status === 500 && !re.text.includes('deadlock'), re);
    const se = setup({ routes: { [FEEDS.assignments.url]: ok(ASSIGNMENTS) }, storeError: true });
    const rse = await run(se);
    check('a database error storing: 500, the run still ended (school_finish)', rse.status === 500 && se.calls.at(-1)?.fn === 'school_finish' && !rse.text.includes('boom'), rse);
  }

  // ---- What each failure is stored as.
  const stopFor = async (route: Route | null, name: string, want: string, feed = FEEDS.assignments) => {
    const s = setup({ feeds: [feed], routes: route ? { [feed.url]: route } : {} });
    const r = await run(s);
    const st = stores(s.calls);
    check(name, r.status === 200 && st.length === 1 && st[0].p_stop === want && Array.isArray(st[0].p_items) && st[0].p_items.length === 0, { status: r.status, st });
    return s;
  };
  await stopFor(() => new Response('gone', { status: 404 }), '404 → gone (the link was replaced or removed at the school)', 'gone');
  await stopFor(() => new Response('', { status: 410 }), '410 → gone', 'gone');
  await stopFor(() => new Response('', { status: 403 }), '403 → refused', 'refused');
  await stopFor(() => new Response('', { status: 503 }), '503 → down (tried again later)', 'down');
  await stopFor(() => new Response('', { status: 429 }), '429 → down', 'down');
  await stopFor(() => new Response('', { status: 418 }), 'any other answer → http', 'http');
  await stopFor(ok(SIGN_IN, { 'Content-Type': 'text/html' }), 'an HTML sign-in page → sign_in', 'sign_in');
  await stopFor(ok('just text'), 'neither HTML nor a calendar → not_calendar', 'not_calendar');
  await stopFor(ok('x', { 'Content-Length': String(MAX_BYTES + 1) }), `a Content-Length over ${MAX_BYTES} bytes → too_big, the body not read`, 'too_big');
  await stopFor(() => new Response(new ReadableStream({
    pull(c) { c.enqueue(new TextEncoder().encode('BEGIN:VCALENDAR\r\n' + 'X'.repeat(256 * 1024))); },
  }), { status: 200 }), 'a body that runs on past 3 MB without a Content-Length → too_big', 'too_big');
  await stopFor(ok(crlf(['BEGIN:VCALENDAR', ...Array.from({ length: 401 }, (_, i) => [`BEGIN:VEVENT`, `UID:w-${i}`, 'DTSTART;VALUE=DATE:20261120', `SUMMARY:Worksheet ${i}`, 'END:VEVENT']).flat(), 'END:VCALENDAR'])),
    '401 assignments in the window → too_many, no items sent', 'too_many');

  // Redirects.
  const nextUrl = z('N1n2N3n4N5n6');
  {
    const s = setup({ routes: { [FEEDS.assignments.url]: redirect(`https://edge.${HOST}/podium/feed/iCal.aspx?z=R1`), [`https://edge.${HOST}/podium/feed/iCal.aspx?z=R1`]: redirect('/feeds/a?z=R2', 301),
      [`https://edge.${HOST}/feeds/a?z=R2`]: redirect(nextUrl, 307), [nextUrl]: ok(ASSIGNMENTS) } });
    const r = await run(s);
    const st = stores(s.calls);
    check('three redirects on school hosts (one relative) are followed', r.status === 200 && st[0]?.p_stop === null && st[0].p_items.length === 10 && s.hits.length === 4, s.hits.map((h) => h.url));
    check('... each with redirect: "manual"', s.hits.every((h) => h.redirect === 'manual'));
  }
  {
    const chain: Record<string, Route> = {};
    const urls = [FEEDS.assignments.url, z('R1'), z('R2'), z('R3'), z('R4')];
    for (let i = 0; i < 4; i++) chain[urls[i]] = redirect(urls[i + 1]);
    chain[urls[4]] = ok(ASSIGNMENTS);
    const s = setup({ routes: chain });
    await run(s);
    check('a fourth redirect is refused (redirect), the fifth address never fetched', stores(s.calls)[0]?.p_stop === 'redirect' && !s.hits.some((h) => h.url === urls[4]), s.hits.map((h) => h.url));
  }
  for (const [to, name] of [
    [`http://${HOST}/podium/feed/iCal.aspx?z=Q1`, 'a redirect to http:// is refused'],
    [`https://${HOST}:8443/podium/feed/iCal.aspx?z=Q1`, 'a redirect to port 8443 is refused'],
    [`https://pat:pw@${HOST}/podium/feed/iCal.aspx?z=Q1`, 'a redirect with user info is refused'],
    ['https://attacker.example/collect?z=Q1', 'a redirect to another host is refused'],
    ['https://169.254.169.254/latest/meta-data/', 'a redirect to an address (the cloud metadata one) is refused'],
    ['webcal://attacker.example/x', 'a redirect to webcal:// on another host is refused'],
  ] as const) {
    const s = setup({ routes: { [FEEDS.assignments.url]: redirect(to) } });
    await run(s);
    check(`${name}, never followed`, stores(s.calls)[0]?.p_stop === 'redirect' && s.hits.length === 1, s.hits.map((h) => h.url));
  }
  {
    const s = setup({ routes: { [FEEDS.assignments.url]: () => new Response(null, { status: 302 }) } });
    await run(s);
    check('a redirect without a Location → redirect', stores(s.calls)[0]?.p_stop === 'redirect');
  }

  // A link that school_begin hands over and the address check refuses is never fetched.
  {
    const s = setup({ feeds: [{ ...FEEDS.assignments, url: 'http://academy.school.example/podium/feed/iCal.aspx?z=Q1' }] });
    await run(s);
    check('an address that fails the check again before the fetch: bad_link, nothing fetched', stores(s.calls)[0]?.p_stop === 'bad_link' && s.hits.length === 0, s.hits);
  }

  // The time limits.
  {
    SCHOOL_LIMITS.fetchMs = 60;
    const s = setup({ routes: { [FEEDS.assignments.url]: (_u, init) => new Promise<Response>((_res, rej) => {
      init.signal.addEventListener('abort', () => rej(init.signal.reason));
    }) } });
    await run(s);
    check('a fetch that doesn\'t answer in time → timeout', stores(s.calls)[0]?.p_stop === 'timeout', stores(s.calls));
    const slow = setup({ routes: { [FEEDS.assignments.url]: () => new Response(new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode('BEGIN:VCALENDAR\r\n')); },   // then nothing more
    }), { status: 200 }) } });
    await run(slow);
    check('a body that stops coming → timeout', stores(slow.calls)[0]?.p_stop === 'timeout', stores(slow.calls));
    SCHOOL_LIMITS.fetchMs = 15000;
  }
  {
    // No fetch starts after RUN_BUDGET_MS: the clock passes it during the first read.
    const s = setup({ feeds: [FEEDS.assignments, FEEDS.schedule, FEEDS.games], routes: {
      [FEEDS.assignments.url]: () => { s.clock.t += RUN_BUDGET_MS + 1; return new Response(ASSIGNMENTS, { status: 200 }); },
      [FEEDS.schedule.url]: ok(SCHEDULE.text), [FEEDS.games.url]: ok(GAMES) } });
    const r = await run(s);
    const body = JSON.parse(r.text);
    check(`no fetch starts after ${RUN_BUDGET_MS / 1000} seconds: the rest wait for the next run (still due)`,
      s.hits.length === 1 && stores(s.calls).length === 1 && body.skipped === 2 && s.calls.at(-1)?.fn === 'school_finish', body);
  }

  // One link's failure doesn't stop the others.
  {
    const s = setup({ feeds: [FEEDS.assignments, FEEDS.schedule, FEEDS.games], routes: {
      [FEEDS.assignments.url]: () => { throw new TypeError('error sending request'); }, [FEEDS.schedule.url]: ok(SCHEDULE.text), [FEEDS.games.url]: ok(SIGN_IN) } });
    const r = await run(s);
    const st = stores(s.calls);
    check('one link unreachable, one a sign-in page, one good: each stored on its own, the good one with its items',
      r.status === 200 && st.length === 3 && st[0].p_stop === 'unreachable' && st[1].p_stop === null && st[1].p_items.length === 200 && st[2].p_stop === 'sign_in', st.map((a) => a.p_stop));
    check('... the answer says the run wasn\'t all good', JSON.parse(r.text).ok === false && JSON.parse(r.text).failed === 2, r.text);
  }

  // The address never leaks: fetch's own error quotes it.
  {
    logged.length = 0;
    const leaky = { ...FEEDS.assignments, url: z('SECRETMARKER') };
    const s = setup({ feeds: [leaky], routes: { [leaky.url]: () => { throw new TypeError(`error sending request for url (${leaky.url})`); } } });
    const r = await run(s);
    const st = stores(s.calls);
    const sent = JSON.stringify(s.calls.filter((c) => c.fn !== 'school_begin'));
    check('fetch\'s error quoting the address becomes the fixed code unreachable', st[0]?.p_stop === 'unreachable', st);
    check('... SECRETMARKER is in no console line', !logged.some((l) => l.includes('SECRETMARKER')) && logged.length === 0, logged);
    check('... in nothing sent to the database (school_store\'s stop, school_finish)', !sent.includes('SECRETMARKER'), sent);
    check('... and not in the answer', !r.text.includes('SECRETMARKER'), r.text);
  }

  // The source: no log calls, no message(), the redirect mode.
  {
    const src = readFileSync(new URL('../../supabase/functions/hub-jobs/school.ts', import.meta.url), 'utf8')
      + readFileSync(new URL('../../supabase/functions/hub-jobs/ical.ts', import.meta.url), 'utf8');
    const code = src.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
    check('school.ts and ical.ts never write to the console', !/\bconsole\./.test(code));
    check('... never use util.ts\'s message() (it quotes an error\'s text)', !/\bmessage\(/.test(code));
    check('... fetch with redirect: \'manual\'', /redirect: 'manual'/.test(code));
    check('... and hold no U+2028 or U+2029 escape (an MCP deploy breaks on them)', !/\\u2028|\\u2029/.test(src));
    check('... and import nothing from outside the function', [...code.matchAll(/^import .* from '([^']+)'/gm)].every((m) => m[1].startsWith('./')));
  }

  finish();
})().catch((err) => {
  clearInterval(keepAlive);
  loudConsole();
  console.log(results.join('\n'));
  console.log(`FAIL  test run stopped early: ${String((err && err.stack) || err).split('\n').slice(0, 3).join(' | ')}`);
  process.exit(1);
});

function finish() {
  clearInterval(keepAlive);
  console.log(results.join('\n'));
  console.log(`\n${results.filter((r) => r.startsWith('PASS')).length}/${results.length} passed`);
  if (results.some((r) => r.startsWith('FAIL'))) process.exitCode = 1;
}
