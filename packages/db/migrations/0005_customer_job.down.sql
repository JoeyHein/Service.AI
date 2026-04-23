-- Migration: 0005_customer_job (down). Drops policies + tables + enum.

DROP POLICY IF EXISTS customers_platform_admin      ON customers;
DROP POLICY IF EXISTS customers_franchisor_admin    ON customers;
DROP POLICY IF EXISTS customers_scoped              ON customers;
DROP POLICY IF EXISTS jobs_platform_admin           ON jobs;
DROP POLICY IF EXISTS jobs_franchisor_admin         ON jobs;
DROP POLICY IF EXISTS jobs_scoped                   ON jobs;
DROP POLICY IF EXISTS job_status_log_platform_admin   ON job_status_log;
DROP POLICY IF EXISTS job_status_log_franchisor_admin ON job_status_log;
DROP POLICY IF EXISTS job_status_log_scoped           ON job_status_log;
DROP POLICY IF EXISTS job_photos_platform_admin     ON job_photos;
DROP POLICY IF EXISTS job_photos_franchisor_admin   ON job_photos;
DROP POLICY IF EXISTS job_photos_scoped             ON job_photos;

ALTER TABLE IF EXISTS customers       NO FORCE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS jobs            NO FORCE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS job_status_log  NO FORCE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS job_photos      NO FORCE ROW LEVEL SECURITY;

DROP TABLE IF EXISTS job_photos      CASCADE;
DROP TABLE IF EXISTS job_status_log  CASCADE;
DROP TABLE IF EXISTS jobs            CASCADE;
DROP TABLE IF EXISTS customers       CASCADE;

DROP TYPE IF EXISTS job_status;
