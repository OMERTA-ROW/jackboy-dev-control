// Push-only worker for Jackboy phone alerts. It caches nothing and never serves pages.
// Config comes from the registration URL (public values only).
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');

firebase.initializeApp(Object.fromEntries(new URL(self.location).searchParams));
firebase.messaging();

// Taps open the alert's page on this site only (relative links).
self.addEventListener('notificationclick', (event) => {
  const raw = (event.notification && event.notification.data && (event.notification.data.link || (event.notification.data.FCM_MSG && event.notification.data.FCM_MSG.data && event.notification.data.FCM_MSG.data.link))) || '/';
  const path = typeof raw === 'string' && raw.startsWith('/') && !raw.startsWith('//') ? raw : '/';
  event.notification.close();
  event.waitUntil(self.clients.openWindow(new URL(path, self.location.origin).href));
});
