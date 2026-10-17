import { Module } from '@nestjs/common';
import { SandboxScriptsService } from './sandbox-scripts.service';
import { SandboxService } from './sandbox.service';

/**
 * Code mode services: the isolate runtime and saved-script storage. They depend
 * only on Prisma (global), never on the MCP module, so McpServerModule can
 * import this one. A dashboard REST API would need the MCP module (to resolve
 * the role-filtered tool list), so it must live in a separate module; there is
 * none yet, only its DTOs in sandbox-scripts.dto.ts.
 */
@Module({
  providers: [SandboxService, SandboxScriptsService],
  exports: [SandboxService, SandboxScriptsService],
})
export class SandboxModule {}
