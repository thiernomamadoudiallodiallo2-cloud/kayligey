CREATE EXTENSION IF NOT EXISTS pgcrypto;
DO $$ BEGIN CREATE TYPE user_role AS ENUM ('patient','medecin','prestataire','admin'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE user_status AS ENUM ('pending','active','suspended'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE TABLE IF NOT EXISTS users(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role user_role NOT NULL, status user_status NOT NULL,
  nom text NOT NULL, tel text NOT NULL UNIQUE, email text UNIQUE, pwd_hash text NOT NULL,
  tel_verified_at timestamptz,
  consent_version text NOT NULL, consent_at timestamptz NOT NULL,
  failed_logins int NOT NULL DEFAULT 0, locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE, expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), ip text, ua text
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS reset_codes(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash text NOT NULL, attempts int NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL, used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS rate_limits(key text PRIMARY KEY, count int NOT NULL, window_start timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS audit_log(
  id bigserial PRIMARY KEY, user_id uuid, event text NOT NULL, ip text, meta jsonb,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_event ON audit_log(event, at DESC);
CREATE TABLE IF NOT EXISTS doctors(
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  specialite text NOT NULL, ville text NOT NULL, tarif_fcfa int NOT NULL CHECK (tarif_fcfa>=0),
  langues text[] NOT NULL DEFAULT '{}', modes text[] NOT NULL DEFAULT '{cabinet}',
  structure text, numero_ordre text NOT NULL, bio text,
  verified_at timestamptz, verified_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS availability_slots(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doctor_id uuid NOT NULL REFERENCES doctors(user_id) ON DELETE CASCADE,
  starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','booked','closed')),
  UNIQUE (doctor_id, starts_at), CHECK (ends_at>starts_at)
);
CREATE TABLE IF NOT EXISTS appointments(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slot_id uuid NOT NULL REFERENCES availability_slots(id),
  patient_id uuid NOT NULL REFERENCES users(id),
  doctor_id uuid NOT NULL REFERENCES doctors(user_id),
  mode text NOT NULL CHECK (mode IN ('cabinet','video','audio')),
  motif text NOT NULL,
  status text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed','cancelled','completed','no_show')),
  cancelled_by uuid, cancelled_at timestamptz, cancel_reason text,
  consent_at timestamptz NOT NULL, rescheduled_count int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS appt_one_confirmed_per_slot ON appointments(slot_id) WHERE status='confirmed';
CREATE INDEX IF NOT EXISTS appt_patient ON appointments(patient_id);
CREATE INDEX IF NOT EXISTS appt_doctor ON appointments(doctor_id);
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS amount_fcfa int NOT NULL DEFAULT 0;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS hold_expires_at timestamptz;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS payment_mode text NOT NULL DEFAULT 'sur_place';
ALTER TABLE appointments DROP CONSTRAINT IF EXISTS appointments_status_check;
ALTER TABLE appointments ADD CONSTRAINT appointments_status_check CHECK (status IN ('pending_payment','confirmed','cancelled','completed','no_show'));
DROP INDEX IF EXISTS appt_one_confirmed_per_slot;
CREATE UNIQUE INDEX IF NOT EXISTS appt_one_active_per_slot ON appointments(slot_id) WHERE status IN ('confirmed','pending_payment');
CREATE TABLE IF NOT EXISTS payments(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id uuid NOT NULL REFERENCES appointments(id),
  patient_id uuid NOT NULL REFERENCES users(id),
  amount_fcfa int NOT NULL CHECK (amount_fcfa>0), currency text NOT NULL DEFAULT 'XOF',
  provider text NOT NULL, provider_session_id text UNIQUE, launch_url text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','succeeded','failed','refunded','refund_pending')),
  created_at timestamptz NOT NULL DEFAULT now(), paid_at timestamptz, refunded_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS pay_one_open_per_appt ON payments(appointment_id) WHERE status IN ('pending','succeeded','refund_pending');
CREATE TABLE IF NOT EXISTS ledger_entries(
  id bigserial PRIMARY KEY, payment_id uuid NOT NULL REFERENCES payments(id),
  kind text NOT NULL, amount_fcfa int NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(payment_id,kind)
);
CREATE SEQUENCE IF NOT EXISTS receipt_seq;
CREATE TABLE IF NOT EXISTS receipts(
  payment_id uuid PRIMARY KEY REFERENCES payments(id), number text NOT NULL UNIQUE, issued_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS webhook_events(
  event_key text PRIMARY KEY, provider text NOT NULL, received_at timestamptz NOT NULL DEFAULT now(), outcome text
);
CREATE TABLE IF NOT EXISTS notification_prefs(
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  email_enabled boolean NOT NULL DEFAULT true, sms_enabled boolean NOT NULL DEFAULT false,
  reminders_enabled boolean NOT NULL DEFAULT true, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS notifications(
  id bigserial PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL, title text NOT NULL, body text NOT NULL, link text, dedupe_key text NOT NULL,
  read_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id,dedupe_key)
);
CREATE INDEX IF NOT EXISTS notif_user ON notifications(user_id,created_at DESC);
CREATE TABLE IF NOT EXISTS outbox(
  id bigserial PRIMARY KEY, notification_id bigint NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  user_id uuid NOT NULL, channel text NOT NULL CHECK (channel IN ('email','sms')), to_addr text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
  attempts int NOT NULL DEFAULT 0, last_error text, next_attempt_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS outbox_due ON outbox(status,next_attempt_at);
CREATE TABLE IF NOT EXISTS record_access(
  id bigserial PRIMARY KEY, patient_id uuid NOT NULL REFERENCES users(id), doctor_id uuid NOT NULL REFERENCES users(id),
  granted_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL, revoked_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS access_one_active ON record_access(patient_id,doctor_id) WHERE revoked_at IS NULL;
CREATE TABLE IF NOT EXISTS record_entries(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), patient_id uuid NOT NULL REFERENCES users(id), author_id uuid NOT NULL REFERENCES users(id),
  author_role text NOT NULL, kind text NOT NULL CHECK (kind IN ('allergie','antecedent','constante','vaccination','note')),
  title text NOT NULL, body text NOT NULL DEFAULT '', data jsonb,
  status text NOT NULL DEFAULT 'finalise' CHECK (status IN ('brouillon','finalise')), version int NOT NULL DEFAULT 1,
  amends_id uuid REFERENCES record_entries(id), content_hash text, created_at timestamptz NOT NULL DEFAULT now(), finalized_at timestamptz
);
CREATE INDEX IF NOT EXISTS entries_patient ON record_entries(patient_id,created_at DESC);
CREATE TABLE IF NOT EXISTS entry_versions(
  id bigserial PRIMARY KEY, entry_id uuid NOT NULL REFERENCES record_entries(id), version int NOT NULL, title text NOT NULL, body text NOT NULL, edited_at timestamptz NOT NULL DEFAULT now()
);
CREATE SEQUENCE IF NOT EXISTS rx_seq;
CREATE TABLE IF NOT EXISTS prescriptions(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), number text UNIQUE, patient_id uuid NOT NULL REFERENCES users(id), doctor_id uuid NOT NULL REFERENCES users(id),
  appointment_id uuid REFERENCES appointments(id), items jsonb NOT NULL, notes text,
  status text NOT NULL DEFAULT 'brouillon' CHECK (status IN ('brouillon','signee','annulee')), version int NOT NULL DEFAULT 1,
  content_hash text, created_at timestamptz NOT NULL DEFAULT now(), signed_at timestamptz, cancelled_at timestamptz, cancel_reason text
);
CREATE TABLE IF NOT EXISTS documents(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), patient_id uuid NOT NULL REFERENCES users(id), uploader_id uuid NOT NULL REFERENCES users(id),
  filename text NOT NULL, mime text NOT NULL, size_bytes int NOT NULL, sha256 text NOT NULL, blob_key text NOT NULL UNIQUE, kind text NOT NULL DEFAULT 'autre',
  scan_status text NOT NULL DEFAULT 'non_analyse', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS record_access_log(
  id bigserial PRIMARY KEY, actor_id uuid NOT NULL, patient_id uuid NOT NULL, action text NOT NULL, object_type text, object_id text, ip text, at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ral_patient ON record_access_log(patient_id,at DESC);
CREATE OR REPLACE FUNCTION kay_guard_entries() RETURNS trigger AS $$ BEGIN IF TG_OP='DELETE' THEN IF OLD.status='finalise' THEN RAISE EXCEPTION 'entree finalisee non supprimable'; END IF; RETURN OLD; END IF; IF OLD.status='finalise' THEN RAISE EXCEPTION 'entree finalisee non modifiable'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS kay_guard_entries_t ON record_entries;
CREATE TRIGGER kay_guard_entries_t BEFORE UPDATE OR DELETE ON record_entries FOR EACH ROW EXECUTE FUNCTION kay_guard_entries();
CREATE OR REPLACE FUNCTION kay_guard_rx() RETURNS trigger AS $$ BEGIN IF TG_OP='DELETE' THEN IF OLD.status<>'brouillon' THEN RAISE EXCEPTION 'ordonnance signee non supprimable'; END IF; RETURN OLD; END IF; IF OLD.status IN ('signee','annulee') AND (NEW.items IS DISTINCT FROM OLD.items OR NEW.notes IS DISTINCT FROM OLD.notes OR NEW.patient_id<>OLD.patient_id OR NEW.doctor_id<>OLD.doctor_id OR NEW.content_hash IS DISTINCT FROM OLD.content_hash OR NEW.number IS DISTINCT FROM OLD.number OR (OLD.status='annulee' AND NEW.status<>'annulee')) THEN RAISE EXCEPTION 'ordonnance signee non modifiable'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS kay_guard_rx_t ON prescriptions;
CREATE TRIGGER kay_guard_rx_t BEFORE UPDATE OR DELETE ON prescriptions FOR EACH ROW EXECUTE FUNCTION kay_guard_rx();
CREATE TABLE IF NOT EXISTS conversations(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), patient_id uuid NOT NULL REFERENCES users(id), doctor_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(), last_message_at timestamptz, UNIQUE(patient_id,doctor_id)
);
CREATE TABLE IF NOT EXISTS messages(
  id bigserial PRIMARY KEY, conversation_id uuid NOT NULL REFERENCES conversations(id), sender_id uuid NOT NULL REFERENCES users(id),
  client_id uuid NOT NULL, body text NOT NULL, document_id uuid REFERENCES documents(id),
  created_at timestamptz NOT NULL DEFAULT now(), read_at timestamptz, UNIQUE(conversation_id,client_id)
);
CREATE INDEX IF NOT EXISTS msg_conv ON messages(conversation_id,id);
CREATE TABLE IF NOT EXISTS document_shares(
  document_id uuid NOT NULL REFERENCES documents(id), doctor_id uuid NOT NULL REFERENCES users(id), shared_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(document_id,doctor_id)
);
CREATE TABLE IF NOT EXISTS dependents(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), guardian_id uuid NOT NULL REFERENCES users(id), nom text NOT NULL,
  date_naissance date NOT NULL, sexe text CHECK (sexe IN ('F','M')), created_at timestamptz NOT NULL DEFAULT now(), archived_at timestamptz
);
CREATE INDEX IF NOT EXISTS dep_guardian ON dependents(guardian_id);
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS dependent_id uuid REFERENCES dependents(id);
ALTER TABLE prescriptions ADD COLUMN IF NOT EXISTS dependent_id uuid REFERENCES dependents(id);
ALTER TABLE prescriptions ADD COLUMN IF NOT EXISTS poids_kg numeric;
CREATE TABLE IF NOT EXISTS dependent_access(
  id bigserial PRIMARY KEY, dependent_id uuid NOT NULL REFERENCES dependents(id), doctor_id uuid NOT NULL REFERENCES users(id),
  granted_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL, revoked_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS depacc_one_active ON dependent_access(dependent_id,doctor_id) WHERE revoked_at IS NULL;
CREATE TABLE IF NOT EXISTS ped_growth(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), dependent_id uuid NOT NULL REFERENCES dependents(id), measured_on date NOT NULL,
  poids_kg numeric, taille_cm numeric, pc_cm numeric, recorded_by uuid NOT NULL REFERENCES users(id), recorded_role text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), voided_at timestamptz, void_reason text
);
CREATE TABLE IF NOT EXISTS ped_vaccines(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), dependent_id uuid NOT NULL REFERENCES dependents(id), vaccine text NOT NULL, dose text,
  given_on date NOT NULL, lot text, administered_by text, next_due date, recorded_by uuid NOT NULL REFERENCES users(id), recorded_role text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), voided_at timestamptz, void_reason text
);
CREATE OR REPLACE FUNCTION kay_guard_ped() RETURNS trigger AS $$ BEGIN IF TG_OP='DELETE' THEN RAISE EXCEPTION 'entree pediatrique non supprimable'; END IF; IF OLD.voided_at IS NOT NULL OR (to_jsonb(NEW)-'voided_at'-'void_reason')<>(to_jsonb(OLD)-'voided_at'-'void_reason') THEN RAISE EXCEPTION 'entree pediatrique non modifiable'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS kay_guard_growth_t ON ped_growth;
CREATE TRIGGER kay_guard_growth_t BEFORE UPDATE OR DELETE ON ped_growth FOR EACH ROW EXECUTE FUNCTION kay_guard_ped();
DROP TRIGGER IF EXISTS kay_guard_vacc_t ON ped_vaccines;
CREATE TRIGGER kay_guard_vacc_t BEFORE UPDATE OR DELETE ON ped_vaccines FOR EACH ROW EXECUTE FUNCTION kay_guard_ped();
CREATE TABLE IF NOT EXISTS deletion_requests(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id), requested_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','refused')), note text, handled_by uuid REFERENCES users(id), handled_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS delreq_one_pending ON deletion_requests(user_id) WHERE status='pending';
CREATE TABLE IF NOT EXISTS provider_profiles(
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, categorie text NOT NULL, zones text[] NOT NULL,
  tarif_fcfa int NOT NULL CHECK (tarif_fcfa>=0), frais_deplacement_fcfa int NOT NULL DEFAULT 0 CHECK (frais_deplacement_fcfa>=0),
  bio text, qualification_ref text, verified_at timestamptz, verified_by uuid REFERENCES users(id), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS care_requests(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), patient_id uuid NOT NULL REFERENCES users(id), dependent_id uuid REFERENCES dependents(id),
  categorie text NOT NULL, zone text NOT NULL, preferred_date date, description text,
  status text NOT NULL DEFAULT 'ouverte' CHECK (status IN ('ouverte','attribuee','annulee')), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS care_quotes(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), request_id uuid NOT NULL REFERENCES care_requests(id), provider_id uuid NOT NULL REFERENCES users(id),
  prix_fcfa int NOT NULL CHECK (prix_fcfa>=0), frais_fcfa int NOT NULL DEFAULT 0 CHECK (frais_fcfa>=0), message text,
  status text NOT NULL DEFAULT 'proposee' CHECK (status IN ('proposee','acceptee','refusee')), created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(request_id,provider_id)
);
CREATE TABLE IF NOT EXISTS missions(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), request_id uuid NOT NULL REFERENCES care_requests(id), quote_id uuid NOT NULL REFERENCES care_quotes(id),
  patient_id uuid NOT NULL REFERENCES users(id), provider_id uuid NOT NULL REFERENCES users(id), dependent_id uuid REFERENCES dependents(id),
  categorie text NOT NULL, adresse text NOT NULL, amount_fcfa int NOT NULL, preferred_date date,
  status text NOT NULL CHECK (status IN ('pending_payment','confirmee','declaree_realisee','terminee','annulee','litige')),
  payment_mode text NOT NULL DEFAULT 'sur_place', hold_expires_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), done_declared_at timestamptz, completed_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS mission_one_active ON missions(request_id) WHERE status<>'annulee';
CREATE TABLE IF NOT EXISTS care_reviews(
  mission_id uuid PRIMARY KEY REFERENCES missions(id), patient_id uuid NOT NULL REFERENCES users(id), provider_id uuid NOT NULL REFERENCES users(id),
  rating int NOT NULL CHECK (rating BETWEEN 1 AND 5), comment text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS care_disputes(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), mission_id uuid NOT NULL REFERENCES missions(id), opened_by uuid NOT NULL REFERENCES users(id), reason text NOT NULL,
  status text NOT NULL DEFAULT 'ouvert' CHECK (status IN ('ouvert','rembourse','rejete')), note text, handled_by uuid REFERENCES users(id), handled_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE payments ALTER COLUMN appointment_id DROP NOT NULL;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS mission_id uuid REFERENCES missions(id);
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_target_check;
ALTER TABLE payments ADD CONSTRAINT payments_target_check CHECK ((appointment_id IS NOT NULL)<>(mission_id IS NOT NULL));
CREATE UNIQUE INDEX IF NOT EXISTS pay_one_open_per_mission ON payments(mission_id) WHERE mission_id IS NOT NULL AND status IN ('pending','succeeded','refund_pending');
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'pharmacien';
CREATE TABLE IF NOT EXISTS pharmacies(
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, nom_officine text NOT NULL, ville text NOT NULL, adresse text NOT NULL, numero_autorisation text NOT NULL,
  frais_livraison_fcfa int CHECK (frais_livraison_fcfa>=0), verified_at timestamptz, verified_by uuid REFERENCES users(id), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS drugs(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), nom text NOT NULL, forme text, dosage text, sur_ordonnance boolean NOT NULL, actif boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS drugs_unique ON drugs(lower(nom),coalesce(forme,''),coalesce(dosage,''));
CREATE TABLE IF NOT EXISTS pharmacy_stock(
  pharmacy_id uuid NOT NULL REFERENCES pharmacies(user_id) ON DELETE CASCADE, drug_id uuid NOT NULL REFERENCES drugs(id),
  prix_fcfa int NOT NULL CHECK (prix_fcfa>0), quantite int NOT NULL CHECK (quantite>=0), updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(pharmacy_id,drug_id)
);
CREATE TABLE IF NOT EXISTS pharmacy_orders(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), patient_id uuid NOT NULL REFERENCES users(id), dependent_id uuid REFERENCES dependents(id), pharmacy_id uuid NOT NULL REFERENCES pharmacies(user_id),
  prescription_id uuid REFERENCES prescriptions(id), mode text NOT NULL CHECK (mode IN ('retrait','livraison')), adresse text, frais_livraison_fcfa int NOT NULL DEFAULT 0, total_fcfa int NOT NULL,
  status text NOT NULL CHECK (status IN ('pending_payment','en_attente','en_preparation','prete','livree','annulee')), payment_mode text NOT NULL DEFAULT 'sur_place',
  hold_expires_at timestamptz, cancel_reason text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS order_one_per_rx ON pharmacy_orders(prescription_id) WHERE prescription_id IS NOT NULL AND status<>'annulee';
CREATE TABLE IF NOT EXISTS pharmacy_order_items(
  order_id uuid NOT NULL REFERENCES pharmacy_orders(id), drug_id uuid NOT NULL REFERENCES drugs(id), nom text NOT NULL, prix_fcfa int NOT NULL, quantite int NOT NULL CHECK (quantite>0), PRIMARY KEY(order_id,drug_id)
);
ALTER TABLE prescriptions DROP CONSTRAINT IF EXISTS prescriptions_status_check;
ALTER TABLE prescriptions ADD CONSTRAINT prescriptions_status_check CHECK (status IN ('brouillon','signee','annulee','delivree'));
CREATE OR REPLACE FUNCTION kay_guard_rx() RETURNS trigger AS $$ BEGIN IF TG_OP='DELETE' THEN IF OLD.status<>'brouillon' THEN RAISE EXCEPTION 'ordonnance signee non supprimable'; END IF; RETURN OLD; END IF; IF OLD.status IN ('signee','annulee','delivree') AND (NEW.items IS DISTINCT FROM OLD.items OR NEW.notes IS DISTINCT FROM OLD.notes OR NEW.patient_id<>OLD.patient_id OR NEW.doctor_id<>OLD.doctor_id OR NEW.content_hash IS DISTINCT FROM OLD.content_hash OR NEW.number IS DISTINCT FROM OLD.number OR (OLD.status='annulee' AND NEW.status<>'annulee') OR (OLD.status='delivree' AND NEW.status<>'delivree')) THEN RAISE EXCEPTION 'ordonnance signee non modifiable'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS order_id uuid REFERENCES pharmacy_orders(id);
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_target_check;
ALTER TABLE payments ADD CONSTRAINT payments_target_check CHECK (num_nonnulls(appointment_id,mission_id,order_id)=1);
CREATE UNIQUE INDEX IF NOT EXISTS pay_one_open_per_order ON payments(order_id) WHERE order_id IS NOT NULL AND status IN ('pending','succeeded','refund_pending');
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS no_show_by text;
CREATE TABLE IF NOT EXISTS consultation_rooms(
  appointment_id uuid PRIMARY KEY REFERENCES appointments(id), room_name text NOT NULL UNIQUE, twilio_room_sid text,
  created_at timestamptz NOT NULL DEFAULT now(), patient_waiting_at timestamptz, opened_at timestamptz, ended_at timestamptz
);
CREATE TABLE IF NOT EXISTS consultation_events(
  id bigserial PRIMARY KEY, appointment_id uuid NOT NULL REFERENCES appointments(id), user_id uuid NOT NULL, event text NOT NULL, at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS consult_ev ON consultation_events(appointment_id,at);
