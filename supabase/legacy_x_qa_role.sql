-- QA role (owner request 2026-11-07): a team role for the people who test the website. Like Developer and Designer it is a website role
-- (a badge, no moderation, no game-server permissions). While active, the API gives a QA tester every cosmetic for good, switched-off ones
-- included, so they can try each before it is sold. Those items carry source 'qa' and are taken back when the tester leaves the role.
ALTER TABLE legacy_x.staff DROP CONSTRAINT IF EXISTS staff_role_check;
ALTER TABLE legacy_x.staff ADD CONSTRAINT staff_role_check CHECK (role IN ('OWNER','MANAGER','ADMIN','DEVELOPER','DESIGNER','QA'));
ALTER TABLE legacy_x.cosmetic_owned DROP CONSTRAINT IF EXISTS cosmetic_owned_source_check;
ALTER TABLE legacy_x.cosmetic_owned ADD CONSTRAINT cosmetic_owned_source_check CHECK (source IN ('coin', 'achievement', 'staff', 'qa'));

-- A QA switch on any staff row (owner request 2026-11-07, "the Owner is already on the list, so add QA on top"): a tester need not be a QA-role row.
ALTER TABLE legacy_x.staff ADD COLUMN IF NOT EXISTS qa boolean NOT NULL DEFAULT false;

-- Deleting a staff member (owner request 2026-11-07): their audit rows and queued actions stay, only the "who" link is emptied.
ALTER TABLE legacy_x.staff_audit_logs ALTER COLUMN staff_id DROP NOT NULL;
ALTER TABLE legacy_x.staff_audit_logs DROP CONSTRAINT IF EXISTS staff_audit_logs_staff_id_fkey;
ALTER TABLE legacy_x.staff_audit_logs ADD CONSTRAINT staff_audit_logs_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES legacy_x.staff(id) ON DELETE SET NULL;
ALTER TABLE legacy_x.staff_panel_actions DROP CONSTRAINT IF EXISTS staff_panel_actions_requested_by_staff_id_fkey;
ALTER TABLE legacy_x.staff_panel_actions ADD CONSTRAINT staff_panel_actions_requested_by_staff_id_fkey FOREIGN KEY (requested_by_staff_id) REFERENCES legacy_x.staff(id) ON DELETE SET NULL;
ALTER TABLE legacy_x.staff_panel_settings DROP CONSTRAINT IF EXISTS staff_panel_settings_updated_by_staff_id_fkey;
ALTER TABLE legacy_x.staff_panel_settings ADD CONSTRAINT staff_panel_settings_updated_by_staff_id_fkey FOREIGN KEY (updated_by_staff_id) REFERENCES legacy_x.staff(id) ON DELETE SET NULL;
