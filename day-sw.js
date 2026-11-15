/* My day's service worker (0031, docs/v1.3-homework.md §31): phone reminders only. It shows the notification hub-jobs
   sends (sealed for this phone; the browser opens it) and, on a tap, opens his My day. No fetch handler: the page is
   never cached or served from here. Registered by assets/day.js with scope ./day.html. */
'use strict';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
const sameSite = (u) => {
  try { const x = new URL(u, self.registration.scope); return x.origin === self.location.origin ? x.href : null; } catch (e) { return null; }
};
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = {}; }
  const text = (v, n) => String(v == null ? '' : v).slice(0, n);
  // Every push shows a notification (iOS stops sending to a web app that doesn't).
  e.waitUntil(self.registration.showNotification(text(d.title, 120) || 'Home Hub', {
    body: text(d.body, 300), tag: text(d.tag, 60) || 'home-hub', icon: 'assets/icons/icon-192.png',
    data: { url: sameSite(d.url) || self.registration.scope },
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = sameSite(e.notification.data && e.notification.data.url) || self.registration.scope;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    const mine = list.find((c) => c.url.split('#')[0] === url.split('#')[0]);
    if (mine) return mine.navigate(url).then((c) => (c || mine).focus()).catch(() => mine.focus());
    return self.clients.openWindow(url);
  }));
});
