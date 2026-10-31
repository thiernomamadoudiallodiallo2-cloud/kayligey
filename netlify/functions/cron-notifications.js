// Tâche planifiée Netlify : rappels de rendez-vous + envoi des notifications en attente (toutes les 5 minutes).
import {enqueueReminders,processOutbox} from './lib/notify.js';
import {purgeExpired} from './lib/maintenance.js';
export default async()=>{
  const reminders=await enqueueReminders();
  const out=await processOutbox();
  const purge=await purgeExpired();
  console.log(JSON.stringify({reminders,...out,purge}));
  return new Response('ok');
};
export const config={schedule:'*/5 * * * *'};
