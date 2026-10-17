-- A saved script can describe the arguments it reads (`args.<name>`) as a JSON
-- Schema object. A script with parameters is also offered as an MCP tool of its
-- own name, with those parameters. NULL: the script is run only by name through
-- sandbox_run_script, as before.
ALTER TABLE "sandbox_scripts" ADD COLUMN "parameters" JSONB;
