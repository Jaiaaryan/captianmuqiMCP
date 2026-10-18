import { Module } from '@nestjs/common';
import { ConnectorsModule } from '../connectors/connectors.module';
import { McpServerModule } from '../mcp-server/mcp-server.module';
import { McpServersModule } from '../mcp-servers/mcp-servers.module';
import { SandboxModule } from '../sandbox/sandbox.module';
import { SettingsModule } from '../settings/settings.module';
import { DemoAdminController } from './demo-admin.controller';
import { DemoControlController } from './demo-control.controller';
import { DemoControlService } from './demo-control.service';
import { DemoController } from './demo.controller';
import { DemoResetService } from './demo-reset.service';
import { DemoSeedService } from './demo-seed.service';
import { DemoStateService } from './demo-state.service';
import { MockSystemsService } from './mock-systems.service';

/**
 * Demo mode (a runtime switch, self-hosted only; DEMO_MODE=true is its initial
 * default): mock business systems on a loopback port, the CODEBOUND demo
 * workspace seeded when it is turned on, the public endpoint the login page
 * reads and the demo control. Inert while off; refused on Cloud.
 * See docs/demo-mode.md.
 */
@Module({
  imports: [ConnectorsModule, McpServerModule, McpServersModule, SandboxModule, SettingsModule],
  controllers: [DemoController, DemoAdminController, DemoControlController],
  providers: [DemoStateService, MockSystemsService, DemoSeedService, DemoResetService, DemoControlService],
})
export class DemoModule {}
