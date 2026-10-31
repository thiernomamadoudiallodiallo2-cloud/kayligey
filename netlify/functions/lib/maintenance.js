import {sql} from './db.js';
// Purge des données techniques périmées (jamais les données médicales ni le journal d'audit).
export async function purgeExpired(){
  const c=async(q)=>(await q).length;
  return {
    sessions:await c(sql`DELETE FROM sessions WHERE expires_at<now() RETURNING id`),
    codes_reinit:await c(sql`DELETE FROM reset_codes WHERE expires_at<now()-interval '1 day' RETURNING id`),
    limiteurs:await c(sql`DELETE FROM rate_limits WHERE window_start<now()-interval '1 day' RETURNING key`),
    webhooks:await c(sql`DELETE FROM webhook_events WHERE received_at<now()-interval '90 days' RETURNING event_key`),
    envois_anciens:await c(sql`DELETE FROM outbox WHERE status='sent' AND sent_at<now()-interval '30 days' RETURNING id`)};
}
