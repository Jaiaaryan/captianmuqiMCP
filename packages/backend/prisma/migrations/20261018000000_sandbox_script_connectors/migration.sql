-- Sandbox scripts become an organization-wide library. A script no longer belongs
-- to one MCP server; it declares the connectors and tools it calls, and a server
-- offers it to an agent only when the server has every one of those connectors.

-- 1. Names were unique per server and must now be unique per organization. Where
--    two servers of one organization used the same name, the oldest keeps it and
--    the others get a short suffix from their id (still a valid script name).
WITH ranked AS (
  SELECT "id",
         row_number() OVER (PARTITION BY "organization_id", "name" ORDER BY "created_at", "id") AS rn
  FROM "sandbox_scripts"
)
UPDATE "sandbox_scripts" s
SET "name" = left(s."name", 57) || '_' || lower(left(s."id", 6))
FROM ranked r
WHERE r."id" = s."id" AND r.rn > 1;

-- 2. The declared connectors and tools.
-- CreateTable
CREATE TABLE "sandbox_script_tools" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "script_id" TEXT NOT NULL,
    "connector_id" TEXT NOT NULL,
    "connector_name" TEXT NOT NULL,
    "tool_name" TEXT NOT NULL,

    CONSTRAINT "sandbox_script_tools_pkey" PRIMARY KEY ("id")
);

-- 3. Existing scripts: declare what their code calls, resolved against the
--    connectors of the server the script belonged to (`tools.name(` and
--    `tools['name']`). A call that cannot be found this way, such as a computed
--    tool name, has to be declared by hand in the dashboard.
INSERT INTO "sandbox_script_tools" ("id", "organization_id", "script_id", "connector_id", "connector_name", "tool_name")
SELECT gen_random_uuid()::text, d."organization_id", d."script_id", d."connector_id", d."connector_name", d."tool_name"
FROM (
  SELECT DISTINCT s."organization_id" AS organization_id,
                  s."id"              AS script_id,
                  c."id"              AS connector_id,
                  c."name"            AS connector_name,
                  t."name"            AS tool_name
  FROM "sandbox_scripts" s
  CROSS JOIN LATERAL (
    SELECT m[1] AS name
    FROM regexp_matches(s."code", '\mtools\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)', 'g') AS m
    UNION
    SELECT m[1]
    FROM regexp_matches(s."code", '\mtools\s*\[\s*[''"`]([A-Za-z_][A-Za-z0-9_]*)[''"`]\s*\]', 'g') AS m
  ) refs
  JOIN "mcp_server_connectors" sc ON sc."mcp_server_id" = s."mcp_server_id"
  JOIN "connectors" c ON c."id" = sc."connector_id" AND c."organization_id" = s."organization_id"
  JOIN "mcp_tools" t ON t."connector_id" = c."id" AND t."name" = refs.name
  WHERE refs.name NOT IN ('list', 'describe')
) d;

-- 4. Scripts leave their server.
-- DropForeignKey
ALTER TABLE "sandbox_scripts" DROP CONSTRAINT "sandbox_scripts_mcp_server_id_fkey";

-- DropIndex
DROP INDEX "sandbox_scripts_mcp_server_id_name_key";

-- AlterTable
ALTER TABLE "sandbox_scripts" DROP COLUMN "mcp_server_id";

-- CreateIndex
CREATE INDEX "sandbox_script_tools_organization_id_idx" ON "sandbox_script_tools"("organization_id");

-- CreateIndex
CREATE INDEX "sandbox_script_tools_connector_id_idx" ON "sandbox_script_tools"("connector_id");

-- CreateIndex
CREATE UNIQUE INDEX "sandbox_script_tools_script_id_connector_id_tool_name_key" ON "sandbox_script_tools"("script_id", "connector_id", "tool_name");

-- CreateIndex
CREATE UNIQUE INDEX "sandbox_scripts_organization_id_name_key" ON "sandbox_scripts"("organization_id", "name");

-- AddForeignKey
ALTER TABLE "sandbox_script_tools" ADD CONSTRAINT "sandbox_script_tools_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sandbox_script_tools" ADD CONSTRAINT "sandbox_script_tools_script_id_fkey" FOREIGN KEY ("script_id") REFERENCES "sandbox_scripts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
