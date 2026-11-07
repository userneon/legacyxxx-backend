-- QA role (owner request 2026-11-07): a team role for the people who test the website. Like Developer and Designer it is a website role
-- (a badge, no moderation, no game-server permissions). While active, the API gives a QA tester every cosmetic for good, switched-off ones
-- included, so they can try each before it is sold. Those items carry source 'qa' and are taken back when the tester leaves the role.
ALTER TABLE legacy_x.staff DROP CONSTRAINT IF EXISTS staff_role_check;
ALTER TABLE legacy_x.staff ADD CONSTRAINT staff_role_check CHECK (role IN ('OWNER','MANAGER','ADMIN','DEVELOPER','DESIGNER','QA'));
ALTER TABLE legacy_x.cosmetic_owned DROP CONSTRAINT IF EXISTS cosmetic_owned_source_check;
ALTER TABLE legacy_x.cosmetic_owned ADD CONSTRAINT cosmetic_owned_source_check CHECK (source IN ('coin', 'achievement', 'staff', 'qa'));
