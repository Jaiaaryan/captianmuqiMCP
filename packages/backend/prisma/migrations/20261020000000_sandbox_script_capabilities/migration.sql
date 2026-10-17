-- Level 3 of code mode: a saved script can opt in to the variables of the
-- connectors it declares (`env`) and to direct HTTP requests to those
-- connectors' base URLs (`http.fetch`). `{ "env": true, "http": true }`;
-- NULL: tools only, as before. Inline code never gets either.
ALTER TABLE "sandbox_scripts" ADD COLUMN "capabilities" JSONB;
