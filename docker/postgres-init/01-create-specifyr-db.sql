-- Bootstrap database for specifyr (multi-tenant phase).
--
-- Mirrors roles/postgres/files/docker-entrypoint-initdb.d/create_specifyr_db.sql
-- in the ansible deployment, so dev and prod end up with the same DB layout.
--
-- Runs once on first postgres init (when the data volume is empty); ignored
-- on subsequent boots. For an existing volume, create manually via:
--   docker exec specifyr-postgres-dev psql -U postgres -c "CREATE DATABASE specifyr"
CREATE DATABASE specifyr;
